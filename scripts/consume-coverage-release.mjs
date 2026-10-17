/** Offline admission of an externally selected, completed data release. */
import {readFile, lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const digest = raw => 'sha256:' + createHash('sha256').update(raw).digest('hex');
const canonical = value => JSON.stringify(sort(value)).replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sort(value[k])])) : value;
}
async function regular(base, key, cap = 32 * 1024 ** 2) {
  if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe release member');
  let file = resolve(base);
  for (const part of [file, ...key.split('/')]) {
    file = part === resolve(base) ? part : join(file, part);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw Error('Release symlink refused');
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > cap) throw Error('Invalid release member bound');
  return readFile(file);
}

export async function readSelection(path = 'content/coverage-release-selection.v1.json') {
  const raw = await readFile(path).catch(error => {
    if (error.code === 'ENOENT') throw Error('Completed coverage requires a reviewed selection file: ' + path + ' (see docs/release-runbook.md)');
    throw error;
  });
  const selection = JSON.parse(raw);
  if (selection.format !== 'spicygov-coverage-release-selection' || selection.version !== 1) throw Error('Unsupported coverage release selection');
  return selection;
}

export async function consumeRelease(directory, expected, {codeRoot = root} = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected ?? '')) throw Error('A reviewed manifest SHA-256 is required');
  const raw = await regular(directory, 'manifest.json');
  if (digest(raw) !== expected) throw Error('Selected coverage release changed');
  const release = JSON.parse(raw);
  if (release.format !== 'spicygov-completed-coverage-release' || release.version !== 1
      || release.owner !== 'scripts/build-coverage-maps.py:full-completion'
      || !release.members || !release.implementation || !Object.keys(release.implementation).length) throw Error('Unsupported completed coverage release');
  const members = {};
  let bytes = 0;
  if (Object.keys(release.members).length > 16) throw Error('Coverage release member bound');
  for (const [key, pin] of Object.entries(release.members)) {
    const data = await regular(directory, key);
    bytes += data.length;
    if (bytes > 64 * 1024 ** 2 || data.length !== pin.bytes || digest(data) !== pin.sha256) throw Error('Coverage release member changed: ' + key);
    members[key] = data;
  }
  for (const [key, pin] of Object.entries(release.implementation)) {
    if (!/^(scripts\/[a-zA-Z0-9_-]+\.py|content\/coverage-definitions\/[a-z]+\.json)$/.test(key)) throw Error('Invalid coverage implementation path');
    // A bound file that no longer exists is a changed implementation, not an I/O fault.
    const code = await regular(codeRoot, key).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!code || digest(code) !== pin) throw Error('Coverage implementation changed; explicitly refresh data release: ' + key);
  }
  const {outputFiles} = await build({stdin: {contents: `
    export {parseCoverageMaps,currentCoverageMap} from './lib/coverage-map';
    export {loadCatalog} from './lib/catalog';
    export {loadOtherPublications,sourceEntries} from './lib/source-directory';`, resolveDir: codeRoot},
    bundle: true, platform: 'node', format: 'esm', write: false});
  const parser = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
  const maps = parser.parseCoverageMaps(JSON.parse(members['coverage-maps.v1.json']));
  if (!Object.keys(maps.tables).length || maps.censusDigest !== release.censusDigest || maps.generatedAt !== release.generatedAt) throw Error('Coverage release identity differs');
  const policies = JSON.parse(members['effective-policies.json']);
  if (canonical(Object.keys(policies).sort()) !== canonical(Object.keys(maps.tables).sort())
      || canonical(Object.keys(release.measurementRevisions).sort()) !== canonical(Object.keys(policies).sort())) throw Error('Incomplete coverage policies');
  for (const [id, map] of Object.entries(maps.tables)) {
    const policy = policies[id];
    if (map.definitionDigest !== digest(canonical(policy)) || map.measurementRevision !== release.measurementRevisions[id]
        || !/^sha256:[a-f0-9]{64}$/.test(map.measurementRevision ?? '')
        || canonical(map.schema) !== canonical(policy.schema)
        || policy.dimensions.length !== map.dimensions.length) throw Error('Coverage policy/revision changed: ' + id);
    for (let i = 0; i < policy.dimensions.length; i++) {
      if (map.dimensions[i].id !== policy.dimensions[i].id
          || map.dimensions[i].definitionDigest !== digest(canonical(policy.dimensions[i]))) throw Error('Coverage dimension policy changed: ' + id);
    }
  }
  // Use the same live Sources parsers, with a closed retained-file fetch.
  const originalFetch = globalThis.fetch;
  let tables;
  globalThis.fetch = async url => {
    const value = new URL(url);
    if (value.origin !== 'https://data.spicygov.ai' || value.search || value.hash) throw Error('Unretained publication request');
    const raw = members['publications/' + value.pathname.slice(1)];
    if (!raw) throw Error('Missing retained publication: ' + value.pathname);
    return new Response(raw, {status: 200, headers: {'content-type': 'application/json'}});
  };
  try {
    const [main, other] = await Promise.all([parser.loadCatalog(), parser.loadOtherPublications()]);
    if (other.warnings.length) throw Error(other.warnings.join('; '));
    tables = parser.sourceEntries(main, other.tables).map(e => e.table);
  } finally { globalThis.fetch = originalFetch; }
  if (tables.length !== Object.keys(maps.tables).length || tables.some(t => !parser.currentCoverageMap(t, maps))) throw Error('Coverage source selection differs or measurement expired; explicitly refresh data release');
  return {release, maps, tables, mapBytes: members['coverage-maps.v1.json']};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = key => {
    const index = args.indexOf(key);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw Error('Missing value for ' + key);
    return args[index + 1];
  };
  let directory, expected;
  if (args.includes('--release')) { directory = option('--release'); expected = option('--sha256'); }
  else {
    const selected = await readSelection(option('--selection'));
    directory = selected.directory; expected = selected.manifestSha256;
  }
  const result = await consumeRelease(directory, expected);
  console.log(JSON.stringify({status: 'accepted', manifestSha256: expected, tables: result.tables.length, sourceRestorations: 0, networkRequests: 0}));
}
