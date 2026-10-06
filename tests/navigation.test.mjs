import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/navigation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseNavigation,targetKeys,elements,matchesConnection,forwardLinks,validConnection}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const part=(name,from='element',transform)=>({path:name?[name]:[],from,...(transform?{transform}:{})});
const key=(...parts)=>({parts,separator:'',pattern:'.+'});
const target={table:'nominations',columns:['congress','citation'],keys:[key(part('congress')),key(part('number','element','nomination-citation'),part('part','element','partition'))],guards:[{...part('congress'),pattern:'[1-9][0-9]*'},{...part('part'),pattern:'[0-9]+'}]};
const spec={id:'meeting_nominations',source:'committee_meetings',fields:['nomination_references_json'],field:'nomination_references_json',targets:[target],mode:'array',meaning:'Source-listed nominations',receiptFields:[],elementPath:[],ruleVersion:'source-navigation/1'};
test('array connections retain complete PN partitions and reject unstated scope',()=>{
 assert.deepEqual(targetKeys(target,{congress:118,number:14,part:'2'},{}),['118','PN14-2']);
 assert.deepEqual(targetKeys(target,{congress:118,number:14,part:'00'},{}),['118','PN14']);
 assert.equal(targetKeys(target,{congress:118,number:14},{}),undefined);
 const row={nomination_references_json:JSON.stringify([{congress:118,number:14,part:'2'},null,{congress:118,number:14,part:'2'},{congress:118,number:14,part:'3'}])};
 assert.equal(forwardLinks(spec,row).length,2);
 assert.equal(matchesConnection(row,spec,{id:spec.id,target:0,values:['118','PN14-2']}),true);
 assert.equal(matchesConnection(row,spec,{id:spec.id,target:0,values:['119','PN14-2']}),false);
});
test('read states distinguish missing, empty and malformed source arrays',()=>{
 assert.equal(elements(spec,{detail_read:'false'}).state,'unread');
 assert.equal(elements(spec,{nomination_references_json:'[]'}).state,'empty');
 assert.equal(elements(spec,{nomination_references_json:'{}'}).state,'unsupported shape');
});
test('URL state contains only a recipe reference and complete literals; recipes validate strictly',()=>{
 assert.equal(validConnection({id:spec.id,target:0,values:['118','PN14-2']}),true);
 assert.equal(validConnection({id:spec.id,target:-1,values:[]}),false);
 assert.equal(parseNavigation([spec])[0].id,spec.id);
 assert.throws(()=>parseNavigation([spec,spec]),/Invalid/);
 assert.throws(()=>parseNavigation([{...spec,targets:[{...target,columns:['congress']}]}]),/keys/);
 assert.throws(()=>parseNavigation([{...spec,targets:[{...target,keys:[key({...part('x'),transform:'eval'}),key(part('x'))]}]}]),/keys/);
});
test('legal candidates keep ambiguous alternatives and use recorded target identities',()=>{
 const t={table:'cfr_sections',columns:['package_id','granule_id'],keys:[key(part('package_id')),key(part('granule_id'))],guards:[{...part('target_status'),values:['found','ambiguous']}]};
 const s={...spec,id:'native_legal_targets',source:'native_legal_references',field:'target_candidates_json',fields:['target_candidates_json'],candidates:true,targets:[t]};
 const row={target_candidates_json:JSON.stringify([{target_status:'ambiguous',candidate_keys:[{package_id:'CFR-2024-title2',granule_id:'g1'},{package_id:'CFR-2025-title2',granule_id:'g1'}]}])};
 assert.equal(forwardLinks(s,row).length,2);
 assert.equal(matchesConnection(row,s,{id:s.id,target:0,values:['CFR-2025-title2','g1']}),true);
});

test('FCC direct document arrays and retained raw records follow the same URL recipe',()=>{
 const url={table:'@url',columns:['url'],keys:[{...key(part('src')),pattern:'https://[^\\s]+'}],guards:[]};
 const s={...spec,id:'fcc_documents',field:'documents',fields:['documents'],targets:[url],receiptFields:['native_fields_json'],elementPath:['documents']};
 assert.equal(forwardLinks(s,{documents:[{src:'https://example.test/document.pdf'}]})[0].values[0],'https://example.test/document.pdf');
 assert.equal(forwardLinks({...s,field:'native_fields_json'},{native_fields_json:JSON.stringify({documents:[{src:'https://example.test/document.pdf'}]})})[0].values[0],'https://example.test/document.pdf');
});

test('legal targets distinguish unresolved and ambiguous candidates from absent references',()=>{
 const s={...spec,candidates:true};
 assert.equal(elements(s,{nomination_references_json:'[]'}).state,'unresolved targets');
 assert.equal(elements(s,{nomination_references_json:JSON.stringify([{target_status:'not_checked',candidate_keys:[]}])}).state,'unresolved targets');
 assert.equal(elements(s,{nomination_references_json:JSON.stringify([{target_status:'ambiguous',candidate_keys:[{id:'one'},{id:'two'}]}])}).state,'ambiguous targets');
});

test('receipt routes constrain the event type as well as the exact source identity',()=>{
 const t={table:'@receipt:congress_acquisition',columns:['event','congress','citation'],keys:[key({...part(''),literal:'congress-detail-result'}),key(part('congress','row')),key(part('citation','row'))],guards:[]};
 const s={...spec,mode:'row',field:undefined,fields:[],targets:[t]};
 assert.deepEqual(forwardLinks(s,{congress:'119',citation:'PN129-10'})[0].filters,[{column:'event',value:'congress-detail-result'},{column:'congress',value:'119'},{column:'citation',value:'PN129-10'}]);
 assert.throws(()=>parseNavigation([{...s,targets:[{...t,keys:[key({...part(''),literal:42}),...t.keys.slice(1)]}]}]),/keys/);
});
