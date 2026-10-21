import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

async function load(path) {
  const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],logLevel:'silent'});
  const loaded={exports:{}};
  new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
  return loaded.exports;
}
const {LobbyingProfile}=await load('components/lobbying-profile.tsx');
const {SourceConnections}=await load('components/source-connections.tsx');
const {applyMetadata,defaultColumns}=await load('lib/catalog.ts');
const {lobbyingNavigation,LOBBYING_BODY_NAVIGATION_ID}=await load('lib/lobbying-navigation.ts');
const {parseNavigation,usableNavigation,sourceOccurrences}=await load('lib/navigation.ts');
const {readLocation}=await load('lib/explorer-location.ts');
const {readPage}=await load('lib/reader.ts');
const schema={
  lobbying_filings:[['filing_uuid','VARCHAR'],['filing_type','VARCHAR'],['filing_year','BIGINT'],['filing_period','VARCHAR'],['dt_posted','TIMESTAMP WITH TIME ZONE'],['registrant_name','VARCHAR'],['registrant_id','VARCHAR'],['client_name','VARCHAR'],['client_id','VARCHAR'],['lobbying_activities','STRUCT(general_issue_code VARCHAR, general_issue_code_display VARCHAR, description VARCHAR)[]'],['government_entities','STRUCT(id VARCHAR, "name" VARCHAR)[]']],
  lobbying_activities:[['filing_uuid','VARCHAR'],['activity_index','BIGINT'],['general_issue_code','VARCHAR'],['general_issue_code_display','VARCHAR'],['description','VARCHAR'],['foreign_entity_issues','VARCHAR'],['government_entities','STRUCT(id VARCHAR, "name" VARCHAR)[]']],
  lobbying_activity_lobbyists:[['filing_uuid','VARCHAR'],['activity_index','BIGINT'],['lobbyist_index','BIGINT'],['lobbyist_id','VARCHAR'],...['prefix','first_name','nickname','middle_name','last_name','suffix','covered_position'].map(k=>[k,'VARCHAR']),['new','BOOLEAN']],
};
const identities={lobbying_filings:['filing_uuid'],lobbying_activities:['filing_uuid','activity_index'],lobbying_activity_lobbyists:['filing_uuid','activity_index','lobbyist_index']};
const catalog=Object.entries(schema).map(([id,fields])=>({
  id,label:id,family:'lobbying-filings',metadataState:'current',artifactDigest:'sha256:'+'a'.repeat(64),
  columns:fields.map(([name,type])=>({name,type,description:''})),connectionNotes:[],
  recordIdentity:{columns:identities[id],basis:'declared_main_key',uniqueness:'unknown'},
  coverage:'Synthetic selected snapshot; dates are not inferred.',published:'2026-10-19T00:00:00Z',
  publication:{recordUrl:'https://data.spicygov.ai/generations/lobbying-filings/example/artifact.json'},
}));
const navigation=usableNavigation(parseNavigation(lobbyingNavigation(catalog)),catalog)[0];
const filing={filing_uuid:'original',registrant_id:'100',registrant_name:'Same firm name',client_id:'200',client_name:'Same client name',
  filing_type:'Q2',filing_year:2022n,filing_period:'second_quarter',dt_posted:new Date('2022-07-20T00:00:00Z'),
  lobbying_activities:[{general_issue_code:'SCI',general_issue_code_display:'Science',description:'Literal activity'}],government_entities:[{id:'24',name:'Commerce'}]};
const props=(id,row,extra={})=>({table:catalog.find(t=>t.id===id),row,catalog,bodyNavigation:navigation,onOpen:()=>{},...extra});
const render=(id,row,extra)=>renderToStaticMarkup(createElement(LobbyingProfile,props(id,row,extra)));
function anchors(node) {
  if(!node||typeof node!=='object')return [];
  if(Array.isArray(node))return node.flatMap(anchors);
  return [...(node.type==='a'?[node]:[]),...anchors(node.props?.children)];
}
const route=(node)=>readLocation(new URL(node.props.href,'https://spicygov.ai').search);
const findLink=(id,row,label)=>anchors(LobbyingProfile(props(id,row))).find(node=>node.props.children===label);

