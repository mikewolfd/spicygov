import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['lib/source-catalog.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {parseCatalogFilePage}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`);
const sha='sha256:'+'a'.repeat(64), generation='sha256:'+'c'.repeat(64);
const acquisition=hash=>`acquisitions/sha256/${hash.slice(0,2)}/${hash}`;
const retained=hash=>`objects/sha256/${hash.slice(0,2)}/${hash}.gz`;
const read=(version,receipt)=>parseCatalogFilePage({format:'spicy-source-files',version,generation,
  collectionId:'legacy',files:[{id:'one',name:'original.json',status:'held',provenance:{basis:'receipt-backed',
    availability:'local',sourceUrls:[],receipt}}]},generation,'legacy',1,false,version);

for(const version of [1,2]) {
  test(`v${version} receipt link refuses another acquisition digest`,()=>{
    assert.throws(()=>read(version,{sha256:sha,key:acquisition('b'.repeat(64)),kind:'acquisition',entry:1}),/fingerprint/);
  });
  test(`v${version} receipt link refuses another retained-manifest digest`,()=>{
    assert.throws(()=>read(version,{sha256:sha,key:retained('b'.repeat(64)),kind:'retained-manifest',entry:1}),/fingerprint/);
  });
  test(`v${version} receipt link refuses mismatched kind or an incomplete archive reference`,()=>{
    assert.throws(()=>read(version,{sha256:sha,key:acquisition('a'.repeat(64)),kind:'frozen-index',entry:1}),/kind/);
    assert.throws(()=>read(version,{sha256:sha,key:acquisition('a'.repeat(64)),entry:1}),/reference/);
    assert.throws(()=>read(version,{sha256:sha,key:acquisition('a'.repeat(64)),kind:'acquisition'}),/reference/);
  });
  test(`v${version} exact and unavailable legacy receipt identities remain readable`,()=>{
    for(const receipt of [
      {sha256:sha,key:acquisition('a'.repeat(64)),kind:'acquisition',entry:1},
      {sha256:sha,key:retained('a'.repeat(64)),kind:'retained-manifest',entry:1},
      {sha256:sha,key:'files.jsonl.gz',kind:'frozen-index',entry:1},
      {sha256:sha,key:null}, {sha256:sha},
    ]) assert.deepEqual(read(version,receipt).files[0].provenance.receipt,receipt);
  });
}
