import json
import hashlib
import shutil
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
import duckdb

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
from coverage_dimensions import validate_definition,scan_dimension
from fec_coverage import scan_special,scope,footer_collection_counts

PIN_A='sha256:'+'a'*64
PIN_B='sha256:'+'b'*64

class RetainedInputs:
    def __init__(self,parents):self.parents=parents;self.calls=[]
    def parent(self,child_id,child,relation):self.calls.append(('parent',child_id));return self.parents[PIN_A]
    def producing(self,id,table):return self.parents[PIN_A]
    def table(self,family,pin,id):self.calls.append((family,pin,id));return self.parents[pin]

class FecCoverageTest(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.folder.name);self.conn=duckdb.connect()
    def tearDown(self):self.conn.close();self.folder.cleanup()
    def parquet(self,name,ddl,rows):
        self.conn.execute('CREATE TABLE '+name+'('+ddl+')')
        if rows:self.conn.executemany('INSERT INTO '+name+' VALUES('+','.join('?' for _ in rows[0])+')',rows)
        path=self.root/(name+'.parquet');self.conn.execute('COPY '+name+' TO ? (FORMAT PARQUET)',[str(path)])
        return str(path)
    def parent(self,pin,path,n):return {'family':'fec-observations','artifactDigest':pin,'tableId':'fec_collections','recordUrl':'test/'+pin,'members':[{'key':'fec_collections.parquet','rows':n}],'urls':[path],'rows':n}
    def dim(self,special):return {'id':special,'kind':'inherited','fields':[],'label':'Retained scope','meaning':'Exact source scope','special':special,'parent':{'table':'fec_collections','mode':'recorded-parent','keys':[['collection_id','collection_id']]}}
    def collections(self,name,rows):return self.parquet(name,'collection_id VARCHAR, source_family VARCHAR,record_outcome VARCHAR,requested_scope_json VARCHAR,collection_outcome_json VARCHAR',rows)
    def test_definitions_cover_every_reviewed_published_fec_schema(self):
        repo=pathlib.Path(__file__).resolve().parents[1]
        definitions=json.loads((repo/'content/coverage-definitions/fec.json').read_text());review=json.loads((repo/'content/coverage-reviews/fec.json').read_text())
        expected={t['tableId']:t for t in review['tables']}
        self.assertEqual(set(definitions['tables']),set(expected))
        for id,d in definitions['tables'].items():
            self.assertEqual(d['schema'],expected[id]['schema']);validate_definition(d,d['schema'])
            for axis in expected[id]['recommendedDimensions']:
                if axis['kind'] in ('date','year','year-list','date-list','interval'):
                    fields=axis['fields'][:2] if axis['kind']=='interval' else axis['fields'][:1]
                    self.assertTrue(any(set(fields)<=set(x.get('fields',[])) for x in d['dimensions']),(id,fields))
    def test_recorded_generation_and_explicit_pin_prevent_false_scope_matches(self):
        a=self.collections('ca',[('same','fec_candidates','no-record-rejections',json.dumps({'capture':{'requestUrl':'https://example.gov/bulk-downloads/2024/cn24.zip'}}),'{}')])
        b=self.collections('cb',[('same','fec_candidates','no-record-rejections',json.dumps({'capture':{'requestUrl':'https://example.gov/bulk-downloads/2026/cn26.zip'}}),'{}')])
        path=self.parquet('rows','collection_id VARCHAR,source_generation_pin VARCHAR',[('same',PIN_A),('same',PIN_B),(None,PIN_A)])
        table={'rows':3,'url':[path]};inputs=RetainedInputs({PIN_A:self.parent(PIN_A,a,1),PIN_B:self.parent(PIN_B,b,1)})
        result=scan_special(self.conn,'fec_test',table,self.dim('collection-cycle'),inputs)
        self.assertEqual(result['buckets'],{'2024':1});self.assertEqual((result['matchedRows'],result['unmatchedRows']),(1,2))
        self.assertEqual(inputs.calls,[('parent','fec_test')])
    def test_per_witness_pins_are_resolved_independently_and_counts_stay_at_witness_grain(self):
        a=self.collections('ca',[('same','fec_candidates','no-record-rejections',json.dumps({'capture':{'requestUrl':'https://example.gov/bulk-downloads/2024/cn24.zip'}}),'{}')])
        b=self.collections('cb',[('same','fec_candidates','no-record-rejections',json.dumps({'capture':{'requestUrl':'https://example.gov/bulk-downloads/2026/cn26.zip'}}),'{}')])
        path=self.parquet('witness','collection_id VARCHAR,witness_generation_pin VARCHAR,witness_generation_scope VARCHAR',[('same',PIN_A,'external'),('same',PIN_A,'external'),('same',PIN_B,'external')])
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,a,1),PIN_B:self.parent(PIN_B,b,1)})
        result=scan_special(self.conn,'fec_record_evidence',{'rows':3,'url':[path]},self.dim('witness-cycle'),inputs)
        self.assertEqual(result['buckets'],{'2024':2,'2026':1});self.assertEqual(result['evidence']['usedCollections'],2)
        self.assertEqual({call[1] for call in inputs.calls},{PIN_A,PIN_B})
    def test_zero_output_attempts_preserve_qualified_empty_filters_and_refusal_meaning(self):
        query={'captures':[{'requestUrl':'https://api.open.fec.gov/v1/candidates/?candidate_id=H001&candidate_id=H002&cycle=2024&per_page=100'}]}
        path=self.collections('attempts',[('empty','fec_candidates','empty',json.dumps(query),json.dumps({'recordOutcome':'empty','publishedRecordCount':0})),('refused','fec_archive_quality','refused',None,json.dumps({'providerOutcome':None,'receiverDisposition':{'reason':'dictionary mapping refused'}})),('context','fec_access','selection_context',None,'{}')])
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,path,3)});dim={'id':'outcomes','kind':'category','fields':['record_outcome'],'label':'Results','meaning':'Recorded collection outcomes','special':'collection-outcomes'}
        result=scan_special(self.conn,'fec_collections',{'rows':3,'url':[path]},dim,inputs)
        self.assertEqual(result['placedRows'],3);empty=result['evidence']['qualifiedEmptyRequests'];self.assertEqual(len(empty),1)
        self.assertEqual(empty[0]['queryFilters'],[[['candidate_id','H001'],['candidate_id','H002'],['cycle','2024']]])
        self.assertEqual(result['evidence']['refusals'][0]['reason'],'dictionary mapping refused')
        self.assertIsNone(scope({'source_family':'fec_candidates','record_outcome':'empty','requested_scope_json':json.dumps(query),'collection_outcome_json':'{}'})['cycle'])
        self.assertFalse(scope({'source_family':'fec_candidates','record_outcome':'empty','requested_scope_json':None,'collection_outcome_json':'{}'})['providerQualifiedEmpty'])
    def test_related_events_deduplicate_root_rows_per_month_and_year(self):
        child=self.parquet('children','record_id VARCHAR,matter_record_id VARCHAR',[('p1','m1'),('p2','m2'),('p3','missing')])
        parent=self.parquet('events','matter_record_id VARCHAR,event_date DATE,date_precision VARCHAR',[('m1','2024-01-02','day'),('m1','2024-01-03','day'),('m1','2024-02-03','day'),('m2','2023-01-01','year'),('m2',None,None)])
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,parent,5)});dim={'id':'events','kind':'inherited','fields':[],'label':'Related event dates','meaning':'Related dates, not role start','special':'related-events','parent':{'table':'fec_legal_events','mode':'same-generation','keys':[['matter_record_id','matter_record_id']]}}
        result=scan_special(self.conn,'fec_legal_parties',{'rows':3,'url':[child]},dim,inputs)
        self.assertEqual(result['buckets'],{'2024-01':1,'2024-02':1});self.assertEqual(result['yearBuckets'],{'2024':1})
        self.assertEqual((result['placedRows'],result['unplacedRows']),(1,2));self.assertTrue(result['overlapping'])
    def test_legal_year_precision_never_invents_a_month(self):
        path=self.parquet('dates','event_date DATE,date_precision VARCHAR',[('2024-01-02','day'),('2023-01-01','year'),('2022-08-01','month'),(None,None)])
        dim={'id':'legal_year','kind':'year','fields':['event_date'],'label':'Stated years','meaning':'Dates at stated precision','special':'precision-year'}
        result=scan_special(self.conn,'fec_legal_events',{'rows':4,'url':[path]},dim,None)
        self.assertEqual(result['buckets'],{'2022':1,'2023':1,'2024':1});self.assertEqual(result['unplacedRows'],1)
    def test_duplicate_collection_keys_refuse_fanout(self):
        parent=self.collections('dupes',[('same','fec_candidates','empty',None,'{}'),('same','fec_candidates','empty',None,'{}')])
        child=self.parquet('data','collection_id VARCHAR',[('same',)])
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,parent,2)})
        with self.assertRaisesRegex(ValueError,'not unique'):scan_special(self.conn,'fec_test',{'rows':1,'url':[child]},self.dim('collection-cycle'),inputs)
    def test_footer_constant_and_mixed_groups_equal_full_projected_counts(self):
        try:import pyarrow
        except ImportError:self.skipTest('Optional large-scan dependencies unavailable')
        path=self.parquet('keys','collection_id VARCHAR',[('a',),('a',),('b',),(None,)])
        result=footer_collection_counts(self.conn,[path],4)
        self.assertEqual({key:n for key,_,n in result},{'a':2,'b':1,None:1})
        with self.assertRaisesRegex(ValueError,'differ from publication'):footer_collection_counts(self.conn,[path],5)

    def test_inexact_equal_footer_bounds_force_projected_reads(self):
        try:import pyarrow
        except ImportError:self.skipTest('Optional large-scan dependencies unavailable')
        path=self.parquet('inexact','collection_id VARCHAR',[('a',),('a',),('b',),(None,)])
        class InexactStatistics:
            def execute(self,*args):return self
            def fetchall(self):return [(0,4,'a','a',0,False,False)]
        result=footer_collection_counts(InexactStatistics(),[path],4)
        self.assertEqual({key:n for key,_,n in result},{'a':2,'b':1,None:1})

    def test_remote_parent_download_refuses_bytes_that_do_not_match_receipt(self):
        import fec_coverage
        path=self.collections('bytes',[('same','fec_candidates','empty',None,'{}')])
        parent=self.parent(PIN_A,path,1)
        parent['urls']=['https://data.spicygov.ai/test.parquet']
        parent['members'][0].update(byteSize=pathlib.Path(path).stat().st_size,sha256='sha256:'+'0'*64)
        child=self.parquet('bound_child','collection_id VARCHAR',[('same',)])
        inputs=RetainedInputs({PIN_A:parent})
        def copied(args,**kwargs):shutil.copyfile(path,args[args.index('-o')+1])
        with patch.object(fec_coverage.subprocess,'run',side_effect=copied):
            with self.assertRaisesRegex(ValueError,'bytes differ'):
                scan_special(self.conn,'fec_test',{'rows':1,'url':[child]},self.dim('collection-cycle'),inputs)

    def test_scope_retains_new_filters_and_sanitized_endpoint_without_calendar_cycle_guess(self):
        row={'source_family':'fec_research','record_outcome':'empty','collection_outcome_json':'{}',
             'requested_scope_json':json.dumps({'capture':{'requestUrl':'https://user:secret@api.open.fec.gov/v1/legal/advisory_opinions/?ao_year=2025&ao_status=issued&q=health&q=care&form_type=F3&new_filter=literal&api_key=secret&access_token=secret&page=2&per_page=100#private'}})}
        result=scope(row)
        self.assertEqual(result['calendarYears'],['2025']);self.assertIsNone(result['cycle'])
        self.assertEqual(result['endpoints'],['https://api.open.fec.gov/v1/legal/advisory_opinions/'])
        self.assertNotIn('secret',json.dumps(result));self.assertNotIn('private',json.dumps(result))
        self.assertEqual(result['queryFilters'],[[['ao_status','issued'],['ao_year','2025'],['form_type','F3'],['new_filter','literal'],['q','care'],['q','health']]])
        self.assertEqual(result['requests'][0]['endpoint'],result['endpoints'][0])
        row['requested_scope_json']=json.dumps({'capture':{'requestUrl':'https://api.open.fec.gov/v1/?q=a%26ao_year%3D2025'}})
        literal=scope(row)
        row['requested_scope_json']=json.dumps({'capture':{'requestUrl':'https://api.open.fec.gov/v1/?q=a&ao_year=2025'}})
        self.assertNotEqual(literal['description'],scope(row)['description'])

    def test_calendar_request_bounds_are_sparse_and_deduplicate_years(self):
        request={'capture':{'requestUrl':'https://api.open.fec.gov/v1/legal/administrative_fines/?af_min_fd_date=2025-01-01&af_max_fd_date=2025-12-31'}}
        a=self.collections('bound_scope',[('a','fec_legal','empty',json.dumps(request),'{}')])
        child=self.parquet('bound_root','collection_id VARCHAR',[('a',),('a',),('missing',)])
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,a,1)})
        result=scan_special(self.conn,'fec_test',{'rows':3,'url':[child]},self.dim('collection-date-bounds'),inputs)
        self.assertEqual(result['buckets'],{'2025-01':2,'2025-12':2});self.assertEqual(result['yearBuckets'],{'2025':2})
        self.assertEqual((result['placedRows'],result['unplacedRows']),(2,1))

    def test_loan_deadlines_require_explicit_four_digit_years_and_keep_future_schedules(self):
        values=['20271001','12/31/2026','12-31-2024','2028-02-29','7/29/2014',
                '04/01/27','03/010/2012','20260229','ON DEMAND','NONE','',None,
                '01/10/2011','20051205','2026-01-10','20271111','0000-01-01']
        path=self.parquet('due_terms','due_date_terms VARCHAR',[(v,)for v in values])
        dim={'id':'due','kind':'date','fields':['due_date_terms'],'label':'Loan due dates','meaning':'Explicit source deadlines','special':'loan-due-dates'}
        result=scan_special(self.conn,'fec_loans',{'rows':len(values),'url':[path]},dim,None)
        self.assertEqual(result['buckets'],{'2014-07':1,'2024-12':1,'2026-01':1,'2026-12':1,'2027-11':1,'2028-02':1})
        self.assertEqual((result['placedRows'],result['unplacedRows']),(6,11))
        self.assertEqual(result['evidence']['unplacedReasons'],{'missing':2,'twoDigitYear':1,'invalidDate':3,'nonDateTerms':2,'ambiguousDate':3})
        literal={**dim,'kind':'category','special':None}
        del literal['special']
        source=scan_dimension(self.conn,[path],len(values),literal)
        self.assertEqual((source['placedRows'],source['unplacedRows']),(15,2))
        self.assertIn('["04/01/27"]',source['buckets']);self.assertIn('["ON DEMAND"]',source['buckets'])

    def test_loan_deadline_scanner_refuses_wrong_field_and_publication_count(self):
        path=self.parquet('due_bad','due_date_terms VARCHAR',[('20271001',)])
        dim={'id':'due','kind':'date','fields':['due_date_terms'],'label':'Due dates','meaning':'Explicit years','special':'loan-due-dates'}
        with self.assertRaisesRegex(ValueError,'publication'):
            scan_special(self.conn,'fec_loans',{'rows':2,'url':[path]},dim,None)
        with self.assertRaisesRegex(ValueError,'due_date_terms'):
            scan_special(self.conn,'fec_loans',{'rows':1,'url':[path]},{**dim,'fields':['incurred_date']},None)

    def test_exact_header_report_context_deduplicates_witnesses_and_keeps_conflicts(self):
        parent=self.parquet('reports','collection_id VARCHAR,filing_header_record_id VARCHAR,source_sha256 VARCHAR,period_start DATE,period_end DATE',[
            ('c','h','sha','2024-01-01','2024-02-29'),('c','h','sha','2024-01-01','2024-02-29'),('c','h','sha','2024-02-01','2024-03-31'),
            ('c','h','sha',None,None),('c','nodate','sha',None,None)])
        child=self.parquet('native','record_id VARCHAR,collection_id VARCHAR,filing_header_record_id VARCHAR,source_sha256 VARCHAR',[
            ('one','c','h','sha'),('two','c','h','sha'),('wrong-hash','c','h','different'),('undated','c','nodate','sha')])
        dim={'id':'period','kind':'inherited','fields':[],'label':'Related periods','meaning':'Context, not event','special':'related-filing-periods','parent':{'table':'fec_filing_report_observations','mode':'same-generation','keys':[[f,f] for f in ['collection_id','filing_header_record_id','source_sha256']]}}
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,parent,5)})
        r=scan_special(self.conn,'fec_filing_text_observations',{'rows':4,'url':[child]},dim,inputs)
        self.assertEqual(r['buckets'],{'2024-01':2,'2024-02':2,'2024-03':2});self.assertEqual(r['yearBuckets'],{'2024':2})
        self.assertEqual((r['placedRows'],r['unplacedRows'],r['partialRows']),(2,2,2))
        self.assertEqual((r['matchedRows'],r['unmatchedRows']),(3,1));self.assertEqual(r['evidence']['matchedNoPeriodRows'],1)
        self.assertEqual(r['evidence']['conflictingPeriodRows'],2)

    def test_association_uses_explicit_resolved_ids_with_no_unique_parent_fabrication(self):
        parent=self.parquet('filings','record_id VARCHAR,receipt_date DATE,coverage_start_date DATE,coverage_end_date DATE',[
            ('f1','2024-02-02','2024-01-01','2024-02-29'),('f2','2024-03-02','2024-02-01','2024-03-31'),('f3','2024-04-02',None,None)])
        child=self.parquet('assocs','record_id VARCHAR,association_status VARCHAR,filing_observation_ids VARCHAR[]',[
            ('a','resolved_native_filing_key',['f1','f1','f2','missing']),('b','unresolved',['f1']),('c','resolved_native_filing_key',['f3'])])
        dim={'id':'period','kind':'inherited','fields':[],'label':'Selected related periods','meaning':'Literal selected IDs','special':'associated-filing-periods','parent':{'table':'fec_filings','mode':'same-generation','keys':[['filing_observation_ids','record_id']]}}
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,parent,3)})
        r=scan_special(self.conn,'fec_filing_header_associations',{'rows':3,'url':[child]},dim,inputs)
        self.assertEqual(r['buckets'],{'2024-01':1,'2024-02':1,'2024-03':1});self.assertEqual(r['yearBuckets'],{'2024':1})
        self.assertEqual((r['matchedRows'],r['unmatchedRows'],r['partialRows']),(2,1,1));self.assertEqual(r['evidence']['conflictingPeriodRows'],0)
        dim['special']='associated-filing-dates';r=scan_special(self.conn,'fec_filing_header_associations',{'rows':3,'url':[child]},dim,inputs)
        self.assertEqual(r['buckets'],{'2024-02':1,'2024-03':1,'2024-04':1});self.assertEqual(r['yearBuckets'],{'2024':2})

    def test_related_context_refuses_duplicate_root_ids_and_unknown_special(self):
        parent=self.parquet('unique_reports','collection_id VARCHAR,filing_header_record_id VARCHAR,source_sha256 VARCHAR,period_start DATE,period_end DATE', [('c','h','sha','2024-01-01','2024-01-31')])
        child=self.parquet('repeated_roots','record_id VARCHAR,collection_id VARCHAR,filing_header_record_id VARCHAR,source_sha256 VARCHAR',[('same','c','h','sha'),('same','c','h','sha')])
        dim={'id':'period','kind':'inherited','fields':[],'label':'Related periods','meaning':'Context','special':'related-filing-periods','parent':{'table':'fec_filing_report_observations','mode':'same-generation','keys':[[f,f] for f in ['collection_id','filing_header_record_id','source_sha256']]}}
        inputs=RetainedInputs({PIN_A:self.parent(PIN_A,parent,1)})
        with self.assertRaisesRegex(ValueError,'root observation IDs'):scan_special(self.conn,'fec_test',{'rows':2,'url':[child]},dim,inputs)
        dim['special']='typo'
        with self.assertRaisesRegex(ValueError,'Unknown FEC'):scan_special(self.conn,'fec_test',{'rows':2,'url':[child]},dim,inputs)

    def test_batch_c_sector_comparisons_definitions_measure_candidate_schemas(self):
        import importlib.util
        import coverage_scan
        repo = pathlib.Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('coverage_builder', repo / 'scripts/build-coverage-maps.py')
        builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
        defs = builder.definitions()
        for tid in ('sector_financial_comparisons', 'sector_classification_evidence', 'lobbying_issue_financial_observations'):
            self.assertEqual(defs[tid]['family'], 'sector-comparisons')

        def make_tbl(name, insert_sql):
            policy = defs[name]
            path = self.root / f'{name}.parquet'
            cols = ', '.join(f'"{n}" {t}' for n, t in policy['schema'])
            with duckdb.connect() as conn:
                conn.execute(f'CREATE TABLE t ({cols})')
                conn.execute(insert_sql)
                conn.execute('COPY t TO ? (FORMAT PARQUET)', [str(path)])
            raw = path.read_bytes()
            rows = int(self.conn.execute('SELECT count(*) FROM read_parquet(?)', [str(path)]).fetchone()[0])
            return policy, {
                'family': 'sector-comparisons', 'kind': 'generation', 'columns': policy['schema'],
                'rows': rows, 'publishedAt': '2026-11-25T17:00:00Z', '_coverageAsOfMonth': '2026-11',
                'members': [{'key': path.name, 'url': str(path), 'rows': rows, 'byteSize': len(raw)}],
            }

        sfc_pol, sfc_tbl = make_tbl(
            'sector_financial_comparisons',
            "INSERT INTO t (record_id, sector_code, source_family, measure, amount_status, period_start, period_end) VALUES "
            "('r1', '62', 'fec', 'receipts', 'known_selected_observations', '2025-01-01', '2025-12-31'), "
            "('r2', 'unclassified', 'lda', 'expenses', 'no_qualified_measure', '2025-01-01', '2025-12-31')"
        )
        builder.validate_plan({'sector_financial_comparisons': sfc_tbl}, {'sector_financial_comparisons': dict(sfc_pol)})
        sfc_dims = {d['id']: d for d in coverage_scan.scan_table('sector_financial_comparisons', sfc_tbl, sfc_pol)['dimensions']}
        self.assertEqual((sfc_dims['comparison-periods']['placedRows'], sfc_dims['comparison-periods']['unplacedRows']), (2, 0))
        self.assertEqual(sfc_dims['comparison-periods']['yearBuckets'], {'2025': 2})
        self.assertEqual(sfc_dims['source-measure']['buckets'], {'["fec","receipts"]': 1, '["lda","expenses"]': 1})
        self.assertEqual(sfc_dims['sector-code']['buckets'], {'["62"]': 1, '["unclassified"]': 1})

        sce_pol, sce_tbl = make_tbl(
            'sector_classification_evidence',
            "INSERT INTO t (record_id, source_namespace, sector_codes_json, classification_status, method, applicable_start, applicable_end) VALUES "
            "('e1', 'fec_committee', '[\"62\"]', 'supported_context', 'curated_disclosed_organization_and_primary_business_description', '2025-01-01', '2025-12-31'), "
            "('e2', 'cross_source_association', '[]', 'unresolved_identity', 'not_used_for_money', '2025-01-01', '2025-12-31')"
        )
        builder.validate_plan({'sector_classification_evidence': sce_tbl}, {'sector_classification_evidence': dict(sce_pol)})
        sce_dims = {d['id']: d for d in coverage_scan.scan_table('sector_classification_evidence', sce_tbl, sce_pol)['dimensions']}
        self.assertEqual(sce_dims['applicable-periods']['yearBuckets'], {'2025': 2})
        self.assertEqual(sce_dims['sector-codes']['buckets'], {'"62"': 1})
        self.assertEqual((sce_dims['sector-codes']['placedRows'], sce_dims['sector-codes']['unplacedRows']), (1, 1))

        lifo_pol, lifo_tbl = make_tbl(
            'lobbying_issue_financial_observations',
            "INSERT INTO t (record_id, issue_code, period_start, period_end) VALUES "
            "('i1', 'DEF', '2025-01-01', '2025-03-31'), "
            "('i2', 'TAX', '2025-04-01', '2025-06-30')"
        )
        builder.validate_plan({'lobbying_issue_financial_observations': lifo_tbl}, {'lobbying_issue_financial_observations': dict(lifo_pol)})
        lifo_dims = {d['id']: d for d in coverage_scan.scan_table('lobbying_issue_financial_observations', lifo_tbl, lifo_pol)['dimensions']}
        self.assertEqual((lifo_dims['reporting-periods']['placedRows'], lifo_dims['reporting-periods']['unplacedRows']), (2, 0))
        self.assertEqual(lifo_dims['reporting-periods']['yearBuckets'], {'2025': 2})
        self.assertEqual(lifo_dims['issue-code']['buckets'], {'["DEF"]': 1, '["TAX"]': 1})

    def test_irs527_definitions_measure_candidate_schemas(self):
        import importlib.util
        import coverage_scan
        repo = pathlib.Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('coverage_builder', repo / 'scripts/build-coverage-maps.py')
        builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
        defs = builder.definitions()
        irs_tables = (
            'irs527_transmissions', 'irs527_form8871', 'irs527_form8872',
            'irs527_directors', 'irs527_related_entities', 'irs527_eains',
            'irs527_contributions', 'irs527_expenditures',
        )
        for tid in irs_tables:
            self.assertEqual(defs[tid]['family'], 'irs-527')
        self.assertIn(['malformed_row_count', 'BIGINT'], defs['irs527_transmissions']['schema'])

        def make_tbl(name, insert_sql):
            policy = defs[name]
            path = self.root / f'{name}.parquet'
            cols = ', '.join(f'"{n}" {t}' for n, t in policy['schema'])
            with duckdb.connect() as conn:
                conn.execute(f'CREATE TABLE t ({cols})')
                conn.execute(insert_sql)
                conn.execute('COPY t TO ? (FORMAT PARQUET)', [str(path)])
            raw = path.read_bytes()
            rows = int(self.conn.execute('SELECT count(*) FROM read_parquet(?)', [str(path)]).fetchone()[0])
            return policy, path, {
                'family': 'irs-527', 'kind': 'generation', 'columns': policy['schema'],
                'rows': rows, 'publishedAt': '2026-11-26T01:50:00Z', '_coverageAsOfMonth': '2026-11',
                'members': [{'key': path.name, 'url': str(path), 'rows': rows, 'byteSize': len(raw)}],
            }

        tx_pol, _, tx_tbl = make_tbl(
            'irs527_transmissions',
            "INSERT INTO t (file_id_modifier, transmission_date, footer_record_count, observed_data_records, malformed_row_count) VALUES "
            "('F', DATE '2026-11-21', 18878123, 18877975, 148)"
        )
        builder.validate_plan({'irs527_transmissions': tx_tbl}, {'irs527_transmissions': dict(tx_pol)})
        tx_dims = {d['id']: d for d in coverage_scan.scan_table('irs527_transmissions', tx_tbl, tx_pol)['dimensions']}
        self.assertEqual(tx_dims['transmission-dates']['buckets'], {'2026-11': 1})
        self.assertEqual(tx_dims['file-id-modifier']['buckets'], {'["F"]': 1})
        self.assertEqual(tx_dims['retained-snapshot']['granularity'], 'snapshot')

        f8871_pol, f8871_path, f8871_tbl = make_tbl(
            'irs527_form8871',
            "INSERT INTO t (form_id_number, initial_report_indicator, amended_report_indicator, final_report_indicator, "
            "established_date, exempt_8872_indicator, exempt_990_indicator, material_change_date, insert_datetime_raw) VALUES "
            "('8', '0', '0', '0', DATE '1808-01-01', '1', '0', NULL, '2001-05-13 21:20:54'), "
            "('9', '1', '0', '0', NULL, '', '', DATE '2026-08-12', '2026-08-12 17:03:50')"
        )
        builder.validate_plan({'irs527_form8871': f8871_tbl}, {'irs527_form8871': dict(f8871_pol)})
        f8871_dims = {d['id']: d for d in coverage_scan.scan_table('irs527_form8871', f8871_tbl, f8871_pol)['dimensions']}
        self.assertEqual(f8871_dims['filing-insert-dates']['buckets'], {'2001-05': 1, '2026-08': 1})
        self.assertEqual(f8871_dims['established-dates']['buckets'], {'1808-01': 1})
        self.assertEqual((f8871_dims['established-dates']['placedRows'], f8871_dims['established-dates']['unplacedRows']), (1, 1))
        self.assertEqual(f8871_dims['material-change-dates']['buckets'], {'2026-08': 1})
        self.assertEqual(f8871_dims['filing-indicators']['buckets'], {'["0","0","0"]': 1, '["1","0","0"]': 1})
        self.assertEqual(f8871_dims['exemption-flags']['buckets'], {'["1","0"]': 1})
        self.assertEqual((f8871_dims['exemption-flags']['placedRows'], f8871_dims['exemption-flags']['unplacedRows']), (1, 1))

        f8872_pol, f8872_path, f8872_tbl = make_tbl(
            'irs527_form8872',
            "INSERT INTO t (form_id_number, period_begin_date, period_end_date, initial_report_indicator, amended_report_indicator, "
            "final_report_indicator, org_formation_date, qtr_indicator, pre_or_post_elect_date, sched_a_ind, sched_b_ind, insert_datetime_raw) VALUES "
            "('465', DATE '2000-01-01', DATE '2000-03-31', '1', '0', '0', DATE '1869-09-01', '8', DATE '2000-11-07', '1', '1', '2000-11-17 16:41:01'), "
            "('466', NULL, NULL, '0', '1', '0', DATE '2024-01-15', '4', NULL, '0', '0', '2026-10-15 12:20:39')"
        )
        builder.validate_plan({'irs527_form8872': f8872_tbl}, {'irs527_form8872': dict(f8872_pol)})
        f8872_dims = {d['id']: d for d in coverage_scan.scan_table('irs527_form8872', f8872_tbl, f8872_pol)['dimensions']}
        self.assertEqual(f8872_dims['reporting-periods']['buckets'], {'2000-01': 1, '2000-02': 1, '2000-03': 1})
        self.assertEqual((f8872_dims['reporting-periods']['placedRows'], f8872_dims['reporting-periods']['unplacedRows']), (1, 1))
        self.assertEqual(f8872_dims['filing-insert-dates']['buckets'], {'2000-11': 1, '2026-10': 1})
        self.assertEqual(f8872_dims['election-dates']['buckets'], {'2000-11': 1})
        self.assertEqual(f8872_dims['org-formation-dates']['buckets'], {'1869-09': 1, '2024-01': 1})
        self.assertEqual(f8872_dims['reporting-period-codes']['buckets'], {'["4"]': 1, '["8"]': 1})

        class SameGenIrs527:
            def parent(self_inner, child_id, child, relation):
                table_id = relation['table']
                p_path = f8871_path if table_id == 'irs527_form8871' else f8872_path
                p_tbl = f8871_tbl if table_id == 'irs527_form8871' else f8872_tbl
                return {
                    'family': 'irs-527', 'artifactDigest': 'sha256:' + 'a' * 64,
                    'tableId': table_id, 'recordUrl': 'local://artifact.json',
                    'members': p_tbl['members'], 'urls': [str(p_path)], 'rows': p_tbl['rows'],
                }

        for child_name, sql, cat_id, cat_bucket in (
            ('irs527_directors', "INSERT INTO t (form_id_number, entity_address_state) VALUES ('8', 'WA'), ('orphan', 'CA')", 'entity-address-state', {'["CA"]': 1, '["WA"]': 1}),
            ('irs527_related_entities', "INSERT INTO t (form_id_number, entity_address_state) VALUES ('8', 'NY'), ('orphan', 'OH')", 'entity-address-state', {'["NY"]': 1, '["OH"]': 1}),
            ('irs527_eains', "INSERT INTO t (form_id_number, state_issued) VALUES ('9', 'FL'), ('orphan', 'FD')", 'state-issued', {'["FD"]': 1, '["FL"]': 1}),
        ):
            c_pol, c_path, c_tbl = make_tbl(child_name, sql)
            builder.validate_plan({child_name: c_tbl}, {child_name: dict(c_pol)})
            c_dims = {d['id']: d for d in coverage_scan._measure(
                self.conn, child_name, c_tbl, [str(c_path)], c_pol, SameGenIrs527(),
            )}
            self.assertEqual((c_dims['parent-notice-insert-dates']['matchedRows'], c_dims['parent-notice-insert-dates']['unmatchedRows']), (1, 1))
            self.assertEqual((c_dims['parent-notice-insert-dates']['placedRows'], c_dims['parent-notice-insert-dates']['unplacedRows']), (1, 1))
            self.assertEqual(c_dims[cat_id]['buckets'], cat_bucket)

        c_pol, c_path, c_tbl = make_tbl(
            'irs527_contributions',
            "INSERT INTO t (form_id_number, contribution_amount_status, contribution_date, contribution_date_status) VALUES "
            "('465', 'parsed', DATE '2000-02-15', 'parsed'), "
            "('466', 'parsed', NULL, 'blank')"
        )
        builder.validate_plan({'irs527_contributions': c_tbl}, {'irs527_contributions': dict(c_pol)})
        c_dims = {d['id']: d for d in coverage_scan._measure(
            self.conn, 'irs527_contributions', c_tbl, [str(c_path)], c_pol, SameGenIrs527(),
        )}
        self.assertEqual(c_dims['contribution-dates']['buckets'], {'2000-02': 1})
        self.assertEqual((c_dims['contribution-dates']['placedRows'], c_dims['contribution-dates']['unplacedRows']), (1, 1))
        self.assertEqual((c_dims['parent-report-periods']['matchedRows'], c_dims['parent-report-periods']['unmatchedRows']), (2, 0))
        self.assertEqual((c_dims['parent-report-periods']['placedRows'], c_dims['parent-report-periods']['unplacedRows']), (1, 1))
        self.assertEqual(c_dims['contribution-date-status']['buckets'], {'["blank"]': 1, '["parsed"]': 1})

        e_pol, e_path, e_tbl = make_tbl(
            'irs527_expenditures',
            "INSERT INTO t (form_id_number, expenditure_amount_status, expenditure_date, expenditure_date_status) VALUES "
            "('465', 'parsed', DATE '2000-03-10', 'parsed'), "
            "('466', 'parsed', NULL, 'blank')"
        )
        builder.validate_plan({'irs527_expenditures': e_tbl}, {'irs527_expenditures': dict(e_pol)})
        e_dims = {d['id']: d for d in coverage_scan._measure(
            self.conn, 'irs527_expenditures', e_tbl, [str(e_path)], e_pol, SameGenIrs527(),
        )}
        self.assertEqual(e_dims['expenditure-dates']['buckets'], {'2000-03': 1})
        self.assertEqual((e_dims['expenditure-dates']['placedRows'], e_dims['expenditure-dates']['unplacedRows']), (1, 1))
        self.assertEqual((e_dims['parent-report-periods']['matchedRows'], e_dims['parent-report-periods']['unmatchedRows']), (2, 0))
        self.assertEqual((e_dims['parent-report-periods']['placedRows'], e_dims['parent-report-periods']['unplacedRows']), (1, 1))
        self.assertEqual(e_dims['expenditure-date-status']['buckets'], {'["blank"]': 1, '["parsed"]': 1})

    def test_wave2_fec_query_50_tables_and_v2_election_results_and_profiles(self):
        import importlib.util
        import coverage_scan
        repo = pathlib.Path(__file__).resolve().parents[1]
        spec = importlib.util.spec_from_file_location('coverage_builder', repo / 'scripts/build-coverage-maps.py')
        builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
        defs = builder.definitions()

        fec_query_tables = sorted(t for t, p in defs.items() if p['family'] == 'fec-query')
        self.assertEqual(len(fec_query_tables), 50)
        for retired in (
            'fec_research_source_pages', 'fec_research_filing_feed_items',
            'fec_research_document_observations', 'fec_research_context_dispositions',
            'fec_research_response_outcomes', 'fec_retained_csv_observations',
        ):
            self.assertNotIn(retired, defs)
        for added in ('fec_reference_source_pages', 'fec_reference_filing_feed_items'):
            self.assertIn(added, defs)
            self.assertEqual(defs[added]['family'], 'fec-query')

        def make_tbl(name, family, insert_sql):
            policy = defs[name]
            path = self.root / f'{name}.parquet'
            cols = ', '.join(f'"{n}" {t}' for n, t in policy['schema'])
            with duckdb.connect() as conn:
                conn.execute(f'CREATE TABLE t ({cols})')
                conn.execute(insert_sql)
                conn.execute('COPY t TO ? (FORMAT PARQUET)', [str(path)])
            raw = path.read_bytes()
            rows = int(self.conn.execute('SELECT count(*) FROM read_parquet(?)', [str(path)]).fetchone()[0])
            return policy, path, {
                'family': family, 'kind': 'generation', 'columns': policy['schema'],
                'rows': rows, 'publishedAt': '2026-11-28T05:00:00Z', '_coverageAsOfMonth': '2026-11',
                'members': [{'key': path.name, 'url': str(path), 'rows': rows, 'byteSize': len(raw)}],
            }

        coll_path = self.collections('fec_ref_colls', [
            ('col1', 'fec_access', 'no-record-rejections',
             json.dumps({'capture': {'requestUrl': 'https://www.fec.gov/help-candidates-and-committees/forms/'}}), '{}'),
            ('col2', 'fec_reports', 'no-record-rejections',
             json.dumps({'capture': {'requestUrl': 'https://efilingapps.fec.gov/rss/generate'}}), '{}'),
        ])
        inputs = RetainedInputs({PIN_A: self.parent(PIN_A, coll_path, 2)})

        rp_pol, rp_path, rp_tbl = make_tbl(
            'fec_reference_source_pages', 'fec-query',
            "INSERT INTO t (record_id, collection_id, page_type, content_scope, content_status) VALUES "
            "('p1', 'col1', 'filing_form_reference', 'retained_native_context_part', 'body_extracted')"
        )
        builder.validate_plan({'fec_reference_source_pages': rp_tbl}, {'fec_reference_source_pages': dict(rp_pol)})
        rp_dims = {d['id']: d for d in coverage_scan._measure(
            self.conn, 'fec_reference_source_pages', rp_tbl, [str(rp_path)], rp_pol, inputs,
        )}
        self.assertEqual(rp_dims['page_type_content_scope']['buckets'], {'["filing_form_reference","retained_native_context_part"]': 1})
        self.assertEqual(rp_dims['content_status']['buckets'], {'["body_extracted"]': 1})
        self.assertEqual(rp_dims['selected_source_scopes']['matchedRows'], 1)

        ff_pol, ff_path, ff_tbl = make_tbl(
            'fec_reference_filing_feed_items', 'fec-query',
            "INSERT INTO t (record_id, collection_id, published_at, coverage_start_date, coverage_end_date, source_label_status, parsing_status) VALUES "
            "('f1', 'col2', TIMESTAMPTZ '2026-10-15 14:00:00+00', DATE '2026-07-01', DATE '2026-09-30', 'committee_id', 'parsed'), "
            "('f2', 'col2', NULL, NULL, NULL, 'missing', 'missing')"
        )
        builder.validate_plan({'fec_reference_filing_feed_items': ff_tbl}, {'fec_reference_filing_feed_items': dict(ff_pol)})
        ff_dims = {d['id']: d for d in coverage_scan._measure(
            self.conn, 'fec_reference_filing_feed_items', ff_tbl, [str(ff_path)], ff_pol, inputs,
        )}
        self.assertEqual(ff_dims['published_at']['buckets'], {'2026-10': 1})
        self.assertEqual((ff_dims['published_at']['placedRows'], ff_dims['published_at']['unplacedRows']), (1, 1))
        self.assertEqual(ff_dims['coverage_period']['buckets'], {'2026-07': 1, '2026-08': 1, '2026-09': 1})
        self.assertEqual((ff_dims['coverage_period']['placedRows'], ff_dims['coverage_period']['unplacedRows']), (1, 1))
        self.assertEqual(ff_dims['source_label_status']['buckets'], {'["committee_id"]': 1, '["missing"]': 1})
        self.assertEqual(ff_dims['selected_source_scopes']['matchedRows'], 2)

        fer_pol, _, fer_tbl = make_tbl(
            'fec_election_results', 'fec-election-results',
            "INSERT INTO t (record_id, office, state, district, seat_term, stage, vote_basis, row_kind, votes_status, source_cycle, votes) VALUES "
            "('e1', 'president', 'ME', 'P', 'not_applicable', 'general', 'electoral_vote', 'candidate', 'exact', 2024, 3), "
            "('e2', 'house', 'IN', '02', 'unexpired', 'general', 'ballot_line', 'candidate', 'exact', 2022, 118997), "
            "('e3', 'senate', 'AK', NULL, 'full', 'general', 'ranked_choice_round', 'state_total', 'missing', 2022, NULL)"
        )
        builder.validate_plan({'fec_election_results': fer_tbl}, {'fec_election_results': dict(fer_pol)})
        fer_dims = {d['id']: d for d in coverage_scan.scan_table('fec_election_results', fer_tbl, fer_pol)['dimensions']}
        self.assertEqual(fer_dims['source-cycles']['buckets'], {'2022': 2, '2024': 1})
        self.assertEqual(fer_dims['office']['buckets'], {'["house"]': 1, '["president"]': 1, '["senate"]': 1})
        self.assertEqual(fer_dims['stage-and-basis']['buckets'], {
            '["general","ballot_line"]': 1,
            '["general","electoral_vote"]': 1,
            '["general","ranked_choice_round"]': 1,
        })
        self.assertEqual(fer_dims['seat-term']['buckets'], {'["full"]': 1, '["not_applicable"]': 1, '["unexpired"]': 1})

        rel_pol, _, rel_tbl = make_tbl(
            'fec_committee_relationship_profiles', 'fec-research-profiles',
            "INSERT INTO t (profile_id, committee_id, designation, relationship_effective_date_status, policy_version) VALUES "
            "('r1', 'C00000001', 'P', 'not_supplied; filing and retrieval dates are not relationship dates', 'fec-disclosed-relationships/1'), "
            "('r2', 'C00000002', NULL, 'not_supplied; filing and retrieval dates are not relationship dates', 'fec-disclosed-relationships/1')"
        )
        builder.validate_plan({'fec_committee_relationship_profiles': rel_tbl}, {'fec_committee_relationship_profiles': dict(rel_pol)})
        rel_dims = {d['id']: d for d in coverage_scan.scan_table('fec_committee_relationship_profiles', rel_tbl, rel_pol)['dimensions']}
        self.assertEqual((rel_dims['committee-designation']['placedRows'], rel_dims['committee-designation']['unplacedRows']), (1, 1))
        self.assertEqual(rel_dims['retained-snapshot']['placedRows'], 2)

if __name__=='__main__':unittest.main()