test('client history is registrant-scoped, amendments stay separate and complete keys use bounded lists',()=>{
  const label='Client filing history within this registrant';
  const first=route(findLink('lobbying_filings',filing,label));
  const different=route(findLink('lobbying_filings',{...filing,registrant_id:'101',client_id:'201'},label));
  assert.deepEqual(first.filters,[{column:'registrant_id',value:'100'},{column:'client_id',value:'200'}]);
  assert.notDeepEqual(first.filters,different.filters);
  assert.equal(first.detail,undefined);
  const amended={...filing,filing_uuid:'amendment',filing_type:'2A',dt_posted:new Date('1905-01-01T00:00:00Z')};
  assert.deepEqual(route(findLink('lobbying_filings',amended,label)).filters,first.filters);
  const html=render('lobbying_filings',amended);
  assert.match(html,/Filing: amendment/);assert.match(html,/Filing type: 2A/);assert.match(html,/1905-01-01/);
  assert.match(html,/keeps separate filings and amendments/);assert.match(html,/not live coverage/);
  for(const key of ['client_id','registrant_id']) {
    assert.equal(findLink('lobbying_filings',{...filing,[key]:null},label),undefined);
    assert.match(render('lobbying_filings',{...filing,[key]:null}),/source key or published field is missing/);
  }
  assert.deepEqual(route(findLink('lobbying_filings',filing,'Activity record 0')).filters,[{column:'filing_uuid',value:'original'},{column:'activity_index',value:'0'}]);
  assert.equal(route(findLink('lobbying_filings',filing,'Activity record 0')).detail,undefined);
  let opened;
  const tree=LobbyingProfile(props('lobbying_filings',filing,{onOpen:(...args)=>{opened=args;}}));
  const activityLink=anchors(tree).find(node=>node.props.children==='Activity record 0');
  activityLink.props.onClick({preventDefault(){}});
  assert.deepEqual(opened,['lobbying_activities',[{column:'filing_uuid',value:'original'},{column:'activity_index',value:'0'}]]);
  assert.ok(defaultColumns(catalog[0]).includes('filing_type'));
});

test('lobbyist role and source positions remain literal with missing, empty and unresolved identity states',()=>{
  const row={filing_uuid:'original',activity_index:0n,lobbyist_index:3n,lobbyist_id:'7',first_name:'Same',last_name:'Name',covered_position:' Clerk\\nNot a date '};
  const html=render('lobbying_activity_lobbyists',row);
  assert.match(html,/Activity position: 0.*Lobbyist position: 3/);
  assert.ok(html.includes(' Clerk\\nNot a date '));assert.match(html,/not person identities/);
  assert.match(html,/does not establish employment dates, current employment/);
  const label='Occurrences of this lobbyist record within this filing';
  assert.deepEqual(route(findLink('lobbying_activity_lobbyists',row,label)).filters,[{column:'filing_uuid',value:'original'},{column:'lobbyist_id',value:'7'}]);
  assert.notDeepEqual(route(findLink('lobbying_activity_lobbyists',{...row,filing_uuid:'other-firm'},label)).filters,route(findLink('lobbying_activity_lobbyists',row,label)).filters);
  for(const [covered_position,text] of [[null,'Not stated (null)'],['','Empty source text'],['None','None']]) {
    assert.ok(render('lobbying_activity_lobbyists',{...row,covered_position}).includes(text));
  }
  assert.equal(findLink('lobbying_activity_lobbyists',{...row,lobbyist_id:null},label),undefined);
  const roleOccurrence=route(findLink('lobbying_activity_lobbyists',row,'Supporting activity and contacted bodies'));
  assert.deepEqual(roleOccurrence.filters,[{column:'filing_uuid',value:'original'},{column:'activity_index',value:'0'}]);
  assert.equal(roleOccurrence.detail,undefined);
  const parent=route(findLink('lobbying_activity_lobbyists',row,'Supporting filing and registrant'));
  assert.deepEqual(parent.filters,[{column:'filing_uuid',value:'original'}]);assert.equal(parent.detail,undefined);
  assert.match(html,/without assuming uniqueness/);
});

