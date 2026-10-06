import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
async function module(path){const {outputFiles}=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);}
const {lookupRecord,completeIdentity}=await module('lib/record-lookup.ts');
const {readPage}=await module('lib/reader.ts');
const {matchesFilters,parquetFilter,exactTimestamp}=await module('lib/filter-values.ts');
const {exactParsers}=await module('lib/exact-parquet.ts');
const {billKeyCache,subjectBinding}=await module('lib/subject-key-cache.ts');
const files=['part0','part1','exact-types','bill-keys-unique','bill-keys-duplicate'].map(name=>readFileSync(new URL(`./fixtures/${name}.parquet`,import.meta.url)));
const server=createServer((req,res)=>{const id=Number(req.url.slice(1)),file=files[id],etag=`"fixture-${id}"`;if(req.headers['if-match']!==etag){res.writeHead(412).end();return;}const m=/bytes=(\d+)-(\d+)/.exec(req.headers.range);const start=+m[1],end=+m[2];res.writeHead(206,{'ETag':etag,'Content-Range':`bytes ${start}-${end}/${file.length}`});res.end(file.subarray(start,end+1));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const member=(id,rows)=>({url:`http://127.0.0.1:${server.address().port}/${id}`,rows,byteSize:files[id].length,etag:`fixture-${id}`});
const table={id:'synthetic',rows:140,columns:[{name:'id',type:'VARCHAR'},{name:'group',type:'VARCHAR'},{name:'key',type:'VARCHAR'},{name:'large',type:'BIGINT'}],members:[member(0,70),member(1,70)],recordIdentity:{columns:['id'],basis:'declared_main_key',uniqueness:'unknown'}};
try {
 await test('bill cache admits all exact subject positions once and refuses changed members or duplicates',async()=>{
  const bills={id:'congress_bills',rows:3,columns:[{name:'bill_id',type:'VARCHAR'},{name:'title',type:'VARCHAR'}],members:[{...member(3,3),sha256:'sha256:'+'a'.repeat(64)}],recordIdentity:{columns:['bill_id'],basis:'declared_main_key',uniqueness:'unknown'}};
  const first=await billKeyCache(bills);assert.deepEqual([...first.positions],[['119-hr-1',0],['119-s-2',1],['118-s-3',2]]);
  assert.equal(await billKeyCache(bills),first);
  const changed={...bills,members:[{...bills.members[0],etag:'changed'}]};
  assert.notEqual(subjectBinding(bills),subjectBinding(changed));await assert.rejects(billKeyCache(changed),/identity could not be checked/);
  await assert.rejects(billKeyCache({...bills,members:[{...member(4,3),sha256:'sha256:'+'b'.repeat(64)}]}),/duplicate identity/);
  assert.equal(await billKeyCache({...bills,rows:500001}),undefined);
 });
 await test('complete identity is a declared main key, never receipt identity or a scope',async()=>{
  assert.equal(completeIdentity({...table,recordIdentity:undefined,receiptIdentity:['id']},[{column:'id',value:'10'}]),false);
  assert.equal(completeIdentity(table,[{column:'group',value:'x'}]),false);
  assert.equal(completeIdentity(table,[{column:'id',value:'10',values:['10','11']}]),false);
  await assert.rejects(lookupRecord(table,[{column:'group',value:'x'}]),/scope/);
 });
 await test('one current match opens full details only after all selected members are checked',async()=>{
  const result=await lookupRecord(table,[{column:'id',value:'72'}]);
  assert.equal(result.status,'found');assert.deepEqual(result.positions,[72]);assert.equal(result.row.id,'72');assert.equal(typeof result.row.large,'bigint');
  assert.equal((await lookupRecord(table,[{column:'id',value:'absent'}])).status,'missing');
  await assert.rejects(lookupRecord({...table,members:table.members.map(m=>({...m,etag:undefined}))},[{column:'id',value:'72'}]),/checked file version/);
  await assert.rejects(lookupRecord({...table,members:[{...table.members[0],rows:71},table.members[1]],rows:141},[{column:'id',value:'72'}]),/footer differs/);
 });
 await test('bounded lookup keeps a first match unresolved until continuation proves uniqueness',async()=>{
  const first=await lookupRecord(table,[{column:'id',value:'5'}],0,[],()=>{},10);
  assert.equal(first.status,'incomplete');assert.equal(first.row,undefined);assert.deepEqual(first.positions,[5]);
  const final=await lookupRecord(table,[{column:'id',value:'5'}],first.cursor,first.positions);
  assert.equal(final.status,'found');assert.equal(final.row.id,'5');
  const duplicate={...table,recordIdentity:{...table.recordIdentity,columns:['group']}};
  const keys=await readPage({table,columns:['group'],filters:[],cursor:0,limit:1});
  const result=await lookupRecord(duplicate,[{column:'group',value:keys.rows[0].group}]);
  assert.equal(result.status,'ambiguous');assert.equal(result.row,undefined);
 });
 await test('native integer/date equality and microsecond timestamps survive real Parquet reads',async()=>{
  const typed={id:'typed',rows:2,members:[member(2,2)],columns:[{name:'id',type:'BIGINT'},{name:'n',type:'BIGINT'},{name:'day',type:'DATE'},{name:'moment',type:'TIMESTAMP'}]};
  const read=filters=>readPage({table:typed,columns:typed.columns.map(c=>c.name),filters,cursor:0});
  assert.deepEqual((await read([{column:'n',value:'9223372036854775807'}])).rows.map(r=>r.id),[1n]);
  for(const value of ['9223372036854775808','9223372036854775807.0','9e18'])assert.equal((await read([{column:'n',value}])).rows.length,0);
  assert.deepEqual((await read([{column:'day',value:'2026-10-07'}])).rows.map(r=>r.id),[2n]);
  assert.deepEqual((await read([{column:'moment',value:'2026-10-06T12:00:00.123456Z'}])).rows.map(r=>r.id),[1n]);
  assert.deepEqual((await read([{column:'moment',value:'2026-10-06 12:00:00.123457'}])).rows.map(r=>r.id),[2n]);
  assert.equal((await read([{column:'moment',value:'2026-10-06T12:00:00.123Z'}])).rows.length,0);
 });
 await test('unsupported pruning and invalid time values preserve exact post-filtering',()=>{
  assert.equal(parquetFilter([{column:'moment',value:'2026-10-06T12:00:00.123456Z'}],[{name:'moment',type:'TIMESTAMP'}]),undefined);
  assert.equal(exactTimestamp('2026-02-30T12:00:00Z'),undefined);assert.equal(exactTimestamp('2026-10-06T24:00:00Z'),undefined);
  assert.equal(exactParsers.timestampFromMicroseconds(-1n),'1969-12-31T23:59:59.999999Z');
  assert.equal(matchesFilters({n:9007199254740992},[{column:'n',value:'9007199254740992'}],[{name:'n',type:'BIGINT'}]),false);
  assert.equal(matchesFilters({name:'007'},[{column:'name',value:'7'}],[{name:'name',type:'VARCHAR'}]),false);
 });
} finally {server.close();server.closeAllConnections();}
