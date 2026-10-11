import copy
import concurrent.futures
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
import duckdb
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('coverage_builder', ROOT / 'scripts/build-coverage-maps.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)


def fixture():
    table = {'family':'test','kind':'generation','columns':[['day','DATE']], 'rows':2,
             'members':[{'url':'file','rows':2,'byteSize':10}]}
    policy = {'family':'test','classification':'temporal','schema':[['day','DATE']], 'dimensions':[
        {'id':'day','kind':'date','fields':['day'],'label':'Event day','meaning':'Source event date.'}]}
    measured = {'status':'measured','rows':2,'placedRows':1,'unplacedRows':1,'granularity':'month','buckets':{'2024-01':1}}
    return table, policy, measured


class CoverageGateTest(unittest.TestCase):
    def test_every_published_table_requires_review_and_changed_schema_requires_revalidation(self):
        table, policy, _ = fixture()
        builder.validate_plan({'records':table},{'records':policy})
        with self.assertRaisesRegex(ValueError,'need coverage review'): builder.validate_plan({'records':table,'new':table},{'records':policy})
        changed = {**table,'columns':[['day','VARCHAR']]}
        with self.assertRaisesRegex(ValueError,'schema needs coverage review'): builder.validate_plan({'records':changed},{'records':policy})

    def test_a_scalar_or_overlapping_dimension_cannot_hide_bad_counts(self):
        _, _, measured = fixture()
        builder.validate_counts(measured,2)
        for changes in ({'placedRows':2},{'buckets':{'2024-13':1}},{'status':'unknown'},
                        {'matchedRows':2,'unmatchedRows':1},{'partialRows':2},
                        {'overlapping':True,'yearBuckets':{'2024':3}},
                        {'notes':'not a list'},
                        {'granularity':'snapshot'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError): builder.validate_counts({**measured,**changes},2)

    def test_duplicate_coverage_policies_cannot_compete_for_one_table(self):
        _,policy,_=fixture()
        with tempfile.TemporaryDirectory() as folder:
            for name in ('congress','fec'):
                pathlib.Path(folder,name+'.json').write_text(json.dumps({'format':'spicygov-coverage-definitions','version':1,'tables':{'records':policy}}))
            with self.assertRaisesRegex(ValueError,'Duplicate'): builder.definitions(pathlib.Path(folder))

    def test_snapshot_facts_require_real_calculation_times_and_readable_values(self):
        _, _, measured = fixture()
        snapshot = {**measured, 'granularity':'snapshot', 'buckets':{}, 'placedRows':2, 'unplacedRows':0,
                    'snapshot':{'publishedAt':'2026-10-03T21:53:09Z', 'asOf':'2026-10-03T21:53:05.434554+00:00',
                                'facts':[{'label':'Comparison measure','value':'Monthly average across the comparison window'}]}}
        builder.validate_counts(snapshot,2)
        for change in ({'asOf':'2026-10-03'},{'asOf':'2026-02-31T21:53:05Z'},
                       {'asOf':'0000-10-03T21:53:05Z'},{'asOf':'2026-10-03T21:53:05+00:60'},{'facts':'facts'},
                       {'facts':[{'label':'Window','value':None}]},{'facts':[{'label':'','value':'window'}]}):
            invalid=copy.deepcopy(snapshot); invalid['snapshot'].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError): builder.validate_counts(invalid,2)

    def test_implementation_changes_force_recount_even_for_identical_published_bytes(self):
        table,policy,measured=fixture()
        original = {**builder.binding(table,policy),'status':'measured','measurementRevision':'sha256:'+'0'*64,
                    'dimensions':[{**measured,'id':'day','definitionDigest':builder.definition_digest(policy['dimensions'][0])}]}
        self.assertFalse(builder.cached(table,policy,original))

    def test_scan_table_counts_typed_instants_in_utc_and_preserves_literal_source_dates(self):
        connect = duckdb.connect
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder, 'records.parquet')
            with connect() as writer:
                writer.execute("CREATE TABLE records(instant TIMESTAMPTZ, source_date VARCHAR)")
                writer.executemany("INSERT INTO records VALUES (?, ?)", [
                    ('2026-03-01T00:15:00Z', '2026-03-01T00:15:00+14:00'),
                    ('2026-01-01T00:15:00Z', '2026-01-01T00:15:00+14:00'),
                    ('2026-01-31T23:45:00Z', '2026-01-31T23:45:00-12:00'),
                    ('2025-12-31T23:45:00Z', '2025-12-31T23:45:00-12:00'),
                    (None, None),
                ])
                writer.execute('COPY records TO ? (FORMAT PARQUET)', [str(path)])
            columns = [['instant', 'TIMESTAMP WITH TIME ZONE'], ['source_date', 'VARCHAR']]
            table = {'family': 'test', 'kind': 'generation', 'columns': columns, 'rows': 5,
                     'publishedAt': '2026-02-01T00:00:00Z',
                     'members': [{'url': str(path), 'rows': 5, 'byteSize': path.stat().st_size}]}
            policy = {'family': 'test', 'classification': 'record-dates', 'schema': columns,
                      '_scanner': 'regulation', 'dimensions': [
                {'id': 'instants', 'kind': 'date', 'fields': ['instant'],
                 'label': 'Event instants', 'meaning': 'Stored UTC event instants.'},
                {'id': 'literal-dates', 'kind': 'date', 'fields': ['source_date'],
                 'label': 'Source dates', 'meaning': 'Calendar dates stated in source text.'},
                {'id': 'activity', 'kind': 'date', 'fields': ['instant'],
                 'label': 'Activity instants', 'meaning': 'Stored UTC activity instants.',
                 'special': 'literal-date-anomalies'},
            ]}
            expected = {'2025-12': 1, '2026-01': 2, '2026-03': 1}
            for zone in ('UTC', 'America/Los_Angeles', 'Asia/Tokyo'):
                def connect_in_zone(*args, **kwargs):
                    conn = connect(*args, **kwargs)
                    conn.execute('SET TimeZone = ?', [zone])
                    return conn
                with self.subTest(initial_zone=zone), \
                     mock.patch.object(builder.duckdb, 'connect', side_effect=connect_in_zone):
                    result = builder.scan_table('records', table, policy)
                    dimensions = {d['id']: d for d in result['dimensions']}
                    for id in ('instants', 'literal-dates'):
                        self.assertEqual(dimensions[id]['buckets'], expected)
                        self.assertEqual(dimensions[id]['placedRows'], 4)
                        self.assertEqual(dimensions[id]['unplacedRows'], 1)
                    activity = dimensions['activity']
                    self.assertEqual(activity['buckets'], {'2025-12': 1, '2026-01': 2})
                    self.assertEqual(activity['placedRows'], 3)
                    self.assertEqual(activity['unplacedRows'], 2)
                    self.assertEqual(activity['activityBoundary'], {'month': '2026-02', 'basis': 'publication-month'})
                    self.assertEqual(activity['anomalies']['futureActivityBuckets'], {'2026-03': 1})

    def test_policy_edit_during_scanning_preserves_the_published_inventory(self):
        table, policy, measured = fixture()
        changed = copy.deepcopy(policy)
        changed['dimensions'][0]['meaning'] = 'Corrected source meaning.'
        result = {'measurementRevision':'fixed', 'dimensions':[measured]}
        with tempfile.TemporaryDirectory() as folder:
            output = pathlib.Path(folder, 'published.json')
            original = '{"tables":{}}\n'
            output.write_text(original)
            with mock.patch.object(sys, 'argv', ['builder', '--output', str(output)]), \
                 mock.patch.object(builder, 'CACHE', pathlib.Path(folder, 'cache')), \
                 mock.patch.object(builder.duckdb, 'connect'), \
                 mock.patch.object(builder, 'load', return_value=({}, {'records':table})), \
                 mock.patch.object(builder, 'definitions', side_effect=[{'records':policy}, {'records':changed}]), \
                 mock.patch.object(builder, 'measurement_revision', return_value='fixed'), \
                 mock.patch.object(builder, 'timed_scan', return_value=('records', result)), \
                 mock.patch.object(builder.subprocess, 'run') as publish:
                with self.assertRaisesRegex(ValueError, 'definitions changed'):
                    builder.main()
                publish.assert_not_called()
            self.assertEqual(output.read_text(), original)

    def test_publication_time_and_paired_input_changes_refuse_cached_measurements(self):
        table, policy, measured = fixture()
        table['publishedAt'] = '2026-01-31T00:00:00Z'
        table['coverageInputs'] = [{'id':'comments_index','url':'index','rows':1,'byteSize':10,'sha256':'a'*64,'etag':'first'}]
        original = {**builder.binding(table,policy), 'status':'measured','measurementRevision':'fixed',
                    'dimensions':[{**measured,'id':'day','definitionDigest':builder.definition_digest(policy['dimensions'][0])}]}
        with mock.patch.object(builder, 'measurement_revision', return_value='fixed'), mock.patch.object(builder, 'header_matches'):
            self.assertTrue(builder.cached(table, policy, original))
            moved = {**table, 'publishedAt':'2026-02-28T00:00:00Z'}
            self.assertFalse(builder.cached(moved, policy, original))
            paired = copy.deepcopy(table); paired['coverageInputs'][0]['sha256'] = 'b'*64
            self.assertFalse(builder.cached(paired, policy, original))

    def test_later_member_schema_drift_cannot_hide_behind_the_first_member(self):
        with tempfile.TemporaryDirectory() as folder:
            conn = duckdb.connect()
            a,b = (str(pathlib.Path(folder,name+'.parquet')) for name in ('a','b'))
            conn.execute("CREATE TABLE good(day DATE, uncovered INTEGER); INSERT INTO good VALUES ('2024-01-01',1)")
            conn.execute("CREATE TABLE bad(day DATE, uncovered VARCHAR, extra DATE); INSERT INTO bad VALUES ('2024-02-01','x',NULL)")
            conn.execute('COPY good TO ? (FORMAT PARQUET)',[a]); conn.execute('COPY bad TO ? (FORMAT PARQUET)',[b])
            expected = [['day','DATE'],['uncovered','INTEGER']]
            observed = [[r[0],r[1]] for r in conn.execute('DESCRIBE SELECT * FROM read_parquet(?)',[[a,b]]).fetchall()]
            self.assertEqual(observed, expected)
            with self.assertRaisesRegex(ValueError, 'member schema'):
                builder.validate_members(conn,'records',{'members':[{'url':a,'rows':1},{'url':b,'rows':1}]},expected)
            conn.close()

    def test_individual_member_counts_must_match_even_when_total_rows_match(self):
        with tempfile.TemporaryDirectory() as folder:
            conn = duckdb.connect()
            a,b = (str(pathlib.Path(folder,name+'.parquet')) for name in ('a','b'))
            conn.execute('CREATE TABLE empty(day DATE)')
            conn.execute("CREATE TABLE populated(day DATE); INSERT INTO populated VALUES ('2024-01-01'),('2024-02-01')")
            conn.execute('COPY empty TO ? (FORMAT PARQUET)',[a]); conn.execute('COPY populated TO ? (FORMAT PARQUET)',[b])
            self.assertEqual(conn.execute('SELECT count(*) FROM read_parquet(?)',[[a,b]]).fetchone()[0],2)
            with self.assertRaisesRegex(ValueError, 'member row count'):
                builder.validate_members(conn,'records',{'members':[{'url':a,'rows':1},{'url':b,'rows':1}]},[['day','DATE']])
            conn.close()

    def test_review_evidence_and_executable_definitions_account_for_identical_table_sets(self):
        for path in (ROOT/'content/coverage-definitions').glob('*.json'):
            document=json.loads(path.read_text())
            reviewed=json.loads((ROOT/'content/coverage-reviews'/path.name).read_text())
            expected={table['tableId']:table for table in reviewed['tables']}
            self.assertEqual(set(document['tables']),set(expected))
            for id, policy in document['tables'].items(): self.assertEqual(policy['schema'],expected[id]['schema'])

    def test_parallel_readers_cannot_remove_each_others_spill_files(self):
        ready = threading.Barrier(2)
        first_finished = threading.Event()
        with tempfile.TemporaryDirectory() as shared:
            directories = []
            def reader(command, **options):
                id = json.loads(options['input'])['id']
                directory = pathlib.Path(options.get('cwd', shared))
                directories.append(directory)
                scratch = directory / '.tmp'
                scratch.mkdir(exist_ok=True)
                spill = scratch / 'duckdb_temp_storage_DEFAULT-0.tmp'
                spill.write_bytes(b'active reader data')
                ready.wait(timeout=5)
                if id == 'first':
                    spill.unlink()
                    first_finished.set()
                else:
                    self.assertTrue(first_finished.wait(timeout=5))
                    self.assertTrue(spill.exists(), 'The first reader removed the second reader\'s active spill file')
                return mock.Mock(stdout=json.dumps({'reader': id}), stderr='')
            with mock.patch.object(builder, 'cached', return_value=False), \
                 mock.patch.object(builder.subprocess, 'run', side_effect=reader), \
                 concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(builder.timed_scan, (id, {}, {}, None)) for id in ('first', 'second')]
                self.assertEqual([future.result()[0] for future in futures], ['first', 'second'])
            self.assertEqual(len(set(directories)), 2)
            self.assertTrue(all(not directory.exists() for directory in directories))

    def test_heavy_native_readers_queue_without_blocking_cached_results(self):
        for second_id in ('court_opinions', 'fr_docket_links', 'comment_periods', 'rule_targets'):
            with self.subTest(second_id=second_id):
                started, release, second_started = (threading.Event() for _ in range(3))
                def reader(command, **options):
                    id = json.loads(options['input'])['id']
                    self.assertEqual(options['timeout'], 2700 if id == 'court_opinions' else 900)
                    if id == 'federal_register':
                        started.set()
                        self.assertTrue(release.wait(timeout=5))
                    else:
                        second_started.set()
                    return mock.Mock(stdout=json.dumps({'reader': id}), stderr='')
                policy = {'_additionalNativeProcessing': True}
                with mock.patch.object(builder, 'cached', side_effect=lambda table, policy, old: old == 'cached'), \
                     mock.patch.object(builder.subprocess, 'run', side_effect=reader), \
                     concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    first = pool.submit(builder.timed_scan, ('federal_register', {}, policy, None))
                    try:
                        self.assertTrue(started.wait(timeout=5))
                        second = pool.submit(builder.timed_scan, (second_id, {}, policy, None))
                        self.assertFalse(second_started.wait(timeout=0.1))
                        self.assertEqual(builder.timed_scan(('documents', {}, policy, 'cached')), ('documents', 'cached'))
                        self.assertEqual(builder.timed_scan(('court_opinions', {}, policy, 'cached')), ('court_opinions', 'cached'))
                    finally:
                        release.set()
                    self.assertEqual(first.result()[0], 'federal_register')
                    self.assertEqual(second.result()[0], second_id)
                    self.assertTrue(second_started.is_set())

    def test_court_outer_allowance_is_limited_to_native_restoration(self):
        cases = (
            ('court_opinions', {'_additionalNativeProcessing': True}, 2700),
            ('court_opinions', {}, 900),
            ('court_dockets', {'_additionalNativeProcessing': True}, 900),
            ('fr_docket_links', {'_additionalNativeProcessing': True}, 900),
            ('comments', {}, 3600),
            ('fec_receipts', {}, 3600),
        )
        for id, policy, expected in cases:
            with self.subTest(id=id, policy=policy), \
                 mock.patch.object(builder, 'cached', return_value=False), \
                 mock.patch.object(builder.subprocess, 'run', return_value=mock.Mock(stdout='{}', stderr='')) as run:
                self.assertEqual(builder.timed_scan((id, {}, policy, None)), (id, {}))
                self.assertEqual(run.call_args.kwargs['timeout'], expected)

    def test_clock_dependent_counts_expire_even_without_future_anomalies(self):
        table, policy, measured = fixture()
        policy['dimensions'][0]['special'] = 'literal-date-anomalies'
        table['_coverageAsOfMonth'] = '2026-10'
        original = {**builder.binding(table, policy), 'status': 'measured', 'measurementRevision': 'fixed',
                    'dimensions': [{**measured, 'id': 'day', 'definitionDigest': builder.definition_digest(policy['dimensions'][0]),
                                    'activityBoundary': {'month': '2026-10', 'basis': 'measurement-month'}}]}
        with mock.patch.object(builder, 'measurement_revision', return_value='fixed'):
            self.assertTrue(builder.cached(table, policy, original))
            self.assertFalse(builder.cached({**table, '_coverageAsOfMonth': '2026-11'}, policy, original))

    def test_timed_out_reader_cleans_up_its_private_spill_directory(self):
        directories = []
        with tempfile.TemporaryDirectory() as shared:
            def timeout(command, **options):
                directory = pathlib.Path(options.get('cwd', shared))
                directories.append(directory)
                (directory / 'spill').write_bytes(b'unfinished reader data')
                raise builder.subprocess.TimeoutExpired(command, options['timeout'])
            with mock.patch.object(builder, 'cached', return_value=False), \
                 mock.patch.object(builder.subprocess, 'run', side_effect=timeout):
                with self.assertRaisesRegex(ValueError, 'time limit'):
                    builder.timed_scan(('records', {}, {}, None))
            self.assertTrue(all(not directory.exists() for directory in directories))


if __name__ == '__main__': unittest.main()