test('short summaries keep role and identity limits visible while existing details retain explanations',()=>{
  const role={filing_uuid:'original',activity_index:0n,lobbyist_index:3n,lobbyist_id:'7',first_name:'Same',last_name:'Name',covered_position:'  Reported role\nliteral text  '};
  for(const [id,row] of [
    ['lobbying_filings',filing],['lobbying_activities',{...filing,activity_index:0n}],
    ['lobbying_activity_lobbyists',role],
  ]) {
    const html=render(id,row),[main,details]=html.split('<details>');
    assert.match(main,/Searches are bounded and may require Next; an incomplete search is not evidence of absence/);
    assert.match(details,/Publication scope and evidence/);
    assert.match(details,/not live coverage/);
    assert.match(details,/without assuming uniqueness/);
    assert.match(details,/Selected publication evidence/);
    assert.doesNotMatch(main,/Selected generation:|original document URL/);
    if(id==='lobbying_filings') {
      assert.match(main,/Client IDs belong to this registrant/);
      assert.match(main,/keeps separate filings and amendments/);
      assert.match(details,/Client record ID: 200 · Registrant ID: 100/);
      assert.match(details,/does not select a current relationship or combine financial amounts/);
    } else if(id==='lobbying_activity_lobbyists') {
      assert.ok(main.includes(role.covered_position));
      assert.match(main,/Missing text does not mean no former role/);
      assert.match(main,/registrant-local records, not person identities/);
      assert.match(details,/Lobbyist record ID: 7/);
      assert.match(details,/does not establish employment dates, current employment/);
    }
  }
});

