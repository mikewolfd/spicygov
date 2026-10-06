import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/navigation-measurement.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {countNavigation,targetIdentity,retainedScalarCounts}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const target={table:'targets',columns:['id'],keys:[{parts:[{from:'element',path:['id']}],separator:'',pattern:'.+'}],guards:[]};
const spec={id:'refs',source:'source',field:'refs',fields:['refs'],targets:[target],mode:'array',receiptFields:[],elementPath:[]};
test('measurements preserve repeats and separate missing, unchecked and multiple retained matches',()=>{
 const counts=countNavigation(spec,[{refs:[{id:'a'},{id:'a'},{id:'b'},{id:'c'},null]}],(_,values)=>({a:2,b:0})[values[0]]);
 assert.equal(counts.occurrences,5); assert.equal(counts.eligible,4);
 assert.equal(counts.matched,2); assert.equal(counts.missing,1); assert.equal(counts.unchecked,1);
 assert.equal(counts.referencesWithMultipleTargetRows,2); assert.equal(counts.unsupported,1);
});
test('ambiguous alternatives and unread fields are counted without inventing empty results',()=>{
 const counts=countNavigation({...spec,candidates:true},[{refs:[{target_status:'ambiguous',candidate_keys:[{id:'a'},{id:'b'}]}]},{detail_read:'false'}],()=>1);
 assert.equal(counts.recordedAmbiguousAlternatives,2); assert.equal(counts.states.unread,1);
 assert.equal(counts.sourceRows,2); assert.equal(counts.matched,2);
});
test('offered URLs are not capture matches, and incomplete or lossy keys do not enter target counts',()=>{
 const counts=countNavigation({...spec,targets:[{...target,table:'@url'}]},[{refs:[{id:'https://example.test/file.pdf'}]}],()=>1);
 assert.equal(counts.offeredUrls,1); assert.equal(counts.matched,0);
 assert.equal(targetIdentity({a:123456789123456789n,b:'x'},['a','b']),'["123456789123456789","x"]');
 assert.equal(targetIdentity({a:9007199254740992},['a']),undefined);
 assert.equal(targetIdentity({a:null},['a']),undefined);
});

test('retained scalar counts require exact current file pins and refuse amplified joins',()=>{
 const table={rows:3,publicationIdentity:'sha256:selection',members:[{url:'https://example.test/pinned.parquet',rows:3,byteSize:100,sha256:'sha256:file',etag:'"v1"'}]};
 const pin={publicationIdentity:table.publicationIdentity,members:table.members};
 const measurement={scope:'full_selected_inputs',selected_inputs:{child:pin,parent:pin},child_input_rows:3,parent_input_rows:3,child_nonnull_rows:2,inner_join_rows:1,max_matched_parent_multiplicity:1};
 assert.equal(retainedScalarCounts(measurement,table,table).missing,1);
 assert.equal(retainedScalarCounts(measurement,{...table,members:[{...table.members[0],etag:'"v2"'}]},table),undefined);
 assert.equal(retainedScalarCounts({...measurement,max_matched_parent_multiplicity:2},table,table),undefined);
 assert.equal(retainedScalarCounts({...measurement,inner_join_rows:4},table,table),undefined);
});
