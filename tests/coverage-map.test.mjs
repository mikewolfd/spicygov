import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
async function module(path) {
  const {outputFiles} = await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

const {parseCoverageMaps, currentCoverageMap, coverageMapForDisplay, coverageMapCounts, dimensionPeriodRows, scopeLabel, coverageFieldLabel, textAvailabilityDetails, coverageStatement, coveragePeriodLabel, coverageItemNoun, coverageCategoryDisplay, coverageCategoryMatches} = await module('lib/coverage-map.ts');
const {parseComments} = await module('lib/source-directory.ts');
const {coverageInputsFingerprint} = await module('lib/coverage-map.ts');
const {publisherNames, loadCoveragePublishers, coveragePublisherNames} = await module('lib/coverage-publishers.ts');
const hash = 'sha256:' + 'a'.repeat(64);
const table = {id:'records',family:'test',rows:3,artifactDigest:hash, columns:[{name:'date',type:'DATE'}],members:[{url:'https://example.test/file',rows:3,byteSize:100,sha256:hash}]};
const dimension = {id:'date',label:'Event date',meaning:'Source-stated event dates.',status:'measured',granularity:'month',rows:3,placedRows:2,unplacedRows:1,buckets:{'2024-01':1,'2024-02':1}};
const map = {fingerprint:JSON.stringify([[hash,3,100]]),inputsFingerprint:'[]',publishedAt:null,rows:3,family:'test',artifactDigest:hash,schema:[['date','DATE']],status:'measured',classification:'temporal',note:'Selected source rows.',measuredAt:'2026-10-05T00:00:00Z',definitionDigest:hash,dimensions:[dimension]};
const document = () => ({format:'spicygov-coverage-maps',version:1,partial:false,generatedAt:'2026-10-05T00:00:00Z',censusDigest:hash,tables:{records:structuredClone(map)}});
test('native snapshot coverage becomes stale when a selected receipt, run or pointer changes',()=>{
 const snapshot={pointer:{snapshot_id:'snapshot_native',label:'café😀'},manifestDefinitionDigest:hash,generationId:'selected',subjects:[{key:'records.parquet',rows:3,byteSize:100,sha256:hash}],receipts:{key:'etl_receipts.parquet',rows:3,byteSize:200,sha256:hash}};
 const selected={...table,rulemakingSnapshot:snapshot};
 const raw=document();raw.tables.records.inputsFingerprint=coverageInputsFingerprint(selected);
 const maps=parseCoverageMaps(raw);
 assert.ok(currentCoverageMap(selected,maps));
 assert.match(raw.tables.records.inputsFingerprint,/caf\\u00e9\\ud83d\\ude00/);
 for(const changed of [{...snapshot,generationId:'different'},{...snapshot,manifestDefinitionDigest:'sha256:'+'b'.repeat(64)},{...snapshot,pointer:{...snapshot.pointer,snapshot_id:'snapshot_other'}},{...snapshot,receipts:{...snapshot.receipts,sha256:'sha256:'+'b'.repeat(64)}}]) assert.equal(currentCoverageMap({...selected,rulemakingSnapshot:changed},maps),undefined);
 assert.equal(coverageInputsFingerprint(table),'[]');
});

test('coverage maps bind exact publication, schema and family, including carried input changes', () => {
  const maps = parseCoverageMaps(document());
  assert.ok(currentCoverageMap(table,maps));
  for (const changed of [{...table,artifactDigest:'sha256:'+'b'.repeat(64)},{...table,rows:4},{...table,family:'other'},{...table,columns:[{name:'date',type:'VARCHAR'}]}]) assert.equal(currentCoverageMap(changed,maps),undefined);
});

test('measurement-month coverage expires at a UTC rollover even without anomalies', t => {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-31T23:59:59Z').getTime()});
  const raw=document();
  raw.tables.records.dimensions[0].activityBoundary={month:'2026-10',basis:'measurement-month'};
  const maps=parseCoverageMaps(raw);
  assert.ok(currentCoverageMap(table,maps));
  t.mock.timers.setTime(new Date('2026-11-01T00:00:00Z').getTime());
  assert.equal(currentCoverageMap(table,maps),undefined);
  raw.tables.records.publishedAt='2026-09-30T23:30:00-02:00';
  raw.tables.records.dimensions[0].activityBoundary.basis='publication-month';
  assert.ok(currentCoverageMap({...table,published:raw.tables.records.publishedAt},parseCoverageMaps(raw)));
});

test('activity month basis must match the bound publication timestamp', () => {
  for (const [publishedAt,boundary] of [
    [null,{month:'2026-10',basis:'publication-month'}],
    ['2026-09-30T23:30:00-02:00',{month:'2026-09',basis:'publication-month'}],
    ['2026-10-05T00:00:00Z',{month:'2026-10',basis:'measurement-month'}],
    ['2026-02-30T00:00:00Z',{month:'2026-03',basis:'publication-month'}],
    ['2026-10-05',{month:'2026-10',basis:'publication-month'}],
  ]) {
    const raw=document();raw.tables.records.publishedAt=publishedAt;
    raw.tables.records.dimensions[0].activityBoundary=boundary;
    assert.throws(()=>parseCoverageMaps(raw),/activity boundary/);
    const maps=parseCoverageMaps(document());
    maps.tables.records.publishedAt=publishedAt;
    maps.tables.records.dimensions[0].activityBoundary=boundary;
    assert.equal(currentCoverageMap({...table,published:publishedAt},maps),undefined);
  }
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
  assert.equal(coverageFieldLabel('edition'), 'Source edition');
});

test('cycle labels explain their period without converting other source years or unusual cycles', () => {
  const cycle = {...dimension, label:'Source election cycle',granularity:'year'};
  assert.equal(coveragePeriodLabel(cycle,'2026'), 'Cycle ending 2026 (2025–2026)');
  assert.equal(coveragePeriodLabel(cycle,'2025'), 'Cycle label 2025');
  assert.equal(coveragePeriodLabel({...cycle,label:'Fiscal year'},'2026'), '2026');
  assert.equal(coveragePeriodLabel({...cycle,label:'Edition years'},'2026'), '2026');
  assert.equal(coveragePeriodLabel({...dimension,label:'Receipt dates'},'2026-01'), '2026-01');
  assert.equal(coverageStatement({...dimension,meaning:'Regulations.gov dates describe postings. Receipt dates remain separate.'}), 'Regulations.gov dates describe postings.');
});

test('primary meaning keeps U.S. Code together and preserves the edition qualification in checks', async () => {
  const {TableCoverageMap}=await coverageComponent();
  const raw=document();
  const meaning='Saved electronic regulation and U.S. Code selections, grouped by source record and stated edition. Editions can be release identifiers or requested dates, rather than calendar years.';
  Object.assign(raw.tables.records.dimensions[0],{label:'Selected source records and editions',meaning});
  assert.equal(coverageStatement(raw.tables.records.dimensions[0]),'Saved electronic regulation and U.S. Code selections, grouped by source record and stated edition.');
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps:parseCoverageMaps(raw),view:{year:2024,mode:'years'}}));
  const [visible,checks]=html.split('<details class="coverage-checks">');
  assert.match(visible,/U\.S\. Code selections, grouped by source record and stated edition\./);
  assert.match(checks,/Editions can be release identifiers or requested dates, rather than calendar years\./);
});

