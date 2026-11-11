import copy
import concurrent.futures
import contextlib
import importlib.util
import io
import hashlib
import json
import pathlib
import os
import signal
import textwrap
import time
import sys
import tempfile
import threading
import unittest
import duckdb
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import coverage_scan
spec = importlib.util.spec_from_file_location('coverage_builder', ROOT / 'scripts/build-coverage-maps.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)


def fixture():
    table = {'family':'test','kind':'generation','columns':[['day','DATE']], 'rows':2,
             'members':[{'url':'file','rows':2,'byteSize':10}]}
    policy = {'family':'test','classification':'temporal','schema':[['day','DATE']], '_scanner':'regulation', 'dimensions':[
        {'id':'day','kind':'date','fields':['day'],'label':'Event day','meaning':'Source event date.'}]}
    measured = {'status':'measured','rows':2,'placedRows':1,'unplacedRows':1,'granularity':'month','buckets':{'2024-01':1}}
    return table, policy, measured


class CoverageGateTest(unittest.TestCase):
    def test_federal_register_coverage_reads_reviewed_published_date_fields(self):
        policy = builder.definitions()['federal_register']
        dates = {'publication_date', 'effective_on', 'comments_close_on', 'signing_date'}
        self.assertEqual({field for dim in policy['dimensions'] for field in dim['fields']}, dates)
        self.assertTrue(dates <= set(dict(policy['schema'])))
        table = {'family':'federal-register', 'kind':'generation', 'columns':policy['schema']}
        selected = {'federal_register': dict(policy)}
        builder.validate_plan({'federal_register':table}, selected)
        self.assertEqual(selected['federal_register']['schema'], policy['schema'])
        with self.assertRaisesRegex(ValueError, 'Published schema needs coverage review'):
            builder.validate_plan({'federal_register':{**table, 'columns':table['columns'][:-1]}},
                                  {'federal_register':dict(policy)})

    def test_latest_day_uses_the_same_eligible_rows_as_month_buckets(self):
        from coverage_dimensions import scan_dimension
        conn = duckdb.connect()
        conn.execute("CREATE TABLE example (day VARCHAR, precision VARCHAR, accepted VARCHAR)")
        conn.execute("INSERT INTO example VALUES ('2024-01-03','day','yes'), ('2024-03-17','day','yes'), ('2024-03-25','month','yes'), ('2025-01-01','day','no'), ('bad','day','yes')")
        dim = {'id':'day', 'kind':'date', 'fields':['day'], 'label':'Date', 'meaning':'Selected dates.',
               'precisionField':'precision', 'conditions':[{'field':'accepted', 'values':['yes']}]}
        result = scan_dimension(conn, [], 5, dim, source_view='example')
        self.assertEqual(result['buckets'], {'2024-01':1, '2024-03':1})
        self.assertEqual(result['latestDate'], '2024-03-17')
        self.assertEqual(result['unplacedRows'], 3)

    def test_published_scan_reuses_exact_cached_bytes_without_rebinding_the_map(self):
        table,policy,_=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder); source=root/'source.parquet'; conn=duckdb.connect()
            conn.execute('COPY (SELECT DATE \'2024-01-01\' AS "day" UNION ALL SELECT NULL) TO ? (FORMAT PARQUET)',[str(source)])
            raw=source.read_bytes(); digest='sha256:'+hashlib.sha256(raw).hexdigest()
            cached=root/'members'/digest[7:]/'records.parquet';cached.parent.mkdir(parents=True);cached.write_bytes(raw)
            table.update(artifactDigest='sha256:'+'a'*64,members=[{'key':'records.parquet','url':'https://invalid.test/records.parquet','sha256':digest,'rows':2,'byteSize':len(raw)}])
            before=copy.deepcopy(table)
            with mock.patch.dict('os.environ',{'SPICYGOV_NATIVE_COVERAGE_CACHE':str(root)}), mock.patch.object(coverage_scan,'_connect',return_value=conn):
                result=coverage_scan.scan_table('records',table,policy)
                self.assertEqual(result['fingerprint'],builder.binding(table,policy)['fingerprint'])
                self.assertEqual(result['dimensions'][0]['buckets'],{'2024-01':1})
                self.assertEqual(result['dimensions'][0]['unplacedRows'],1)
                self.assertEqual(table,before)
                cached.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError,'differs from its publication'):
                    coverage_scan.cached_published_members(table)

    def test_current_comparison_is_bound_even_when_denominator_is_not_remeasured(self):
        table, policy, measured=fixture()
        policy['dimensions'][0]['comparisonTable']='congress_bills'
        bills={**table,'family':'bill-family','rows':10}
        policies={'records':policy}
        builder.validate_plan({'records':table},policies,{'records':table,'congress_bills':bills})
        self.assertEqual(policies['records']['dimensions'][0]['comparison'],bills)
        self.assertNotIn('comparison',policy['dimensions'][0])
        first=builder.binding(table,policies['records'])['definitionDigest']
        builder.validate_plan({'records':table},policies,{'records':table,'congress_bills':{**bills,'rows':11}})
        self.assertNotEqual(builder.binding(table,policies['records'])['definitionDigest'],first)

    def test_selected_refresh_does_not_require_definitions_for_unselected_new_tables(self):
        import coverage_release
        table, policy, measured = fixture()
        retained = {'format': 'spicygov-coverage-maps', 'version': 1, 'partial': False,
                    'tables': {'earlier': {'note': 'keep this exact earlier measurement'}},
                    'measurementStates': {'earlier': 'held', 'records': 'unavailable'}}
        result = {'measurementRevision': 'fixed', 'dimensions': [measured]}
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder); base = root/'base.json'; output = root/'map.json'
            base.write_text(json.dumps(retained))
            argv = ['builder', '--only', 'records', '--refresh-from', str(base),
                    '--base-sha256', coverage_release.sha(base.read_bytes()),
                    '--output', str(output), '--release-output', str(root/'release')]
            capture = ({'records': table, 'new_unreviewed_table': table}, {'publication.v2.json': b'fixed'})
            with mock.patch.object(sys, 'argv', argv), \
                 mock.patch.object(builder, 'CACHE', root/'cache'), \
                 mock.patch.object(builder.duckdb, 'connect'), \
                 mock.patch.object(builder, 'definitions', return_value={'records': policy}), \
                 mock.patch.object(builder, 'measurement_revision', return_value='fixed'), \
                 mock.patch.object(builder, 'timed_scan', return_value=('records', result)) as scan, \
                 mock.patch.object(builder.subprocess, 'run'), \
                 mock.patch.object(coverage_release, 'capture_load', return_value=capture), \
                 mock.patch.object(coverage_release, 'complete', return_value={}) as complete:
                builder.main()
                self.assertEqual(scan.call_count, 1)
                self.assertEqual(set(complete.call_args.args[4]), {'records'})
                self.assertEqual(complete.call_args.kwargs['base_bytes'], base.read_bytes())
                self.assertEqual(json.loads(output.read_bytes())['tables'], retained['tables'] | {'records': result})
                self.assertEqual(json.loads(output.read_bytes())['measurementStates'], {'earlier': 'held'})

    def test_full_builder_owns_release_completion_and_refuses_failure_or_changed_capture(self):
        import coverage_release
        table,policy,measured=fixture()
        for failure in ('none','scan','capture','partial'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root=pathlib.Path(folder);output=root/'map.json';release=root/'release'
                output.write_text('{"tables":{}}')
                argv=['builder','--output',str(output),'--release-output',str(release)]
                if failure=='partial':argv+=['--only','records']
                result={'measurementRevision':'fixed','dimensions':[measured]}
                captures=[({'records':table},{'publication.v2.json':b'original'}),
                          ({'records':table},{'publication.v2.json':b'changed' if failure=='capture' else b'original'})]
                with mock.patch.object(sys,'argv',argv), \
                     mock.patch.object(builder,'CACHE',root/'cache'), \
                     mock.patch.object(builder.duckdb,'connect'), \
                     mock.patch.object(builder,'definitions',return_value={'records':policy}), \
                     mock.patch.object(builder,'measurement_revision',return_value='fixed'), \
                     mock.patch.object(builder,'timed_scan',side_effect=ValueError('scan refused') if failure=='scan' else None,return_value=('records',result)), \
                     mock.patch.object(builder.subprocess,'run'), \
                     mock.patch.object(coverage_release,'capture_load',side_effect=captures), \
                     mock.patch.object(coverage_release,'complete',return_value={'manifestSha256':'fixture'}) as complete:
                    if failure=='none':
                        builder.main();complete.assert_called_once()
                        self.assertEqual(complete.call_args.args[3],{'publication.v2.json':b'original'})
                    else:
                        with self.assertRaises(ValueError):builder.main()
                        complete.assert_not_called()

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
        with mock.patch.object(builder, 'measurement_revision', return_value='fixed'), mock.patch.object(coverage_scan, 'header_matches'):
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
                coverage_scan.validate_members(conn,'records',{'members':[{'url':a,'rows':1},{'url':b,'rows':1}]},expected)
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
                coverage_scan.validate_members(conn,'records',{'members':[{'url':a,'rows':1},{'url':b,'rows':1}]},[['day','DATE']])
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
            def reader(**options):
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
                 mock.patch.object(builder, '_scan_process', side_effect=reader), \
                 concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(builder.timed_scan, (id, {}, {}, None)) for id in ('first', 'second')]
                self.assertEqual([future.result()[0] for future in futures], ['first', 'second'])
            self.assertEqual(len(set(directories)), 2)
            self.assertTrue(all(not directory.exists() for directory in directories))

    def test_large_published_tables_have_their_own_finite_allowance(self):
        cases = (('court_opinions', 2700), ('documents', 1500), ('federal_register', 1500),
                 ('comments', 7200), ('fec_receipts', 3600), ('court_dockets', 900), ('records', 900))
        for id, expected in cases:
            with self.subTest(id=id), \
                 mock.patch.object(builder, 'cached', return_value=False), \
                 mock.patch.object(builder, '_scan_process', return_value=mock.Mock(stdout='{}', stderr='')) as run:
                self.assertEqual(builder.timed_scan((id, {}, {}, None)), (id, {}))
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

    def test_scan_child_receives_only_the_table_and_its_reviewed_policy(self):
        with mock.patch.object(builder, 'cached', return_value=False), \
             mock.patch.object(builder, '_scan_process', return_value=mock.Mock(stdout='{}', stderr='')) as run:
            builder.timed_scan(('records', {'rows': 1}, {'schema': []}, None))
        self.assertEqual(json.loads(run.call_args.kwargs['input']),
                         {'id': 'records', 'table': {'rows': 1}, 'policy': {'schema': []}})

    def test_timed_out_reader_cleans_up_its_private_spill_directory(self):
        directories = []
        with tempfile.TemporaryDirectory() as shared:
            def timeout(**options):
                directory = pathlib.Path(options.get('cwd', shared))
                directories.append(directory)
                (directory / 'spill').write_bytes(b'unfinished reader data')
                raise builder.subprocess.TimeoutExpired(['scan'], options['timeout'])
            with mock.patch.object(builder, 'cached', return_value=False), \
                 mock.patch.object(builder, '_scan_process', side_effect=timeout):
                with self.assertRaisesRegex(ValueError, 'time limit'):
                    builder.timed_scan(('records', {}, {}, None))
            self.assertTrue(all(not directory.exists() for directory in directories))




