/** Shared inspection of the complete, selected public catalog, including native file inventories. */
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
export const catalogDigest = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;
let reader;
async function schema() {
  reader ??= build({entryPoints:[fileURLToPath(new URL('../lib/source-catalog.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false})
    .then(({outputFiles}) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));
  return reader;
}
export async function catalogRegularFile(root,relative) {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid public catalog path');
  const base = await lstat(root);
  if (!base.isDirectory() || base.isSymbolicLink()) throw Error('Catalog root must be a regular directory');
  let path = root;
  for (const part of relative.split('/')) {
    path = join(path,part);
    if ((await lstat(path)).isSymbolicLink()) throw Error('Catalog symlink refused');
  }
  if (!(await lstat(path)).isFile()) throw Error('Catalog member must be a regular file');
  return path;
}
export async function inspectCatalog(source) {
  const root = resolve(source), api = await schema(), members = new Map();
  async function bytes(relative) {
    if (members.has(relative)) throw Error('Repeated catalog reference');
    const path = await catalogRegularFile(root,relative);
    if ((await lstat(path)).size > 4 * 1024 ** 2) throw Error('Catalog member exceeds inspection bound');
    const body = await readFile(path);
    members.set(relative,{path:relative,bytes:body.length,sha256:catalogDigest(body)});
    return body;
  }
  async function json(relative) { return JSON.parse(await bytes(relative)); }
  const manifest = api.parseCatalogManifest(await json('manifest.json'));
  const prefix = `generations/${manifest.generation.slice(7)}/`;
  function selectedPath(path) { if (!path.startsWith(prefix)) throw Error('Catalog reference leaves selected generation'); return path; }
  for (const collection of manifest.collections) {
    const detail = api.parseCatalogDetail(await json(selectedPath(collection.detailPath)),manifest.generation,collection.id,false,manifest.version);
    for (const [inventoryKind,inventory] of [['active',detail.files],['attention',detail.retainedFiles]]) {
      if (!inventory) continue;
      for (const part of inventory.pages) {
        const path = selectedPath(part.path);
        if (manifest.version === 3) {
          const body = await bytes(path), pin = members.get(path);
          if (pin.bytes !== part.bytes || pin.sha256 !== part.sha256) throw Error('Catalog Parquet descriptor differs from member bytes');
          await api.parseCatalogParquet(body.buffer.slice(body.byteOffset,body.byteOffset + body.byteLength),{generation:manifest.generation,collectionId:collection.id,inventoryKind,part});
        } else api.parseCatalogFilePage(await json(path),manifest.generation,collection.id,part.rows,false,manifest.version);
      }
    }
  }
  async function walk(path,relative = '') {
    for (const item of await readdir(path,{withFileTypes:true})) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error('Catalog symlink refused');
      if (item.isDirectory()) await walk(join(path,item.name),name);
      else if (!item.isFile() || !members.has(name)) throw Error('Catalog includes an unreferenced member');
    }
  }
  await walk(root);
  return {format:'spicy-public-source-catalog-selection',version:1,generation:manifest.generation,files:[...members.values()].sort((a,b)=>a.path.localeCompare(b.path))};
}
