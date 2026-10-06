import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {renderToStaticMarkup} from 'react-dom/server';
const {outputFiles}=await build({entryPoints:['lib/navigation.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseNavigation,targetKeys,elements,matchesConnection,forwardLinks,validConnection,fccDocumentOutcome}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const part=(name,from='element',transform)=>({path:name?[name]:[],from,...(transform?{transform}:{})});
const key=(...parts)=>({parts,separator:'',pattern:'.+'});
const target={table:'nominations',columns:['congress','citation'],keys:[key(part('congress')),key(part('number','element','nomination-citation'),part('part','element','partition'))],guards:[{...part('congress'),pattern:'[1-9][0-9]*'},{...part('part'),pattern:'[0-9]+'}]};
const spec={id:'meeting_nominations',source:'committee_meetings',fields:['nomination_references_json'],field:'nomination_references_json',targets:[target],mode:'array',meaning:'Source-listed nominations',receiptFields:[],elementPath:[],ruleVersion:'source-navigation/1'};
test('nomination hearings accept retained citation spellings with the complete hearing identity',()=>{
 const t={table:'hearing_transcripts',columns:['congress','chamber','jacket_number'],keys:[key(part('citation','element','hearing-congress')),key(part('chamber','element','lower')),key(part('jacketNumber'))],guards:[]};
 for(const citation of ['S.Hrg.119-136','S.Hrg. 119-136']) {
  const reference={citation,chamber:'Senate',jacketNumber:61323};
  assert.deepEqual(targetKeys(t,reference,{congress:'118'}),['119','senate','61323']);
  assert.equal(matchesConnection({hearings_json:JSON.stringify([reference])}, {...spec,fields:['hearings_json'],field:'hearings_json',targets:[t]}, {id:spec.id,target:0,values:['119','senate','61323']}),true);
 }
 for(const citation of ['119-136','prefix S.Hrg.119-136','S.Hrg.119-136 suffix']) assert.equal(targetKeys(t,{citation,chamber:'Senate',jacketNumber:61323},{}),undefined);
});
test('array connections retain complete PN partitions and reject unstated scope',()=>{
 assert.deepEqual(targetKeys(target,{congress:118,number:14,part:'2'},{}),['118','PN14-2']);
 assert.deepEqual(targetKeys(target,{congress:118,number:14,part:'00'},{}),['118','PN14']);
 assert.equal(targetKeys(target,{congress:118,number:14},{}),undefined);
 const row={nomination_references_json:JSON.stringify([{congress:118,number:14,part:'2'},null,{congress:118,number:14,part:'2'},{congress:118,number:14,part:'3'}])};
 assert.equal(forwardLinks(spec,row).length,2);
 assert.equal(matchesConnection(row,spec,{id:spec.id,target:0,values:['118','PN14-2']}),true);
 assert.equal(matchesConnection(row,spec,{id:spec.id,target:0,values:['119','PN14-2']}),false);
});
test('publisher-padded nomination parts resolve without changing source occurrences',()=>{
 const t={...target,guards:[{...part('congress'),pattern:'[1-9][0-9]*'},{...part('part'),pattern:'00|0*[1-9][0-9]*'}]};
 const s={...spec,targets:[t]};
 const references=[{congress:119,number:1272,part:'07'},{congress:119,number:1272,part:'07'},{congress:119,number:1272,part:'10'}];
 const row={nomination_references_json:JSON.stringify(references)};
 assert.deepEqual(forwardLinks(s,row).map(link=>link.values),[['119','PN1272-7'],['119','PN1272-10']]);
 assert.equal(matchesConnection(row,s,{id:s.id,target:0,values:['119','PN1272-7']}),true);
 assert.deepEqual(elements(s,row).values,references);
 for(const value of [undefined,null,'',false,true,1.5,{},'0','000','-07','+07',' 07','07x']) assert.equal(targetKeys(t,{congress:119,number:1272,part:value},{}),undefined);
});
test('treaty references may omit a suffix and preserve a stated suffix',()=>{
 const t={table:'treaties',columns:['congress_received','number','suffix'],keys:[key(part('congress')),key(part('number')),{...key(part('part','element','partition-value')),pattern:'[0-9]*'}],guards:[{...part('congress'),pattern:'[1-9][0-9]*'},{...part('part','element','partition-value'),pattern:'[0-9]*'}]};
 const s={...spec,id:'meeting_treaties',field:'treaty_references_json',fields:['treaty_references_json'],targets:[t]};
 assert.deepEqual(targetKeys(t,{congress:112,number:8},{}),['112','8','']);
 assert.deepEqual(targetKeys(t,{congress:112,number:8,part:'02'},{}),['112','8','02']);
 assert.deepEqual(targetKeys(t,{congress:112,number:8,part:0n},{}),['112','8','']);
 assert.equal(targetKeys(t,{congress:112,number:8,part:18446744073709551616n},{}),undefined);
 const row={treaty_references_json:JSON.stringify([{congress:112,number:8}])};
 assert.equal(matchesConnection(row,s,{id:s.id,target:0,values:['112','8','']}),true);
 for(const value of [false,true,1.5,{},'-2','+2',' 02','02x']) assert.equal(targetKeys(t,{congress:112,number:8,part:value},{}),undefined);
});
test('reference JSON retains exact integers and refuses decimal tokens without dropping siblings',()=>{
 const t={...target,guards:[{...part('congress'),pattern:'[1-9][0-9]*'},{...part('part'),pattern:'00|0*[1-9][0-9]*'}]};
 const s={...spec,targets:[t]};
 const text='[{"congress":119,"number":14,"part":7.0},{"congress":119,"number":14,"part":7e0},{"congress":119,"number":14,"part":"07"},{"congress":119,"number":14,"part":18446744073709551615},{"congress":119,"number":14,"part":18446744073709551616}]';
 const row={nomination_references_json:text};
 assert.deepEqual(forwardLinks(s,row).map(link=>link.values),[['119','PN14-7'],['119','PN14-18446744073709551615']]);
 assert.equal(elements(s,row).values.length,5);
 assert.equal(row.nomination_references_json,text);
 assert.equal(matchesConnection(row,s,{id:s.id,target:0,values:['119','PN14-18446744073709551615']}),true);
 const treaty={table:'treaties',columns:['suffix'],keys:[{...key(part('part','element','partition-value')),pattern:'[0-9]*'}],guards:[{...part('part','element','partition-value'),pattern:'[0-9]*'}]};
 const treatySpec={...s,targets:[treaty]};
 assert.equal(forwardLinks(treatySpec,{nomination_references_json:'[{"part":0.0},{"part":7.0},{"part":7e0}]'}).length,0);
 assert.deepEqual(forwardLinks(treatySpec,{nomination_references_json:'[{}]'}).map(link=>link.values),[['']]);
 for(const field of ['congress','number']) assert.equal(forwardLinks(s,{nomination_references_json:`[{"congress":119,"number":14,"part":"07","${field}":7.0}]`}).length,0);
});
test('reference qualification refuses unverified numeric tokens on older JSON parsers',()=>{
 const original=JSON.parse;
 try {
  JSON.parse=(text,reviver)=>original(text,reviver?function(key,value){return reviver.call(this,key,value);}:undefined);
  assert.equal(forwardLinks(spec,{nomination_references_json:'[{"congress":119,"number":14,"part":"2"}]'}).length,0);
  assert.equal(forwardLinks(spec,{nomination_references_json:'[{"congress":"119","number":"14","part":"2"}]'}).length,1);
 } finally {JSON.parse=original;}
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

test('FCC offered document occurrences preserve order and repeated URLs',()=>{
 const url={table:'@url',columns:['url'],keys:[{...key(part('src')),pattern:'https://[^\\s]+'}],guards:[]};
 const s={...spec,id:'fcc_filing_documents',source:'fcc_filings',field:'documents',fields:['documents'],targets:[url],receiptFields:['native_fields_json','pdf_extraction_results_json'],elementPath:['documents']};
 const documents=[{src:'javascript:alert(1)',filename:'invalid.pdf',description:'Not a link'},null,{src:'https://example.test/first.pdf',filename:'First literal name.pdf',description:'First occurrence'},{src:'https://example.test/second.pdf',filename:'Second literal name.pdf',description:'Second occurrence'},{src:'https://example.test/first.pdf',filename:'Repeated literal name.pdf',description:'Repeated occurrence'}];
 const expected=documents.slice(2).map(d=>d.src);
 assert.deepEqual(forwardLinks(s,{documents}).map(link=>link.values[0]),expected);
 assert.deepEqual(forwardLinks({...s,field:'native_fields_json'},{native_fields_json:JSON.stringify({documents})}).map(link=>link.values[0]),expected);
 const links=forwardLinks(s,{documents});
 assert.deepEqual(links.map(link=>link.sourceOrdinal),[2,3,4]);
 assert.deepEqual(links.map(link=>[link.values[0],link.sourceElement.filename,link.sourceElement.description]),documents.slice(2).map(d=>[d.src,d.filename,d.description]));
 assert.equal(forwardLinks({...s,id:'another_recipe'},{documents})[0].sourceElement,undefined);
});

test('FCC receipt diagnostics report recorded outcomes with exact URL matching, without qualifying capture or text',()=>{
 const url='https://docs.fcc.gov/public/attachments/DOC-425379A1.pdf', digest='sha256:'+'d'.repeat(64);
 const diagnostic={url,source_sha256:digest,status:'ok',page_count:2,error:null};
 const fields={pdf_extraction_results_json:JSON.stringify([diagnostic])};
 const outcome=fccDocumentOutcome(url,fields);
 assert.equal(outcome.state,'recorded');assert.equal(outcome.sourceSha256,digest);assert.equal(outcome.pageCount,2);
 assert.equal(outcome.message,'Reported extraction: successful.');
 assert.equal(fccDocumentOutcome(url,{},false).state,'unavailable');
 assert.equal(fccDocumentOutcome(url,fields,false).state,'unavailable');
 for(const other of ['https://other.test/DOC-425379A1.pdf',url+'?download=1',url.replace('DOC-425379A1','doc-425379a1')]) assert.equal(fccDocumentOutcome(other,fields).state,'unrecorded');
 assert.equal(fccDocumentOutcome(url,{}).state,'unread');
 for(const value of [null,'[]',JSON.stringify([{...diagnostic,url:'https://other.test/a.pdf'}])]) assert.equal(fccDocumentOutcome(url,{pdf_extraction_results_json:value}).state,'unrecorded');
 assert.equal(fccDocumentOutcome(url,{pdf_extraction_results_json:JSON.stringify([diagnostic,diagnostic])}).state,'ambiguous');
 for(const value of ['invalid','{}',undefined,'[null]',JSON.stringify([{...diagnostic,status:'captured'}]),JSON.stringify([{...diagnostic,source_sha256:'invalid'}]),JSON.stringify([{...diagnostic,page_count:'2'}]),JSON.stringify([{...diagnostic,page_count:0}]),JSON.stringify([{...diagnostic,error:'contradiction'}]),JSON.stringify([{url,status:'ok'}])]) assert.equal(fccDocumentOutcome(url,{pdf_extraction_results_json:value}).state,'malformed');
 for(const status of ['empty','encrypted','error']) {
  const result=fccDocumentOutcome(url,{pdf_extraction_results_json:JSON.stringify([{...diagnostic,status,page_count:0,error:status==='error'?'retained failure':null}])});
  assert.equal(result.state,'recorded');assert.equal(result.sourceSha256,digest);assert.equal(result.pageCount,0);
 }
 const failed=fccDocumentOutcome(url,{pdf_extraction_results_json:JSON.stringify([{...diagnostic,status:'error',source_sha256:null,page_count:null,error:'fetch returned no bytes'}])});
 assert.equal(failed.state,'recorded');assert.equal(failed.sourceSha256,undefined);assert.equal(failed.pageCount,undefined);assert.equal(failed.error,'fetch returned no bytes');
});

test('FCC document display keeps literal descriptors and compact status with expandable recorded facts',async()=>{
 const {outputFiles}=await build({entryPoints:['components/source-connections.tsx'],bundle:true,platform:'node',format:'esm',write:false});
 const {FccDocumentReference}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
 const url='https://example.test/not-the-offered-filename.pdf', digest='sha256:'+'a'.repeat(64);
 const link={values:[url],sourceElement:{filename:'Literal & offered.pdf',description:'Publisher description'},sourceOrdinal:2};
 const receipt={pdf_extraction_results_json:JSON.stringify([{url,source_sha256:digest,status:'ok',page_count:2,error:null}])};
 const html=renderToStaticMarkup(FccDocumentReference({link,receipt,fieldAvailable:true}));
 const [primary,details]=html.split('<details>');
 assert.match(primary,/Literal &amp; offered.pdf/);assert.match(primary,/Publisher description/);
 assert.match(primary,/Open offered document 3/);assert.match(primary,/Reported extraction: successful\. 2 pages\./);
 assert.match(primary,/File and text access: not verified/);assert.ok(!primary.includes(digest));
 assert.match(details,/<summary>Recorded details<\/summary>/);assert.ok(details.includes(digest));
 assert.match(details,/do not establish access to retained file bytes or extracted text/);
 const absent=renderToStaticMarkup(FccDocumentReference({link:{values:[url],sourceElement:{}},receipt:{},fieldAvailable:false}));
 assert.match(absent,/unavailable in the published source details/);assert.ok(!absent.includes('not read yet'));
 assert.ok(!absent.includes('Offered filename:'));assert.ok(!absent.includes('Description:'));
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
