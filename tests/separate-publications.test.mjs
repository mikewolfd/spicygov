import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function module(path) {const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);}
const {loadCollection,applyMetadata,connectionFilters}=await module('lib/catalog.ts');
const {parseMetadata}=await module('lib/metadata.ts');
const {parseComments,parseRulemaking,sourceEntries}=await module('lib/source-directory.ts');
const {publicationDescriptor,descriptorIdentity,bindExtraTables}=await module('lib/separate-publications.ts');
const sha='sha256:'+'a'.repeat(64), base='https://data.spicygov.ai';
const pointer={format_version:2,dataset:'rulemaking',snapshot_id:'snapshot_123',manifest_key:'materialized/rulemaking/snapshots/snapshot_123/manifest.json'};
const manifest={format_version:2,dataset:'rulemaking',snapshot_id:'snapshot_123',artifacts:{'proceedings.parquet':{visibility:'public',remote_key:'materialized/rulemaking/snapshots/snapshot_123/proceedings.parquet',rows:3,bytes:120,sha256:sha}}};
const receipt={format_version:1,source:{schema_id:6},files:{'comments.parquet':{rows:12,bytes:1200,sha256:sha,etag:'"comments-current"'},'comments_index.parquet':{rows:2,bytes:150,sha256:sha,etag:'"index-current"'}}};
function core() {return {version:2,families:{core:{artifactDigest:sha,prefix:'generations/core/current',tables:{'parent.parquet':{rows:1,byteSize:50,columns:[['id','VARCHAR'],['cycle','BIGINT']]}}}}};}
function details(family,publicationSchema) {return {family,publicationSchema,metadataStatus:'documented',sourceStatus:'documented',sources:[],inputs:[],modelGenerated:false,columns:[{column_name:'phantom_legacy_field',description:'Must never become a physical column.'}]};}
async function fixture() {
 const extra=[...parseRulemaking(pointer,manifest),...parseComments(receipt)];
 const metadata={format:'spicy-regs-explorer-metadata',version:1,generatedAt:'2026-10-05T20:00:00Z',publication:{families:{core:sha}},tables:{parent:details('core',[['id','VARCHAR'],['cycle','BIGINT']])},extra_tables:{},joins:[]};
 for(const table of extra) {
  const descriptor=publicationDescriptor(table), publicationIdentity=await descriptorIdentity(descriptor);
  const schema=table.id==='comments'?[['comment_id','VARCHAR'],['docket_id','VARCHAR'],['cycle','BIGINT']]:[['docket_id','VARCHAR'],['cycle','BIGINT']];
  metadata.extra_tables[table.id]={family:table.family,publicationSchema:schema,publicationIdentity,descriptor};
  metadata.tables[table.id]={...details(table.family,schema),publicationIdentity,label:table.id};
 }
 metadata.joins=[{child:'comments',parent:'parent',child_columns:['docket_id','cycle'],parent_columns:['id','cycle'],kind:'scope',reason:'Exact declared source keys.'}];
 return {publication:core(),metadata,extra};
}
async function mocked(fixture,action,{commentsMissing=false}={}) {
 const saved=globalThis.fetch, requested=[];
 globalThis.fetch=async url=>{requested.push(String(url));
  if(String(url).endsWith('/publication.v2.json'))return Response.json(fixture.publication);
  if(String(url).endsWith('/explorer-metadata.v1.json'))return fixture.metadata instanceof Error?Promise.reject(fixture.metadata):Response.json(fixture.metadata);
  if(String(url).endsWith('/latest.json'))return Response.json(pointer);
  if(String(url).endsWith('/manifest.json'))return Response.json(manifest);
  if(String(url).endsWith('/comments-publication.json'))return commentsMissing?new Response('missing',{status:503}):Response.json(receipt);
  throw Error('Unexpected data-body request '+url);
 };
 try{return await action(requested);}finally{globalThis.fetch=saved;}
}
test('separate tables join the real explorer collection using bound physical schemas and complete keys',async()=>{
 const f=await fixture();await mocked(f,async requested=>{
  const result=await loadCollection();assert.equal(result.tables.length,4);assert.equal(result.metadata.state,'current');assert.equal(result.joins.length,1);
  const comments=result.tables.find(table=>table.id==='comments');assert.equal(comments.recordsAvailable,true);assert.equal(comments.metadataState,'current');
  assert.deepEqual(comments.columns.map(column=>column.name),['comment_id','docket_id','cycle']);assert.equal(comments.columns.some(column=>column.name==='phantom_legacy_field'),false);
  assert.deepEqual(connectionFilters(result.joins[0],'comments',{docket_id:'D-1',cycle:0}),[{column:'id',value:'D-1'},{column:'cycle',value:'0'}]);
  assert.deepEqual(connectionFilters(result.joins[0],'parent',{id:'D-1',cycle:2026}),[{column:'docket_id',value:'D-1'},{column:'cycle',value:'2026'}]);
  assert.equal(connectionFilters(result.joins[0],'comments',{docket_id:'D-1',cycle:null}),null);
  assert.equal(sourceEntries(result.tables,[]).filter(entry=>entry.explorer).length,4);
  assert.equal(comments.members[0].sha256,undefined);assert.equal(comments.members[0].etag,'"comments-current"');
  assert.deepEqual(comments.coverageInputs,parseComments(receipt)[0].coverageInputs);
  for(const suffix of ['/latest.json','/manifest.json','/comments-publication.json'])assert.equal(requested.filter(url=>url.endsWith(suffix)).length,1);
  assert.equal(requested.some(url=>url.endsWith('.parquet')),false);
 });
});
test('publication identity, descriptor, schema and per-table bindings must all agree',async()=>{
 for(const change of [m=>m.extra_tables.comments.publicationIdentity='sha256:'+'b'.repeat(64),m=>m.extra_tables.comments.descriptor.members[0].etag='"old"',m=>m.tables.comments.publicationIdentity='sha256:'+'b'.repeat(64),m=>m.tables.comments.publicationSchema=[['invented','VARCHAR']]]){
  const f=await fixture();change(f.metadata);await mocked(f,async()=>{
   const result=await loadCollection(),comments=result.tables.find(t=>t.id==='comments');
   assert.equal(comments.recordsAvailable,false);assert.deepEqual(comments.columns,[]);assert.equal(result.joins.length,0);
   assert.equal(result.tables.find(t=>t.id==='parent').rows,1);assert.equal(sourceEntries(result.tables,[]).find(entry=>entry.table.id==='comments').explorer,false);
  });
 }
});
test('main-index precedence keeps a migrated table once with its main files and schema',async()=>{
 const f=await fixture();f.publication.families.core.tables['comments.parquet']={rows:99,byteSize:990,columns:[['id','VARCHAR'],['cycle','BIGINT']]};f.metadata.tables.comments=details('core',[['id','VARCHAR'],['cycle','BIGINT']]);
 await mocked(f,async()=>{const result=await loadCollection();const selected=result.tables.filter(t=>t.id==='comments');assert.equal(selected.length,1);assert.equal(selected[0].rows,99);assert.equal(selected[0].family,'core');assert.equal(selected[0].publication.kind,'generation');assert.match(selected[0].members[0].url,/generations\/core\/current/);assert.deepEqual(selected[0].columns.map(c=>c.name),['id','cycle']);});
});
test('unavailable comments never hide the main or separately published rulemaking tables',async()=>{
 const f=await fixture();await mocked(f,async()=>{const result=await loadCollection();assert.deepEqual(result.tables.map(t=>t.id).sort(),['parent','proceedings']);assert.equal(result.tables.find(t=>t.id==='proceedings').recordsAvailable,true);assert.match(result.warnings[0],/Comments files could not be checked/);},{commentsMissing:true});
});
test('metadata outage preserves current separate file listings and main record access without accepting unknown fields',async()=>{
 const f=await fixture();f.metadata=Error('offline');await mocked(f,async()=>{const result=await loadCollection();assert.equal(result.tables.length,4);assert.equal(result.tables.find(t=>t.id==='parent').recordsAvailable,undefined);assert.equal(result.tables.find(t=>t.id==='comments').recordsAvailable,false);assert.deepEqual(result.joins,[]);assert.deepEqual(result.tables.find(t=>t.id==='comments').columns,[]);});
});
test('mutating a bound file identity pauses metadata and its dependent navigation',async()=>{
 const f=await fixture(),bundle=parseMetadata(f.metadata);const bound=await bindExtraTables(f.extra,bundle);const changed=bound.map(t=>t.id==='comments'?{...t,members:[{...t.members[0],etag:'"replacement"'}]}:t);
 const result=applyMetadata(changed,bundle);assert.equal(result.tables.find(t=>t.id==='comments').metadataState,'incompatible');assert.equal(result.joins.length,0);
});
