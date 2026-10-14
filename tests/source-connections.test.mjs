import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';

async function load(path) {
  const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime'],logLevel:'silent'});
  const loaded={exports:{}};
  new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
  return loaded.exports;
}
const {SourceConnections}=await load('components/source-connections.tsx');
const {related,isIncomingJoin,connectionFilters}=await load('lib/catalog.ts');
const table=(id,label=id)=>({id,label,columns:[],members:[],rows:1,metadataState:'current'});
const render=(target,joins,row,{catalog=[],navigation=[]}={})=>renderToStaticMarkup(createElement(SourceConnections,{table:target,catalog:[target,...catalog],row,joins,navigation,onOpen:()=>{}}));
const gao={child:'gao_recommendations',child_columns:['report_id'],parent:'gao_reports',parent_columns:['report_id'],directions:{forward:{available:true},reverse:{available:true}}};

test('GAO recommendations appear once in the open incoming-record group',()=>{
  const target=table('gao_reports','GAO reports'), source=table('gao_recommendations','GAO recommendations');
  const html=render(target,[gao],{report_id:'gao-27-108551'},{catalog:[source]});
  assert.match(html,/<details open=""><summary>Records that reference this record<\/summary>/);
  assert.equal(html.split('GAO recommendations').length-1,1);
  assert.match(html,/report_id: gao-27-108551/);
  assert.doesNotMatch(html,/disabled=""/);
  const [incoming]=related(target.id,[gao]).filter(join=>isIncomingJoin(join,target.id));
  assert.deepEqual(connectionFilters(incoming,target.id,{report_id:'gao-27-108551'}),[{column:'report_id',value:'gao-27-108551'}]);
  // Forward scalar references remain in the explorer's separate referenced-records view.
  assert.equal(render(source,[gao],{report_id:'gao-27-108551'},{catalog:[target]}),'');
});

test('all bundled scalar declarations keep complete reverse keys, including composite joins',()=>{
  const registry=JSON.parse(readFileSync(new URL('../lib/data/table_joins.json',import.meta.url),'utf8'));
  assert.ok(registry.joins.some(join=>join.child==='gao_recommendations'));
  assert.ok(registry.joins.some(join=>join.parent_columns.length>1));
  for(const join of registry.joins) {
    const links=related(join.parent,[join]), incoming=links.filter(link=>isIncomingJoin(link,join.parent));
    assert.equal(incoming.length,1,JSON.stringify(join));
    const row=Object.fromEntries(join.parent_columns.map((column,index)=>[column,`native-${index}`]));
    assert.deepEqual(connectionFilters(incoming[0],join.parent,row),join.child_columns.map((column,index)=>({column,value:`native-${index}`})));
    assert.equal(connectionFilters(incoming[0],join.parent,{...row,[join.parent_columns.at(-1)]:null}),null);
    if(join.child===join.parent)assert.equal(links.filter(link=>!isIncomingJoin(link,join.parent)).length,1);
  }
});

test('self references separate the referenced record from records that refer to it',()=>{
  const target=table('amendments','Amendments');
  const join={child:target.id,child_columns:['amended_amendment_id'],parent:target.id,parent_columns:['amendment_id']};
  const links=related(target.id,[join]), row={amendment_id:'119-samdt-2',amended_amendment_id:'119-samdt-1'};
  assert.equal(links.filter(link=>!isIncomingJoin(link,target.id)).length,1);
  const [incoming]=links.filter(link=>isIncomingJoin(link,target.id));
  assert.deepEqual(connectionFilters(incoming,target.id,row),[{column:'amended_amendment_id',value:'119-samdt-2'}]);
  const html=render(target,[join],row);
  assert.match(html,/Amendments modifying this amendment/);
  assert.doesNotMatch(html,/Amendment being amended/);
});

test('incoming composite keys and selected-publication refusals remain explicit',()=>{
  const target=table('lobbying_activities'), source=table('lobbying_activity_lobbyists','Lobbyists');
  const join={child:source.id,child_columns:['filing_uuid','activity_index'],parent:target.id,parent_columns:['filing_uuid','activity_index'],directions:{reverse:{available:true}}};
  const complete=render(target,[join],{filing_uuid:'filing-A',activity_index:0},{catalog:[source]});
  assert.match(complete,/activity_index: 0/);
  assert.doesNotMatch(complete,/disabled=""/);
  assert.deepEqual(connectionFilters(join,target.id,{filing_uuid:'filing-A',activity_index:0}),[{column:'filing_uuid',value:'filing-A'},{column:'activity_index',value:'0'}]);
  for(const value of [null,'',{},[]]) {
    const incomplete=render(target,[join],{filing_uuid:'filing-A',activity_index:value},{catalog:[source]});
    assert.match(incomplete,/disabled=""/);
    assert.match(incomplete,/no complete target key/);
  }
  const refused=render(target,[{...join,directions:{reverse:{available:false}}}],{filing_uuid:'filing-A',activity_index:0},{catalog:[source]});
  assert.match(refused,/disabled=""/);
  assert.match(refused,/unavailable for the selected publication/);
  assert.match(render(target,[join],{filing_uuid:'filing-A',activity_index:0}),/Source is not published/);
});

test('array recipes stay alongside scalar references without changing their composite target identity',()=>{
  const target=table('nominations'), source=table('committee_meetings','Committee meetings');
  const navigation=[{id:'meeting_nominations',source:source.id,targets:[{table:target.id,columns:['congress','citation'],available:true,directions:{reverse:{available:true}}}],receiptFields:[]}];
  const html=render(target,[],{congress:'119',citation:'PN1272-7'},{catalog:[source],navigation});
  assert.match(html,/Records that reference this record/);
  assert.match(html,/Committee meetings/);
  assert.match(html,/Show related records listing this exact key/);
  assert.doesNotMatch(html,/disabled=""/);
});
