import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const built = await build({entryPoints:['components/catalog-retained-files.tsx'],bundle:true,
  platform:'node',format:'cjs',write:false,external:['react','react/jsx-runtime']});
const loaded = {exports:{}};
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const render = retainedFiles => renderToStaticMarkup(createElement(loaded.exports.CatalogRetainedFiles, {
  reader:{retainedFiles(){throw Error('File bodies must wait for an explicit request');}},
  manifest:{generation:'sha256:'+'a'.repeat(64)},detail:{collection:{id:'family:sam-entities'},retainedFiles},
}));

test('older catalog details do not gain an invented saved-response inventory',()=>{
  assert.equal(render(undefined),'');
  assert.equal(render({total:0,pages:[]}),'');
});

test('saved source responses are an optional separate disclosure, not usable source files',()=>{
  const html=render({total:4,pages:[{path:'retained-responses/page-0.json',rows:4}]});
  assert.match(html,/<details class="evidence-disclosure catalog-retained-files">/);
  assert.match(html,/Files that need attention \(4 references\)/);
  assert.match(html,/missing originals, saved source errors, refusals, incomplete responses or unchecked content/);
  assert.match(html,/separate from the source-file counts above/);
  assert.match(html,/do not establish usable data/);
  assert.match(html,/Browse files needing attention/);
  assert.doesNotMatch(html,/<ul|File origin and capture evidence/);
});
