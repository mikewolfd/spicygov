"""Fixed-input and failure preservation checks for changed coverage preparation."""
import importlib.util
import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('prepare', ROOT / 'scripts/prepare-coverage-refresh.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        base = {'format': 'spicygov-coverage-maps', 'version': 1, 'partial': False,
                'tables': {'unchanged': {'value': 'accepted'}, 'changed': {'value': 'earlier'},
                           'blocked': {'value': 'earlier blocked'}}}
        raw = json.dumps(base).encode()
        (self.root / 'coverage-maps.v1.json').write_bytes(raw)
        manifest = json.dumps({'members': {'coverage-maps.v1.json': {'sha256': prepare.sha(raw), 'bytes': len(raw)}}}).encode()
        (self.root / 'manifest.json').write_bytes(manifest)
        self.selection = self.root / 'base-selection.json'
        self.selection.write_text(json.dumps({'format': 'spicygov-coverage-release-selection', 'version': 1,
            'directory': str(self.root), 'manifestSha256': prepare.sha(manifest)}))
        self.args = SimpleNamespace(run=self.root / 'run', base_selection=self.selection,
                                    reserve_gib=25, max_restoration_bytes=100)

    def test_selected_base_rejects_content_changed_after_selection(self):
        self.assertIn(b'accepted', prepare.selected_base(self.selection))
        (self.root / 'coverage-maps.v1.json').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            prepare.selected_base(self.selection)

    def test_changed_only_scans_keep_unresolved_earlier_measurement(self):
        tables = {id: {'id': id, 'members': []} for id in ('unchanged', 'changed', 'blocked')}
        policies = {id: {'dimensions': [], 'schema': []} for id in tables}
        measured = {'value': 'new', 'measurementRevision': 'rev'}
        # An unchanged accepted checkpoint is reused without entering the scan;
        # the blocked table's over-budget restore cannot enter it either.
        def cached(table, policy, old): return table['id'] == 'unchanged'
        def scan(request):
            self.assertEqual(request[0], 'changed')
            return 'changed', measured
        def complete(root, output, raw, captured, effective, revisions, **kwargs):
            document = json.loads(raw)
            self.assertEqual(document['tables']['blocked'], {'value': 'earlier blocked'})
            self.assertEqual(document['tables']['unchanged']['value'], 'accepted')
            self.assertEqual(document['tables']['changed'], measured)
            self.assertEqual(set(effective), {'unchanged', 'changed'})
            self.assertEqual(document['measurementStates'], {'blocked': 'unavailable'})
            self.assertNotIn('101 bytes', raw.decode())
            output.mkdir()
            (output / 'coverage-maps.v1.json').write_bytes(raw)
            return {'directory': str(output), 'manifestSha256': 'fixture'}
        # Reused records must still carry the checked scanner revision.
        base = json.loads(prepare.selected_base(self.selection))
        base['tables']['unchanged']['measurementRevision'] = 'rev'
        with patch.object(prepare, 'selected_base', return_value=json.dumps(base).encode()), \
             patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare.builder, 'definitions', return_value=policies), \
             patch.object(prepare.builder, 'validate_plan'), \
             patch.object(prepare.builder, 'cached', side_effect=cached), \
             patch.object(prepare, 'restoration_inputs', side_effect=lambda id, *a: [{'byteSize': 101}] if id == 'blocked' else []), \
             patch.object(prepare.builder, 'timed_scan', side_effect=scan) as scans, \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'recover_release', return_value={'directory': 'fixture'}), \
             patch.object(prepare, 'complete', side_effect=complete):
            report = prepare.prepare(self.args)
            self.assertEqual(scans.call_count, 1)
            self.assertEqual((report['currentTables'], report['unresolvedTables']), (2, 1))
            self.assertIn('101 bytes', report['tables']['blocked']['reason'])
            # A fresh invocation of a completed fixed run does not repeat scans.
            prepare.prepare(self.args)
            self.assertEqual(scans.call_count, 1)

    def test_saved_publication_snapshot_rejects_metadata_corruption(self):
        run = self.root / 'snapshot'
        run.mkdir()
        (run / 'publications').mkdir()
        raw = b'{}'
        (run / 'publications/publication.v2.json').write_bytes(raw)
        prepare.save(run / 'publication-snapshot.json', {'publication.v2.json': {'bytes': len(raw), 'sha256': prepare.sha(raw)}})
        (run / 'publications/publication.v2.json').write_bytes(b'[]')
        with self.assertRaisesRegex(ValueError, 'Captured publication changed'):
            prepare.publication_snapshot(run)

    def test_automatic_handoff_prepares_before_website_finish_with_separate_reader_source(self):
        spec = importlib.util.spec_from_file_location('refresh', ROOT / 'scripts/refresh-local-catalog.py')
        refresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(refresh)
        args = SimpleNamespace(prepare_coverage=True, coverage_selection=self.selection,
                               finish_selected=True, candidate=None, full_rebuild=False)
        order = []
        def command(argv, **kwargs):
            order.append('prepare')
            self.assertEqual(kwargs['env']['PYTHONPATH'], '/pinned/coverage-reader/src')
            self.assertIn('prepare-coverage-refresh.py', argv[1])
        def finish(selected, website, run):
            order.append('finish')
            self.assertEqual(selected.coverage_selection, run / 'coverage/selection.json')
        with patch.dict(refresh.os.environ, {'SPICYGOV_COVERAGE_PYTHONPATH': '/pinned/coverage-reader/src'}), \
             patch.object(refresh.subprocess, 'run', side_effect=command), \
             patch.object(refresh, 'finish_selected', side_effect=finish):
            refresh.run_refresh(args, ROOT, self.args.run, self.root / 'raw', None)
        self.assertEqual(order, ['prepare', 'finish'])

    def test_rulemaking_preflight_uses_exact_snapshot_subject_and_receipt_pins(self):
        subject = {'key': 'proceedings.parquet', 'byteSize': 12, 'sha256': 'subject'}
        receipt = {'key': 'etl_receipts.parquet', 'byteSize': 80, 'sha256': 'receipt'}
        required = prepare.restoration_inputs('proceedings', {
            'kind': 'rulemaking', 'recordUrl': 'pinned manifest',
            'rulemakingSnapshot': {'subjects': [subject], 'receipts': receipt}},
            {'_additionalNativeProcessing': True, 'dimensions': []}, {}, {})
        self.assertEqual(required, [subject, receipt])

    def test_recorded_parent_budget_follows_adapter_without_current_schema(self):
        relation = {'mode': 'recorded-parent', 'table': 'laws'}
        parent = {'family': 'laws', 'artifactDigest': 'historical', 'tableId': 'laws',
                  'recordUrl': 'historical artifact', 'members': [{'key': 'laws.parquet', 'byteSize': 30}],
                  'artifact': {'spec': {'etlReceipts': {'key': 'etl_receipts.parquet',
                                                     'policies': [{'dataset': 'laws'}]}}}}
        owner = {'family': 'child', 'artifactDigest': 'child-generation', 'recordUrl': 'child artifact',
                 'members': [{'key': 'child.parquet', 'byteSize': 10}],
                 'artifact': {'spec': {'etlReceipts': {'key': 'etl_receipts.parquet'}}}}
        class Inputs:
            def producing(self, *args): return owner
            def parent(self, *args): return parent
            def artifact(self, family, generation):
                size = 20 if family == 'child' else 900
                return '', {}, [{'role': 'table', 'objectKey': 'etl_receipts.parquet', 'byteSize': size, 'sha256': 'pin'}]
        policy = {'_additionalNativeProcessing': True, 'dimensions': [{'kind': 'inherited', 'parent': relation}]}
        with patch.object(prepare, 'CoverageInputs', Inputs), \
             patch.object(prepare.builder, 'validate_plan', side_effect=AssertionError('Used a current parent schema')):
            for current_schema in ([['new', 'STRUCT(different INTEGER)']], [['legacy', 'VARCHAR']]):
                required = prepare.restoration_inputs('child', {'kind': 'generation'}, policy, {},
                                                      {'laws': {'columns': current_schema}})
                # AdditionalInputs recorded-parent route reads the pinned public
                # parent directly; its 900-byte processing receipt is unrelated.
                self.assertEqual(sum(member['byteSize'] for member in required), 60)

    def test_holds_apply_only_to_unchanged_publications_and_preserve_prior_records(self):
        tables = {id: {'id': id, 'members': []} for id in ('unchanged', 'changed')}
        self.args.hold_unchanged = ['unchanged', 'changed']
        measured = {'value': 'current changed', 'measurementRevision': 'rev'}
        def completion(root, output, raw, captured, effective, revisions, **kwargs):
            document = json.loads(raw)
            self.assertEqual(document['tables']['unchanged'], {'value': 'accepted'})
            self.assertEqual(document['measurementStates'], {'unchanged': 'held'})
            self.assertEqual(set(effective), {'changed'})
            return {'directory': str(output), 'manifestSha256': 'fixture'}
        with patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare, 'publication_matches', side_effect=lambda table, old: table['id'] == 'unchanged'), \
             patch.object(prepare.builder, 'definitions', return_value={id: {'schema': [], 'dimensions': []} for id in tables}), \
             patch.object(prepare.builder, 'validate_plan'), \
             patch.object(prepare.builder, 'cached', return_value=False), \
             patch.object(prepare, 'restoration_inputs', return_value=[]), \
             patch.object(prepare.builder, 'timed_scan', return_value=('changed', measured)) as scan, \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'complete', side_effect=completion):
            report = prepare.prepare(self.args)
        self.assertEqual(scan.call_args.args[0][0], 'changed')
        self.assertEqual((report['currentTables'], report['heldTables']), (1, 1))

    def test_compatible_checkpoint_is_current_before_hold_without_body_or_restore(self):
        self.args.hold_unchanged = ['unchanged']
        checkpoint = self.args.run / 'checkpoints/unchanged.json'
        current = {'value': 'newer qualified checkpoint', 'measurementRevision': 'rev', 'dimensions': []}
        prepare.save(checkpoint, current)
        tables = {'unchanged': {'id': 'unchanged', 'members': []}}
        def completion(root, output, raw, captured, effective, revisions, **kwargs):
            document = json.loads(raw)
            self.assertEqual(document['tables']['unchanged'], current)
            self.assertEqual(document['measurementStates'], {})
            return {'directory': str(output), 'manifestSha256': 'fixture'}
        with patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare, 'publication_matches', return_value=True), \
             patch.object(prepare.builder, 'definitions', return_value={'unchanged': {'schema': [], 'dimensions': []}}), \
             patch.object(prepare.builder, 'validate_plan'), \
             patch.object(prepare.builder, 'cached', return_value=True), \
             patch.object(prepare, 'restoration_inputs', side_effect=AssertionError('Unneeded input/body lookup')), \
             patch.object(prepare.builder, 'timed_scan', side_effect=AssertionError('Repeated measurement')), \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'complete', side_effect=completion):
            report = prepare.prepare(self.args)
        self.assertEqual(report['tables']['unchanged']['status'], 'current')
        self.assertEqual(report['tables']['unchanged']['action'], 'reused')

    def test_invalid_documents_latest_day_stays_private_and_held(self):
        invalid = {'measurementRevision': 'rev', 'dimensions': [{
            'id': 'document-posting-dates', 'granularity': 'month', 'latestDate': '2026-12-13',
            'buckets': {'2026-10': 2}, 'anomalies': {'futureActivityBuckets': {'2026-12': 1}}}]}
        with self.assertRaisesRegex(ValueError, 'Latest-date summary'):
            prepare.validate_summary_fields(invalid)
        with self.assertRaisesRegex(ValueError, 'Latest-date summary'):
            prepare.validate_summary_fields({'dimensions': [{**invalid['dimensions'][0], 'latestDate': None}]})
        self.args.hold_unchanged = ['unchanged']
        checkpoint = self.args.run / 'checkpoints/unchanged.json'
        prepare.save(checkpoint, invalid)
        tables = {id: {'id': id, 'members': []} for id in ('unchanged', 'changed')}
        current = {'measurementRevision': 'rev', 'dimensions': []}
        def completion(root, output, raw, captured, effective, revisions, **kwargs):
            document = json.loads(raw)
            self.assertEqual(document['tables']['unchanged'], {'value': 'accepted'})
            self.assertEqual(document['measurementStates'], {'unchanged': 'held'})
            self.assertNotIn('2026-12-13', raw.decode())
            self.assertEqual(set(effective), {'changed'})
            return {'directory': str(output), 'manifestSha256': 'fixture'}
        with patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare, 'publication_matches', return_value=True), \
             patch.object(prepare.builder, 'definitions', return_value={id: {'schema': [], 'dimensions': []} for id in tables}), \
             patch.object(prepare.builder, 'validate_plan'), \
             patch.object(prepare.builder, 'cached', side_effect=lambda table, *args: table['id'] == 'unchanged'), \
             patch.object(prepare, 'restoration_inputs', return_value=[]), \
             patch.object(prepare.builder, 'timed_scan', return_value=('changed', current)), \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'complete', side_effect=completion):
            report = prepare.prepare(self.args)
        self.assertEqual(report['tables']['unchanged']['status'], 'held')
        self.assertEqual(json.loads(checkpoint.read_bytes()), invalid)

    def test_reviewed_future_activity_filter_only_omits_ineligible_optional_day(self):
        table = {'publishedAt': '2026-10-30T00:00:00Z'}
        policy = {'_scanner': 'regulation', 'dimensions': [
            {'id': 'date-closed', 'kind': 'date', 'special': 'literal-date-anomalies'}]}
        dimension = {'id': 'date-closed', 'kind': 'date', 'granularity': 'month',
                     'status': 'measured', 'overlapping': False, 'rows': 21724,
                     'placedRows': 19100, 'unplacedRows': 2624, 'buckets': {'2026-06': 19100},
                     'latestDate': '2100-01-31',
                     'activityBoundary': {'basis': 'publication-month', 'month': '2026-10'},
                     'anomalies': {'boundaryMonth': '2026-10', 'futureActivityRows': 406,
                                   'futureActivityBuckets': {'2099-12': 376, '2100-01': 30}}}
        original = {'dimensions': [dimension]}
        prepare.builder.validate_counts(dimension, 21724)
        projected, omissions = prepare.eligible_month_summary(original, table, policy)
        self.assertEqual(projected, {'dimensions': [{key: value for key, value in dimension.items() if key != 'latestDate'}]})
        self.assertEqual(original['dimensions'][0]['latestDate'], '2100-01-31')
        self.assertEqual(omissions[0]['latestEligibleMonth'], '2026-06')
        self.assertEqual(omissions[0]['omittedLatestDate'], '2100-01-31')
        for latest, month in [('2026-12-13', '2026-12'), ('4018-04-11', '4018-04')]:
            candidate = copy.deepcopy(original)
            candidate['dimensions'][0].update(latestDate=latest, anomalies={
                'boundaryMonth': '2026-10', 'futureActivityRows': 1, 'futureActivityBuckets': {month: 1}})
            self.assertNotIn('latestDate', prepare.eligible_month_summary(candidate, table, policy)[0]['dimensions'][0])
        for mutation in [lambda d: d.update(latestDate=None), lambda d: d.update(latestDate='2100-02-31'),
                         lambda d: d['anomalies'].update(futureActivityRows=405),
                         lambda d: d['activityBoundary'].update(month='2026-09'),
                         lambda d: d.update(latestDate='2026-07-01')]:
            candidate = copy.deepcopy(original)
            mutation(candidate['dimensions'][0])
            with self.assertRaises(ValueError): prepare.eligible_month_summary(candidate, table, policy)
        with self.assertRaises(ValueError):
            prepare.eligible_month_summary(original, table, {'_scanner': 'regulation', 'dimensions': [{'kind': 'date'}]})

    def test_targeted_followup_preserves_other_table_records_and_public_states(self):
        self.args.only = ['changed']
        base = json.loads(prepare.selected_base(self.selection))
        base['measurementStates'] = {'unchanged': 'held', 'blocked': 'unavailable', 'changed': 'unavailable'}
        measured = {'measurementRevision': 'rev', 'dimensions': []}
        prepare.save(self.args.run / 'checkpoints/changed.json', measured)
        tables = {id: {'id': id, 'members': []} for id in ('changed', 'unchanged', 'blocked')}
        def completion(root, output, raw, captured, effective, revisions, **kwargs):
            document = json.loads(raw)
            self.assertEqual(document['measurementStates'], {'unchanged': 'held', 'blocked': 'unavailable'})
            self.assertEqual(document['tables']['unchanged'], base['tables']['unchanged'])
            self.assertEqual(document['tables']['blocked'], base['tables']['blocked'])
            self.assertEqual(set(effective), {'changed'})
            return {'directory': str(output), 'manifestSha256': 'fixture'}
        with patch.object(prepare, 'selected_base', return_value=json.dumps(base).encode()), \
             patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare.builder, 'definitions', return_value={'changed': {'schema': [], 'dimensions': []}}), \
             patch.object(prepare.builder, 'validate_plan'), \
             patch.object(prepare.builder, 'cached', return_value=True), \
             patch.object(prepare, 'restoration_inputs', side_effect=AssertionError('no restore')), \
             patch.object(prepare.builder, 'timed_scan', side_effect=AssertionError('no scan')), \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'complete', side_effect=completion):
            report = prepare.prepare(self.args)
        self.assertEqual(set(report['tables']), {'changed'})
        self.assertEqual((report['currentTables'], report['heldTables'], report['unresolvedTables']), (1, 1, 2))

    def test_unsupported_held_policy_retains_earlier_without_body_reads(self):
        self.args.hold_unchanged = ['unchanged']
        tables = {id: {'id': id, 'members': []} for id in ('unchanged', 'changed')}
        def validate(tables, *args):
            if 'unchanged' in tables: raise ValueError('Unsupported current published schema')
        with patch.object(prepare, 'publication_snapshot', return_value=(tables, {})), \
             patch.object(prepare, 'census_digest', return_value='census'), \
             patch.object(prepare, 'publication_matches', return_value=True), \
             patch.object(prepare.builder, 'definitions', return_value={id: {'schema': [], 'dimensions': []} for id in tables}), \
             patch.object(prepare.builder, 'validate_plan', side_effect=validate), \
             patch.object(prepare.builder, 'cached', return_value=False), \
             patch.object(prepare, 'restoration_inputs', return_value=[]), \
             patch.object(prepare.builder, 'timed_scan', return_value=('changed', {'measurementRevision': 'rev'})) as scan, \
             patch.object(prepare.builder, 'validate_native_implementations'), \
             patch.object(prepare.builder.additional, 'validate_native_implementations'), \
             patch.object(prepare.builder, 'measurement_revision', return_value='rev'), \
             patch.object(prepare.builder, 'binding', return_value={}), \
             patch.object(prepare, 'complete', return_value={'directory': 'fixture', 'manifestSha256': 'fixture'}):
            report = prepare.prepare(self.args)
        self.assertEqual(scan.call_args.args[0][0], 'changed')
        self.assertEqual(report['tables']['unchanged']['status'], 'held')

    def test_crash_after_immutable_completion_recovers_selection_offline(self):
        from test_coverage_release import ReleaseTests
        fixture = ReleaseTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        completion = fixture.create_refresh()
        self.assertFalse((fixture.root / 'selection.json').exists())
        inputs = {'censusDigest': fixture.document['censusDigest'],
                  'baseSha256': prepare.sha((fixture.release / 'base-coverage-maps.v1.json').read_bytes())}
        with patch.object(prepare.builder, 'timed_scan', side_effect=AssertionError('Repeated measurement')):
            selected = prepare.recover_release(fixture.root, inputs, fixture.captured)
            self.assertEqual(selected['manifestSha256'], completion['manifestSha256'])
            self.assertEqual(prepare.recover_release(fixture.root, inputs, fixture.captured), selected)
        with self.assertRaisesRegex(ValueError, 'fixed inputs'):
            prepare.recover_release(fixture.root, {**inputs, 'baseSha256': 'wrong'}, fixture.captured)


if __name__ == '__main__': unittest.main()