test('short category labels retain exact request scopes and never fabricate publisher names', () => {
  const selected={...dimension,id:'selected_source_scopes',fields:[]};
  const key=JSON.stringify(['fec_access','no-record-rejections','https://api.open.fec.gov/v1/schedules/schedule_c/?loan_source_name=BANK&min_incurred_date=2025-01-01']);
  const before=structuredClone(selected);
  const shown=coverageCategoryDisplay(selected,key);
  assert.ok(!shown.label.includes('https://'));
  assert.match(shown.label,/schedule c/);assert.match(shown.label,/BANK/);
  assert.match(shown.label,/Selected records parsed/);
  assert.equal(shown.exact,scopeLabel(key,[]));
  assert.deepEqual(selected,before);
  assert.equal(coverageItemNoun(selected),'selected files and requests');
  const publisher={...dimension,fields:['publisher_id']};
  assert.deepEqual(coverageCategoryDisplay(publisher,'["afp"]'),{label:'Publisher ID: afp',exact:'afp'});
  assert.equal(scopeLabel('["selection_context"]',['record_outcome']),'Selection notes');
  assert.equal(scopeLabel('["selection_context"]',['publisher_period']),'selection_context');
});

async function coverageComponent() {
  const require=createRequire(import.meta.url);
  const {outputFiles}=await build({entryPoints:['components/coverage-map.tsx'],bundle:true,platform:'node',format:'esm',write:false,loader:{'.css':'empty'},plugins:[{name:'shared-react',setup(builder){
    builder.onResolve({filter:/^react(?:\/jsx-runtime|\/jsx-dev-runtime)?$/},args=>({path:pathToFileURL(require.resolve(args.path)).href,external:true}));
  }}]});
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}

