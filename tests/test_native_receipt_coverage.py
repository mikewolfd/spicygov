"""Native receipt views require exact admitted rows, not matching IDs alone."""
import base64
import copy
import datetime
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from decimal import Decimal

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from native_receipt_coverage import RECEIPT_SCHEMA, content_hash, decode, exact, policy_schema, qualified_records, subject_keys
from gao_receipt_policy import GAO_REPORT_V2_SCHEMA
from regulation_coverage import scan_special, source_instant
from publication_census import BASE


class NativeReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = pathlib.Path(self.temp.name)
    def tearDown(self): self.temp.cleanup()
    def fixture(self, dataset='usaspending_recipients', report_v2=False):
        if dataset == 'usaspending_recipients':
            schema = pa.schema([('recipient_id',pa.string()),('amount',pa.decimal128(38,6))])
            subjects = [{'recipient_id':'r1','amount':Decimal('1.000000')},
                        {'recipient_id':'r2','amount':Decimal('2.000000')},
                        {'recipient_id':'r3','amount':Decimal('3.000000')}]
            raw = [dict(row, observed_at='2020-01-01T00:30:00+01:00', source_capture_sha256='sha256:'+'c'*64) for row in subjects]
            raw[1]['observed_at']='2020-01-20T00:00:00Z'
            raw[2].update(observed_at=None,source_capture_sha256=None)
            identity=['recipient_id'];version='government-sources/1'
        else:
            identity=['report_id'] if dataset=='gao_reports' else ['decision_number','url']
            schema=pa.schema([(name,pa.string()) for name in identity]+[('published_date',pa.date32())])
            subjects=[dict(zip(identity,['id1','https://example.invalid/d1'][:len(identity)]),published_date=datetime.date(1990,1,1)),
                      dict(zip(identity,['id2','https://example.invalid/d2'][:len(identity)]),published_date=datetime.date(2001,1,1))]
            raw=[dict(row,source='gao_listing') for row in subjects];raw[1]['source']='gao_rss'
            version='government-sources/1' if dataset=='gao_reports' else 'government-sources/2'
            if report_v2:
                self.assertEqual(dataset, 'gao_reports')
                schema=GAO_REPORT_V2_SCHEMA;version='government-sources/2'
                subjects=[{name:row.get(name) for name in schema.names} for row in subjects]
                subjects[0].update(major_rule_agency='Department of Energy',
                    major_rule_rins=['1904-AF12', '1904-AF12'],major_rule_fr_citations=['89 FR 1234'])
                subjects[1].update(major_rule_agency=None,major_rule_rins=[],major_rule_fr_citations=None)
                raw=[dict(row,source=old['source'],major_rule_letter_json={
                    'readings':[None,{'literal':'1904-AF12','spans':[1,3]}],
                    '_rulespec':{'source':None,'diagnostic':'kept verbatim'}})
                    for row,old in zip(subjects,raw)]
        descriptor={'dataset':dataset,'policy_version':version,
                    'subject_schema':base64.b64encode(schema.serialize()).decode(),
                    'identity_fields':identity,'receipt_fields':['raw_record'],
                    'receipt_only':False,'nullable_identity_fields':[]}
        receipts=[]
        for row,original in zip(subjects,raw):
            record,subject_version,identity_json=subject_keys(dataset,row)
            receipt={'dataset':dataset,'policy_version':version,'generation_id':'selected',
                     'record_id':record,'subject_version':subject_version,'identity_json':identity_json,
                     'attempt_id':'attempt','outcome':'accepted','processor':'government',
                     'witnesses':[{'source_id':'usaspending:ranking-page' if dataset=='usaspending_recipients' else 'source',
                                   'source_uri':None,'sha256':'sha256:'+'c'*64,'locator':None,'body_version':None}],
                     'processing_json':exact({'raw_record':original}),'diagnostic_json':exact({})}
            receipt['receipt_id']=content_hash(receipt);receipts.append(receipt)
        return {'dataset':dataset,'schema':schema,'subjects':subjects,'receipts':receipts,'descriptor':descriptor}
    def paths(self,fixture):
        subject=self.root/(fixture['dataset']+'.parquet');receipt=self.root/'etl_receipts.parquet'
        pq.write_table(pa.Table.from_pylist(fixture['subjects'],schema=fixture['schema']),subject)
        pq.write_table(pa.Table.from_pylist(fixture['receipts'],schema=RECEIPT_SCHEMA),receipt)
        return subject,receipt
    def read(self,fixture):
        subject,receipt=self.paths(fixture)
        with qualified_records(subject,receipt,fixture['dataset'],{fixture['dataset']:fixture['descriptor']},'selected',len(fixture['subjects']),len(fixture['receipts'])) as rows:
            return list(rows)
    def resign(self,receipt): receipt['receipt_id']=content_hash({k:v for k,v in receipt.items() if k!='receipt_id'})
    def inputs(self,fixture):
        subject,receipt=self.paths(fixture);key='generations/test/'+'a'*64;files={};members=[]
        for p in [subject,receipt]:
            data=p.read_bytes();files[key+'/'+p.name]=data
            members.append({'objectKey':p.name,'role':'table','recordCount':len(fixture['subjects']) if p==subject else len(fixture['receipts']),
                            'byteSize':len(data),'sha256':'sha256:'+hashlib.sha256(data).hexdigest()})
        table={'family':'test','artifactDigest':'sha256:'+'a'*64,'rows':len(fixture['subjects']),
               'publishedAt':'2026-10-04T00:00:00Z','recordUrl':BASE+'/'+key+'/artifact.json',
               'members':[{'key':subject.name,'url':BASE+'/'+key+'/'+subject.name,'rows':len(fixture['subjects']),
                           'sha256':members[0]['sha256'],'byteSize':members[0]['byteSize']}]}
        artifact={'spec':{'etlReceipts':{'key':'etl_receipts.parquet','rows':len(fixture['receipts']),
                                      'generationId':'selected','policies':[fixture['descriptor']]}}}
        owner={**table,'artifact':artifact,'members':[{k:table['members'][0][k] for k in ('key','sha256','rows','byteSize')}]}
        class Inputs:
            def producing(self,*args):return owner
            def artifact(self,*args):return key,artifact,members
            def fetch(self,k):return files[k]
        return table,Inputs(),files,key,members,artifact
    def dimension(self,dataset):
        return {'id':'observations' if dataset=='usaspending_recipients' else 'origin','kind':'date' if dataset=='usaspending_recipients' else 'category',
                'label':'Saved observation','meaning':'Exact saved row evidence.',
                'fields':['recipient_id'] if dataset=='usaspending_recipients' else ['report_id'] if dataset=='gao_reports' else ['decision_number','url'],
                'special':'government-receipt-observation-dates' if dataset=='usaspending_recipients' else 'government-receipt-origins'}

    def test_exact_joins_and_parquet_nested_list_normalization(self):
        f=self.fixture();rows=self.read(f)
        self.assertEqual(len(rows),3);self.assertEqual(rows[0][0]['amount'],Decimal('1.000000'))
        self.assertEqual(rows[2][1]['observed_at'],None)
    def test_observation_axis_uses_utc_source_read_dates_without_legacy_fallback(self):
        f=self.fixture();table,inputs,*_=self.inputs(f)
        result=scan_special(None,f['dataset'],table,self.dimension(f['dataset']),inputs)
        self.assertEqual(result['buckets'],{'2019-12':1,'2020-01':1})
        self.assertEqual(result['yearBuckets'],{'2019':1,'2020':1})
        self.assertEqual((result['rows'],result['placedRows'],result['unplacedRows']),(3,2,1))
        self.assertNotIn('2026-10',result['buckets']);self.assertFalse(result['overlapping'])
    def test_key_match_without_exact_content_version_is_refused(self):
        f=self.fixture();f['subjects'][0]['amount']=Decimal('99.000000')
        with self.assertRaisesRegex(ValueError,'exact subject receipt'):self.read(f)
    def test_duplicate_subject_and_duplicate_receipt_are_refused_before_yield(self):
        for target in ['subjects','receipts']:
            with self.subTest(target=target):
                f=self.fixture();f[target].append(copy.deepcopy(f[target][0]))
                with self.assertRaisesRegex(ValueError,'reused|Duplicate'):self.read(f)
    def test_missing_or_unused_accepted_receipt_is_refused(self):
        for target in ['subjects','receipts']:
            with self.subTest(target=target):
                f=self.fixture();f[target].pop()
                with self.assertRaisesRegex(ValueError,'matching|exact subject'):self.read(f)
    def test_wrong_generation_policy_and_forged_digest_are_refused(self):
        for target,value in [('generation_id','other'),('policy_version','unknown'),('receipt_id','sha256:'+'f'*64)]:
            with self.subTest(target=target):
                f=self.fixture();f['receipts'][0][target]=value
                if target!='receipt_id':self.resign(f['receipts'][0])
                with self.assertRaises(ValueError):self.read(f)
    def test_unclassified_processing_and_noncanonical_json_are_refused(self):
        for body in [exact({'raw_record':{},'undeclared':'x'}), '["dict", [["raw_record", ["dict", []]]]]']:
            with self.subTest(body=body):
                f=self.fixture();f['receipts'][0]['processing_json']=body;self.resign(f['receipts'][0])
                with self.assertRaisesRegex(ValueError,'Unclassified|Noncanonical'):self.read(f)
    def test_wrong_dataset_or_original_natural_identity_is_refused(self):
        f=self.fixture();f['receipts'][0]['dataset']='gao_reports';self.resign(f['receipts'][0])
        with self.assertRaisesRegex(ValueError,'dataset'):self.read(f)
        f=self.fixture();from native_receipt_coverage import decode
        body=decode(f['receipts'][0]['processing_json']);body['raw_record']['recipient_id']='other'
        f['receipts'][0]['processing_json']=exact(body);self.resign(f['receipts'][0])
        with self.assertRaisesRegex(ValueError,'Original row identity'):self.read(f)
    def test_file_sha_and_receipt_row_descriptor_are_required(self):
        f=self.fixture();table,inputs,files,key,members,artifact=self.inputs(f)
        files[key+'/etl_receipts.parquet']=b'changed'
        with self.assertRaisesRegex(ValueError,'SHA'):scan_special(None,f['dataset'],table,self.dimension(f['dataset']),inputs)
        table,inputs,files,key,members,artifact=self.inputs(f);artifact['spec']['etlReceipts']['rows']+=1
        with self.assertRaisesRegex(ValueError,'missing/ambiguous'):scan_special(None,f['dataset'],table,self.dimension(f['dataset']),inputs)
    def test_capture_witness_and_date_presence_must_agree(self):
        for mutation in ['witness','missing-capture','future','invalid']:
            with self.subTest(mutation=mutation):
                f=self.fixture();from native_receipt_coverage import decode
                r=f['receipts'][0];body=decode(r['processing_json'])
                if mutation=='witness':r['witnesses'][0]['source_id']='producer-only'
                if mutation=='missing-capture':body['raw_record']['source_capture_sha256']=None
                if mutation=='future':body['raw_record']['observed_at']='2027-01-01T00:00:00Z'
                if mutation=='invalid':body['raw_record']['observed_at']='2020-01'
                r['processing_json']=exact(body);self.resign(r)
                table,inputs,*_=self.inputs(f)
                with self.assertRaises(ValueError):scan_special(None,f['dataset'],table,self.dimension(f['dataset']),inputs)
    def test_report_and_decision_origins_have_no_invented_collection_months(self):
        for dataset in ['gao_reports','gao_decisions']:
            with self.subTest(dataset=dataset):
                f=self.fixture(dataset);table,inputs,*_=self.inputs(f)
                result=scan_special(None,dataset,table,self.dimension(dataset),inputs)
                self.assertEqual(result['buckets'],{'["gao_rss"]':1,'["gao_listing"]':1})
                self.assertEqual(result['granularity'],'category');self.assertEqual(result['unplacedRows'],0)
                self.assertEqual(result['evidence']['recordedOrigins'],{'gao_listing':1,'gao_rss':1})
                self.assertNotIn('yearBuckets',result)
    def test_current_report_policy_preserves_native_lists_nulls_and_raw_evidence(self):
        f=self.fixture('gao_reports',report_v2=True);rows=self.read(f)
        self.assertEqual(rows[0][0]['major_rule_rins'],['1904-AF12','1904-AF12'])
        self.assertEqual(rows[1][0]['major_rule_rins'],[])
        self.assertIsNone(rows[1][0]['major_rule_fr_citations'])
        for row,receipt in zip(rows,f['receipts']):
            self.assertEqual(row[1],decode(receipt['processing_json'])['raw_record'])
        table,inputs,*_=self.inputs(f)
        result=scan_special(None,'gao_reports',table,self.dimension('gao_reports'),inputs)
        self.assertEqual(result['evidence']['recordedOrigins'],{'gao_listing':1,'gao_rss':1})
        self.assertEqual(result['buckets'],{'["gao_rss"]':1,'["gao_listing"]':1})
        self.assertNotIn('yearBuckets',result)
    def test_current_report_policy_refuses_unreviewed_schema_version_and_identity(self):
        for mutation in ['missing-column','wrong-list-type','wrong-order','wrong-version','wrong-key']:
            with self.subTest(mutation=mutation):
                f=self.fixture('gao_reports',report_v2=True);d=f['descriptor']
                schema=f['schema']
                if mutation=='missing-column':schema=schema.remove(schema.get_field_index('major_rule_agency'))
                if mutation=='wrong-list-type':schema=schema.set(schema.get_field_index('major_rule_rins'),pa.field('major_rule_rins',pa.string()))
                if mutation=='wrong-order':schema=pa.schema(list(schema)[::-1])
                if mutation=='wrong-version':d['policy_version']='government-sources/3'
                if mutation=='wrong-key':d['identity_fields']=['title']
                d['subject_schema']=base64.b64encode(schema.serialize()).decode()
                with self.assertRaises(ValueError):policy_schema(d)
    def test_current_report_receipt_must_match_new_fields_and_selected_policy(self):
        for mutation in ['native-value','receipt-policy','raw-identity']:
            with self.subTest(mutation=mutation):
                f=self.fixture('gao_reports',report_v2=True)
                if mutation=='native-value':f['subjects'][0]['major_rule_rins']=['different']
                else:
                    r=f['receipts'][0]
                    if mutation=='receipt-policy':r['policy_version']='government-sources/1'
                    else:
                        body=decode(r['processing_json']);body['raw_record']['report_id']='other'
                        r['processing_json']=exact(body)
                    self.resign(r)
                with self.assertRaises(ValueError):self.read(f)
    def test_shared_current_gao_receipts_admit_both_datasets_without_rebinding(self):
        report=self.fixture('gao_reports',report_v2=True);decision=self.fixture('gao_decisions')
        descriptors={f['dataset']:f['descriptor'] for f in [report,decision]}
        receipts=report['receipts']+decision['receipts']
        receipt=self.root/'shared.parquet'
        pq.write_table(pa.Table.from_pylist(receipts,schema=RECEIPT_SCHEMA),receipt)
        for f in [report,decision]:
            with self.subTest(dataset=f['dataset']):
                subject=self.root/(f['dataset']+'.parquet')
                pq.write_table(pa.Table.from_pylist(f['subjects'],schema=f['schema']),subject)
                with qualified_records(subject,receipt,f['dataset'],descriptors,'selected',2,4) as rows:
                    admitted=list(rows)
                self.assertEqual([row[0] for row in admitted],f['subjects'])
                self.assertEqual([row[1]['source'] for row in admitted],['gao_listing','gao_rss'])
        descriptors['gao_reports']['policy_version']='government-sources/3'
        with self.assertRaisesRegex(ValueError,'policy'):
            with qualified_records(subject,receipt,'gao_decisions',descriptors,'selected',2,4) as rows:
                list(rows)
    def test_current_major_rule_origins_remain_literal_and_have_no_invented_dates(self):
        f=self.fixture('gao_reports',report_v2=True)
        origins=['gao_major_rule_listing','gao_major_rule_index']
        for receipt,origin in zip(f['receipts'],origins):
            body=decode(receipt['processing_json']);body['raw_record']['source']=origin
            receipt['processing_json']=exact(body);self.resign(receipt)
        table,inputs,*_=self.inputs(f)
        result=scan_special(None,'gao_reports',table,self.dimension('gao_reports'),inputs)
        self.assertEqual(result['buckets'],{json.dumps([origin]):1 for origin in origins})
        self.assertEqual(result['evidence']['recordedOrigins'],dict.fromkeys(origins,1))
        self.assertEqual(result['placedRows'],2)
        self.assertNotIn('yearBuckets',result)
    def test_unknown_origin_requires_review(self):
        f=self.fixture('gao_reports');from native_receipt_coverage import decode
        r=f['receipts'][0];body=decode(r['processing_json']);body['raw_record']['source']='unreviewed'
        r['processing_json']=exact(body);self.resign(r);table,inputs,*_=self.inputs(f)
        with self.assertRaisesRegex(ValueError,'Unreviewed'):scan_special(None,f['dataset'],table,self.dimension(f['dataset']),inputs)

    def test_invalid_offset_minutes_and_clock_values_are_not_normalized(self):
        for literal in ['2026-10-03T21:53:05+00:60','2026-10-03T21:53:05+0060',
                        '2026-10-03T21:53:05+24:00','2026-10-03T24:00:00Z','2026-10-03T21:60:00Z']:
            with self.subTest(literal=literal),self.assertRaises(ValueError):source_instant(literal)

if __name__=='__main__':unittest.main()