class ScanOwnerTests(unittest.TestCase):
    def test_actual_scan_owner_bounds_nested_processes_and_private_temp(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            helper = root / 'scan.py'
            helper.write_text(textwrap.dedent('''\
                import json, os, subprocess, sys, tempfile, time
                from pathlib import Path
                if '--nested' in sys.argv:
                    mode, state = sys.argv[-2:]
                    with tempfile.TemporaryDirectory(prefix='nested-admission-') as private:
                        (Path(private) / 'private.db').write_bytes(b'tiny admission fixture')
                        Path(state).write_text(json.dumps({
                            'pid': os.getpid(), 'group': os.getpgrp(),
                            'private': private, 'workdir': os.getcwd()}))
                        print('nested reader diagnostic', file=sys.stderr, flush=True)
                        if mode != 'success':
                            time.sleep(30)
                else:
                    request = json.load(sys.stdin)
                    child = subprocess.Popen([
                        sys.executable, __file__, '--nested', request['mode'], request['state']],
                        stdout=subprocess.DEVNULL if request['mode'] == 'failure' else None,
                        stderr=subprocess.DEVNULL if request['mode'] == 'failure' else None)
                    while not Path(request['state']).exists():
                        time.sleep(0.01)
                    if request['mode'] == 'failure':
                        print('source refused', file=sys.stderr, flush=True)
                        sys.exit(4)
                    child.wait()
                    print(json.dumps({'done': True}))
                '''))
            for mode in ('success', 'failure', 'timeout'):
                with self.subTest(mode=mode):
                    state_path = root / (mode + '.json')
                    request = {'mode': mode, 'state': str(state_path)}
                    try:
                        with mock.patch.object(builder, '__file__', str(helper)):
                            if mode == 'success':
                                self.assertEqual(builder._run_scan(
                                    request, timeout_seconds=2, label='tiny'), {'done': True})
                            else:
                                with self.assertRaisesRegex(ValueError, 'source refused|time limit') as refused:
                                    builder._run_scan(request, timeout_seconds=2, label='tiny')
                                self.assertIn('source refused' if mode == 'failure' else 'nested reader diagnostic',
                                              refused.exception.__cause__.stderr)
                                if mode == 'failure':
                                    self.assertIsInstance(refused.exception.__cause__, builder.subprocess.CalledProcessError)
                        state = json.loads(state_path.read_text())
                        self.assertTrue(pathlib.Path(state['private']).resolve().is_relative_to(
                            pathlib.Path(state['workdir']).resolve()))
                        self.assertFalse(pathlib.Path(state['workdir']).exists())
                        self.assertFalse(pathlib.Path(state['private']).exists())
                        deadline = time.monotonic() + 2
                        while True:
                            try:
                                os.kill(state['pid'], 0)
                            except ProcessLookupError:
                                break
                            if time.monotonic() >= deadline:
                                self.fail('Nested scan survived its owner')
                            time.sleep(0.01)
                        self.assertTrue(helper.exists(), 'Cleanup reached outside scan scratch')
                    finally:
                        # Keep an unexpected regression from leaving the tiny probe running.
                        if state_path.exists():
                            try:
                                os.killpg(json.loads(state_path.read_text())['group'], signal.SIGKILL)
                            except ProcessLookupError:
                                pass


if __name__ == '__main__':
    unittest.main()