test('default coverage keeps checks collapsed and preserves exclusions and source cautions inside', async () => {
  const {TableCoverageMap}=await coverageComponent();
  const raw=document();const dim=raw.tables.records.dimensions[0];
  dim.meaning='Source-stated event dates. Missing dates do not establish missing records.';
  dim.notes=['0 rows have invalid dates.'];
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps:parseCoverageMaps(raw),view:{year:2024,mode:'years'}}));
  const [visible,checks]=html.split('<details class="coverage-checks">');
  assert.match(visible,/Source-stated event dates/);assert.doesNotMatch(visible,/0 rows have invalid dates|Missing dates do not|Rows not counted/);
  assert.match(checks,/How this count was checked/);assert.match(checks,/0 rows have invalid dates/);assert.match(checks,/Missing dates do not establish missing records/);
  assert.match(checks,/Rows not counted for this field/);assert.match(checks,/<dd>1<\/dd>/);
  assert.doesNotMatch(html,/<details class="coverage-checks" open/);
});

test('month view explains missing precision rather than showing twelve misleading empty months', async () => {
  const {TableCoverageMap}=await coverageComponent();const raw=document();
  Object.assign(raw.tables.records.dimensions[0],{granularity:'year',buckets:{'2024':2}});
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps:parseCoverageMaps(raw),view:{year:2024,mode:'months'}}));
  assert.match(html,/Month counts are unavailable/);assert.match(html,/years/);
  assert.match(html,/2 rows counted for 2024/);assert.doesNotMatch(html,/time-empty|2024-01/);
});

test('snapshot primary text contains no calendar warning and preserves its calculation facts', async () => {
  const {TableCoverageMap}=await coverageComponent();const raw=document();
  Object.assign(raw.tables.records.dimensions[0],{label:'Agency totals',meaning:'Totals from the saved source inputs. This is one saved release.',granularity:'snapshot',buckets:{},placedRows:3,unplacedRows:0,snapshot:{asOf:'2026-10-03T21:53:05Z',facts:[{label:'Measure',value:'Saved agency totals'}]}});
  raw.tables.records.note='An empty period does not establish source completeness.';
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps:parseCoverageMaps(raw),view:{year:2024,mode:'years'}}));
  const visible=html.split('<details class="coverage-checks">')[0];
  assert.match(visible,/3 rows/);assert.match(visible,/Saved agency totals/);assert.match(visible,/UTC/);
  assert.doesNotMatch(visible,/empty period|future|time-cell/);
});

