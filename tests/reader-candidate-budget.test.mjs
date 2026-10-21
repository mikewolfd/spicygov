import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';

const {outputFiles}=await build({stdin:{contents:"export * from './lib/reader.ts'; export * from './lib/record-lookup.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {readPage,lookupRecord}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const files=Object.fromEntries(['groups','late-duplicate','no-statistics','empty'].map(name=>[name,readFileSync(new URL(`./fixtures/lookup/${name}.parquet`,import.meta.url))]));
let changed;
const visited=[];
const server=createServer((req,res)=>{
  const name=req.url.slice(1),file=files[name],etag=`"${changed===name?'changed':name}"`;
  visited.push(name);
  if(!file||req.headers['if-match']!==etag){res.writeHead(412).end();return;}
  const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range??'');
  if(!match){res.writeHead(400).end();return;}
  const start=+match[1],end=+match[2];
  res.writeHead(206,{'ETag':etag,'Content-Range':`bytes ${start}-${end}/${file.length}`});
  res.end(file.subarray(start,end+1));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const member=(name,rows)=>({url:`http://127.0.0.1:${server.address().port}/${name}`,rows,byteSize:files[name].length,etag:name});
const table=(members)=>({id:'candidate-fixture',rows:members.reduce((n,m)=>n+m.rows,0),members,columns:[{name:'id',type:'VARCHAR'},{name:'literal',type:'VARCHAR'}],recordIdentity:{columns:['id'],basis:'declared_main_key',uniqueness:'unknown'}});
const filters=[{column:'id',value:'needle'}];
const request=(selected,extra={})=>({table:selected,columns:['id'],filters,cursor:0,maxScanRows:2,...extra});
try {
  await test('a two-candidate budget crosses rejected groups and members and still checks trailing empty files',async()=>{
    // The first member contains no "zzz"; the second has one match in its last group.
    const selected=table([member('late-duplicate',4),member('groups',8),member('empty',0)]);
    visited.length=0;
    const result=await lookupRecord(selected,[{column:'id',value:'zzz'}],0,[],()=>{},2);
    assert.equal(result.status,'found');assert.deepEqual(result.positions,[11]);
    assert.equal(result.row.literal,'row:7');assert.equal(result.cursor,12);
    assert.ok(visited.includes('late-duplicate'));assert.ok(visited.includes('empty'));
    const absent=await lookupRecord(selected,[{column:'id',value:'unseen'}],0,[],()=>{},1);
    assert.equal(absent.status,'missing');assert.equal(absent.cursor,12);
  });
  await test('a late duplicate stays unresolved across the budget and is never opened as unique',async()=>{
    const selected=table([member('groups',8),member('late-duplicate',4),member('empty',0)]);
    const first=await lookupRecord(selected,filters,0,[],()=>{},2);
    assert.equal(first.status,'incomplete');assert.equal(first.row,undefined);
    assert.deepEqual(first.positions,[2]);assert.equal(first.cursor,10);
    const final=await lookupRecord(selected,filters,first.cursor,first.positions,()=>{},2);
    assert.equal(final.status,'ambiguous');assert.equal(final.row,undefined);
    assert.deepEqual(final.positions,[2,10]);
  });
  await test('missing statistics consume the budget, including after an earlier match',async()=>{
    const selected=table([member('no-statistics',8),member('empty',0)]);
    let result=await lookupRecord(selected,filters,0,[],()=>{},2);
    assert.equal(result.status,'incomplete');assert.equal(result.cursor,2);assert.deepEqual(result.positions,[]);
    result=await lookupRecord(selected,filters,result.cursor,result.positions,()=>{},2);
    assert.equal(result.status,'incomplete');assert.equal(result.cursor,4);assert.deepEqual(result.positions,[2]);
    result=await lookupRecord(selected,filters,result.cursor,result.positions,()=>{},4);
    assert.equal(result.status,'found');assert.equal(result.cursor,8);assert.equal(result.row.literal,'row:2');
  });
  await test('page limits retain physical cursors inside candidates and exact alternatives across groups',async()=>{
    const selected=table([member('groups',8),member('empty',0)]);
    const alternatives=[{column:'id',value:'needle',values:['needle','m','zzz']}];
    const first=await readPage(request(selected,{filters:alternatives,limit:1}));
    assert.deepEqual(first.positions,[2]);assert.equal(first.cursor,3);assert.equal(first.done,false);
    const next=await readPage(request(selected,{filters:alternatives,cursor:first.cursor,limit:1}));
    assert.deepEqual(next.positions,[3]);assert.equal(next.cursor,4);
    const final=await readPage(request(selected,{filters:alternatives,cursor:next.cursor,limit:1}));
    assert.deepEqual(final.positions,[7]);assert.equal(final.done,true);assert.equal(final.cursor,8);
  });
  await test('version and footer mismatches refuse even rejected or declared-empty members',async()=>{
    const selected=table([member('late-duplicate',4),member('groups',8),member('empty',0)]);
    for(const name of ['late-duplicate','empty']){
      changed=name;
      await assert.rejects(readPage(request(selected,{filters:[{column:'id',value:'zzz'}]})),/identity could not be checked/);
      changed=undefined;
    }
    // Reaching the last match cannot hide a falsely declared empty trailing member.
    await assert.rejects(readPage(request(table([member('groups',8),member('late-duplicate',0)]),{filters:[{column:'id',value:'zzz'}],limit:1})),/footer differs/);
    await assert.rejects(readPage(request(table([member('groups',9)]),{filters:[{column:'id',value:'unseen'}]})),/footer differs/);
  });
  await test('rejected groups still validate all requested physical columns before claiming completion',async()=>{
    const selected=table([member('groups',8)]);
    selected.columns.push({name:'absent_output',type:'VARCHAR'});
    await assert.rejects(readPage(request(selected,{columns:['absent_output'],filters:[{column:'id',value:'unseen'}]})),/parquet column not found: absent_output/);
  });
  await test('unfiltered physical budgets stop before opening the next member',async()=>{
    visited.length=0;
    const result=await readPage(request(table([member('groups',8),member('late-duplicate',4)]),{filters:[],maxScanRows:8}));
    assert.equal(result.cursor,8);assert.equal(result.done,false);assert.equal(result.rows.length,8);
    assert.ok(!visited.includes('late-duplicate'));
  });
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
