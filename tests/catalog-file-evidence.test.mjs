import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const built = await build({ entryPoints: ['components/catalog-file-evidence.tsx'], bundle: true,
  platform: 'node', format: 'cjs', write: false, external: ['react', 'react/jsx-runtime'] });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const sha = 'sha256:' + 'a'.repeat(64);
const file = { id: 'file:test', name: 'original.json', status: 'held', sha256: sha, bytes: 10 };
const render = provenance => renderToStaticMarkup(createElement(loaded.exports.CatalogFileEvidence, { file: { ...file, provenance } }));

test('file evidence shows explicit unknowns for older metadata', () => {
  const html = render();
  assert.match(html, /Origin and capture evidence are unknown/);
  assert.match(html, /Capture date:.*Unknown/);
  assert.match(html, /Source location:.*Unknown/);
  assert.match(html, /availability is unknown/);
  assert.ok(html.includes(sha));
});

test('receipt facts and exact identity are inspectable without local paths', () => {
  const html = render({ basis: 'receipt-backed', sourceUrls: ['https://source.gov/request', 'https://source.gov/result'],
    capturedAt: '2026-09-14T22:05:04Z', availability: 'local', receipt: { sha256: sha, entry: 3 } });
  assert.match(html, /Receipt documents this retained file/);
  assert.match(html, /2026-09-14T22:05:04Z/);
  assert.match(html, /Evidence entry:.*3/);
  assert.match(html, /href="https:\/\/source.gov\/request"/);
  assert.match(html, /href="https:\/\/source.gov\/result"/);
  assert.doesNotMatch(html, /file:\/\/|\/Users\//);
});

test('provisional attribution does not describe a confirmed capture', () => {
  const html = render({ basis: 'provisional', sourceUrls: ['https://source.gov/data'],
    availability: 'local', originalReceiptSha256: sha });
  assert.match(html, /Provisional attribution/);
  assert.match(html, /matching checksum does not establish the same acquisition or capture date/);
  assert.match(html, /Capture date:.*Unknown/);
  assert.doesNotMatch(html, /Receipt documents/);
});

test('local receipt lookup is actionable only for a directly recorded acquisition', () => {
  const direct = render({basis:'receipt-backed',sourceUrls:[],availability:'local',receipt:{sha256:sha,entry:3}});
  assert.match(direct, /acquisitions\/sha256\/aa\/a{64}/);
  assert.match(direct, /files\[2\].*entry 3/);
  assert.match(direct, /A public copy may not have been uploaded yet/);
  assert.match(direct, /Public copy availability has not been checked/);
  for (const basis of ['provisional','inferred','unknown']) {
    const html = render({basis,sourceUrls:[],availability:'unknown',receipt:{sha256:sha,entry:3}});
    assert.doesNotMatch(html,/acquisitions\/sha256/);
  }
  const original = render({basis:'provisional',sourceUrls:[],availability:'local',originalReceiptSha256:sha});
  assert.match(original,/python3 verify.py restore --sha256 sha256:a{64} --destination \.\.\/receipt-review.json/);
  assert.doesNotMatch(original,/acquisitions\/sha256/);
});

test('direct native archive keys drive public links without guessing from fingerprints',()=>{
 const unknown=render({basis:'receipt-backed',sourceUrls:[],availability:'unknown',receipt:{sha256:sha,key:null,entry:3}});
 assert.doesNotMatch(unknown,/acquisitions\/sha256/);
 const native=render({basis:'provisional',sourceUrls:[],availability:'local',receipt:{sha256:sha,key:'files.jsonl.gz',kind:'frozen-index',entry:3},originalReceiptKey:'objects/sha256/aa/'+'a'.repeat(64)+'.gz',originalReceiptSha256:sha,originalReceiptPointer:'/receipt/files/2'});
 assert.match(native,/href="https:\/\/data.spicygov.ai\/spicyregs\/raw\/files.jsonl.gz"/);
 assert.match(native,/decoded JSON-lines index, inspect line 3/);
 assert.match(native,/Original receipt location:.*\/receipt\/files\/2/);
});

test('storage compression explains which bytes the original fingerprint checks',()=>{
 const key='objects/sha256/aa/'+'a'.repeat(64);
 const renderStored=contentKey=>renderToStaticMarkup(createElement(loaded.exports.CatalogFileEvidence,{file:{...file,contentKey,provenance:{basis:'unknown',sourceUrls:[],availability:'local'}}}));
 assert.match(renderStored(key+'.gz'),/Decompress it once to check the original file/);
 assert.doesNotMatch(renderStored(key),/Decompress it once/);
});