const publisherRows=[{publisher_id:'afp',name:'Americans for Prosperity'},{publisher_id:'aauw',name:'American Association of University Women'}];
const publisherBytes=new TextEncoder().encode(JSON.stringify(publisherRows)).buffer;
const publisherHash='sha256:'+createHash('sha256').update(new Uint8Array(publisherBytes)).digest('hex');
function publisherFixture() {
  const source={...table,id:'scorecard_publishers',family:'scorecards',rows:2,columns:[{name:'publisher_id',type:'VARCHAR'},{name:'name',type:'VARCHAR'}],members:[{...table.members[0],rows:2,byteSize:publisherBytes.byteLength,sha256:publisherHash}]};
  const dim={...dimension,id:'publishers',label:'Publishers',fields:['publisher_id'],granularity:'category',rows:2,placedRows:2,unplacedRows:0,buckets:{'["afp"]':1,'["aauw"]':1}};
  const raw=document();raw.tables={scorecard_publishers:{...map,family:'scorecards',rows:2,fingerprint:JSON.stringify([[publisherHash,2,publisherBytes.byteLength]]),schema:[['publisher_id','VARCHAR'],['name','VARCHAR']],dimensions:[dim]}};
  return {source,dim,maps:parseCoverageMaps(raw)};
}

test('publisher lookup reads only the small bound publisher list and retains actual names', async () => {
  const {source,maps}=publisherFixture();let calls=0;
  const publishers=await loadCoveragePublishers([source],maps,undefined,{fetchMember:async member=>{calls++;assert.equal(member,source.members[0]);return publisherBytes.slice(0);},decode:async (buffer,rows)=>{
    assert.equal(buffer.byteLength,publisherBytes.byteLength);assert.equal(rows,2);return publisherRows;
  }});
  assert.equal(calls,1);assert.equal(publishers.names.get('afp'),'Americans for Prosperity');
  const dim=maps.tables.scorecard_publishers.dimensions[0];
  const names=coveragePublisherNames(source,maps,dim,publishers);
  assert.deepEqual(coverageCategoryDisplay(dim,'["afp"]',names),{label:'Americans for Prosperity',exact:'afp'});
  assert.deepEqual(coverageCategoryDisplay(dim,'["unknown"]',names),{label:'Publisher ID: unknown',exact:'unknown'});
  assert.equal(coverageCategoryMatches(dim,'["afp"]','Americans for Prosperity',names),true);
  assert.equal(coverageCategoryMatches(dim,'["afp"]',' afp ',names),true);
  assert.equal(coverageCategoryMatches(dim,'["afp"]','University Women',names),false);
  assert.equal(coverageCategoryMatches(dim,'["afp"]','Americans for Prosperity'),false);
});

test('coverage renders recorded publisher names only while its lookup remains bound', async () => {
  const {TableCoverageMap}=await coverageComponent();const {source,maps}=publisherFixture();
  const publishers={source,names:new Map([['afp','Americans for Prosperity'],['aauw','American Association of University Women']])};
  const props={table:source,maps,publishers,view:{year:2026,mode:'years'}};
  const html=renderToStaticMarkup(createElement(TableCoverageMap,props));
  assert.match(html,/Americans for Prosperity/);assert.match(html,/American Association of University Women/);
  const unbound=renderToStaticMarkup(createElement(TableCoverageMap,{...props,publishers:{...publishers,source:{...source,artifactDigest:'sha256:'+'b'.repeat(64)}}}));
  assert.doesNotMatch(unbound,/Americans for Prosperity/);assert.match(unbound,/Publisher ID: afp/);
});

