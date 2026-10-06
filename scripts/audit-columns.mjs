// Inventory current public schemas and bounded row samples; never infer a join from a name.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const outArg = process.argv.indexOf('--out');
if (outArg < 0 || !process.argv[outArg + 1]) throw new Error('Usage: node scripts/audit-columns.mjs --out /path/to/report');
const output = resolve(process.argv[outArg + 1]);
await mkdir(join(output, 'tables'), {recursive: true});
await mkdir(join(output, 'inputs'), {recursive: true});
const options = {version: 1, rowsPerWindow: 3, windows: ['first', 'middle', 'last'], columnBatch: 8,
  maxRangeBytes: 32 * 1024 * 1024, maxTableBytes: 64 * 1024 * 1024, sampleCharacters: 240};
const hash = value => createHash('sha256').update(value).digest('hex');
const scriptDigest = hash(await readFile(new URL(import.meta.url)));
const originalFetch = globalThis.fetch;
const captures = [];
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (response.ok) captures.push({url: String(args[0]), status: response.status, etag: response.headers.get('etag'), text: await response.clone().text()});
  return response;
};
const {outputFiles} = await build({entryPoints:['lib/catalog.ts'], bundle:true, platform:'node', format:'esm', write:false});
const {loadCollection} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
let collection;
try { collection = await loadCollection(); } finally { globalThis.fetch = originalFetch; }
if (collection.metadata.state === 'unavailable' || collection.warnings?.length) throw new Error('The complete publication inventory or its metadata could not be loaded.');
for (const capture of captures) {
  capture.sha256 = hash(capture.text);
  await writeFile(join(output, 'inputs', `${capture.sha256}.json`), capture.text);
  delete capture.text;
}
await writeFile(join(output, 'catalog.json'), JSON.stringify(collection, null, 2));
console.log(`Inventoried ${collection.tables.length} tables and ${collection.joins.length} usable declared joins.`);

