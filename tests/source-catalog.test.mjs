import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { validatePublicDirectory } from '../scripts/catalog-public-validation.mjs';
import { catalogOpsMiddleware, isLoopback, loopbackHost } from '../scripts/catalog-ops-server.mjs';
const built = await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const { parseCatalogManifest, parseCatalogDetail, parseCatalogFilePage, catalogPartitionUrl, SourceCatalogReader } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const generation = 'sha256:'+'a'.repeat(64), otherGeneration = 'sha256:'+'b'.repeat(64);
const item = { id:'unintegrated',title:'Held collection without publication',statuses:['held','unintegrated'],families:[],tables:[],routeCount:2,holdings:{aliases:1,objects:1,decodedBytes:10,missing:0},periods:[],detailPath:'generations/a/collections/unintegrated.json' };
const manifest = { format:'spicy-source-catalog',version:1,generation,generatedAt:'2026-10-10T00:00:00Z',collections:[item],totals:{collections:1} };
const route = { id:'legacy',label:'Historical bulk',deliveryMethod:'bulk',lifecycle:'legacy',custodian:'publisher',contentBehavior:'snapshot',periods:[{kind:'edition',label:'Historical edition',basis:'Retained publisher listing'}] };
const detail = { format:'spicy-source-collection',version:1,generation,collection:item,routes:[route,{...route,id:'api',label:'Current API',deliveryMethod:'api',lifecycle:'active',periods:[]}],tables:[],files:{pages:[{path:'generations/a/files/0.json',rows:1}],total:1},planned:[{id:'plan',status:'unassigned',reason:'Mapping unresolved'}],observations:[],relationships:[] };
const page = { format:'spicy-source-files',version:1,generation,collectionId:item.id,files:[{id:'alias',name:'original.zip',status:'held',bytes:10}] };
test('upstream and held collections remain independent of publication; routes retain their different periods', () => {
 assert.equal(parseCatalogManifest(manifest).collections[0].tables.length,0);
 const parsed = parseCatalogDetail(detail,generation,item.id); assert.equal(parsed.routes[0].periods[0].kind,'edition'); assert.equal(parsed.routes[1].periods.length,0); assert.equal(parsed.planned[0].status,'unassigned');
});
test('reader loads manifest, chosen detail and one chosen file page only', async () => {
 const urls=[]; const fetcher = async url => { urls.push(url); return new Response(JSON.stringify(urls.length===1?manifest:urls.length===2?detail:page)); };
 const reader = new SourceCatalogReader('https://data.example/source-catalog/manifest.json',false,fetcher);
 const selected = await reader.manifest(); assert.equal(urls.length,1);
 const selectedDetail = await reader.detail(selected,selected.collections[0]); assert.equal(urls.length,2);
 const files=await reader.files(selected,selectedDetail,0); assert.equal(urls.length,3); assert.equal(files.files[0].id,'alias'); assert.equal(urls[2],'https://data.example/source-catalog/generations/a/files/0.json');
});
test('generation drift, mismatched collection, malformed totals and duplicate IDs fail explicitly', () => {
 assert.throws(()=>parseCatalogDetail({...detail,generation:otherGeneration},generation,item.id),/generation changed/);
 assert.throws(()=>parseCatalogFilePage(page,generation,'other',1),/collection mismatch/);
 assert.throws(()=>parseCatalogDetail({...detail,files:{...detail.files,total:2}},generation,item.id),/partitions/);
 assert.throws(()=>parseCatalogManifest({...manifest,collections:[item,item]}),/Duplicate/);
 assert.throws(()=>parseCatalogManifest({}),/version/);
 assert.throws(()=>parseCatalogManifest({...manifest,version:2}),/version/);
});
test('public metadata refuses local fields and credential-bearing route URLs', () => {
 for (const bad of [{...manifest,audience:'internal'},{...manifest,localPath:'/Users/private'},{...manifest,collections:[{...item,description:'/home/user/corpus/file'}]}]) assert.throws(()=>parseCatalogManifest(bad));
 assert.throws(()=>parseCatalogDetail({...detail,routes:[{...route,accessUrl:'https://example.test/?api_key=secret'}]},generation,item.id),/Credential/);
 assert.throws(()=>parseCatalogFilePage({...page,files:[{...page.files[0],localPath:'/private/corpus'}]},generation,item.id,1),/Internal/);
 const internal = parseCatalogFilePage({...page,audience:'internal',files:[{...page.files[0],localPath:'/private/corpus',encodedBytes:5,verification:'verified'}]},generation,item.id,1,true); assert.equal(internal.files[0].localPath,'/private/corpus');
});
test('partition references cannot traverse, encode traversal, change origin or carry query credentials', () => {
 for (const path of ['../private.json','/private.json','https://other.test/a.json','a/%2e%2e/private.json','a\\private.json','a.json?token=secret','a//b.json']) assert.throws(()=>catalogPartitionUrl('https://data.example/catalog/manifest.json',path),/Unsafe/);
 assert.equal(catalogPartitionUrl('https://data.example/catalog/manifest.json','generation/files.json'),'https://data.example/catalog/generation/files.json');
});
test('failed requests surface catalog errors instead of empty successful universes', async () => {
 await assert.rejects(new SourceCatalogReader('/manifest.json',false,async()=>new Response('',{status:404})).manifest(),/404/);
});
test('production artifact validation rejects an internal export and symlink escape', async () => {
 const root = await mkdtemp(join(tmpdir(),'catalog-public-')); const folder=join(root,'source-catalog'); await mkdir(folder);
 try { await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest)); await validatePublicDirectory(root); await writeFile(join(folder,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); await assert.rejects(validatePublicDirectory(root),/Internal/); await rm(join(folder,'manifest.json')); await symlink('/tmp',join(folder,'external')); await assert.rejects(validatePublicDirectory(root),/symlink/); } finally { await rm(root,{recursive:true,force:true}); }
});
test('operations server restricts host, method, traversal and symlinks while reading exact internal partitions', async () => {
 assert.equal(isLoopback('10.0.0.1'),false); assert.equal(loopbackHost('localhost.attacker.test'),false);
 const root=await mkdtemp(join(tmpdir(),'catalog-ops-')); await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); await symlink('/etc/passwd',join(root,'escape.json'));
 const middleware=await catalogOpsMiddleware(root); const server=createServer((req,res)=>{ void middleware(req,res,()=>{res.statusCode=404;res.end();}); }); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const url=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json')).status,200);
  assert.equal(await new Promise((resolve,reject) => { const req = request(url+'/__source-catalog-internal/manifest.json',{headers:{host:'attacker.example'}},res => { res.resume(); resolve(res.statusCode); }); req.on('error',reject); req.end(); }),403);
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json',{headers:{origin:'https://attacker.example'}})).status,403);
  assert.equal((await fetch(url+'/__source-catalog-internal/manifest.json',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/__source-catalog-internal/%2e%2e/private.json')).status,404);
  assert.equal((await fetch(url+'/__source-catalog-internal/escape.json')).status,404);
 } finally { await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}); }
});

