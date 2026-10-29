/** Build UI with an explicit completed release or unavailable coverage. */
import {lstat,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {consumeRelease, readSelection} from './consume-coverage-release.mjs';

const args = process.argv.slice(2);
const value = key => {
  const index = args.indexOf(key);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error('Missing value for ' + key);
  return args[index + 1];
};
const mode = args.includes('--coverage') ? value('--coverage') : 'completed';
if (!['completed', 'unavailable'].includes(mode)) throw Error('Choose --coverage completed or unavailable');
let admitted;
if (mode === 'completed') {
  const selection = await readSelection(value('--selection'));
  admitted = await consumeRelease(selection.directory, selection.manifestSha256);
}
const catalogExists = await lstat('public/source-catalog').then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
if (!catalogExists && mode === 'completed') throw Error('Missing public/source-catalog for completed UI build');
if (process.env.SOURCE_CATALOG_MIRROR_INVENTORY) {
  if (!catalogExists || !process.env.SOURCE_CATALOG_CACHE || !process.env.SPICYGOV_RAW_ROOT)
    throw Error('Mirror inventory requires the selected catalog cache and raw archive root');
  const prepared = spawnSync(process.env.SOURCE_CATALOG_PYTHON || 'python3', ['scripts/prepare-archive-mirror.py',
    '--inventory', process.env.SOURCE_CATALOG_MIRROR_INVENTORY, '--cache', process.env.SOURCE_CATALOG_CACHE,
    '--catalog', 'public/source-catalog', '--raw-root', process.env.SPICYGOV_RAW_ROOT,
    '--output', 'public/archive-mirror.v1.json'], {stdio:'inherit'});
  if (prepared.status !== 0) process.exit(prepared.status ?? 1);
}
// A bundled catalog and its date summary must be the catalog the browser reads.
const result = spawnSync('npm', ['run', 'build:assets'], {stdio: 'inherit',
  env: {...process.env, ...(catalogExists ? {VITE_SOURCE_CATALOG_URL: '/source-catalog/manifest.json'} : {})}});
if (result.status !== 0) process.exit(result.status ?? 1);
// Vite derives dates during its required validation of the built catalog.
// Reuse that result instead of scanning the entire input catalog a third time.
const registerPeriodBytes = await readFile('dist/register-source-periods.v1.json');
if (catalogExists) {
  const source = await readFile('public/source-catalog/manifest.json');
  const built = await readFile('dist/source-catalog/manifest.json');
  if (!source.equals(built) || JSON.parse(registerPeriodBytes).generation !== JSON.parse(built).generation)
    throw Error('Built source dates differ from the input catalog');
}
await writeFile('public/register-source-periods.v1.json', registerPeriodBytes);
// Never rewrite retained public source artifacts while preparing the site.
await writeFile('dist/coverage-maps.v1.json', admitted ? admitted.mapBytes : JSON.stringify({
  format: 'spicygov-coverage-unavailable', version: 1,
  reason: 'This UI build has no independently selected completed coverage data release.'
}) + '\n');
await writeFile('dist/coverage-build-status.json', JSON.stringify({mode: admitted?.release.format === 'spicygov-coverage-refresh-release' ? 'refreshed' : mode,
  ...(admitted ? {censusDigest: admitted.release.censusDigest} : {}), sourceRestorations: 0, networkRequests: 0}) + '\n');
console.log(`UI coverage: ${mode}; source restoration disabled`);
