import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const { parseCatalogDetail, SourceCatalogReader } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const generation = 'sha256:'+'a'.repeat(64);
const collection = {id:'source',title:'Source',statuses:['held'],families:[],tables:[],routeCount:0,holdings:{aliases:1,objects:1,decodedBytes:10,missing:0},periods:[],periodSummary:{count:0},detailPath:'generations/a/collection.json'};
const detail = {format:'spicy-source-collection',version:2,generation,collection,routes:[],tables:[],files:{total:1,pages:[{path:'generations/a/files-00000.json',rows:1}]},retainedFiles:{total:1,pages:[{path:'generations/a/retained-files-00000.json',rows:1}]},planned:[],observations:[],relationships:[]};
const manifest = {format:'spicy-source-catalog',version:2,generation,generatedAt:'2026-10-28T00:00:00Z',collections:[collection],totals:{collections:1}};

test('optional retained inventory validates bounds and leaves usable counts unchanged', () => {
 const parsed = parseCatalogDetail(detail,generation,'source');
 assert.equal(parsed.files.total,1); assert.equal(parsed.collection.holdings.aliases,1); assert.equal(parsed.retainedFiles.total,1);
 const {retainedFiles,...older} = detail;
 assert.equal(parseCatalogDetail(older,generation,'source').retainedFiles,undefined);
 for(const inventory of [{total:2,pages:retainedFiles.pages},{total:1,pages:[{path:'../escape.json',rows:1}]},{total:5001,pages:[{path:'safe.json',rows:5001}]}]) {
  assert.throws(()=>parseCatalogDetail({...detail,retainedFiles:inventory},generation,'source'));
 }
});

test('retained pages load separately and reject generation and collection drift', async () => {
 const seen=[];
 const page = {format:'spicy-source-files',version:2,generation,collectionId:'source',files:[{id:'file:'+'b'.repeat(64),name:'failed-response.json',status:'refused-source'}]};
 let payload=page;
 const reader=new SourceCatalogReader('https://catalog.example/manifest.json',false,async url=>{seen.push(url);return new Response(JSON.stringify(payload));});
 assert.equal((await reader.retainedFiles(manifest,detail,0)).files[0].status,'refused-source');
 assert.deepEqual(seen,['https://catalog.example/generations/a/retained-files-00000.json']);
 payload={...page,generation:'sha256:'+'c'.repeat(64)};
 await assert.rejects(reader.retainedFiles(manifest,detail,0),/generation changed/);
 payload={...page,collectionId:'other'};
 await assert.rejects(reader.retainedFiles(manifest,detail,0),/collection mismatch/);
 await assert.rejects(reader.retainedFiles(manifest,{...detail,retainedFiles:undefined},0),/page unavailable/);
});
