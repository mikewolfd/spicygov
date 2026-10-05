"""Coverage remains truthful at supplementary publication and date boundaries."""
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from coverage_dimensions import scan_dimension, validate_definition
from regulation_coverage import scan_special, snapshot_parent, flag_future
from coverage_inputs import inherit_unique
from publication_census import BASE


class Inputs:
    def __init__(self, files): self.files = files
    def fetch(self, key): return self.files[key]


class RegulationCoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        self.conn = duckdb.connect()
    def tearDown(self):
        self.conn.close(); self.directory.cleanup()
    def parquet(self, name, sql):
        file = self.root / name
        self.conn.execute(f"COPY ({sql}) TO '{file}' (FORMAT PARQUET)")
        return str(file)
    def dimension(self, marker, fields, kind='date'):
        dim = {'id': marker, 'kind': kind, 'label': 'Coverage', 'meaning': 'Explicit source scope.',
               'fields': fields, 'special': marker}
        if marker=='discovery-snapshot-facts':dim['reviewedImplementation']='reviewed-calculation'
        return dim

    def test_future_activity_and_partial_dates_do_not_become_present_history(self):
        file = self.parquet('dates.parquet', "SELECT * FROM (VALUES ('2020-01-01'),('4018-04-11'),(NULL),('2007'),('2020-02')) t(postmark_date)")
        result = scan_special(self.conn, 'comment_attributes', {'members': [{'url': file}], 'rows': 5,
                              'publishedAt': '2026-10-03T00:00:00Z'},
                              self.dimension('literal-date-anomalies', ['postmark_date']), Inputs({}))
        self.assertEqual(result['buckets'], {'2020-01': 1})
        self.assertEqual((result['placedRows'], result['unplacedRows']), (1, 4))
        self.assertEqual(result['anomalies']['futureActivityBuckets'], {'4018-04': 1})
        # Explicit scheduled endpoints remain dates when no anomaly policy applies.
        scheduled = scan_dimension(self.conn, [file], 5, {'id': 'expiry', 'kind': 'date', 'fields': ['postmark_date'],
                                                       'label': 'Expiry', 'meaning': 'Stated scheduled endpoints.'})
        self.assertIn('4018-04', scheduled['buckets'])

    def test_future_filter_refuses_overlapping_year_totals(self):
        result = {'overlapping': True, 'rows': 1, 'placedRows': 1, 'unplacedRows': 0,
                  'buckets': {'2020-01': 1, '2020-02': 1, '4018-01': 1},
                  'yearBuckets': {'2020': 1, '4018': 1}}
        with self.assertRaisesRegex(ValueError, 'overlapping'):
            flag_future(result, {'kind': 'list'}, {'publishedAt': '2026-10-03T00:00:00Z'})
        self.assertEqual(result['yearBuckets'], {'2020': 1, '4018': 1})

    def test_explicit_activity_month_controls_filter_and_is_recorded(self):
        result = {'rows': 3, 'placedRows': 3, 'unplacedRows': 0,
                  'buckets': {'2020-01': 1, '2020-02': 1, '2020-03': 1}}
        measured = flag_future(result, {'kind': 'date'}, {'_coverageAsOfMonth': '2020-02'})
        self.assertEqual(measured['buckets'], {'2020-01': 1, '2020-02': 1})
        self.assertEqual((measured['placedRows'], measured['unplacedRows']), (2, 1))
        self.assertEqual(measured['activityBoundary'], {'month': '2020-02', 'basis': 'measurement-month'})
        self.assertEqual(measured['anomalies']['boundaryMonth'], '2020-02')

    def test_activity_boundary_is_present_without_future_anomalies(self):
        for table, expected in [
                ({'_coverageAsOfMonth': '2020-02'}, {'month': '2020-02', 'basis': 'measurement-month'}),
                ({'publishedAt': '2020-01-31T23:30:00-02:00'}, {'month': '2020-02', 'basis': 'publication-month'})]:
            with self.subTest(table=table):
                result = {'rows': 1, 'placedRows': 1, 'unplacedRows': 0, 'buckets': {'2020-01': 1}}
                measured = flag_future(result, {'kind': 'date'}, table)
                self.assertEqual(measured['activityBoundary'], expected)
                self.assertNotIn('anomalies', measured)
                self.assertEqual(measured['buckets'], {'2020-01': 1})

    def test_malformed_publication_or_explicit_month_cannot_fall_back_to_clock(self):
        for table in [{'publishedAt': value} for value in [
                '', '2026-10', '2026-02-30T00:00:00Z', '2026-10-03T00:00:00',
                '2026-10-03T00:00:00+00:60', '2026-10-03T00:00:00+24:00']] + [
                {'_coverageAsOfMonth': value} for value in ['2026-0', '2026-13', '0000-01', 202610]]:
            with self.subTest(table=table), self.assertRaises(ValueError):
                flag_future({'rows': 0, 'placedRows': 0, 'unplacedRows': 0, 'buckets': {}},
                            {'kind': 'date'}, table)

    def test_unpinned_activity_month_uses_utc_clock(self):
        import datetime
        stamp = datetime.datetime(2026, 11, 1, 0, 30, tzinfo=datetime.timezone.utc)
        with patch('regulation_coverage.datetime.datetime') as clock:
            clock.now.return_value = stamp
            measured = flag_future({'rows': 0, 'placedRows': 0, 'unplacedRows': 0, 'buckets': {}},
                                   {'kind': 'date'}, {})
            self.assertEqual(measured['activityBoundary'], {'month': '2026-11', 'basis': 'measurement-month'})
            clock.now.assert_called_once_with(datetime.timezone.utc)

    def test_native_timetable_keeps_all_milestones_precision_and_unresolved_literals(self):
        rows = [
            [{'action': 'NPRM', 'date': '01/01/2020'}, {'action': 'Comments', 'date': '01/12/2020'},
             {'action': 'Final', 'date': '03/02/2020'}, {'action': 'Planned final', 'date': '07/00/2027'}],
            [{'action': 'Later', 'date': 'To Be Determined', 'fr_citation': '90 FR 42'},
             {'action': 'Planned', 'date': '02/00/2021'}, {'action': 'Final', 'date': '12/01/2021'}],
            [{'action': 'Bad day', 'date': '02/30/2024'}, {'action': 'Bad month', 'date': '00/00/2024'}], [],
            [{'action': 'Early', 'date': '11/00/0003'}, {'action': 'Late', 'date': '12/01/9999'}]]
        self.conn.execute('CREATE TABLE agenda(timetable_json VARCHAR)')
        self.conn.executemany('INSERT INTO agenda VALUES (?)', [(json.dumps(r),) for r in rows])
        file = self.root / 'agenda.parquet'; self.conn.execute(f"COPY agenda TO '{file}' (FORMAT PARQUET)")
        table = {'rows': 5, 'members': [{'url': str(file)}]}
        result = scan_special(self.conn, 'unified_agenda', table,
                              self.dimension('agenda-timetable-months', ['timetable_json'], 'list'), Inputs({}))
        self.assertEqual(result['buckets'], {'0003-11': 1, '2020-01': 1, '2020-03': 1,
                                            '2021-02': 1, '2021-12': 1, '2027-07': 1, '9999-12': 1})
        self.assertEqual(result['yearBuckets'], {'0003': 1, '2020': 1, '2021': 1, '2027': 1, '9999': 1})
        self.assertEqual((result['placedRows'], result['unplacedRows'], result['partialRows']), (3, 2, 1))
        self.assertEqual(result['evidence']['milestoneEntriesByPrecision'], {'day': 5, 'month': 3, 'undated': 1, 'invalid': 2})
        self.assertEqual(result['anomalies']['sourceLiteralReviewRows'], 1)
        precision = scan_special(self.conn, 'unified_agenda', table,
                                 self.dimension('agenda-timetable-precision', ['timetable_json'], 'category'), Inputs({}))
        self.assertEqual(precision['buckets'], {'["day"]': 3, '["empty timetable"]': 1,
                                               '["invalid"]': 1, '["month"]': 3, '["undated"]': 1})
        unresolved = scan_special(self.conn, 'unified_agenda', table,
                                  self.dimension('agenda-timetable-unresolved', ['timetable_json'], 'category'), Inputs({}))
        labels = [json.loads(k) for k in unresolved['buckets']]
        self.assertIn({'action': 'Later', 'date': 'To Be Determined', 'fr_citation': '90 FR 42', 'precision': 'undated'}, labels)
        self.assertEqual((unresolved['placedRows'], unresolved['unplacedRows']), (2, 3))
        with self.assertRaisesRegex(ValueError, 'publication'):
            scan_special(self.conn, 'unified_agenda', {**table, 'rows': 6},
                         self.dimension('agenda-timetable-months', ['timetable_json'], 'list'), Inputs({}))

    def test_questionable_literal_years_are_disclosed_without_removing_schedules(self):
        file = self.parquet('schedules.parquet', "SELECT * FROM (VALUES ('1753-01-01'),('2032-10-10'),('3017-11-13')) t(closing)")
        result = scan_special(self.conn, 'comment_periods', {'rows': 3, 'members': [{'url': file}]},
                              self.dimension('source-date-literals', ['closing']), Inputs({}))
        self.assertEqual(result['buckets'], {'1753-01': 1, '2032-10': 1, '3017-11': 1})
        self.assertEqual((result['placedRows'], result['unplacedRows']), (3, 0))
        self.assertEqual(result['anomalies']['sourceLiteralReviewBuckets'], {'1753-01': 1, '3017-11': 1})
        self.assertIn('not corrected', result['notes'][0])

    def test_partition_directory_does_not_override_stored_event_values(self):
        folder = self.root / 'stage_events_json=[]'; folder.mkdir()
        file = folder / 'events.parquet'
        data = json.dumps([{'effective_date': '2020-01-01', 'source': 'federal_register.document_type'}])
        self.conn.execute('CREATE TABLE partition_events(stage_events_json VARCHAR)')
        self.conn.execute('INSERT INTO partition_events VALUES (?)', [data])
        self.conn.execute(f"COPY partition_events TO '{file}' (FORMAT PARQUET)")
        result = scan_special(self.conn, 'proceedings', {'rows': 1, 'members': [{'url': str(file)}]},
                             self.dimension('proceeding-stage-events', ['stage_events_json'], 'list'), Inputs({}))
        self.assertEqual(result['buckets'], {'2020-01': 1})
        self.assertEqual(result['yearBuckets'], {'2020': 1})

    def test_native_proceeding_events_count_each_row_once_per_month(self):
        values = [json.dumps([{'effective_date': '2020-01-01', 'source': 'federal_register.document_type'},
                              {'effective_date': '2020-01-12', 'source': 'federal_register.document_type'},
                              {'effective_date': '2020-02-01', 'source': 'regulations_gov.document_type'}]),
                  json.dumps([{'effective_date': None, 'source': 'regulations_gov.document_type'}]), '[]',
                  json.dumps([{'effective_date': '2021-03-01'}, {'effective_date': '2021'}])]
        self.conn.execute('CREATE TABLE stages(stage_events_json VARCHAR)')
        self.conn.executemany('INSERT INTO stages VALUES (?)', [(v,) for v in values])
        file = self.root / 'stages.parquet'; self.conn.execute(f"COPY stages TO '{file}' (FORMAT PARQUET)")
        result = scan_special(self.conn, 'proceedings', {'members': [{'url': str(file)}], 'rows': 4},
                              self.dimension('proceeding-stage-events', ['stage_events_json'], 'list'), Inputs({}))
        self.assertEqual(result['buckets'], {'2020-01': 1, '2020-02': 1, '2021-03': 1})
        self.assertEqual((result['placedRows'], result['unplacedRows'], result['partialRows']), (2, 2, 1))
        self.assertTrue(result['overlapping'])
        self.assertEqual(result['yearBuckets'], {'2020': 1, '2021': 1})
        with self.assertRaisesRegex(ValueError, 'publication'):
            scan_special(self.conn, 'proceedings', {'members': [{'url': str(file)}], 'rows': 5},
                         self.dimension('proceeding-stage-events', ['stage_events_json'], 'list'), Inputs({}))

    def paired_comments(self):
        file = self.parquet('index.parquet', 'SELECT * FROM (VALUES (2020,1,10),(2020,1,5),(2021,2,2),(NULL,NULL,3)) t(year,month,row_count)')
        entries = {'comments.parquet': {'sha256': 'a'*64, 'rows': 20, 'bytes': 200, 'etag': 'comments-etag'},
                   'comments_index.parquet': {'sha256': 'b'*64, 'rows': 4, 'bytes': 40, 'etag': 'index-etag'}}
        receipt = {'files': entries}
        tables = {id: {'rows': e['rows'], 'checksum': e['sha256'], 'etag': e['etag'],
                       'members': [{'url': BASE+'/'+id+'.parquet', 'byteSize': e['bytes']}]}
                  for id, e in [(name[:-8], e) for name, e in entries.items()]}
        # Local test uses the exact same projected query via a temporary local read alias.
        original_execute = self.conn.execute
        class Conn:
            def execute(self, sql, args):
                return original_execute(sql, [[file] if value == [BASE+'/comments_index.parquet'] else value for value in args])
        return receipt, tables, Conn()

    def test_comments_weights_are_not_index_group_counts_and_races_refuse(self):
        receipt, tables, conn = self.paired_comments()
        def headers(url):
            e = receipt['files'][url.rsplit('/', 1)[1]]; return e['etag'], e['bytes']
        with patch('regulation_coverage.export_header', side_effect=headers) as header:
            result = scan_special(conn, 'comments', tables['comments'],
                                  self.dimension('comments-index-posted', ['posted_date']),
                                  Inputs({'comments-publication.json': json.dumps(receipt).encode()}))
            self.assertEqual(result['buckets'], {'2020-01': 15, '2021-02': 2})
            self.assertEqual((result['placedRows'], result['unplacedRows'], result['rows']), (17, 3, 20))
            self.assertEqual(header.call_count, 4)
            groups = scan_special(conn, 'comments_index', tables['comments_index'],
                                  self.dimension('comments-index-groups', ['year','month']),
                                  Inputs({'comments-publication.json': json.dumps(receipt).encode()}))
            self.assertEqual(groups['buckets'], {'2020-01': 2, '2021-02': 1})
            self.assertEqual(groups['representedComments']['buckets'], result['buckets'])
        with patch('regulation_coverage.export_header', side_effect=[headers(BASE+'/comments.parquet'),
                   headers(BASE+'/comments_index.parquet'), ('changed-etag', 200)]):
            with self.assertRaisesRegex(ValueError, 'changed'):
                scan_special(conn, 'comments', tables['comments'], self.dimension('comments-index-posted', ['posted_date']),
                             Inputs({'comments-publication.json': json.dumps(receipt).encode()}))
        tables['comments']['checksum'] = 'c'*64
        with self.assertRaisesRegex(ValueError, 'receipt'):
            scan_special(conn, 'comments', tables['comments'], self.dimension('comments-index-posted', ['posted_date']),
                         Inputs({'comments-publication.json': json.dumps(receipt).encode()}))

    def test_supplementary_parent_requires_exact_snapshot_and_file_sha(self):
        file = self.parquet('parent.parquet', "SELECT 'p1' proceeding_id, DATE '2020-01-01' event_date")
        data = pathlib.Path(file).read_bytes(); prefix = 'materialized/rulemaking/snapshots/snapshot_test/'
        table = {'snapshotId': 'snapshot_test', 'recordUrl': BASE+'/'+prefix+'manifest.json', 'checksum': 'a'*64,
                 'rows': 1, 'members': [{'url': BASE+'/'+prefix+'proceedings.parquet', 'byteSize': 50}]}
        manifest = {'format_version': 2, 'dataset': 'rulemaking', 'snapshot_id': 'snapshot_test', 'artifacts': {
            'proceedings.parquet': {'sha256': 'a'*64,'rows':1,'bytes':50,'remote_key':prefix+'proceedings.parquet'},
            'lifecycle_events.parquet': {'sha256': hashlib.sha256(data).hexdigest(), 'rows':1,'bytes':len(data),
                                       'remote_key':prefix+'lifecycle_events.parquet','visibility':'public'}}}
        inputs = Inputs({prefix+'manifest.json': json.dumps(manifest).encode(), prefix+'lifecycle_events.parquet': data})
        with snapshot_parent('proceedings', table, 'lifecycle_events', inputs) as parent:
            self.assertEqual(self.conn.execute('select count(*) from read_parquet(?, hive_partitioning=false)',[parent['urls']]).fetchone()[0], 1)
            retained = parent['urls'][0]
        self.assertFalse(pathlib.Path(retained).exists())
        inputs.files[prefix+'lifecycle_events.parquet'] = b'changed'
        with self.assertRaisesRegex(ValueError, 'SHA'):
            with snapshot_parent('proceedings', table, 'lifecycle_events', inputs): pass
        table['checksum'] = 'c'*64
        with self.assertRaisesRegex(ValueError, 'child'):
            with snapshot_parent('proceedings', table, 'lifecycle_events', inputs): pass

    def test_section_inheritance_refuses_mismatched_source_body_and_duplicate_parents(self):
        child = self.parquet('sections.parquet', "SELECT * FROM (VALUES ('law1','body1'),('law1','wrong'),('missing','body2')) t(law_id,source_sha256)")
        parent_file = self.parquet('laws.parquet', "SELECT 'law1' law_id,'body1' uslm_sha256,'2020-01-01' approved_date")
        parent = {'urls':[parent_file], 'family':'laws','artifactDigest':'sha256:'+'a'*64,'tableId':'laws',
                  'recordUrl':'https://example.invalid/artifact.json','members':[],'rows':1}
        relation = {'keys':[['law_id','law_id'],['source_sha256','uslm_sha256']]}
        dim={'id':'approval','kind':'date','label':'Approval','meaning':'Same captured law body.','fields':['approved_date']}
        result=inherit_unique(self.conn,[child],3,parent,relation,dim)
        self.assertEqual(result['matchedRows'],1);self.assertEqual(result['unmatchedRows'],2)
        self.assertEqual(result['buckets'],{'2020-01':1})
        duplicate=self.parquet('duplicates.parquet',"SELECT * FROM read_parquet('"+parent_file+"', hive_partitioning=false) UNION ALL SELECT * FROM read_parquet('"+parent_file+"', hive_partitioning=false)")
        parent['urls']=[duplicate]; parent['rows']=2
        with self.assertRaisesRegex(ValueError,'unique'):inherit_unique(self.conn,[child],3,parent,relation,dim)

    def discovery_inputs(self):
        key='generations/discovery-signals/'+'a'*64
        metadata={'spicy_regs.discovery_signals.as_of':'2000-03-31 23:45:10.123456+00',
                  'spicy_regs.discovery_signals.timezone':'UTC',
                  'spicy_regs.discovery_signals.date_policy':'source offsets preserved; offset-free values use UTC',
                  'spicy_regs.input.documents.sha256':'sha256:'+'d'*64,
                  'spicy_regs.input.documents.rows':'20'}
        descriptor={'sha256':'sha256:'+'d'*64,'byteSize':77,'rows':20}
        parent={'sha256':descriptor['sha256'],'byteSize':77,'artifactDigest':'sha256:'+'e'*64,'family':'documents'}
        artifact={'producer':{'implementationId':'reviewed-calculation'},'spec':{'parents':{'documents.parquet':parent},'readSnapshot':{'families':{'documents':{
                    'artifactDigest':parent['artifactDigest'],'tables':{'documents.parquet':descriptor}}}}}}
        files={};members=[]
        table={'family':'discovery-signals','artifactDigest':'sha256:'+'a'*64,'recordUrl':BASE+'/'+key+'/artifact.json',
               'publishedAt':'2000-04-01T00:00:00Z','rows':1}
        retained={'family':'documents','artifactDigest':parent['artifactDigest'],'tableId':'documents',
                  'recordUrl':BASE+'/saved-documents/artifact.json','members':[descriptor],'rows':20}
        def write():
            file=self.root/'discovery_signals.parquet'
            values=pa.table({'agency_code':['A'],'recent_30d':[10],'baseline':[2.0],'ratio':[5.0]})
            pq.write_table(values.replace_schema_metadata({k.encode():v.encode() for k,v in metadata.items()}),file)
            data=file.read_bytes();files[key+'/discovery_signals.parquet']=data
            member={'objectKey':'discovery_signals.parquet','role':'table','recordCount':1,'byteSize':len(data),
                    'sha256':'sha256:'+hashlib.sha256(data).hexdigest()}
            members[:]=[member]
        write()
        class DiscoveryInputs:
            def producing(self,*args):return {**table,'artifact':artifact}
            def artifact(self,*args):return key,artifact,members
            def fetch(self,k):return files[k]
            def parent(self,*args):return retained
        return table,DiscoveryInputs(),metadata,write,retained

    def test_discovery_snapshot_exposes_qualified_calculation_windows_not_publication_asof(self):
        table,inputs,metadata,write,parent=self.discovery_inputs()
        dim=self.dimension('discovery-snapshot-facts',[],'snapshot')
        result=scan_special(self.conn,'discovery_signals',table,dim,inputs)
        self.assertEqual(result['snapshot']['asOf'],'2000-03-31T23:45:10.123456+00:00')
        self.assertEqual(result['snapshot']['publishedAt'],table['publishedAt'])
        self.assertEqual(result['evidence']['windows']['baselineStartInclusive'],'1999-02-28T23:45:10.123456+00:00')
        self.assertEqual(result['evidence']['windows']['baselineEndExclusive'],'2000-02-29T23:45:10.123456+00:00')
        self.assertEqual(result['buckets'],{});self.assertEqual(result['granularity'],'snapshot')
        facts=result['snapshot']['facts']
        self.assertIn('Feb 29, 2000 at 23:45 UTC; end excluded',facts[1]['value'])
        self.assertIn('At least 24',facts[3]['value']);self.assertEqual(len(facts),4)

    def test_discovery_metadata_requires_exact_timezone_parent_and_source_count(self):
        for field,value in [('spicy_regs.discovery_signals.timezone','Local'),
                            ('spicy_regs.input.documents.sha256','sha256:'+'f'*64),
                            ('spicy_regs.input.documents.rows','21'),
                            ('spicy_regs.discovery_signals.as_of','2000-03-31 23:45:10+00:60')]:
            with self.subTest(field=field):
                table,inputs,metadata,write,parent=self.discovery_inputs();metadata[field]=value;write()
                with self.assertRaises(ValueError):scan_special(self.conn,'discovery_signals',table,
                                              self.dimension('discovery-snapshot-facts',[],'snapshot'),inputs)
        table,inputs,metadata,write,parent=self.discovery_inputs();parent['rows']=21
        with self.assertRaisesRegex(ValueError,'source count'):scan_special(self.conn,'discovery_signals',table,
                                    self.dimension('discovery-snapshot-facts',[],'snapshot'),inputs)
        table,inputs,metadata,write,parent=self.discovery_inputs()
        dim=self.dimension('discovery-snapshot-facts',[],'snapshot');dim['reviewedImplementation']='unknown-calculation'
        with self.assertRaisesRegex(ValueError,'implementation needs coverage review'):
            scan_special(self.conn,'discovery_signals',table,dim,inputs)

    def test_saved_court_origin_keeps_routes_and_missing_origin_separate(self):
        definitions=json.loads((ROOT/'content/coverage-definitions/regulation.json').read_text())['tables']
        dim=next(d for d in definitions['court_opinion_clusters']['dimensions'] if d['id']=='retained-origins')
        self.assertEqual(dim['fields'], ['ingest_source'])
        file=self.parquet('origins.parquet', "SELECT * FROM (VALUES ('bulk'),('bulk'),('search'),(NULL)) t(ingest_source)")
        result=scan_dimension(self.conn,[file],4,dim)
        self.assertEqual(result['buckets'], {'["bulk"]':2,'["search"]':1})
        self.assertEqual((result['placedRows'],result['unplacedRows']), (3,1))

    def test_saved_text_counts_null_blank_and_nonblank_across_every_group(self):
        file=self.root/'texts.parquet'
        pq.write_table(pa.table({'text_content':[None]*4+['']*4+['x',' \n',None,'y']}),file,row_group_size=4)
        table={'rows':12,'members':[{'url':str(file)}]}
        dim=self.dimension('saved-text-availability',['text_content'],'category')
        result=scan_special(self.conn,'documents',table,dim,Inputs({}))
        self.assertEqual(result['buckets'],{'["no_saved_text"]':5,'["saved_blank_text"]':5,'["saved_nonblank_text"]':2})
        self.assertEqual((result['placedRows'],result['unplacedRows']),(12,0))
        self.assertGreaterEqual(result['evidence']['exactFooterRowGroups'],1)
        self.assertGreaterEqual(result['evidence']['readRowGroups'],1)
        table['rows']=13
        with self.assertRaisesRegex(ValueError,'publication'):scan_special(self.conn,'documents',table,dim,Inputs({}))
        with self.assertRaisesRegex(ValueError,'reviewed'):scan_special(self.conn,'laws',table,dim,Inputs({}))

    def test_saved_text_missing_statistics_reads_all_values(self):
        file=self.root/'text-no-statistics.parquet'
        pq.write_table(pa.table({'comment_text':[None,'','\u2003','saved']}),file,write_statistics=False)
        result=scan_special(self.conn,'comments',{'rows':4,'members':[{'url':str(file)}]},
                            self.dimension('saved-text-availability',['comment_text'],'category'),Inputs({}))
        self.assertEqual(result['buckets'],{'["no_saved_text"]':1,'["saved_blank_text"]':2,'["saved_nonblank_text"]':1})
        self.assertEqual(result['evidence']['readRowGroups'],1)

    def test_saved_text_inexact_equal_bounds_cannot_decide_presence(self):
        file=self.root/'inexact-text.parquet'
        pq.write_table(pa.table({'text_content':['',' \n','A','B']}),file)
        class InexactFooter:
            def execute(self, *args): return self
            def fetchall(self): return [(0,4,'','',0,False,False)]
        result=scan_special(InexactFooter(),'documents',{'rows':4,'members':[{'url':str(file)}]},
                            self.dimension('saved-text-availability',['text_content'],'category'),Inputs({}))
        self.assertEqual(result['buckets'],{'["saved_blank_text"]':2,'["saved_nonblank_text"]':2})
        self.assertEqual(result['evidence']['readRowGroups'],1)
        self.assertEqual(result['evidence']['exactFooterRowGroups'],0)

    def test_saved_text_empty_member_requires_real_empty_footer_and_field(self):
        file=self.root/'empty-text.parquet'
        with pq.ParquetWriter(file,pa.schema([('text_content',pa.string())])): pass
        table={'rows':0,'members':[{'url':str(file)}]}
        dim=self.dimension('saved-text-availability',['text_content'],'category')
        result=scan_special(self.conn,'documents',table,dim,Inputs({}))
        self.assertEqual(result['buckets'],{})
        self.assertEqual((result['rows'],result['placedRows'],result['unplacedRows']),(0,0,0))
        with pq.ParquetWriter(file,pa.schema([('another_field',pa.string())])): pass
        with self.assertRaisesRegex(ValueError,'field'):scan_special(self.conn,'documents',table,dim,Inputs({}))

    def test_definitions_cover_reviewed_tables_and_only_exact_published_fields(self):
        definitions=json.loads((ROOT/'content/coverage-definitions/regulation.json').read_text())['tables']
        reviewed={t['tableId']:t for t in json.loads((ROOT/'content/coverage-reviews/regulation.json').read_text())['tables']}
        self.assertEqual(set(definitions),set(reviewed))
        for id, definition in definitions.items():
            self.assertEqual(definition['schema'],reviewed[id]['schema']);validate_definition(definition,definition['schema'])
        cfr=definitions['cfr_sections']['dimensions'][0]
        self.assertEqual(cfr['fields'],['edition_year','title'])
        edition = next(dim for dim in definitions['unified_agenda']['dimensions'] if dim['id'] == 'agenda-spring-fall-editions')
        self.assertEqual(edition['syntax'],'agenda')
        self.assertEqual(definitions['unified_agenda']['dimensions'][0]['id'], 'timetable-milestone-months')
        self.assertEqual(definitions['court_opinion_clusters']['dimensions'][0]['approximateField'],'date_filed_is_approximate')
        for table, field in [('fr_docket_links','link_source'),('rule_targets','source'),
                             ('agenda_item_proceedings','source'),('comment_periods','source'),
                             ('rulemaking_lifecycles','withdrawal_source'),('regulatory_agenda_items','scope_status')]:
            self.assertTrue(any(d['kind']=='category' and d['fields']==[field]
                                for d in definitions[table]['dimensions']), table)
        inline=next(d for d in definitions['fcc_filings']['dimensions'] if d['id']=='saved-inline-text')
        self.assertEqual(inline['fields'],['text_data'])
        native=next(d for d in definitions['native_legal_references']['dimensions'] if d['id']=='reference-evidence-classes')
        self.assertEqual(native['fields'],['observation_kind','interpretation_status'])
        self.assertFalse(any(d.get('special')=='saved-text-availability' for d in definitions['native_legal_references']['dimensions']))
        # No unsupported temporal joins through unrelated current snapshots.
        for id in ['comment_attributes','document_attributes']:
            self.assertFalse(any(d['kind']=='inherited'for d in definitions[id]['dimensions']))
        pdf = next(d for d in definitions['court_opinion_pdf_extractions']['dimensions'] if d['kind'] == 'inherited')
        self.assertEqual(pdf['parent'], {'table': 'court_opinions', 'mode': 'recorded-parent',
                                         'keys': [['opinion_id', 'opinion_id'], ['cluster_id', 'cluster_id']]})
        self.assertEqual(pdf['dimension']['fields'], ['dump_date'])
        # Extrema locate observed endpoints; they cannot fill an intervening month.
        for id, fields in [('org_committee_links', ['first_comment_date', 'last_comment_date']),
                           ('gao_recommendations', ['first_seen', 'last_seen']),
                           ('rule_targets', ['first_seen', 'last_seen'])]:
            axes = definitions[id]['dimensions']
            self.assertFalse(any(d['kind'] == 'interval' for d in axes))
            self.assertTrue(all(any(d['kind'] == 'date' and d['fields'] == [f] for d in axes) for f in fields))

if __name__ == '__main__': unittest.main()
