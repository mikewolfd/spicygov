import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';

// Parse the actual generated artifact with the same code Sources uses, before
// publishing it. Fixtures alone cannot prove an inventory loads in the browser.
const path = process.argv[2] ?? 'public/coverage-maps.v1.json';
const {outputFiles} = await build({stdin:{contents: `
  export {parseCoverageMaps, currentCoverageMap} from './lib/coverage-map';
  export {loadCatalog} from './lib/catalog';
  export {loadOtherPublications, sourceEntries} from './lib/source-directory';
`,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {parseCoverageMaps, currentCoverageMap, loadCatalog, loadOtherPublications, sourceEntries} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const parsed = parseCoverageMaps(JSON.parse(await readFile(path,'utf8')));
const tables = Object.values(parsed.tables);
if (!tables.length) throw new Error('Coverage inventory is empty');
const [main, other] = await Promise.all([
  loadCatalog(AbortSignal.timeout(60000)),
  loadOtherPublications(AbortSignal.timeout(60000)),
]);
if (other.warnings.length) throw new Error(other.warnings.join('; '));
const current = sourceEntries(main, other.tables).map(entry => entry.table);
const missing = current.filter(table => !currentCoverageMap(table, parsed)).map(table => table.id);
const extra = Object.keys(parsed.tables).filter(id => !current.some(table => table.id === id));
if (missing.length || extra.length) throw new Error(`Sources coverage mismatch: missing or stale ${missing.join(', ')}; extra ${extra.join(', ')}`);
console.log(`Sources parser accepts all ${tables.length} maps and ${tables.reduce((n,t)=>n+t.dimensions.length,0)} dimensions`);