test('prior release maps stay visible with their original date and counts, without qualifying as current', async () => {
  const {TableCoverageMap}=await coverageComponent();const maps=parseCoverageMaps(document());
  maps.tables.records.publishedAt='2026-10-04T12:30:00Z';
  const changed={...table,published:'2026-10-06T02:54:15Z',rows:4,artifactDigest:'sha256:'+'b'.repeat(64)};
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table:changed,maps,onRetry:()=>{},view:{year:2024,mode:'years'}}));
  assert.equal(currentCoverageMap(changed,maps),undefined);
  assert.equal(coverageMapForDisplay(changed,maps).freshness,'previous-release');
  assert.match(html,/Previous release.*Refresh pending/);
  assert.match(html,/datetime="2026-10-04T12:30:00Z"/i);
  assert.match(html,/3 rows\. The current release has not been checked/);
  assert.doesNotMatch(html,/4 rows/);
  assert.match(html,/2024: 2 rows counted here/);
  assert.match(html,/Count by|Event date/);
  assert.match(html,/Reload published counts/);
  assert.doesNotMatch(html,/recalculate|scan records/i);
});

test('expired monthly measurements stay visible with their check date and a distinct refresh notice', async t => {
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T00:00:00Z').getTime()});
  const {TableCoverageMap}=await coverageComponent();const raw=document();
  raw.tables.records.dimensions[0].activityBoundary={month:'2026-10',basis:'measurement-month'};
  const maps=parseCoverageMaps(raw);
  assert.equal(currentCoverageMap(table,maps),undefined);
  assert.equal(coverageMapForDisplay(table,maps).freshness,'previous-measurement');
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps,view:{year:2024,mode:'years'}}));
  assert.match(html,/Previous measurement.*Refresh pending/);
  assert.match(html,/datetime="2026-10-05T00:00:00Z"/i);
  assert.match(html,/Counts have not been refreshed for this month/);
  assert.match(html,/2024: 2 rows counted here/);
  assert.doesNotMatch(html,/Previous release/);
});

test('display fallback refuses another family and distinguishes current, previous and missing maps in summaries', async () => {
  const {TableCoverageMap,SourceCoverageSummary}=await coverageComponent();const raw=document();
  raw.tables.previous=structuredClone(map);
  const maps=parseCoverageMaps(raw);
  const previous={...table,id:'previous',published:'2026-10-06T00:00:00Z'};
  const missing={...table,id:'missing'};
  assert.equal(coverageMapForDisplay(table,maps).freshness,'current');
  assert.equal(coverageMapForDisplay(missing,maps),undefined);
  assert.equal(coverageMapForDisplay({...table,family:'another'},maps),undefined);
  assert.deepEqual(coverageMapCounts([table,previous,missing],maps),{current:1,previous:1});
  const summary=renderToStaticMarkup(createElement(SourceCoverageSummary,{tables:[table,previous,missing],maps,view:{year:2024,mode:'years'}}));
  assert.match(summary,/available for 2 of 3 tables/);
  assert.match(summary,/1 map awaits refresh/);
  for (const unavailable of [missing,{...table,family:'another'}]) {
    const html=renderToStaticMarkup(createElement(TableCoverageMap,{table:unavailable,maps,onRetry:()=>{},view:{year:2024,mode:'years'}}));
    assert.match(html,/Coverage counts are not available for this table/);
    assert.doesNotMatch(html,/Previous release|2024: 2 rows/);
  }
  const current=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps,view:{year:2024,mode:'years'}}));
  assert.doesNotMatch(current,/Refresh pending/);
});

test('previous publisher coverage keeps recorded IDs instead of borrowing names from a newer release', async () => {
  const {TableCoverageMap}=await coverageComponent();const {source,maps}=publisherFixture();
  const publishers={source,names:new Map([['afp','Americans for Prosperity']])};
  const changed={...source,artifactDigest:'sha256:'+'b'.repeat(64)};
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table:changed,maps,publishers,view:{year:2026,mode:'years'}}));
  assert.match(html,/Previous release/);
  assert.match(html,/Publisher ID: afp/);
  assert.doesNotMatch(html,/Americans for Prosperity/);
});