function sampleValue(value) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const text = typeof value === 'string' ? value : JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v);
  return {type, text: text.slice(0, options.sampleCharacters), characters: text.length, truncated: text.length > options.sampleCharacters};
}
function embeddedFields(value) {
  if (typeof value === 'string') {
    if (value.length > 65536 || !/^[\[{]/.test(value.trim())) return [];
    try { value = JSON.parse(value); } catch { return []; }
  }
  const fields = new Set();
  function visit(item, path, depth) {
    if (!item || typeof item !== 'object' || depth > 3) return;
    if (Array.isArray(item)) item.slice(0, 3).forEach(v => visit(v, `${path}[]`, depth + 1));
    else for (const [key, child] of Object.entries(item).slice(0, 30)) {
      const next = path ? `${path}.${key}` : key; fields.add(next); visit(child, next, depth + 1);
    }
  }
  visit(value, '', 0); return [...fields].sort();
}
function windows(table) {
  if (!table.rows) return [];
  const starts = table.rows <= 9 ? [0] : [0, Math.floor(table.rows / 2), table.rows - 3];
  return starts.map(start => {
    let offset = 0;
    for (const member of table.members) {
      if (start < offset + member.rows) return {member, position: start, local: start - offset,
        size: Math.min(table.rows <= 9 ? table.rows : 3, offset + member.rows - start)};
      offset += member.rows;
    }
    throw new Error(`Published members do not contain row ${start}: ${table.id}`);
  });
}
async function sampleTable(table) {
  const fingerprint = hash(JSON.stringify({table, options, scriptDigest}));
  const path = join(output, 'tables', `${table.id}.json`);
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'));
    if (cached.fingerprint === fingerprint && !cached.errors.length) return {...cached, reused: true};
  } catch { /* First run or different published inputs. */ }
  const result = {...table, fingerprint, options, profiles: {}, sampledWindows: [], errors: [], bytesFetched: 0, requests: 0};
  for (const column of table.columns) result.profiles[column.name] = {seen: 0, nulls: 0, blank: 0, missing: 0, samples: [], embeddedFields: []};
  let reserved = 0;
  const files = new Map(), signal = AbortSignal.timeout(90_000);
  async function fileFor(member) {
    if (files.has(member.url)) return files.get(member.url);
    const ranges = new Map();
    const file = {byteLength: member.byteSize, slice(start, end = member.byteSize) {
      const key = `${start}:${end}`;
      if (ranges.has(key)) return ranges.get(key);
      const size = end - start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > member.byteSize || size < 0) throw new Error('Invalid byte range');
      if (size > options.maxRangeBytes || reserved + size > options.maxTableBytes) throw new Error('Bounded sample byte limit reached; no full-table scan attempted');
      reserved += size;
      const promise = (async () => {
        const headers = {Range: `bytes=${start}-${end - 1}`};
        if (member.etag) headers['If-Match'] = member.etag.startsWith('"') ? member.etag : `"${member.etag}"`;
        result.requests++;
        const response = await originalFetch(member.url, {headers, signal});
        const contentRange = response.headers.get('content-range');
        const etag = response.headers.get('etag')?.replace(/^"|"$/g, '');
        if (response.status !== 206 || contentRange !== `bytes ${start}-${end - 1}/${member.byteSize}`
            || member.etag && etag !== member.etag.replace(/^"|"$/g, '')) {
          await response.body?.cancel(); throw new Error('Published file identity or byte range did not match');
        }
        const buffer = await response.arrayBuffer();
        result.bytesFetched += buffer.byteLength;
        if (buffer.byteLength !== size) throw new Error('Incomplete byte range');
        return buffer;
      })();
      ranges.set(key, promise); return promise;
    }};
    const metadata = await parquetMetadataAsync(file, {initialFetchSize: 65536});
    if (Number(metadata.num_rows) !== member.rows) throw new Error('Parquet footer count differs from publication');
    const context = {file, metadata}; files.set(member.url, context); return context;
  }
  for (const window of windows(table)) {
    try {
      const context = await fileFor(window.member);
      if (!result.columns.length) {
        result.schemaBasis = 'Selected Parquet footer; no bound explorer schema';
        result.columns = parquetSchema(context.metadata).children.map(child => ({name:child.element.name, type:child.element.type ?? 'STRUCT', description:''}));
        for (const column of result.columns) result.profiles[column.name] = {seen:0,nulls:0,blank:0,missing:0,samples:[],embeddedFields:[]};
      }
      result.sampledWindows.push({position: window.position, rows: window.size, member: window.member.url, localPosition: window.local});
      async function readColumns(columns) {
        const rows = await parquetReadObjects({...context, compressors, columns, rowStart:window.local, rowEnd:window.local + window.size,
          useOffsetIndex:true, usePageIndex:true});
        if (rows.length !== window.size) throw new Error('Unexpected sample row count');
        for (const name of columns) {
          const profile = result.profiles[name];
          for (const row of rows) {
            profile.seen++;
            if (!Object.hasOwn(row,name) || row[name] === undefined) {profile.missing++;continue;}
            if (row[name] === null) {profile.nulls++;continue;}
            if (row[name] === '') {profile.blank++;continue;}
            const value = sampleValue(row[name]);
            if (profile.samples.length < 3 && !profile.samples.some(sample => sample.text === value.text && sample.type === value.type && sample.characters === value.characters)) profile.samples.push(value);
            profile.embeddedFields = [...new Set([...profile.embeddedFields, ...embeddedFields(row[name])])].sort();
          }
        }
      }
      for (let i = 0; i < result.columns.length; i += options.columnBatch) {
        const columns = result.columns.slice(i,i + options.columnBatch).map(column => column.name);
        try { await readColumns(columns); }
        catch {
          for (const column of columns) try { await readColumns([column]); }
          catch (error) { result.errors.push({column,position:window.position,error:error.message}); }
        }
      }
    } catch (error) { result.errors.push({position:window.position,error:error.message}); }
  }
  result.status = !table.rows ? 'empty-publication' : result.errors.length ? 'partial-sample' : 'sampled';
  await writeFile(path, JSON.stringify(result,null,2)); return result;
}
const results = [], failures = []; let next = 0;
async function worker() {
  while (next < collection.tables.length) {
    const table = collection.tables[next++];
    try { results.push(await sampleTable(table)); }
    catch (error) { failures.push({table:table.id,error:error.message}); }
    if ((results.length + failures.length) % 10 === 0) console.log(`${results.length + failures.length}/${collection.tables.length} table samples finished`);
  }
}
await Promise.all([worker(),worker()]);
results.sort((a,b) => a.id.localeCompare(b.id));
const columns = {};
for (const table of results) for (const column of table.columns) {
  (columns[column.name] ??= []).push({table:table.id,family:table.family,type:column.type,description:column.description,profile:table.profiles[column.name],
    joins:collection.joins.filter(j => j.child === table.id && j.child_columns.includes(column.name) || j.parent === table.id && j.parent_columns.includes(column.name))});
}
const summary = {tables:results.length,columnOccurrences:results.reduce((n,t)=>n+t.columns.length,0),distinctColumns:Object.keys(columns).length,
  sampled:results.filter(t=>t.status === 'sampled').length,empty:results.filter(t=>t.status === 'empty-publication').length,
  partial:results.filter(t=>t.status === 'partial-sample').length,failures,bytesFetched:results.reduce((n,t)=>n+t.bytesFetched,0),usableJoins:collection.joins.length};
const report = {format:'spicygov-column-audit',version:1,generatedAt:new Date().toISOString(),options,scriptDigest,summary,inputs:captures,
  limitations:['These are physical first/middle/last row samples, not random samples or full-column profiles.',
    'A sampled overlap suggests a candidate, not uniqueness, referential completeness or source authority.',
    'Saved member hashes identify the publication; this audit does not download whole files to verify their hashes.',
    'No nonblank sample does not establish that a column is empty. Byte-limit failures stay explicit.'],
  metadata:collection.metadata,joins:collection.joins,tables:results,columns};
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(summary));
if (failures.length) process.exitCode = 1;
