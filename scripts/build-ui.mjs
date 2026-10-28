/** Build UI with an explicit completed release or unavailable coverage. */
import {writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {consumeRelease, readSelection} from './consume-coverage-release.mjs';
import {inspectCatalog} from './catalog-inspection.mjs';

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
  // A deployable site must include the catalog its Sources page reads.
  await inspectCatalog('public/source-catalog');
}
const result = spawnSync('npm', ['run', 'build:assets'], {stdio: 'inherit'});
if (result.status !== 0) process.exit(result.status ?? 1);
// Never rewrite retained public source artifacts while preparing the site.
await writeFile('dist/coverage-maps.v1.json', admitted ? admitted.mapBytes : JSON.stringify({
  format: 'spicygov-coverage-unavailable', version: 1,
  reason: 'This UI build has no independently selected completed coverage data release.'
}) + '\n');
await writeFile('dist/coverage-build-status.json', JSON.stringify({mode: admitted?.release.format === 'spicygov-coverage-refresh-release' ? 'refreshed' : mode,
  ...(admitted ? {censusDigest: admitted.release.censusDigest} : {}), sourceRestorations: 0, networkRequests: 0}) + '\n');
console.log(`UI coverage: ${mode}; source restoration disabled`);