test('publisher lookup refuses stale maps, large lists, incomplete reads and conflicting names', async () => {
  const {source,maps}=publisherFixture();let calls=0;const readers={fetchMember:async()=>{calls++;return publisherBytes.slice(0);},decode:async()=>[]};
  assert.equal(await loadCoveragePublishers([{...source,artifactDigest:'sha256:'+'b'.repeat(64)}],maps,undefined,readers),undefined);
  assert.equal(await loadCoveragePublishers([{...source,rows:201}],maps,undefined,readers),undefined);assert.equal(calls,0);
  for (const capped of [
    {...source,rows:201,members:[{...source.members[0],rows:201}]},
    {...source,members:[{...source.members[0],byteSize:1048577}]},
    {...source,members:[{...source.members[0],sha256:undefined}]},
  ]) {
    const boundMap={...maps.tables[source.id],rows:capped.rows,fingerprint:JSON.stringify(capped.members.map(member=>[member.sha256??member.url,member.rows,member.byteSize])),dimensions:[{...maps.tables[source.id].dimensions[0],rows:capped.rows,placedRows:capped.rows,buckets:{'["afp"]':capped.rows}}]};
    const bound=parseCoverageMaps({...document(),tables:{[source.id]:boundMap}});
    assert.ok(currentCoverageMap(capped,bound));
    assert.equal(await loadCoveragePublishers([capped],bound,undefined,readers),undefined);
  }
  assert.equal(calls,0);
  await assert.rejects(loadCoveragePublishers([source],maps,undefined,readers),/read in full/);
  assert.throws(()=>publisherNames([{publisher_id:'a',name:'One'},{publisher_id:'a',name:'Another'}]),/conflicting names/);
  assert.equal(publisherNames([{publisher_id:'a',name:'One'},{publisher_id:'a',name:'One'}]).get('a'),'One');
  assert.equal(publisherNames([{publisher_id:'a',name:null}]).has('a'),false);
});

test('publisher names require a current target and the exact held generation, never latest-to-old matching', () => {
  const {source,maps}=publisherFixture(), held=source.artifactDigest, other='sha256:'+'b'.repeat(64);
  const target={...source,id:'scorecard_item_links',family:'scorecard-analysis',artifactDigest:other};
  const dim={...maps.tables.scorecard_publishers.dimensions[0],parent:{family:'scorecards',artifactDigest:held}};
  maps.tables[target.id]={...maps.tables[source.id],family:target.family,artifactDigest:other,dimensions:[dim]};
  const publishers={source,names:new Map([['afp','Americans for Prosperity']])};
  assert.equal(coveragePublisherNames(target,maps,dim,publishers),publishers.names);
  dim.parent.artifactDigest=other;assert.equal(coveragePublisherNames(target,maps,dim,publishers),undefined);
  dim.parent={family:'unrelated',artifactDigest:held};assert.equal(coveragePublisherNames(target,maps,dim,publishers),undefined);
  delete dim.parent;assert.equal(coveragePublisherNames(target,maps,dim,publishers),undefined);
  assert.equal(coveragePublisherNames({...target,rows:3},maps,dim,publishers),undefined);
  assert.equal(coveragePublisherNames(target,maps,{...dim},publishers),undefined);
  assert.equal(coveragePublisherNames(target,{...maps,tables:{[target.id]:maps.tables[target.id]}},dim,publishers),undefined);
});

test('publisher checksum is verified before decoding and tampered bytes never supply names', async () => {
  const {source,maps}=publisherFixture();let decoded=0;
  const altered=publisherBytes.slice(0);new Uint8Array(altered)[0]^=1;
  await assert.rejects(loadCoveragePublishers([source],maps,undefined,{fetchMember:async()=>altered,decode:async()=>{decoded++;return publisherRows;}}),/checksum does not match/);
  assert.equal(decoded,0);
  await assert.rejects(loadCoveragePublishers([source],maps,undefined,{fetchMember:async()=>publisherBytes.slice(1),decode:async()=>{decoded++;return publisherRows;}}),/size does not match/);
  assert.equal(decoded,0);
  const valid=await loadCoveragePublishers([source],maps,undefined,{fetchMember:async()=>publisherBytes.slice(0),decode:async buffer=>{decoded++;assert.deepEqual(new Uint8Array(buffer),new Uint8Array(publisherBytes));return publisherRows;}});
  assert.equal(decoded,1);assert.equal(valid.names.get('afp'),'Americans for Prosperity');
});

