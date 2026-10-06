import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const {outputFiles}=await build({entryPoints:['lib/receipt-reader.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {receiptFields,recordIdentity,exactJson,unpack,parseExact}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const built=await build({entryPoints:['lib/reader.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {readPage}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const files=Object.fromEntries(['meetings','communications','receipts','ambiguous','keys','wrong-keys'].map(n=>[n,readFileSync(new URL(`./fixtures/navigation/${n}.parquet`,import.meta.url))]));
const server=createServer((req,res)=>{const name=req.url.slice(1),file=files[name];if(!file)return res.writeHead(404).end();const match=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');if(match){const start=Number(match[1]),end=Number(match[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${file.length}`,'Content-Length':end-start+1});res.end(file.subarray(start,end+1));}else{res.writeHead(200,{'Content-Length':file.length});res.end(file);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const member=(n,rows)=>({url:`${base}/${n}`,rows,byteSize:files[n].length});
const cols=names=>names.map(name=>({name,type:'VARCHAR',description:''}));
const table={id:'house_communications',rows:1,columns:cols(['congress','communication_type','number']),members:[member('communications',1)],receiptIdentity:['congress','communication_type','number'],receiptContainers:{source_fields:['record_package_id','record_granule_id','record_entry_text']},artifactDigest:'sha256:'+'a'.repeat(64),publication:{kind:'generation',nativeReceipts:{url:`${base}/receipts`,generationId:'g1',rows:1,bytes:files.receipts.length,sha256:'sha256:'+'b'.repeat(64)}}};
try {
 await test('receipt lookup preserves complete source identity and reads useful source fields',async()=>{
  const row={congress:'113',communication_type:'ec',number:'1'};
  const fields=await receiptFields(table,row,['record_package_id','record_entry_text']);
  assert.deepEqual(fields,{record_package_id:'CREC-2013-01-03',record_entry_text:'A retained communication passage.'});
  await assert.rejects(receiptFields(table,{...row,number:'2'},['record_package_id']),/No accepted receipt/);
  await assert.rejects(receiptFields({...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,generationId:'g2'}}},row,['record_package_id']),/generation differs/);
  const ambiguous={...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,url:`${base}/ambiguous`,rows:2,bytes:files.ambiguous.length}}};
  await assert.rejects(receiptFields(ambiguous,row,['record_package_id']),/Ambiguous/);
  for(const name of ['keys','wrong-keys']) {
   const indexed={...table,publication:{...table.publication,nativeReceipts:{...table.publication.nativeReceipts,keyIndex:{url:`${base}/${name}`,bytes:files[name].length,sha256:'sha256:'+'c'.repeat(64)}}}};
   if(name==='keys')assert.deepEqual(await receiptFields(indexed,row,['record_package_id']),{record_package_id:'CREC-2013-01-03'});
   else await assert.rejects(receiptFields(indexed,row,['record_package_id']),/different receipt/);
  }
 });
 await test('reverse source arrays read hidden reference fields and preserve paging and sort',async()=>{
  const part=(path,transform)=>({path:[path],from:'element',...(transform?{transform}:{})});
  const key=(...parts)=>({parts,separator:'',pattern:'.+'});
  const s={id:'meeting_nominations',source:'committee_meetings',fields:['nomination_references_json'],field:'nomination_references_json',mode:'array',receiptFields:[],elementPath:[],targets:[{table:'nominations',columns:['congress','citation'],keys:[key(part('congress')),key(part('number','nomination-citation'),part('part','partition'))],guards:[]}]};
  const t={id:'committee_meetings',rows:4,columns:cols(['congress','chamber','event_id','nomination_references_json']),members:[member('meetings',4)]};
  const request={table:t,columns:['event_id'],filters:[],cursor:0,limit:1,connection:{id:s.id,target:0,values:['118','PN14-2']},navigation:s};
  const first=await readPage(request);assert.deepEqual(first.positions,[0]);
  const next=await readPage({...request,cursor:first.cursor});assert.deepEqual(next.positions,[3]);
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
