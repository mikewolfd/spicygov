"""Regression checks for occurrence-aware Congress coverage readers."""
import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'scripts'))
import congress_coverage as coverage
from coverage_dimensions import validate_definition


class Inputs:
    def __init__(self,parent):self.saved=parent
    def parent(self,*_):return self.saved
    def producing(self,*_):return self.saved


class CongressCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.conn=duckdb.connect()
    def tearDown(self):self.conn.close();self.temp.cleanup()
    def file(self,name,sql):
        path=self.root/(name+'.parquet');self.conn.execute('COPY ('+sql+") TO '"+str(path)+"' (FORMAT PARQUET)");return str(path)
    def table(self,url,rows,family='fixture'):
        return {'rows':rows,'family':family,'artifactDigest':'sha256:'+'a'*64,'members':[{'url':url}]}
    def parent(self,url,rows,name='member_terms'):
        return {'urls':[url],'family':'fixture','artifactDigest':'sha256:'+'b'*64,'tableId':name,'recordUrl':'fixture-original-parent','members':[],'rows':rows}
    def dim(self,method,kind='inherited',fields=None):
        return {'id':method,'kind':kind,'method':method,'fields':fields or ['bioguide_id'],'label':'Source scope','meaning':'Retained source facts.','parent':{'table':'member_terms','mode':'same-generation','keys':[['bioguide_id','bioguide_id']]}}
    def test_member_terms_count_each_member_once_per_period_preserve_gaps(self):
        child=self.file('members',"SELECT * FROM (VALUES ('A'),('B')) t(bioguide_id)")
        parent=self.file('terms',"SELECT * FROM (VALUES ('A','0','2020-01-01','2020-02-01'),('A','1','2020-01-15','2020-02-15'),('A','2','2022-01-01','2022-01-31')) t(bioguide_id,term_index,term_start,term_end)")
        d=coverage.scan_special(self.conn,'members',self.table(child,2),self.dim('member-service-distinct'),Inputs(self.parent(parent,3)))
        self.assertEqual(d['buckets'],{'2020-01':1,'2020-02':1,'2022-01':1});self.assertEqual(d['yearBuckets'],{'2020':1,'2022':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(1,1))
        duplicate=self.file('duplicates',"SELECT * FROM (VALUES ('A','0','2020-01-01','2020-02-01'),('A','0','2020-03-01','2020-04-01')) t(bioguide_id,term_index,term_start,term_end)")
        with self.assertRaisesRegex(ValueError,'not unique'):coverage.scan_special(self.conn,'members',self.table(child,2),self.dim('member-service-distinct'),Inputs(self.parent(duplicate,2)))
    def test_hearing_compiled_dates_distinct_transcript_counts_and_years(self):
        child=self.file('hearing',"SELECT * FROM (VALUES ('CHRG-A','2020-01-01'),('CHRG-B','2020-02-01')) t(package_id,held_date)")
        dim=self.dim('hearing-sessions','list',['package_id'])
        found={'CHRG-A':{'dates':['2020-01-01','2020-01-02','2020-02-01','2021-01-01']},'CHRG-B':{'dates':['2020-02-01']}}
        with patch.object(coverage,'hearing_dates',return_value=(found,[])):
            d=coverage.scan_special(self.conn,'hearing_transcripts',self.table(child,2),dim,None)
        self.assertEqual(d['buckets'],{'2020-01':1,'2020-02':2,'2021-01':1});self.assertEqual(d['yearBuckets'],{'2020':2,'2021':1});self.assertEqual(d['sourceDateOccurrences'],5)
        found['CHRG-A']['dates']=['1999-01-01']
        with patch.object(coverage,'hearing_dates',return_value=(found,[])),self.assertRaisesRegex(ValueError,'differ'):
            coverage.scan_special(self.conn,'hearing_transcripts',self.table(child,2),dim,None)
    def test_printing_event_does_not_accept_processing_fallback(self):
        child=self.file('events',"SELECT * FROM (VALUES ('b','version_added','{\"version_code\":\"is\",\"source\":\"g\"}','2001-02-03','2026-01-01'),('b','version_added','{\"version_code\":\"enr\",\"source\":\"g\"}','2026-01-01','2026-01-01'),('b','summary_generated','{}','2026-01-01','2026-01-01')) t(bill_id,event_type,event_data_json,occurred_at,detected_at)")
        parent=self.file('versions',"SELECT * FROM (VALUES ('b','is','g','2001-02-03'),('b','enr','g','')) t(bill_id,version_code,source,version_date)")
        d=coverage.scan_special(self.conn,'public_activity_events',self.table(child,3),self.dim('activity-printing-date'),Inputs(self.parent(parent,2,'bill_versions')))
        self.assertEqual(d['buckets'],{'2001-02':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(1,2));self.assertEqual(d['possibleFallbackRows'],1)
    def test_nested_scorecard_periods_remain_literal_and_relative(self):
        child=self.file('periods',"SELECT [{'period_text':'lifetime','kind':'relative','year_text':NULL},{'period_text':'119th Congress','kind':'explicit','year_text':NULL}] periods UNION ALL SELECT NULL")
        d=coverage.scan_special(self.conn,'scorecards',self.table(child,2),self.dim('scorecard-period-labels','list',['periods']),None)
        self.assertEqual((d['placedRows'],d['unplacedRows']),(1,1));self.assertEqual(d['granularity'],'category');self.assertTrue(any('lifetime' in k and 'relative' in k for k in d['buckets']));self.assertNotIn('2025',d['buckets'])
    def test_funding_single_year_null_end_and_affiliation_validity(self):
        child=self.file('funding',"SELECT * FROM (VALUES ('2024',NULL),('2021','2023'),(NULL,NULL)) t(funding_year,funding_year_end)")
        dim=self.dim('funding-year-span','interval',['funding_year','funding_year_end']);dim['syntax']='year'
        d=coverage.scan_special(self.conn,'senate_expenditures',self.table(child,3),dim,None)
        self.assertEqual(d['buckets'],{'2021':1,'2022':1,'2023':1,'2024':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(2,1))
        child=self.file('affiliations',"SELECT * FROM (VALUES ('2020-01-01','2020-03-31','valid','valid'),('2010-01-01','2010-03-31','ambiguous','valid')) t(affiliation_start,affiliation_end,start_status,end_status)")
        d=coverage.scan_special(self.conn,'member_party_affiliations',self.table(child,2),self.dim('affiliation-period','interval',['affiliation_start','affiliation_end']),None)
        self.assertEqual(d['placedRows'],1);self.assertEqual(d['unplacedRows'],1);self.assertNotIn('2010-01',d['buckets'])
    def test_citation_receipt_uses_original_schema_generation_and_text_hash(self):
        text='source body';text_sha='sha256:'+hashlib.sha256(text.encode()).hexdigest();generation='sha256:'+'b'*64;input_sha='sha256:'+'c'*64
        source_path=self.file('old_sections',"SELECT 'b' bill_id,'introduced-in-house' version_code,'govinfo' AS source,'5' seq,'2002-03-04' version_date,'source body' body")
        key=json.dumps(['b','introduced-in-house','govinfo','5'],separators=(',',':'))
        read_path=self.root/'reads.parquet';self.conn.execute("CREATE TABLE reads(document_kind VARCHAR,document_key VARCHAR,text_sha256 VARCHAR,input_family VARCHAR,input_generation VARCHAR,input_sha256 VARCHAR)")
        self.conn.execute('INSERT INTO reads VALUES (?,?,?,?,?,?)',['bill_section',key,text_sha,'bill-family',generation,input_sha]);self.conn.execute("COPY reads TO '"+str(read_path)+"' (FORMAT PARQUET)")
        old=self.parent(source_path,1,'bill_sections');old.update(family='bill-family',artifactDigest=generation,members=[{'sha256':input_sha}],artifact={'spec':{}})
        class Historical(Inputs):
            def table(inner,family,pin,name):
                self.assertEqual((family,pin,name),('bill-family',generation,'bill_sections'))
                return old
        dim=self.dim('cited-read-source-year','year',['document_key']);table=self.table(str(read_path),1,'print-citations')
        d=coverage.scan_special(self.conn,'document_citation_reads',table,dim,Historical(None))
        self.assertEqual(d['buckets'],{'2002':1});self.assertEqual(d['placedRows'],1)
        old['members'][0]['sha256']='sha256:'+'d'*64
        with self.assertRaisesRegex(ValueError,'original input hash'):
            coverage.scan_special(self.conn,'document_citation_reads',table,dim,Historical(None))
        old['members'][0]['sha256']=input_sha
        old['urls']=[self.file('wrong_body',"SELECT 'b' bill_id,'introduced-in-house' version_code,'govinfo' AS source,'5' seq,'2002-03-04' version_date,'changed body' body")]
        with self.assertRaisesRegex(ValueError,'extraction digest'):
            coverage.scan_special(self.conn,'document_citation_reads',table,dim,Historical(None))

    def test_hearing_journal_manifest_and_blob_hash_are_required(self):
        digest='sha256:'+'f'*64;blob=b'<mods><heldDate>2020-01-02</heldDate></mods>';blob_sha='sha256:'+hashlib.sha256(blob).hexdigest()
        event={'event':'capture','requested_url':'https://api.govinfo.gov/packages/CHRG-119hhrg1/mods','status_code':200,'body_retained':True,'response_complete':True,'sha256':blob_sha}
        journal=json.dumps(event).encode()+b'\n';manifest=json.dumps({'members':[{'objectKey':'journal.jsonl','sha256':'sha256:'+hashlib.sha256(journal).hexdigest()}]}).encode()
        root={'artifactDigest':digest,'spec':{'evidence_version':2},'memberManifests':[{'objectKey':'members.json','sha256':'sha256:'+hashlib.sha256(manifest).hexdigest()}]}
        files={'source-evidence/'+digest[7:]+'/artifact.json':json.dumps(root).encode(),'source-evidence/'+digest[7:]+'/members.json':manifest,'source-evidence/'+digest[7:]+'/journal.jsonl':journal,'source-evidence/blobs/sha256/'+blob_sha[7:]:blob}
        owner={'family':'committee-reports','artifact':{'inputs':[{'role':'source-evidence','artifactDigest':digest}]}}
        with patch.object(coverage,'_raw',side_effect=lambda key:files[key]):
            dates,_=coverage.hearing_dates('hearing_transcripts',{},Inputs(owner),{'CHRG-119hhrg1'})
            self.assertEqual(dates['CHRG-119hhrg1']['dates'],['2020-01-02'])
        files['source-evidence/blobs/sha256/'+blob_sha[7:]]=b'changed'
        with patch.object(coverage,'_raw',side_effect=lambda key:files[key]),self.assertRaisesRegex(ValueError,'differ from their pin'):
            coverage.hearing_dates('hearing_transcripts',{},Inputs(owner),{'CHRG-119hhrg1'})

    def test_read_attempt_dates_do_not_fan_out_parts_or_use_processing_stamps(self):
        child=self.file('attempts',"SELECT * FROM (VALUES ('report','complete'),('hearing','complete'),('refused','refused_final')) t(package_id,outcome)")
        reports=self.file('reports',"SELECT * FROM (VALUES ('report','2001-01-02'),('report','2001-01-02')) t(package_id,date_issued)")
        hearings=self.file('transcripts',"SELECT 'hearing' package_id,'2002-02-03' date_issued")
        class PackageInputs:
            def parent(inner,table_id,table,relation):return self.parent(reports,2,'committee_reports') if relation['table']=='committee_reports' else self.parent(hearings,1,'hearing_transcripts')
        d=coverage.scan_special(self.conn,'committee_report_reads',self.table(child,3),self.dim('committee-read-issue-dates','date',['package_id']),PackageInputs())
        self.assertEqual(d['buckets'],{'2001-01':1,'2002-02':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(2,1))
        mismatch=self.file('mismatched_report_parts',"SELECT * FROM (VALUES ('report','2001-01-02'),('report','2003-01-02')) t(package_id,date_issued)")
        reports=mismatch
        with self.assertRaisesRegex(ValueError,'inconsistent issue dates'):
            coverage.scan_special(self.conn,'committee_report_reads',self.table(child,3),self.dim('committee-read-issue-dates','date',['package_id']),PackageInputs())

    def test_roster_snapshot_parser_preserves_source_precision_and_weekday(self):
        child=self.file('roster',"SELECT * FROM (VALUES ('October 1, 2026'),('Saturday, October 3, 2026'),('Sunday, October 3, 2026'),('2026')) t(file_date)")
        d=coverage.scan_special(self.conn,'committee_assignments',self.table(child,4),self.dim('roster-file-date','date',['file_date']),None)
        self.assertEqual(d['buckets'],{'2026-10':2});self.assertEqual((d['placedRows'],d['unplacedRows']),(2,2));self.assertEqual(d['yearBuckets'],{'2026':2})

    def test_metric_periods_use_edition_and_metric_keys_keep_metric_free_rows(self):
        child=self.file('metric_results',"SELECT * FROM (VALUES ('edition-a','same'),('edition-b','same'),('edition-a',NULL)) t(scorecard_id,metric_id)")
        parent=self.file('metric_scopes',"SELECT 'edition-a' scorecard_id,'same' metric_id,[{'period_text':'lifetime','kind':'relative'}] periods UNION ALL SELECT 'edition-b','same',[{'period_text':'2024','kind':'explicit'}]")
        dim=self.dim('scorecard-metric-periods','inherited',['scorecard_id','metric_id']);dim['parent']={'table':'scorecard_metrics','mode':'same-generation','keys':[['scorecard_id','scorecard_id'],['metric_id','metric_id']]}
        d=coverage.scan_special(self.conn,'scorecard_member_item_results',self.table(child,3),dim,Inputs(self.parent(parent,2,'scorecard_metrics')))
        self.assertEqual((d['placedRows'],d['unplacedRows']),(2,1));self.assertEqual((d['matchedRows'],d['unmatchedRows']),(2,1));self.assertEqual(len(d['buckets']),2)
        self.assertTrue(any('lifetime' in k and v==1 for k,v in d['buckets'].items()));self.assertTrue(any('2024' in k and v==1 for k,v in d['buckets'].items()))
        duplicates=self.file('duplicate_metric_scopes',"SELECT 'edition-a' scorecard_id,'same' metric_id,[{'period_text':'lifetime','kind':'relative'}] periods UNION ALL SELECT 'edition-a','same',[{'period_text':'2024','kind':'explicit'}]")
        with self.assertRaisesRegex(ValueError,'not unique'):
            coverage.scan_special(self.conn,'scorecard_member_item_results',self.table(child,3),dim,Inputs(self.parent(duplicates,2,'scorecard_metrics')))

    def test_all_assigned_definitions_match_exact_reviewed_schema(self):
        root=pathlib.Path(__file__).resolve().parents[1]
        definitions=json.loads((root/'content/coverage-definitions/congress.json').read_text())['tables'];review=json.loads((root/'content/coverage-reviews/congress.json').read_text())
        self.assertEqual(set(definitions),{t['tableId'] for t in review['tables']})
        for table in review['tables']:
            definition=definitions[table['tableId']];self.assertEqual(definition['schema'],table['schema']);self.assertEqual(definition['family'],table['family']);validate_definition(definition,definition['schema'])

    def test_printing_body_views_keep_listed_full_text_apart_from_acquired_uncertain_text(self):
        from coverage_dimensions import scan_dimension
        definitions=json.loads((pathlib.Path(__file__).resolve().parents[1]/'content/coverage-definitions/congress.json').read_text())['tables']
        dimensions={d['id']:d for d in definitions['bill_versions']['dimensions']}
        child=self.file('body_states',"SELECT * FROM (VALUES ('govinfo','kind_uncertain'),('govinfo','full_text'),('congress','full_text'),('govinfo',NULL)) t(source,kind)")
        source=scan_dimension(self.conn,[child],4,dimensions['printing-acquisition-source'])
        self.assertEqual(source['buckets'],{'["govinfo"]':3,'["congress"]':1})
        self.assertEqual(source['unplacedRows'],0)
        kinds=scan_dimension(self.conn,[child],4,dimensions['printing-body-kind'])
        self.assertEqual(kinds['buckets'],{'["kind_uncertain"]':1,'["full_text"]':2})
        self.assertEqual(kinds['unplacedRows'],1)
        joint=scan_dimension(self.conn,[child],4,dimensions['printing-source-body-kind'])
        self.assertEqual({tuple(json.loads(key)):n for key,n in joint['buckets'].items()},
                         {('govinfo','kind_uncertain'):1,('govinfo','full_text'):1,('congress','full_text'):1})
        self.assertEqual(joint['unplacedRows'],1)

    def test_communication_detail_view_preserves_unread_and_unstated_flags(self):
        from coverage_dimensions import scan_dimension
        definitions=json.loads((pathlib.Path(__file__).resolve().parents[1]/'content/coverage-definitions/congress.json').read_text())['tables']
        dim=next(d for d in definitions['house_communications']['dimensions'] if d['id']=='communication-source-detail')
        child=self.file('detail_states',"SELECT * FROM (VALUES ('congress-gov-detail','true'),('congress-gov-detail','false'),('congress-gov-detail',NULL)) t(source_route,detail_read)")
        result=scan_dimension(self.conn,[child],3,dim)
        self.assertEqual({tuple(json.loads(key)):n for key,n in result['buckets'].items()},
                         {('congress-gov-detail','true'):1,('congress-gov-detail','false'):1})
        self.assertEqual((result['placedRows'],result['unplacedRows']),(2,1))

    def test_committee_history_keeps_open_ends_and_counts_root_once(self):
        child=self.file('history',"""SELECT '[{"startDate":"2020-01-01T05:00:00Z","endDate":"2020-02-28T04:59:00Z"},{"startDate":"2020-02-01","endDate":"2020-03-01"},{"startDate":"2022-04-01"}]' history_json UNION ALL SELECT '[]'""")
        table=self.table(child,2)
        starts=coverage.scan_special(self.conn,'committees',table,self.dim('committee-history-starts','list',['history_json']),None)
        self.assertEqual(starts['buckets'],{'2020-01':1,'2020-02':1,'2022-04':1});self.assertEqual(starts['yearBuckets'],{'2020':1,'2022':1})
        spans=coverage.scan_special(self.conn,'committees',table,self.dim('committee-history-spans','list',['history_json']),None)
        self.assertEqual(spans['buckets'],{'2020-01':1,'2020-02':1,'2020-03':1});self.assertEqual(spans['yearBuckets'],{'2020':1});self.assertEqual(spans['partialRows'],1);self.assertEqual(spans['openEndpointOccurrences'],1)
        self.assertNotIn('2022-04',spans['buckets'])

    def test_bill_added_requires_exact_introduction_and_excludes_update_fallback(self):
        child=self.file('bill_events',"SELECT * FROM (VALUES ('a','bill_added','2001-02-03','2026-01-01'),('b','bill_added','2025-01-01','2026-01-01'),('c','bill_added','2026-01-01','2026-01-01'),('a','stage_changed','2025-01-01','2026-01-01')) t(bill_id,event_type,occurred_at,detected_at)")
        parent=self.file('bill_dates',"SELECT * FROM (VALUES ('a','2001-02-03'),('b',NULL),('c','2026-01-01')) t(bill_id,introduced_date)")
        dim=self.dim('activity-bill-introduction','inherited',[]);dim['parent']={'table':'congress_bills','mode':'same-generation','keys':[['bill_id','bill_id']]}
        d=coverage.scan_special(self.conn,'public_activity_events',self.table(child,4),dim,Inputs(self.parent(parent,3,'congress_bills')))
        self.assertEqual(d['buckets'],{'2001-02':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(1,3));self.assertEqual(d['possibleFallbackRows'],2)

    def test_committee_passage_future_date_is_retained_as_anomaly(self):
        child=self.file('action_dates',"SELECT * FROM (VALUES ('2001-02-03','1'),('2204-01-22','1'),('2002-02-03','2')) t(stated_date,stated_date_count)")
        table=self.table(child,3);table['publishedAt']='2026-10-03T21:08:56Z'
        d=coverage.scan_special(self.conn,'bill_committee_actions',table,self.dim('committee-action-dates','date',['stated_date']),None)
        self.assertEqual(d['buckets'],{'2001-02':1});self.assertEqual(d['anomalies']['futureActivityRows'],1);self.assertEqual(d['anomalies']['futureDateValues'],{'2204-01-22':1});self.assertEqual((d['placedRows'],d['unplacedRows']),(1,2))

    def test_composite_document_parent_refuses_wrong_text_version(self):
        from coverage_inputs import inherit_unique
        child=self.file('action_source',"SELECT * FROM (VALUES ('report','hash-a'),('report','hash-b')) t(document_key,text_sha256)")
        parent=self.file('retained_reports',"SELECT 'report' package_id,'hash-a' text_sha256,'2002-02-03' date_issued")
        table=self.table(child,2)
        dim={'id':'source-date','kind':'inherited','fields':[],'label':'Source report issue','meaning':'Exact retained text context.','parent':{'table':'house_activity_reports','mode':'same-generation','keys':[['document_key','package_id'],['text_sha256','text_sha256']]},'dimension':{'id':'issue','kind':'date','fields':['date_issued'],'label':'Source issue','meaning':'Exact retained report issue.'}}
        d=inherit_unique(self.conn,[child],table['rows'],self.parent(parent,1,'house_activity_reports'),dim['parent'],dim['dimension'])
        self.assertEqual(d['buckets'],{'2002-02':1});self.assertEqual((d['matchedRows'],d['unmatchedRows']),(1,1))


if __name__=='__main__':unittest.main()
