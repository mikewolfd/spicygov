import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const { outputFiles } = await build({entryPoints:['components/record-text.tsx'], bundle:true,
  platform:'node', format:'cjs', write:false, external:['react', 'react/jsx-runtime']});
const loaded = {exports:{}};
new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { recordText, RecordText } = loaded.exports;

test('publisher title entities display as punctuation in the table and record', () => {
  const title = 'Republicans Block Democrats&#x2019; Bill with &#x201c;Pocket Rescissions&#x201d;';
  const expected = 'Republicans Block Democrats’ Bill with “Pocket Rescissions”';
  assert.equal(recordText('title', title), expected);
  assert.equal(recordText('document_title', 'Research &amp; Health &#8212; Today'), 'Research & Health — Today');
  assert.equal(renderToStaticMarkup(createElement(RecordText, {column:'title', value:title})), expected);
  const detail = renderToStaticMarkup(createElement(RecordText, {column:'title', value:title, showOriginal:true}));
  assert.ok(detail.startsWith(expected));
  assert.match(detail, /<summary>Original source text<\/summary>/);
  assert.ok(detail.includes('Democrats&amp;#x2019;'));
});

test('decoding leaves identifiers, URLs, structured data and undecoded source values intact', () => {
  for (const field of ['release_id', 'source_path', 'link', 'guid', 'description_json']) {
    assert.equal(recordText(field, 'A&amp;B'), 'A&amp;B');
  }
  assert.equal(recordText('title', {title:'A&amp;B'}), '{"title":"A&amp;B"}');
  assert.equal(recordText('title', null), '—');
  assert.equal(recordText('title', 123n), '123');
  assert.equal(recordText('title', 'Already “readable”'), 'Already “readable”');
  assert.equal(recordText('title', '&unknown; &copy and &amp;#x2019;'), '&unknown; &copy and &#x2019;');
  assert.equal(renderToStaticMarkup(createElement(RecordText, {column:'title', value:'Readable', showOriginal:true})), 'Readable');
});

test('encoded markup is readable text and never becomes active HTML', () => {
  const input = '&lt;img src=x onerror=alert(1)&gt; &lt;script&gt;alert(1)&lt;/script&gt;';
  const html = renderToStaticMarkup(createElement(RecordText, {column:'title', value:input, showOriginal:true}));
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.doesNotMatch(html, /<(?:img|script)\b/);
});
