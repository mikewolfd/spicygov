import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {applyMetadata}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/metadata-directions.json',import.meta.url),'utf8'));
const tables=Object.entries(fixture.tables).map(([id,t])=>({id,label:id,family:t.family,artifactDigest:fixture.publication.families[t.family],rows:0,members:[],columns:t.publicationSchema.map(([name,type])=>({name,type})),metadataState:'loading',connectionNotes:[]}));
test('backend directional descriptors preserve declared identity without claiming uniqueness',()=>{
 const result=applyMetadata(tables,fixture),bills=result.tables.find(t=>t.id==='congress_bills');
 assert.deepEqual(bills.recordIdentity,{columns:['bill_id'],basis:'declared_main_key',uniqueness:'unknown'});
 const join=result.joins.find(j=>j.child==='bill_actions');assert.equal(join.completeKey.parent,true);assert.equal(join.completeKey.child,false);
 assert.equal(join.directions.forward.lookup.requiresExactMatch,true);assert.equal(join.directions.forward.measurement.status,'unknown');
});
test('one missing nested key disables only its affected route and receipts cannot supply it',()=>{
 const result=applyMetadata(tables,fixture),vote=result.navigation.find(s=>s.source==='roll_call_votes');
 const status=Object.fromEntries(vote.targets.map(t=>[t.table,t.available]));
 assert.equal(status.congress_bills,false);assert.equal(status.nominations,false);assert.equal(status.treaties,true);
 const missing=JSON.parse(JSON.stringify(fixture));const source=missing.tables[vote.source];source.publicationSchema=source.publicationSchema.filter(([name])=>!vote.fields.includes(name));
 const omitted=tables.map(t=>t.id===vote.source?{...t,columns:t.columns.filter(c=>!vote.fields.includes(c.name))}:t);
 const absent=applyMetadata(omitted,missing).navigation.find(s=>s.id===vote.id);
 assert.equal(absent.available,false);assert.equal(absent.targets.some(t=>t.available),false);
});
