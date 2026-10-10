import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
let schemaReader;
async function validators() {
  if (!schemaReader) schemaReader = build({
    entryPoints: [fileURLToPath(new URL('../lib/source-catalog.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', write: false,
  }).then(async ({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`));
  return schemaReader;
}
export async function validatePublicDirectory(directory) {
  const schema = await validators();
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      try {
        if (entry.isSymbolicLink()) throw Error('Public artifact symlink');
        if (entry.isDirectory()) {
          if (/^(?:ops|operations|internal|catalog-ops)$/i.test(entry.name)) throw Error('Internal directory in public build');
          await walk(child);
        } else if (entry.name.endsWith('.json')) {
          const raw = JSON.parse(await readFile(child, 'utf8'));
          if (basename(path) === 'source-catalog' || String(raw?.format ?? '').startsWith('spicy-source-')) {
            if (raw.format === 'spicy-source-catalog') schema.parseCatalogManifest(raw);
            else if (raw.format === 'spicy-source-collection') schema.parseCatalogDetail(raw, raw.generation, raw.collection?.id);
            else if (raw.format === 'spicy-source-files') schema.parseCatalogFilePage(raw, raw.generation, raw.collectionId, raw.files?.length);
            else throw Error('Invalid public catalog artifact');
          }
        }
      } catch (error) {
        // Replace bundled-module stacks with the artifact location and concise cause.
        if (entry.isDirectory()) throw error;
        throw Error(`${relative(directory, child)}: ${error.message}`);
      }
    }
  }
  await walk(directory);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await validatePublicDirectory(resolve(process.argv[2] ?? 'public'));
    console.log('Public catalog artifacts contain no internal fields or local paths.');
  } catch (error) {
    console.error(`Public catalog validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
