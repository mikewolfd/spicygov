import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function module(path) {
  const {outputFiles} = await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const {parseCoverageMaps, currentCoverageMap, dimensionPeriodRows, scopeLabel, coverageFieldLabel, textAvailabilityDetails} = await module('lib/coverage-map.ts');
const {parseComments} = await module('lib/source-directory.ts');
const hash = 'sha256:' + 'a'.repeat(64);
const table = {id:'records',family:'test',rows:3,artifactDigest:hash, columns:[{name:'date',type:'DATE'}],members:[{url:'https://example.test/file',rows:3,byteSize:100,sha256:hash}]};
const dimension = {id:'date',label:'Event date',meaning:'Source-stated event dates.',status:'measured',granularity:'month',rows:3,placedRows:2,unplacedRows:1,buckets:{'2024-01':1,'2024-02':1}};
const map = {fingerprint:JSON.stringify([[hash,3,100]]),inputsFingerprint:'[]',publishedAt:null,rows:3,family:'test',artifactDigest:hash,schema:[['date','DATE']],status:'measured',classification:'temporal',note:'Selected source rows.',measuredAt:'2026-10-05T00:00:00Z',definitionDigest:hash,dimensions:[dimension]};
const document = () => ({format:'spicygov-coverage-maps',version:1,partial:false,generatedAt:'2026-10-05T00:00:00Z',censusDigest:hash,tables:{records:structuredClone(map)}});

test('coverage maps bind exact publication, schema and family, including carried input changes', () => {
  const maps = parseCoverageMaps(document());
  assert.ok(currentCoverageMap(table,maps));
  for (const changed of [{...table,artifactDigest:'sha256:'+'b'.repeat(64)},{...table,rows:4},{...table,family:'other'},{...table,columns:[{name:'date',type:'VARCHAR'}]}]) assert.equal(currentCoverageMap(changed,maps),undefined);
});

test('text summaries retain blank versus unsaved values and refuse stale or unclassified results', () => {
  const raw = document();
  raw.tables.records.dimensions = [{...dimension,id:'saved-inline-text',granularity:'category',placedRows:3,unplacedRows:0,buckets:{'["saved_nonblank_text"]':1,'["no_saved_text"]':1,'["saved_blank_text"]':1}}];
  assert.deepEqual(textAvailabilityDetails(table,parseCoverageMaps(raw)),[{label:'Inline text',rows:3,withText:1,notSaved:1,blank:1}]);
  assert.deepEqual(textAvailabilityDetails({...table,artifactDigest:'sha256:'+'b'.repeat(64)},parseCoverageMaps(raw)),[]);
  const dim = raw.tables.records.dimensions[0];
  dim.placedRows=2;dim.unplacedRows=1;delete dim.buckets['["saved_blank_text"]'];
  assert.deepEqual(textAvailabilityDetails(table,parseCoverageMaps(raw)),[]);
  dim.placedRows=3;dim.unplacedRows=0;dim.buckets['["unknown_class"]']=1;
  assert.deepEqual(textAvailabilityDetails(table,parseCoverageMaps(raw)),[]);
});

test('partial audits and unreconciled dimensions cannot be published as complete maps', () => {
  const partial = document(); partial.partial=true;
  assert.throws(()=>parseCoverageMaps(partial));
  for (const change of [dim=>dim.unplacedRows=2,dim=>dim.buckets['2024-13']=1,dim=>dim.status='unknown',dim=>dim.rows=4]) {
    const raw=document(); change(raw.tables.records.dimensions[0]); assert.throws(()=>parseCoverageMaps(raw));
  }
});

test('publication timestamp movement invalidates otherwise unchanged coverage bytes', () => {
  const raw=document();raw.tables.records.publishedAt='2026-10-04T00:00:00Z';
  const maps=parseCoverageMaps(raw);
  assert.ok(currentCoverageMap({...table,published:'2026-10-04T00:00:00Z'},maps));
  assert.equal(currentCoverageMap({...table,published:'2026-10-05T00:00:00Z'},maps),undefined);
  assert.equal(currentCoverageMap(table,maps),undefined);
  assert.ok(currentCoverageMap(table,parseCoverageMaps(document())));
  delete raw.tables.records.publishedAt;
  assert.ok(currentCoverageMap(table,parseCoverageMaps(raw)));
  raw.tables.records.publishedAt='not a date';assert.throws(()=>parseCoverageMaps(raw));
});

test('paired comments inputs invalidate either map when only the other export changes', () => {
  const receipt={format_version:1,source:{schema_id:6},files:{
    'comments.parquet':{rows:100,bytes:1000,sha256:hash,etag:'comments-etag'},
    'comments_index.parquet':{rows:5,bytes:100,sha256:hash,etag:'index-etag'},
  }};
  const inputsFingerprint = tables => JSON.stringify(tables[0].coverageInputs.map(i=>[i.id,i.url,i.rows,i.byteSize,i.sha256,i.etag]));
  const original=parseComments(receipt);
  for (const dataset of original) {
    const raw=document();raw.tables={};
    raw.tables[dataset.id]={...map,artifactDigest:undefined,family:'comments',rows:dataset.rows,
      fingerprint:JSON.stringify(dataset.members.map(member=>[member.sha256??member.url,member.rows,member.byteSize])),publicationSha256:hash,
      inputsFingerprint:inputsFingerprint(original),
      dimensions:[{...dimension,rows:dataset.rows,placedRows:dataset.rows,unplacedRows:0,buckets:{'2024-01':dataset.rows}}]};
    const maps=parseCoverageMaps(raw);assert.ok(currentCoverageMap(dataset,maps));
    const changed=structuredClone(receipt);
    const other=dataset.id==='comments'?'comments_index.parquet':'comments.parquet';
    for (const [field,value] of [['sha256','sha256:'+'b'.repeat(64)],['etag','new-etag'],['bytes',1234],['rows',42]]) {
      const update=structuredClone(changed);update.files[other][field]=value;
      const current=parseComments(update).find(t=>t.id===dataset.id);
      assert.equal(currentCoverageMap(current,maps),undefined,`${dataset.id}: other ${field}`);
    }
    const reversed={...dataset,coverageInputs:[...dataset.coverageInputs].reverse()};
    assert.ok(currentCoverageMap(reversed,maps));
  }
});

test('snapshots and auxiliary counts obey the same limits as the measurement builder', () => {
  for (const change of [
    dim=>dim.partialRows=3,dim=>dim.partialRows=-1,dim=>dim.partialRows=1.5,
    dim=>dim.matchedRows=4,dim=>dim.unmatchedRows=-1,
    dim=>{dim.matchedRows=1;dim.unmatchedRows=1;},
    dim=>dim.overlapping='true',dim=>dim.overlapping=null,
    dim=>{dim.granularity='snapshot';dim.buckets={'2024-01':1};},
  ]) {const raw=document();change(raw.tables.records.dimensions[0]);assert.throws(()=>parseCoverageMaps(raw));}
  const valid=document();Object.assign(valid.tables.records.dimensions[0],{granularity:'snapshot',buckets:{},placedRows:3,unplacedRows:0,partialRows:0,matchedRows:2,unmatchedRows:1,overlapping:false});
  assert.doesNotThrow(()=>parseCoverageMaps(valid));
  for (const fingerprint of [undefined,null,42]) {const raw=document();raw.tables.records.inputsFingerprint=fingerprint;assert.throws(()=>parseCoverageMaps(raw));}
});

test('annual membership counts cannot double count monthly list or interval rows', () => {
  const overlap={...dimension,overlapping:true,buckets:{'2024-01':2,'2024-02':2},placedRows:2,yearBuckets:{'2024':2}};
  assert.equal(dimensionPeriodRows(overlap,'2024'),2);
  assert.equal(dimensionPeriodRows({...overlap,yearBuckets:undefined},'2024'),undefined);
  assert.equal(dimensionPeriodRows(overlap,'2025'),0);
  assert.equal(dimensionPeriodRows({...dimension,granularity:'year'},'2024-01'),undefined);
});

test('snapshot calculation facts retain their own time and reject malformed facts', () => {
  const raw=document(); const dim=raw.tables.records.dimensions[0];
  Object.assign(dim,{granularity:'snapshot',buckets:{},placedRows:3,unplacedRows:0,snapshot:{publishedAt:'2026-10-03T21:53:09Z',asOf:'2026-10-03T21:53:05.434554+00:00',facts:[{label:'Comparison measure',value:'Monthly average across the comparison window'}]}});
  const parsed=parseCoverageMaps(raw).tables.records.dimensions[0];
  assert.notEqual(parsed.snapshot.asOf,parsed.snapshot.publishedAt);
  assert.deepEqual(parsed.snapshot.facts,dim.snapshot.facts);
  for(const change of [snapshot=>snapshot.asOf='not a date',snapshot=>snapshot.asOf='2026-10-03',snapshot=>snapshot.asOf='2026-02-31T21:53:05Z',snapshot=>snapshot.asOf='0000-10-03T21:53:05Z',snapshot=>snapshot.asOf='2026-10-03T21:53:05+00:60',snapshot=>snapshot.facts='facts',snapshot=>snapshot.facts=[{label:'Window',value:null}],snapshot=>snapshot.facts=[{label:'',value:'window'}]]) {
    const invalid=structuredClone(raw); change(invalid.tables.records.dimensions[0].snapshot); assert.throws(()=>parseCoverageMaps(invalid));
  }
});

test('edition scopes and literal publisher labels retain their units', () => {
  assert.equal(scopeLabel('["2026","5"]'),'2026 · 5');
  assert.equal(scopeLabel('Lifetime'),'Lifetime');
  assert.equal(dimensionPeriodRows({...dimension,granularity:'category'},'2026'),undefined);
  assert.equal(dimensionPeriodRows({...dimension,granularity:'snapshot'},'2026'),undefined);
});

test('unresolved source milestones read as source facts instead of raw JSON', () => {
  assert.equal(scopeLabel(JSON.stringify({action:'Final action',date:null,fr_citation:null,precision:'undated'})), 'Final action · Date not stated');
  assert.equal(scopeLabel(JSON.stringify({action:'Notice',date:'04/31/1991',fr_citation:'56 FR 100',precision:'invalid'})), 'Notice · 04/31/1991 (invalid date) · 56 FR 100');
  assert.equal(scopeLabel(JSON.stringify({value:'{broken',precision:'invalid timetable'})), 'Unreadable timetable');
});

test('known source classes use readable labels only within their stated fields', () => {
  assert.equal(scopeLabel('["single_observed"]', ['scope_status']), 'One linked proceeding');
  assert.equal(scopeLabel('["single_observed"]', ['publisher_period']), 'single_observed');
  assert.equal(scopeLabel('unresolved'), 'unresolved');
  assert.equal(scopeLabel('["native_reference","native_public_law_href"]', ['observation_kind','interpretation_status']), 'Native reference · Public-law link');
  assert.equal(scopeLabel('native_public_law_href', ['interpretation_status']), 'Public-law link');
  assert.equal(scopeLabel('["documents.comment_end_date+federal_register.comments_close_on"]', ['source']), 'Regulations.gov + Federal Register');
  assert.equal(scopeLabel('[null]', ['withdrawal_source']), 'Not recorded');
  assert.equal(scopeLabel('["constructor"]', ['source']), 'constructor');
  assert.equal(scopeLabel('["recurring"]', ['scope_status']), 'Routine and frequent');
  assert.equal(scopeLabel('["bulk"]', ['ingest_source']), 'Bulk export');
  assert.equal(scopeLabel('["bulk"]', ['publisher_period']), 'bulk');
  assert.equal(scopeLabel('["captured_partial","parsed"]', ['uslm_outcome','law_text_outcome']), 'Partial metadata saved · Sections parsed');
  assert.equal(scopeLabel('["f"]', ['date_filed_is_approximate']), 'Marked exact');
  assert.equal(coverageFieldLabel('interpretation_status'), 'Reading result');
  assert.equal(coverageFieldLabel('edition'), 'edition');
});
