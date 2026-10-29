/** Verify an immutable public catalog selection before exclusive staging. */
import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {catalogDigest as digest,checkCatalogMembers,catalogRegularFile,inspectCatalog,inspectCatalogCached} from './catalog-inspection.mjs';
export {inspectCatalog};

export async function stageCatalog({source,selection,selectionSha256,output}) {
  const raw = await readFile(selection);
  if (digest(raw) !== selectionSha256) throw Error('Catalog selection digest differs');
  const selected = JSON.parse(raw);
  if (selected.format !== 'spicy-public-source-catalog-selection' || selected.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(selected.generation)) throw Error('Unsupported public catalog selection');
  const root = resolve(source), prefix = `generations/${selected.generation.slice(7)}/`, members = new Map();
  let bytes = 0;
  for (const member of selected.files) {
    if (members.has(member.path) || (member.path !== 'manifest.json' && !member.path.startsWith(prefix)) || !/\.(json|parquet)$/.test(member.path)) throw Error('Unexpected or duplicate catalog member');
    if (!Number.isSafeInteger(member.bytes) || member.bytes < 0 || member.bytes > 4 * 1024 ** 2 || !/^sha256:[a-f0-9]{64}$/.test(member.sha256)) throw Error('Invalid catalog member pin');
    bytes += member.bytes;
    if (bytes > 1024 ** 3) throw Error('Catalog selection exceeds staging bound');
    const path = await catalogRegularFile(root,member.path);
    if ((await lstat(path)).size !== member.bytes) throw Error('Catalog member byte size differs');
    if (digest(await readFile(path)) !== member.sha256) throw Error('Catalog member digest differs');
    members.set(member.path,{member,path});
  }
  await checkCatalogMembers(root,members);
  await mkdir(output,{recursive:false});
  try {
    for (const [relative,{member,path}] of members) {
      if (relative === 'manifest.json') continue;
      const target = join(output,relative);
      await mkdir(dirname(target),{recursive:true});
      await copyFile(path,target,constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      if (digest(await readFile(target)) !== member.sha256) throw Error('Catalog changed during copy');
    }
    await writeFile(join(output,'manifest.json'),await readFile(members.get('manifest.json').path),{flag:'wx'});
    if (digest(await readFile(join(output,'manifest.json'))) !== members.get('manifest.json').member.sha256) throw Error('Manifest changed during copy');
    // Validate the actual copied bytes against both the native schema and the
    // selected hashes. Source schema decoding would repeat this same work.
    const {selection:inspected} = await inspectCatalogCached(output);
    if (inspected.generation !== selected.generation) throw Error('Catalog manifest generation differs');
    if (inspected.files.length !== members.size || inspected.files.some(member => {
      const expected = members.get(member.path)?.member;
      return !expected || expected.bytes !== member.bytes || expected.sha256 !== member.sha256;
    })) throw Error('Catalog selection differs from referenced members');
    return {generation:selected.generation,files:members.size,bytes,selectionSha256};
  } catch (error) { await rm(output,{recursive:true,force:true}); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--inspect') {
    const {selection,sourcePeriods} = await inspectCatalogCached(process.argv[3]);
    if (process.argv[4] === '--source-periods' && process.argv[5]) {
      await writeFile(process.argv[5], JSON.stringify(sourcePeriods) + '\n', {flag:'wx'});
    }
    console.log(JSON.stringify(selection));
  }
  else {
    const [source,selection,selectionSha256,output] = process.argv.slice(2);
    if (!source || !selection || !selectionSha256 || !output) throw Error('Usage: node scripts/stage-source-catalog.mjs SOURCE SELECTION SHA256 NEW_OUTPUT');
    console.log(JSON.stringify(await stageCatalog({source,selection,selectionSha256,output})));
  }
}
