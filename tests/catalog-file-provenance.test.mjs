import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['lib/source-catalog.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { parseCatalogFilePage } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const generation = 'sha256:' + 'a'.repeat(64);
const provenance = { basis: 'receipt-backed', sourceUrls: ['https://source.gov/data'], capturedAt: '2026-10-28T01:00:00Z',
  receipt: { sha256: generation, entry: 2 }, availability: 'local' };
const page = value => ({ format: 'spicy-source-files', version: 2, generation, collectionId: 'test',
  files: [{ id: 'file:' + 'a'.repeat(64), name: 'original.json', status: 'held', provenance: value }] });
const parse = value => parseCatalogFilePage(page(value), generation, 'test', 1);

test('file parser preserves per-alias provenance and permits legacy absent evidence', () => {
  assert.deepEqual(parse(provenance).files[0].provenance, provenance);
  assert.equal(parse(undefined).files[0].provenance, undefined);
  const listing = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/list.html?prefix=bulk-data/';
  assert.equal(parse({...provenance, sourceUrls:[listing]}).files[0].provenance.sourceUrls[0],listing);
  assert.equal(parse({ ...provenance, capturedAt: undefined, basis: 'provisional' }).files[0].provenance.basis, 'provisional');
});

test('file parser refuses private fields, unsafe origins and unqualified capture dates', () => {
  for (const bad of [
    { ...provenance, sourceUrls: ['file:///Users/private/data'] },
    { ...provenance, sourceUrls: ['https://user:password@source.gov/data'] },
    { ...provenance, sourceUrls: ['https://source.gov/data?token=private'] },
    { ...provenance, sourceUrls: ['https://source.gov/data#private'] },
    { ...provenance, sourceUrls: ['https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/list.html?prefix=private/'] },
    { ...provenance, sourceUrls: ['https://source.gov/data', 'https://source.gov/data'] },
    { ...provenance, localPath: '/Users/private/data' },
    { ...provenance, receipt: { sha256: generation, entry: 0 } },
    { ...provenance, receipt: { sha256: generation, path: '/private/receipt' } },
    { ...provenance, originalReceiptSha256: 'invalid' },
    { ...provenance, capturedAt: '2026-10-28' },
    { ...provenance, basis: 'inferred' },
    { ...provenance, basis: 'provisional' },
    { ...provenance, availability: 'remote-maybe' },
  ]) assert.throws(() => parse(bad));
});

test('recovered Google Books PDF sources retain their public volume identifiers', () => {
  const urls = [
    'https://books.google.com/books/download/Report_of_the_Secretary_of_the_Senate.pdf?id=OoyNNdJYIw8C&output=pdf',
    'https://books.google.com/books/download/Report_of_the_Secretary_of_the_Senate_Ap.pdf?id=_JqMqHqpkc0C&output=pdf',
    'https://books.google.com/books/download/Report_of_the_Secretary_of_the_Senate.pdf?output=pdf&id=OoyNNdJYIw8C',
  ];
  assert.deepEqual(parse({...provenance,sourceUrls:urls}).files[0].provenance.sourceUrls,urls);
});

test('Google Books support refuses signed, ambiguous and unrelated query URLs', () => {
  const url = 'https://books.google.com/books/download/Report.pdf?id=OoyNNdJYIw8C&output=pdf';
  for (const bad of [
    `${url}&sig=private`, `${url}&token=private`, `${url}&download=1`,
    `${url}&id=WHF6CogHDB4C`, `${url}&output=pdf`, `${url}#private`,
    url.replace('OoyNNdJYIw8C',''), url.replace('OoyNNdJYIw8C','bad/id'),
    url.replace('&output=pdf',''), url.replace('output=pdf','output=epub'),
    url.replace('https:','http:'), url.replace('books.google.com','books.google.com.example.org'),
    url.replace('books.google.com','books.google.com:8443'),
    url.replace('books.google.com','user:password@books.google.com'),
    url.replace('/books/download/','/books/'), url.replace('.pdf?','.html?'),
  ]) assert.throws(() => parse({...provenance,sourceUrls:[url,bad]}),undefined,bad);
});
