import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';
const built=await build({entryPoints:['lib/reader.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {readPage}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const files={meetings:readFileSync(new URL('./fixtures/navigation/meetings.parquet',import.meta.url))};
const server=createServer((req,res)=>{const name=req.url.slice(1),file=files[name];if(!file)return res.writeHead(404).end();const match=/bytes=(\d+)-(\d+)/.exec(req.headers.range??'');if(match){const start=Number(match[1]),end=Number(match[2]);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${file.length}`,'Content-Length':end-start+1});res.end(file.subarray(start,end+1));}else{res.writeHead(200,{'Content-Length':file.length});res.end(file);}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const member=(n,rows)=>({url:`${base}/${n}`,rows,byteSize:files[n].length});
const cols=names=>names.map(name=>({name,type:'VARCHAR',description:''}));
try {
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
} finally {await new Promise(r=>server.close(r));}
