import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/receipt-reader.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {receiptFields,receiptLookup,receiptOnlyFields,recordIdentity,identityCandidates,IDENTITY_SCAN_ROWS,exactJson,unpack,parseExact,readSourceEvidence}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const built=await build({entryPoints:['lib/reader.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {readPage}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const files=Object.fromEntries(['meetings','communications','receipts','ambiguous','detail-attempts','fcc-receipts'].map(n=>[n,readFileSync(new URL(`./fixtures/navigation/${n}.parquet`,import.meta.url))]));
const server=createServer((req,res)=>{const name=req.url.slice(1),file=files[name];if(!file)return res.writeHead(404).end();const match=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');if(match){const start=Number(match[1]),end=Number(match[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${file.length}`,'Content-Length':end-start+1});res.end(file.subarray(start,end+1));}else{res.writeHead(200,{'Content-Length':file.length});res.end(file);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const member=(n,rows)=>({url:`${base}/${n}`,rows,byteSize:files[n].length});
const cols=names=>names.map(name=>({name,type:'VARCHAR',description:''}));
const table={id:'house_communications',rows:1,columns:cols(['congress','communication_type','number']),members:[member('communications',1)],receiptIdentity:['congress','communication_type','number'],receiptContainers:{source_fields:['record_package_id','record_granule_id','record_entry_text']},artifactDigest:'sha256:'+'a'.repeat(64),publication:{kind:'generation',nativeReceipts:{url:`${base}/receipts`,generationId:'g1',rows:1,bytes:files.receipts.length,sha256:'sha256:'+'b'.repeat(64)}}};
try {
 await test('FCC outcomes are read only for the exact filing and selected receipt generation',async()=>{
  const selected={...table,id:'fcc_filings',receiptIdentity:['id_submission'],receiptContainers:{raw_record:['native_fields_json','pdf_extraction_results_json']},publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,url:`${base}/fcc-receipts`,bytes:files['fcc-receipts'].length}}};
  const wanted=['native_fields_json','pdf_extraction_results_json'];
  const fields=await receiptFields(selected,{id_submission:'123'},wanted);
  assert.equal(JSON.parse(fields.pdf_extraction_results_json)[0].status,'ok');
  assert.equal(JSON.parse(fields.native_fields_json).documents[0].src,JSON.parse(fields.pdf_extraction_results_json)[0].url);
  await assert.rejects(receiptFields(selected,{id_submission:'124'},wanted),/No accepted receipt/);
  await assert.rejects(receiptFields({...selected,publication:{...selected.publication,nativeReceipts:{...selected.publication.nativeReceipts,generationId:'other-generation'}}},{id_submission:'123'},wanted),/generation differs/);
 });
 await test('detail attempt evidence preserves PN partitions and separates failed reads from empty successes',async()=>{
  const selected={...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,url:`${base}/detail-attempts`,rows:4,bytes:files['detail-attempts'].length}}};
  const filters=[{column:'event',value:'congress-detail-result'},{column:'congress',value:'119'},{column:'citation',value:'PN129-10'}];
  const result=await readSourceEvidence(selected,'congress_acquisition',filters);
  assert.deepEqual(result.records.map(row=>row.read_outcome),['failed','read']);
  assert.deepEqual(result.records.map(row=>row.citation),['PN129-10','PN129-10']);
  assert.equal(result.records[0].error_type,'PagedJsonSourceError');
  assert.ok(result.records.every(row=>!('credential' in row)&&!('private_path' in row)));
  const unread=await readSourceEvidence(selected,'congress_acquisition',[...filters.slice(0,2),{column:'citation',value:'PN999'}]);
  assert.equal(unread.records.length,0);assert.equal(unread.partial,false);
  await assert.rejects(readSourceEvidence({...selected,publication:{...selected.publication,nativeReceipts:{...selected.publication.nativeReceipts,generationId:'g2'}}},'congress_acquisition',filters),/different generation/);
 });
 await test('receipt lookup preserves complete source identity and reads useful source fields',async()=>{
  const row={congress:'113',communication_type:'ec',number:'1'};
  const fields=await receiptFields(table,row,['record_package_id','record_entry_text']);
  assert.deepEqual(fields,{record_package_id:'CREC-2013-01-03',record_entry_text:'A retained communication passage.'});
  await assert.rejects(receiptFields(table,{...row,number:'2'},['record_package_id']),/No accepted receipt/);
  await assert.rejects(receiptFields({...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,generationId:'g2'}}},row,['record_package_id']),/generation differs/);
  const ambiguous={...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,url:`${base}/ambiguous`,rows:2,bytes:files.ambiguous.length}}};
  await assert.rejects(receiptFields(ambiguous,row,['record_package_id']),/Ambiguous/);
  // Any size of receipt file is offered: the lookup reads only the groups and pages whose bounds admit the identity.
  assert.deepEqual(receiptLookup({...table.publication.nativeReceipts,rows:30_000_000}),{path:'identity'});
  assert.deepEqual(receiptLookup(undefined),{path:'refused',reason:'Matching generation receipts are unavailable.'});
  const scanned=[];
  await receiptFields(table,row,['record_package_id'],p=>scanned.push(p));
  assert.ok(scanned.length&&scanned.every(p=>p.step==='scan'&&p.total===1));
  // A file written before identity bounds counts every receipt of the table, and past the bound refuses unread.
  const stat=(min,max)=>({min_value:min,max_value:max});
  const group=(rows,dataset,identity)=>({num_rows:BigInt(rows),columns:[{meta_data:{path_in_schema:['dataset'],statistics:dataset}},{meta_data:{path_in_schema:['identity_json'],statistics:identity}}]});
  const id='["list",[["list",[["str","n"],["str","5"]]]]]';
  assert.equal(identityCandidates([group(10,stat('a','a'),stat(id,id)),group(20,stat('a','a'),stat('[z','[z')),group(30,stat('b','b'),undefined)],'a',id),10);
  assert.equal(identityCandidates([group(IDENTITY_SCAN_ROWS+1,stat('a','a'),undefined)],'a',id),IDENTITY_SCAN_ROWS+1);
 });
 await test('receipt-only fields are declared container fields absent from published columns',()=>{
  const bills={...table,id:'congress_bills',columns:cols(['bill_id','title']),receiptContainers:{source_fields:['bill_id','title','url'],other:['url','source_xml']}};
  assert.deepEqual(receiptOnlyFields(bills),['url','source_xml']);
  assert.deepEqual(receiptOnlyFields({...bills,columns:cols(['bill_id','title','url','source_xml'])}),[]);
  // Undeclared processing keys, such as build-machine witnesses, are never requested.
  assert.ok(!receiptOnlyFields(bills).includes('witnesses'));
  assert.deepEqual(receiptOnlyFields({...bills,receiptContainers:undefined}),[]);
 });
 await test('reverse source arrays read hidden reference fields and preserve paging and sort',async()=>{
  const part=(path,transform)=>({path:[path],from:'element',...(transform?{transform}:{})});
  const key=(...parts)=>({parts,separator:'',pattern:'.+'});
  const s={id:'meeting_nominations',source:'committee_meetings',fields:['nomination_references_json'],field:'nomination_references_json',mode:'array',receiptFields:[],elementPath:[],targets:[{table:'nominations',columns:['congress','citation'],keys:[key(part('congress')),key(part('number','nomination-citation'),part('part','partition'))],guards:[]}]};
  const t={id:'committee_meetings',rows:4,columns:cols(['congress','chamber','event_id','nomination_references_json']),members:[member('meetings',4)]};
  const request={table:t,columns:['event_id'],filters:[],cursor:0,limit:1,connection:{id:s.id,target:0,values:['118','PN14-2']},navigation:s};
  const first=await readPage(request);assert.deepEqual(first.positions,[0]);
  const next=await readPage({...request,cursor:first.cursor});assert.deepEqual(next.positions,[3]);
  const bounded=await readPage({...request,limit:40,maxScanRows:2});
  assert.deepEqual(bounded.positions,[0]);assert.equal(bounded.cursor,2);assert.equal(bounded.done,false);
  const continuation=await readPage({...request,limit:40,maxScanRows:2,cursor:bounded.cursor});
  assert.deepEqual(continuation.positions,[3]);assert.equal(continuation.done,true);
  const absent=await readPage({...request,limit:40,maxScanRows:2,connection:{...request.connection,values:['119','PN14-2']}});
  assert.equal(absent.rows.length,0);assert.equal(absent.cursor,2);assert.equal(absent.done,false);
  const sorted=await readPage({...request,sort:{column:'event_id',direction:'desc'}});assert.deepEqual(sorted.positions,[3]);
  const empty=await readPage({...request,connection:{...request.connection,values:['119','PN14-2']}});assert.equal(empty.rows.length,0);assert.equal(empty.done,true);
 });
 await test('receipt codec preserves primitive identity and refuses unsupported values',async()=>{
  assert.equal(exactJson(['x', [['id','a']]]),'["list",[["str","x"],["list",[["list",[["str","id"],["str","a"]]]]]]]');
  assert.deepEqual(unpack(['dict',[['empty',['list',[]]],['missing',['null',null]]]]),{empty:[],missing:null});
  assert.equal(unpack(['float','0x1.8000000000000p+1']),3);
  assert.throws(()=>exactJson([1.25]),/exact value type/);
  const a=await recordIdentity(table,{congress:'113',communication_type:'ec',number:'1'});assert.match(a.id,/^sha256:[a-f0-9]{64}$/);
 });
} finally {await new Promise(r=>server.close(r));}