test('body occurrences retain duplicates and nulls; saved URL and click share one literal membership recipe',()=>{
  const bodies=[{id:'24',name:'Commerce'},null,{id:'24',name:'Commerce'},{id:null,name:'Unresolved'}];
  const row={filing_uuid:'original',activity_index:0n,general_issue_code:'SCI',government_entities:bodies};
  assert.deepEqual(sourceOccurrences(navigation,row),bodies);
  let opened; const tree=LobbyingProfile(props('lobbying_activities',row,{onOpen:(...args)=>{opened=args;}}));
  const links=anchors(tree).filter(node=>String(node.props.children).startsWith('Activities listing body'));
  assert.equal(links.length,2);
  const saved=route(links[0]);
  assert.deepEqual(saved.connection,{id:LOBBYING_BODY_NAVIGATION_ID,target:0,values:['24']});
  assert.deepEqual(saved.filters,[]);assert.equal(saved.id,'lobbying_activities');
  let prevented=false;
  links[0].props.onClick({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(opened,['lobbying_activities',[],saved.connection]);
  const html=render('lobbying_activities',row);
  for(let i=0;i<4;i++)assert.ok(html.includes(`Source position ${i}:`));
  assert.match(html,/Unresolved source occurrence/);assert.match(html,/Body lookup unavailable/);
  assert.match(html,/matching activity rows once/);
  assert.deepEqual(route(findLink('lobbying_activities',row,'Activities with this exact issue code')).filters,[{column:'general_issue_code',value:'SCI'}]);
  assert.match(render('lobbying_activities',{...row,government_entities:null}),/list not stated \(null\)/);
  assert.match(render('lobbying_activities',{...row,government_entities:[]}),/lists no contacted bodies/);
  assert.match(render('lobbying_activities',{...row,government_entities:{}}),/unsupported shape/);
  const connections=renderToStaticMarkup(createElement(SourceConnections,{table:catalog[1],catalog,row,joins:[],navigation:[navigation],onOpen:()=>{}}));
  assert.doesNotMatch(connections,/@value|Show related records|Target is not published/);
  assert.match(connections,/Source occurrences · 4/);
});

test('metadata/schema drift removes the recipe; current selected metadata reconstructs it on reload',()=>{
  const table=catalog[1];
  const bundle={generatedAt:'2026-10-20',tables:{[table.id]:{family:table.family,publicationSchema:schema[table.id],metadataStatus:'documented',sourceStatus:'documented',columns:[],sources:[],inputs:[]}},publication:{families:{[table.family]:table.artifactDigest}},joins:[],omittedJoins:[]};
  assert.deepEqual(applyMetadata([table],bundle).navigation.map(n=>n.id),[LOBBYING_BODY_NAVIGATION_ID]);
  for(const metadataState of ['older-publication','missing','incompatible','unavailable','undocumented'])assert.deepEqual(lobbyingNavigation([{...table,metadataState}]),[]);
  for(const type of ['VARCHAR','STRUCT(id BIGINT, "name" VARCHAR)[]','STRUCT(id VARCHAR)[]'])assert.deepEqual(lobbyingNavigation([{...table,columns:table.columns.map(c=>c.name==='government_entities'?{...c,type}:c)}]),[]);
  assert.deepEqual(lobbyingNavigation([{...table,recordsAvailable:false}]),[]);
  assert.deepEqual(lobbyingNavigation([{...table,family:'other'}]),[]);
  assert.equal(applyMetadata([table],{...bundle,publication:{families:{[table.family]:'other'}}}).navigation.length,0);
  assert.match(render('lobbying_activities',{}, {table:{...table,metadataState:'incompatible'}}),/definition is unavailable/);
  assert.match(render('lobbying_filings',filing),/Selected publication evidence/);
  assert.doesNotMatch(render('lobbying_filings',filing),/href="[^"]+\\.pdf/);
});

test('nested membership stays physically bounded while scalar searches skip proven nonmatches without multiplied rows',async()=>{
  const file=readFileSync(new URL('./fixtures/navigation/lobbying-activities.parquet',import.meta.url));
  const server=createServer((req,res)=>{
    const match=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');
    if(match){const start=Number(match[1]),end=Number(match[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${file.length}`,'Content-Length':end-start+1});res.end(file.subarray(start,end+1));}
    else{res.writeHead(200,{'Content-Length':file.length});res.end(file);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const table={...catalog[1],rows:6,members:[{url:`http://127.0.0.1:${server.address().port}/fixture`,rows:6,byteSize:file.length}]};
    const request={table,columns:['filing_uuid','activity_index'],filters:[],connection:{id:navigation.id,target:0,values:['24']},navigation,cursor:0,maxScanRows:2};
    const first=await readPage(request);
    assert.deepEqual(first.positions,[0]);assert.equal(first.cursor,2);assert.equal(first.done,false);
    const second=await readPage({...request,cursor:first.cursor});
    assert.deepEqual(second.positions,[3]);assert.equal(second.done,false);
    const third=await readPage({...request,cursor:second.cursor});
    assert.deepEqual(third.positions,[5]);assert.equal(third.done,true);
    assert.deepEqual([...first.rows,...second.rows,...third.rows].map(r=>r.filing_uuid),['original','amendment','later']);
    const sparse=await readPage({...request,connection:undefined,navigation:undefined,filters:[{column:'general_issue_code',value:'MAN'}]});
    assert.deepEqual(sparse.positions,[5]);assert.equal(sparse.done,true);assert.equal(sparse.cursor,6);
    const last=await readPage({...request,cursor:4,connection:undefined,navigation:undefined,filters:[{column:'general_issue_code',value:'MAN'}]});
    assert.deepEqual(last.positions,[5]);assert.equal(last.done,true);
    await assert.rejects(readPage({...request,navigation:undefined}),/connection is unavailable/);
    await assert.rejects(readPage({...request,sort:{column:'filing_uuid',direction:'asc'}}),/bounded/);
  } finally {await new Promise(r=>server.close(r));}
});
