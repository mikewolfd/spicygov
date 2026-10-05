import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles} = await build({entryPoints:['lib/catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {applyMetadata, connectionFilters} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const printing = 'printing:' + 'a'.repeat(64), body = 'body:sha256:' + 'b'.repeat(64);
const specs = {
  bill_versions:['bill_id','version_code','printing_id'],
  bill_sections:['bill_id','version_code','printing_id','seq'],
  section_diffs:['bill_id','from_version_code','from_printing_id','to_version_code','to_printing_id'],
  document_citations:['document_key','body_version_id'],
  budget_volumes:['package_id','body_version_id'],
  house_activity_reports:['package_id','body_version_id'],
};
const joins = [
  ['bill_sections',['bill_id','version_code','printing_id'],'bill_versions',['bill_id','version_code','printing_id']],
  ['section_diffs',['bill_id','from_version_code','from_printing_id'],'bill_versions',['bill_id','version_code','printing_id']],
  ['section_diffs',['bill_id','to_version_code','to_printing_id'],'bill_versions',['bill_id','version_code','printing_id']],
  ['document_citations',['document_key','body_version_id'],'budget_volumes',['package_id','body_version_id']],
  ['document_citations',['document_key','body_version_id'],'house_activity_reports',['package_id','body_version_id']],
].map(([child,child_columns,parent,parent_columns])=>({child,child_columns,parent,parent_columns,kind:'unmeasured',reason:'Declared physical native identity.'}));
const tables = Object.entries(specs).map(([id,names])=>({id,label:id,family:id.startsWith('bill')||id==='section_diffs'?'bill-family':'print-citations',artifactDigest:'sha256:current',columns:names.map(name=>({name,type:'VARCHAR',description:''})),rows:1,members:[],connectionNotes:[],metadataState:'loading'}));
function metadata(){return {publication:{families:{'bill-family':'sha256:current','print-citations':'sha256:current'}},tables:Object.fromEntries(tables.map(t=>[t.id,{family:t.family,publicationSchema:t.columns.map(c=>[c.name,c.type]),metadataStatus:'documented',sourceStatus:'documented',sources:[],inputs:[],modelGenerated:false}])),joins,omittedJoins:[]};}
test('all five native physical connections preserve complete keys in both directions',()=>{
  const result=applyMetadata(tables,metadata());assert.equal(result.joins.length,5);
  for(const join of result.joins){
    const value=join.child==='document_citations'?body:printing;
    const values=join.child_columns.map(key=>key.endsWith('printing_id')||key==='body_version_id'?value:key.includes('version_code')?'is':'exact-occurrence');
    const childRow=Object.fromEntries(join.child_columns.map((key,i)=>[key,values[i]]));
    const parentRow=Object.fromEntries(join.parent_columns.map((key,i)=>[key,values[i]]));
    assert.deepEqual(connectionFilters(join,join.child,childRow),join.parent_columns.map((column,i)=>({column,value:values[i]})));
    assert.deepEqual(connectionFilters(join,join.parent,parentRow),join.child_columns.map((column,i)=>({column,value:values[i]})));
    assert.equal(connectionFilters(join,join.child,{...childRow,[join.child_columns.at(-1)]:null}),null);
  }
  assert.ok(result.tables.every(t=>!('computedColumns' in t)));
});
test('legacy metadata cannot activate new native-schema joins or recreate receipt-only public tables',()=>{
  const bundle=metadata();bundle.tables.bill_versions.publicationSchema[2]=['source','VARCHAR'];
  bundle.tables.document_citation_reads={...bundle.tables.document_citations,publicationSchema:[['text_sha256','VARCHAR']]};
  const result=applyMetadata(tables,bundle);
  assert.equal(result.tables.find(t=>t.id==='bill_versions').metadataState,'incompatible');
  assert.equal(result.joins.filter(j=>j.parent==='bill_versions').length,0);
  assert.equal(result.tables.some(t=>t.id==='document_citation_reads'),false);
});