test('oversized declared and streamed responses fail before parsing or displaying data', async () => {
 const declared = new SourceCatalogReader('/manifest.json',false,async()=>new Response('{}',{headers:{'content-length':String(17*1024*1024)}}));
 await assert.rejects(declared.manifest(),/16 MiB/);
 let count=0, cancelled=false;
 const streamed = new SourceCatalogReader('/manifest.json',false,async()=>new Response(new ReadableStream({pull(controller){count++; controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})));
 await assert.rejects(streamed.manifest(),/16 MiB/); assert.equal(cancelled,true); assert.ok(count<=18);
});

test('logical file hash IDs remain public while filesystem URIs are rejected', () => {
 const id = 'file:'+'c'.repeat(64);
 assert.equal(parseCatalogFilePage({...page,files:[{...page.files[0],id}]},generation,item.id,1).files[0].id,id);
 assert.throws(()=>parseCatalogFilePage({...page,files:[{...page.files[0],id:'file:///home/private'}]},generation,item.id,1),/Local path/);
 assert.throws(()=>parseCatalogManifest({...manifest,collections:[{...item,description:id}]}),/Local path/);
});

test('validator CLI reports a concise artifact error with a nonzero exit', async () => {
 const root=await mkdtemp(join(tmpdir(),'catalog-cli-'));
 try { await writeFile(join(root,'manifest.json'),JSON.stringify({...manifest,audience:'internal'})); const result=spawnSync(process.execPath,['scripts/catalog-public-validation.mjs',root],{encoding:'utf8'}); assert.equal(result.status,1); assert.match(result.stderr,/manifest.json: Internal/); assert.ok(result.stderr.length<1024); assert.equal(result.stderr.includes('data:text/javascript'),false); } finally { await rm(root,{recursive:true,force:true}); }
});

test('default reader invokes browser fetch with the global receiver', async () => {
 const original=globalThis.fetch;
 try { globalThis.fetch=function(){ assert.equal(this,globalThis); return Promise.resolve(new Response(JSON.stringify(manifest))); }; const result=await new SourceCatalogReader('/manifest.json').manifest(); assert.equal(result.generation,generation); } finally { globalThis.fetch=original; }
});
