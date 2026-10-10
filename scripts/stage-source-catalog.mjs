/** Stage one hash-pinned public catalog into a new directory. No publication. */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { validatePublicDirectory } from './catalog-public-validation.mjs';

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let schemaPromise;
function publicSchema() {
  schemaPromise ??= build({ entryPoints: [fileURLToPath(new URL('../lib/source-catalog.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false }).then(({ outputFiles }) =>
    import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));
  return schemaPromise;
}

async function regularFile(root, relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw Error('Invalid public catalog path');
  }
  let path = root;
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw Error('Catalog root must be a regular directory');
  for (const part of relative.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw Error('Catalog symlink refused');
  }
  if (!(await lstat(path)).isFile()) throw Error('Catalog member must be a regular file');
  return path;
}

export async function inspectCatalog(source) {
  const root = resolve(source);
  const schema = await publicSchema();
  const members = new Map();
  async function json(relative) {
    const path = await regularFile(root, relative);
    if ((await lstat(path)).size > 4 * 1024 ** 2) throw Error('Catalog member exceeds inspection bound');
    const body = await readFile(path);
    members.set(relative, { path: relative, bytes: body.length, sha256: digest(body) });
    return JSON.parse(body);
  }
  const manifest = schema.parseCatalogManifest(await json('manifest.json'));
  const prefix = `generations/${manifest.generation.slice(7)}/`;
  function selectedPath(path) {
    if (!path.startsWith(prefix)) throw Error('Catalog reference leaves selected generation');
    return path;
  }
  for (const collection of manifest.collections) {
    const detail = schema.parseCatalogDetail(await json(selectedPath(collection.detailPath)), manifest.generation, collection.id);
    for (const page of detail.files.pages) {
      schema.parseCatalogFilePage(await json(selectedPath(page.path)), manifest.generation, collection.id, page.rows);
    }
  }
  return { format: 'spicy-public-source-catalog-selection', version: 1, generation: manifest.generation,
    files: [...members.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function stageCatalog({ source, selection, selectionSha256, output }) {
  const raw = await readFile(selection);
  if (digest(raw) !== selectionSha256) throw Error('Catalog selection digest differs');
  const selected = JSON.parse(raw);
  if (selected.format !== 'spicy-public-source-catalog-selection' || selected.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(selected.generation)) {
    throw Error('Unsupported public catalog selection');
  }
  const root = resolve(source);
  const prefix = `generations/${selected.generation.slice(7)}/`;
  const members = new Map();
  let bytes = 0;
  for (const member of selected.files) {
    if (members.has(member.path) || (member.path !== 'manifest.json' && !member.path.startsWith(prefix)) || !member.path.endsWith('.json')) {
      throw Error('Unexpected or duplicate catalog member');
    }
    if (!Number.isSafeInteger(member.bytes) || member.bytes < 0 || member.bytes > 4 * 1024 ** 2 || !/^sha256:[a-f0-9]{64}$/.test(member.sha256)) {
      throw Error('Invalid catalog member pin');
    }
    bytes += member.bytes;
    if (bytes > 1024 ** 3) throw Error('Catalog selection exceeds staging bound');
    const path = await regularFile(root, member.path);
    if ((await lstat(path)).size !== member.bytes) throw Error('Catalog member byte size differs');
    const body = await readFile(path);
    if (digest(body) !== member.sha256) throw Error('Catalog member digest differs');
    members.set(member.path, { member, path });
  }
  const referenced = new Set(['manifest.json']);
  async function json(path) {
    const item = members.get(path);
    if (!item) throw Error('Selected catalog lacks referenced member');
    referenced.add(path);
    const body = await readFile(item.path);
    if (digest(body) !== item.member.sha256) throw Error('Catalog changed during reference check');
    return JSON.parse(body);
  }
  const manifest = await json('manifest.json');
  const schema = await publicSchema();
  schema.parseCatalogManifest(manifest);
  if (manifest.generation !== selected.generation) throw Error('Catalog manifest generation differs');
  for (const collection of manifest.collections) {
    const detail = await json(collection.detailPath);
    schema.parseCatalogDetail(detail, selected.generation, collection.id);
    if (detail.generation !== selected.generation || detail.collection.id !== collection.id) throw Error('Catalog detail identity differs');
    let rows = 0;
    for (const descriptor of detail.files.pages) {
      const page = await json(descriptor.path);
      schema.parseCatalogFilePage(page, selected.generation, collection.id, descriptor.rows);
      if (page.generation !== selected.generation || page.collectionId !== collection.id || page.files.length !== descriptor.rows) {
        throw Error('Catalog page identity or count differs');
      }
      rows += page.files.length;
    }
    if (rows !== detail.files.total) throw Error('Catalog page total differs');
  }
  if (referenced.size !== members.size) throw Error('Catalog selection includes unreferenced members');
  // Exclusive directory creation reserves the result and preserves every prior success.
  await mkdir(output, { recursive: false });
  try {
    for (const [relative, { member, path }] of members) {
      if (relative === 'manifest.json') continue;
      const target = join(output, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      if (digest(await readFile(target)) !== member.sha256) throw Error('Catalog changed during copy');
    }
    // Validate all staged public fields before installing the entry manifest.
    await writeFile(join(output, 'manifest.json'), await readFile(members.get('manifest.json').path), { flag: 'wx' });
    if (digest(await readFile(join(output, 'manifest.json'))) !== members.get('manifest.json').member.sha256) throw Error('Manifest changed during copy');
    await validatePublicDirectory(output);
    return { generation: selected.generation, files: members.size, bytes, selectionSha256 };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--inspect') {
    console.log(JSON.stringify(await inspectCatalog(process.argv[3])));
  } else {
  const [source, selection, selectionSha256, output] = process.argv.slice(2);
  if (!source || !selection || !selectionSha256 || !output) throw Error('Usage: stage-source-catalog.mjs SOURCE SELECTION SHA256 NEW_OUTPUT');
  console.log(JSON.stringify(await stageCatalog({ source, selection, selectionSha256, output })));
  }
}
