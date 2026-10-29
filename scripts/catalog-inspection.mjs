/** Shared inspection of the complete, selected public catalog, including native file inventories. */
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {registerSourcePeriods} from './register-source-periods.mjs';
export const catalogDigest = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;
let reader;
let interpretation;
async function schema() {
  reader ??= build({entryPoints:[fileURLToPath(new URL('../lib/source-catalog.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false,metafile:true})
    .then(async ({outputFiles,metafile}) => {
      const paths = Object.keys(metafile.inputs).filter(path => !path.includes('node_modules/'));
      paths.push(fileURLToPath(import.meta.url),fileURLToPath(new URL('./register-source-periods.mjs',import.meta.url)),fileURLToPath(new URL('../package-lock.json',import.meta.url)));
      interpretation = catalogDigest(JSON.stringify(await Promise.all([...new Set(paths)].sort().map(async path => [resolve(path),catalogDigest(await readFile(path))]))));
      return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
    });
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
export async function checkCatalogMembers(root,members) {
  let count = 0;
  async function walk(path,relative = '') {
    for (const item of await readdir(path,{withFileTypes:true})) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw Error('Catalog symlink refused');
      if (item.isDirectory()) await walk(join(path,item.name),name);
      else if (!item.isFile() || !members.has(name)) throw Error('Catalog includes an unreferenced member');
      else count += 1;
    }
  }
  await walk(root);
  if (count !== members.size) throw Error('Catalog members differ from selection');
}
export async function inspectCatalog(source, {onFilePage} = {}) {
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
          const page = await api.parseCatalogParquet(body.buffer.slice(body.byteOffset,body.byteOffset + body.byteLength),{generation:manifest.generation,collectionId:collection.id,inventoryKind,part});
          onFilePage?.(collection.id,inventoryKind,page.files);
        } else {
          const page = api.parseCatalogFilePage(await json(path),manifest.generation,collection.id,part.rows,false,manifest.version);
          onFilePage?.(collection.id,inventoryKind,page.files);
        }
      }
    }
  }
  await checkCatalogMembers(root,members);
  return {format:'spicy-public-source-catalog-selection',version:1,generation:manifest.generation,files:[...members.values()].sort((a,b)=>a.path.localeCompare(b.path))};
}

/** Reuse semantic admission of identical bytes; retain whole-member transfer checks. */
export async function inspectCatalogCached(source, {cacheRoot=resolve('.cache/catalog-inspections')} = {}) {
  const root = resolve(source);
  await schema();
  const observed = new Map();
  let bytes = 0;
  async function hashMembers(path, relative='') {
    for (const child of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name = relative ? relative+'/'+child.name : child.name;
      if (child.isSymbolicLink()) throw Error('Catalog symlink refused');
      if (child.isDirectory()) await hashMembers(join(path,child.name),name);
      else {
        const file = await catalogRegularFile(root,name), size = (await lstat(file)).size;
        bytes += size;
        if (size > 4*1024**2 || bytes > 1024**3) throw Error('Catalog inspection exceeds byte bound');
        observed.set(name,{path:name,bytes:size,sha256:catalogDigest(await readFile(file))});
      }
    }
  }
  await hashMembers(root);
  const key = catalogDigest(JSON.stringify([interpretation,[...observed.values()]]));
  const path = join(cacheRoot,key.slice(7)+'.json');
  let raw;
  try {raw = await readFile(path,'utf8');} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (raw !== undefined) {
    const saved = JSON.parse(raw), payload = saved.payload;
    if (saved.key !== key || catalogDigest(JSON.stringify(payload)) !== saved.sha256)
      throw Error('Completed catalog inspection changed');
    const members = new Map();
    for (const member of payload.selection.files) {
      if (members.has(member.path)) throw Error('Repeated completed catalog member');
      const actual = observed.get(member.path);
      if (!actual || actual.bytes !== member.bytes || actual.sha256 !== member.sha256)
        throw Error('Completed catalog member changed: '+member.path);
      members.set(member.path,member);
    }
    if (members.size !== observed.size) throw Error('Completed catalog member set differs');
    return {...payload,reused:true};
  }
  const register = registerSourcePeriods();
  const selection = await inspectCatalog(root,{onFilePage:register.addPage});
  const payload = {selection,sourcePeriods:register.result(selection.generation)};
  await mkdir(cacheRoot,{recursive:true});
  const temporary = path+'.'+process.pid+'.tmp';
  await writeFile(temporary,JSON.stringify({key,payload,sha256:catalogDigest(JSON.stringify(payload))})+'\n',{flag:'wx',mode:0o600});
  await rename(temporary,path);
  return {...payload,reused:false};
}
