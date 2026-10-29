import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validatePublicDirectory} from '../scripts/catalog-public-validation.mjs';

const {outputFiles}=await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseArchiveMirror,SourceCatalogReader}=await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const component=await build({entryPoints:['components/catalog-file-list.tsx'],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime']});
const loaded={exports:{}};
new Function('require','module','exports',component.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const sha=character=>'sha256:'+character.repeat(64), stamp='2026-10-29T20:16:14Z';
const manifest={format:'spicy-source-catalog',version:1,generation:sha('a'),generatedAt:stamp,collections:[],totals:{collections:0}};
const manifestBytes=JSON.stringify(manifest)+'\n';
const identity='sha256:'+createHash('sha256').update(manifestBytes).digest('hex');
const key='objects/sha256/bb/'+'b'.repeat(64)+'.gz';
const proof=()=>({format:'spicygov-archive-mirror',version:1,preparedAt:stamp,archiveBase:'https://data.spicygov.ai/spicyregs/raw/',
 catalog:{generation:sha('a'),manifestSha256:identity},
 inventory:{generation:sha('c'),recordedAt:stamp,evidenceSha256:sha('d'),rawSnapshotSha256:sha('e'),acquisitionReceiptSetSha256:sha('f'),objects:1,receipts:1,controls:[{key:'files.jsonl.gz',bytes:12}]},
 publicChecks:{checkedAt:stamp,scope:'sample',files:[{key,bytes:10,status:200}]}});

test('mirror proof requires the exact selected manifest and keeps prior inventory provenance',()=>{
 const parsed=parseArchiveMirror(proof(),manifest,identity);
 assert.equal(parsed.inventory.generation,sha('c'));
 assert.equal(parsed.inventory.recordedAt,stamp);
 assert.throws(()=>parseArchiveMirror(proof(),{...manifest,generation:sha('b')},identity),/another catalog/);
 assert.throws(()=>parseArchiveMirror(proof(),manifest,sha('b')),/another catalog/);
 for(const mutate of [p=>p.localPath='/Users/private',p=>p.archiveBase='https://other.example/',
  p=>p.publicChecks.files[0].status=403,p=>p.publicChecks.files[0].key='../secret',
  p=>p.inventory.controls.push({key:'../secret',bytes:2})]){
  const p=proof();mutate(p);assert.throws(()=>parseArchiveMirror(p,manifest,identity));
 }
});

test('catalog identity hashes the original manifest bytes without another request',async()=>{
 let requests=0;
 const reader=new SourceCatalogReader('/source-catalog/manifest.json',false,async()=>{requests++;return new Response(manifestBytes)});
 const selected=await reader.manifest();
 assert.equal(await reader.manifestIdentity(selected),identity);
 assert.equal(await reader.manifestIdentity({...selected}),undefined);
 assert.equal(requests,1);
});

test('matching inventory changes links without claiming whole-archive byte verification',()=>{
 const file={id:'raw:one',name:'Source',status:'held',contentKey:key,sha256:sha('b'),bytes:10,
  provenance:{basis:'receipt-backed',sourceUrls:[],availability:'local',receipt:{sha256:sha('d'),key:'files.jsonl.gz',kind:'frozen-index',entry:1}}};
 const render=mirror=>renderToStaticMarkup(createElement(loaded.exports.CatalogFileList,{files:[file],mirror}));
 const unknown=render();assert.match(unknown,/Try public copy/);assert.match(unknown,/Public copies may lag/);
 const checked=render(parseArchiveMirror(proof(),manifest,identity));
 assert.match(checked,/Open archive copy/);assert.match(checked,/Open indexed receipt/);
 assert.match(checked,/names and stored sizes/);assert.doesNotMatch(checked,/availability has not been checked|Public copies may lag|whole.archive.*verified/i);
});

test('public validation rejects stale mirror evidence even for valid catalog files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mirror-'));
 try{
  await mkdir(join(root,'source-catalog'));
  await writeFile(join(root,'source-catalog/manifest.json'),manifestBytes);
  await writeFile(join(root,'archive-mirror.v1.json'),JSON.stringify(proof()));
  await validatePublicDirectory(root);
  const stale=proof();stale.catalog.manifestSha256=sha('b');
  await writeFile(join(root,'archive-mirror.v1.json'),JSON.stringify(stale));
  await assert.rejects(validatePublicDirectory(root),/another catalog/);
 }finally{await rm(root,{recursive:true,force:true})}
});
