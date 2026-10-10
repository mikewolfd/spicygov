import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageCatalog, inspectCatalog } from '../scripts/stage-source-catalog.mjs';

const hash = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'catalog-staging-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const manifest = { format: 'spicy-source-catalog', version: 1, generation: `sha256:${'a'.repeat(64)}`, generatedAt: '2026-10-10T00:00:00Z', collections: [], totals: {} };
  const body = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(source, 'manifest.json'), body);
  const selected = { format: 'spicy-public-source-catalog-selection', version: 1, generation: manifest.generation, files: [{ path: 'manifest.json', bytes: body.length, sha256: hash(body) }] };
  const selection = join(root, 'selection.json');
  const raw = Buffer.from(JSON.stringify(selected));
  await writeFile(selection, raw);
  return { root, source, selection, selectionSha256: hash(raw), output: join(root, 'result'), selected };
}

test('stages exact pinned public bytes and preserves an existing successful result', async (t) => {
  const args = await fixture(t);
  const receipt = await stageCatalog(args);
  assert.equal(receipt.files, 1);
  assert.deepEqual(await readFile(join(args.output, 'manifest.json')), await readFile(join(args.source, 'manifest.json')));
  await assert.rejects(stageCatalog(args), /EEXIST/);
  assert.equal(JSON.parse(await readFile(join(args.output, 'manifest.json'))).generation, args.selected.generation);
});

test('refuses a changed selected member before creating output', async (t) => {
  const args = await fixture(t);
  await writeFile(join(args.source, 'manifest.json'), '{}');
  await assert.rejects(stageCatalog(args), /byte size differs/);
  await assert.rejects(readFile(join(args.output, 'manifest.json')), /ENOENT/);
});

test('refuses an unpinned selection', async (t) => {
  const args = await fixture(t);
  await assert.rejects(stageCatalog({ ...args, selectionSha256: `sha256:${'b'.repeat(64)}` }), /selection digest differs/);
});

test('refuses symlink source members', async (t) => {
  const args = await fixture(t);
  const path = join(args.source, 'manifest.json');
  await writeFile(join(args.root, 'original.json'), await readFile(path));
  await rm(path);
  await symlink(join(args.root, 'original.json'), path);
  await assert.rejects(stageCatalog(args), /symlink refused/);
});

test('public-field rejection removes only the new failed stage', async (t) => {
  const args = await fixture(t);
  const manifest = JSON.parse(await readFile(join(args.source, 'manifest.json')));
  manifest.localPath = '/Users/private';
  const body = Buffer.from(JSON.stringify(manifest));
  await writeFile(join(args.source, 'manifest.json'), body);
  args.selected.files[0] = { path: 'manifest.json', bytes: body.length, sha256: hash(body) };
  const raw = Buffer.from(JSON.stringify(args.selected));
  await writeFile(args.selection, raw);
  await assert.rejects(stageCatalog({ ...args, selectionSha256: hash(raw) }), /internal|local|Unexpected/i);
  await assert.rejects(readFile(join(args.output, 'manifest.json')), /ENOENT/);
});

async function addCollection(args, mutate = () => {}) {
  const generation = args.selected.generation;
  const prefix = `generations/${generation.slice(7)}/`;
  const item = { id: 'held', title: 'Retained source', statuses: ['held'], families: [], tables: [], routeCount: 0,
    holdings: { aliases: 1, objects: 1, decodedBytes: 10, missing: 0 }, periods: [], detailPath: `${prefix}collection.json` };
  const manifest = { format: 'spicy-source-catalog', version: 1, generation, generatedAt: '2026-10-10T00:00:00Z', collections: [item], totals: {} };
  const detail = { format: 'spicy-source-collection', version: 1, generation, collection: item, routes: [], tables: [],
    files: { pages: [{ path: `${prefix}page.json`, rows: 1 }], total: 1 }, planned: [], observations: [], relationships: [] };
  const page = { format: 'spicy-source-files', version: 1, generation, collectionId: item.id, files: [{ id: 'alias', name: 'input.xml', status: 'held' }] };
  mutate({ manifest, detail, page });
  await mkdir(join(args.source, prefix), { recursive: true });
  args.selected.files = [];
  for (const [path, value] of [['manifest.json', manifest], [`${prefix}collection.json`, detail], [`${prefix}page.json`, page]]) {
    const body = Buffer.from(JSON.stringify(value));
    await writeFile(join(args.source, path), body);
    args.selected.files.push({ path, bytes: body.length, sha256: hash(body) });
  }
  const raw = Buffer.from(JSON.stringify(args.selected));
  await writeFile(args.selection, raw);
  args.selectionSha256 = hash(raw);
}

test('stages complete collection and file references', async (t) => {
  const args = await fixture(t);
  await addCollection(args);
  assert.equal((await stageCatalog(args)).files, 3);
});

test('rejects stale referenced page even when all selected hashes match', async (t) => {
  const args = await fixture(t);
  await addCollection(args, ({ page }) => { page.generation = `sha256:${'b'.repeat(64)}`; });
  await assert.rejects(stageCatalog(args), /generation/i);
});

test('schema validation applies to every selected file regardless of output name', async (t) => {
  const args = await fixture(t);
  await addCollection(args, ({ page }) => { delete page.format; page.localPath = '/tmp/private'; });
  await assert.rejects(stageCatalog(args), /internal|local|format/i);
  await assert.rejects(inspectCatalog(args.source), /internal|local|format/i);
});

test('inspection rejects a format-less private manifest in an arbitrary directory', async (t) => {
  const args = await fixture(t);
  await writeFile(join(args.source, 'manifest.json'), JSON.stringify({ generation: args.selected.generation, collections: [], localPath: '/Users/private' }));
  await assert.rejects(inspectCatalog(args.source), /internal|local|format/i);
});