test('readable labels retain exact source evidence and do not infer completeness', () => {
  const dim = {...dimension, granularity:'category', fields:['source_family','source_record_key','edition']};
  const key = '["ecfr","ecfr/title/1","requested-as-of:2026-08-10"]';
  const shown = coverageCategoryDisplay(dim,key);
  assert.equal(shown.label,'eCFR · eCFR Title 1 · Requested as of Aug 10, 2026');
  assert.equal(shown.exact,'ecfr · ecfr/title/1 · requested-as-of:2026-08-10');
  assert.ok(coverageCategoryMatches(dim,key,'requested-as-of:2026-08-10'));
  assert.ok(coverageCategoryMatches(dim,key,'eCFR Title 1'));
  assert.equal(scopeLabel('["complete_selected_shapes"]',['read_status']),'Finished supported reference checks');
  assert.equal(scopeLabel('["not_flagged","pdf_extracted"]',['body_completeness','body_completeness']),'No completeness flag · Text extracted from PDF');
  assert.equal(scopeLabel('["not-asserted"]',['query_completeness']),'Completeness not established');
  assert.equal(scopeLabel('["refused_native_observation_not_qualified_empty_success"]',['outcome_status']),'Request refused; not a confirmed empty result');
  assert.equal(scopeLabel('["119-103"]',['edition']),'119-103');
  assert.equal(scopeLabel('["requested-as-of:2026-02-31"]',['edition']),'requested-as-of:2026-02-31');
});

test('translations stay within their fields and preserve unknown and missing values', () => {
  assert.equal(scopeLabel('[true,false,null]',['is_current','is_current','is_current']),'Current list · Historical list · null');
  assert.equal(scopeLabel('["true","false"]',['detail_read','detail_read']),'Details read · List only');
  assert.equal(scopeLabel('["complete_selected_shapes"]',['publisher_period']),'complete_selected_shapes');
  assert.equal(scopeLabel('["billstatus_bulk"]',['publisher_id']),'billstatus_bulk');
  assert.equal(scopeLabel('["new_reader_status"]',['read_status']),'new_reader_status');
  assert.equal(scopeLabel('["constructor","__proto__"]',['constructor','source']),'constructor · __proto__');
  const dim = {...dimension, fields:['is_current','body_completeness']};
  assert.equal(coverageCategoryDisplay(dim,'[null,"not_flagged"]').exact,'null · not_flagged');
});

test('rendered matrices show readable fields and retain original codes without changing counts', async () => {
  const {TableCoverageMap}=await coverageComponent();const raw=document();
  Object.assign(raw.tables.records.dimensions[0],{label:'Body state',granularity:'category',fields:['source','body_completeness'],buckets:{'["billstatus_bulk","not_flagged"]':2}});
  const before=structuredClone(raw),maps=parseCoverageMaps(raw);
  const html=renderToStaticMarkup(createElement(TableCoverageMap,{table,maps,view:{year:2024,mode:'years'}}));
  assert.match(html,/Report text status/);
  assert.match(html,/Text status by Collection source/);
  assert.match(html,/GovInfo bill-status files/);
  assert.match(html,/No completeness flag/);
  assert.match(html,/Original field values/);
  assert.match(html,/<code>not_flagged<\/code>/);
  assert.match(html,/<td[^>]*>2<\/td>/);
  assert.deepEqual(raw,before);
  assert.deepEqual(maps.tables.records.dimensions[0],before.tables.records.dimensions[0]);
  assert.ok(currentCoverageMap(table,maps));
});
