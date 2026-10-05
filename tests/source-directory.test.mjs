import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
async function module(path) {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
}
const { parseSourceReview, parseRulemaking, parseComments, sourceEntries, reviewedGenerationLinks, filterEntries, parseGenerationDetails, loadOtherPublications } = await module('lib/source-directory.ts');
const { generationEvidence, dataUrl } = await module('lib/publication-evidence.ts');
const sha = 'sha256:' + 'a'.repeat(64), newer = 'sha256:' + 'b'.repeat(64);
const base = 'https://data.spicygov.ai';
const table = (id = 'records') => ({ id, family: 'family', label: 'Records', columns: [], rows: 0, bytes: 20, members: [], inputs: [], sources: [], artifactDigest: sha, summary: '', coverage: '', connectionNotes: [] });
const review = () => ({ format: 'spicygov-source-review', version: 1, reviewedAt: '2026-10-04T21:00:00Z', sourceRevision: 'a'.repeat(40), tables: {
  records: { family: 'family', label: 'Records', methods: ['api', 'bulk_download'], summary: 'API plus bulk.', mixing: 'Retained records.', gaps: ['Bodies absent.'], sources: [{ id: 'publisher', name: 'Publisher', url: 'https://example.gov' }], artifactDigest: sha, generationLinks: [{ label: 'Source observation journal', url: `${base}/source-evidence/${'a'.repeat(64)}/journal.jsonl` }], evidence: [] },
} });
const pointer = { format_version: 2, dataset: 'rulemaking', snapshot_id: 'snapshot_123', manifest_key: 'materialized/rulemaking/snapshots/snapshot_123/manifest.json' };
const manifest = () => ({ format_version: 2, dataset: 'rulemaking', snapshot_id: 'snapshot_123', asserted_at: '2026-10-03T22:00:00Z', artifacts: {
  'proceedings.parquet': { visibility: 'public', remote_key: 'materialized/rulemaking/snapshots/snapshot_123/proceedings.parquet', rows: 12, bytes: 120, sha256: sha },
  'internal.parquet': { visibility: 'private', remote_key: 'private/internal.parquet', rows: 999, bytes: 100, sha256: sha },
} });
const comments = () => ({ format_version: 1, source: { schema_id: 6 }, files: {
  'comments.parquet': { rows: 100, bytes: 1000, sha256: sha, etag: '"current"' },
  'comments_index.parquet': { rows: 5, bytes: 100, sha256: sha, etag: '"index"' },
  'comments/agency/agency_code=X/part-0.parquet': { rows: 100, bytes: 1000, sha256: sha },
} });

test('dated notes cannot invent live membership and historical attribution stays labeled', () => {
  const audit = parseSourceReview(review());
  assert.deepEqual(sourceEntries([], [], audit), []);
  const entries = sourceEntries([table(), table('new_table')], [], audit);
  assert.equal(entries.length, 2);
  const reviewed = entries.find(entry => entry.table.id === 'records');
  assert.equal(reviewed.historicalAttribution, true);
  assert.equal(reviewed.source.name, 'Publisher');
  assert.equal(entries.find(entry => entry.table.id === 'new_table').review, undefined);
});
test('receipt files apply only to their advertised datasets and safe publication paths', () => {
  const receipt = { datasets: ['records'], key: 'etl_receipts.parquet', generationId: 'g1', rows: 20, byteSize: 100, sha256: sha };
  assert.equal(generationEvidence('generations/family/current', receipt, 'records').nativeReceipts.generationId, 'g1');
  assert.equal(generationEvidence('generations/family/current', receipt, 'another').nativeReceipts, undefined);
  assert.equal(generationEvidence('generations/family/current', { ...receipt, key: '../../../private' }, 'records').nativeReceipts, undefined);
  for (const path of ['../a', '/a', '//host/path', 'https://evil.test/x', 'a/%2e%2e/b', 'a\\b']) assert.equal(dataUrl(path), undefined);
});
test('a new generation or different family cannot inherit verified journal links', () => {
  const audit = parseSourceReview(review());
  assert.equal(reviewedGenerationLinks(sourceEntries([table()], [], audit)[0]).length, 1);
  assert.deepEqual(reviewedGenerationLinks(sourceEntries([{ ...table(), artifactDigest: newer }], [], audit)[0]), []);
  assert.equal(sourceEntries([{ ...table(), family: 'changed' }], [], audit)[0].review, undefined);
});
test('rulemaking uses its exact snapshot and only public files', () => {
  const tables = parseRulemaking(pointer, manifest());
  assert.equal(tables.length, 1);
  assert.equal(tables[0].rows, 12);
  assert.match(tables[0].members[0].url, /snapshots\/snapshot_123\/proceedings.parquet$/);
  assert.equal(tables[0].publication.snapshotId, 'snapshot_123');
  assert.throws(() => parseRulemaking(pointer, { ...manifest(), snapshot_id: 'snapshot_other' }));
  const malicious = manifest(); malicious.artifacts['proceedings.parquet'].remote_key = '../secret';
  assert.throws(() => parseRulemaking(pointer, malicious));
});
test('comments partitions are not double-counted and missing exports stay absent', () => {
  const raw = comments();
  const tables = parseComments(raw);
  assert.equal(tables.length, 2);
  assert.equal(tables[0].publication.etag, '"current"');
  assert.equal(tables[0].published, undefined);
  const expected=[
    {id:'comments',url:`${base}/comments.parquet`,rows:100,byteSize:1000,sha256:sha,etag:'"current"'},
    {id:'comments_index',url:`${base}/comments_index.parquet`,rows:5,byteSize:100,sha256:sha,etag:'"index"'},
  ];
  for (const table of tables) assert.deepEqual(table.coverageInputs,expected);
  delete raw.files['comments_index.parquet'];
  assert.equal(parseComments(raw).length, 1);
  assert.deepEqual(parseComments(raw)[0].coverageInputs,[expected[0]]);
  raw.files['comments.parquet'].rows = -1;
  assert.throws(() => parseComments(raw));
});
test('migration into the main index wins without duplicate tables or stale counts', () => {
  const current = { ...table('proceedings'), rows: 999, family: 'new-rulemaking' };
  const entries = sourceEntries([current], parseRulemaking(pointer, manifest()));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].table.rows, 999);
  assert.equal(entries[0].explorer, true);
});
test('method, evidence, empty, separate and unknown filters preserve live membership', () => {
  const rows = sourceEntries([table(), { ...table('new_table'), rows: 5 }], parseComments(comments()), parseSourceReview(review()));
  assert.equal(filterEntries(rows, 'Publisher', 'api', '').length, 1);
  assert.equal(filterEntries(rows, '', '', 'empty').length, 1);
  assert.equal(filterEntries(rows, '', '', 'separate').length, 2);
  assert.equal(filterEntries(rows, '', '', 'unreviewed').length, 3);
  assert.equal(filterEntries(rows, '', '', 'journal').length, 1);
});
test('generation details retain pinned parent identity, carry-forwards and receipt keys', () => {
  const raw = { kind: 'spicy-regs-rollup-generation', artifactDigest: sha, inputs: [{ role: 'source-evidence', artifactDigest: newer }], spec: {
    family: 'family', parents: { 'parent.parquet': { family: 'parent', artifactDigest: newer, sha256: sha } },
    carriedForward: { 'records.parquet': newer }, etlReceipts: { policies: [{ dataset: 'records', identity_fields: ['id', 'cycle'] }] },
  } };
  const result = parseGenerationDetails(raw, table());
  assert.match(result.parents[0].url, new RegExp('b'.repeat(64)));
  assert.equal(result.parents[0].digest, sha);
  assert.equal(result.carriedForward, newer);
  assert.deepEqual(result.identityFields, ['id', 'cycle']);
  assert.equal(result.links.length, 2);
  assert.throws(() => parseGenerationDetails({ ...raw, artifactDigest: newer }, table()));
  assert.throws(() => parseGenerationDetails(raw, { ...table(), family: 'other' }));
});
test('reviewed source and evidence URLs cannot execute scripts', () => {
  const raw = review();
  raw.tables.records.sources[0].url = 'javascript:alert(1)';
  raw.tables.records.evidence = [{ url: 'javascript:alert(1)', label: 'Bad link' }];
  raw.tables.records.generationLinks[0].url = 'https://evil.example/source-evidence/journal';
  const parsed = parseSourceReview(raw).tables.records;
  assert.equal(parsed.sources[0].url, undefined);
  assert.deepEqual(parsed.evidence, []);
  assert.deepEqual(parsed.generationLinks, []);
});
test('one unavailable publication never hides another and reports the incomplete check', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('comments-publication.json') ? Response.json(comments()) : new Response('unavailable', { status: 503 });
  try {
    const result = await loadOtherPublications();
    assert.equal(result.tables.length, 2);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Rulemaking.*could not be checked/);
  } finally { globalThis.fetch = saved; }
});
test('the shipped inventory parses, remains dated and has no runtime file membership', async () => {
  const raw = JSON.parse(await readFile('public/source-inventory.v1.json', 'utf8'));
  const parsed = parseSourceReview(raw);
  assert.ok(parsed.tables.crs_reports.methods.includes('api'));
  assert.ok(parsed.tables.scorecards.methods.length);
  assert.equal(parsed.tables.crs_reports.rows, undefined);
  assert.equal(parsed.tables.crs_reports.members, undefined);
  assert.deepEqual(sourceEntries([], [], parsed), []);
});
test('origin inputs link separate exports directly and do not claim unknown inputs are unpublished', async () => {
  const { TableProvenance } = await module('components/table-provenance.tsx');
  const parent = { ...table('agency_stats'), inputs: ['comments', 'records', 'unknown_input'] };
  const html = renderToStaticMarkup(createElement(TableProvenance, { table: parent, catalog: [table(), ...parseComments(comments())] }));
  assert.match(html, /href="https:\/\/data.spicygov.ai\/comments.parquet"/);
  assert.match(html, /Comments \(Parquet\)/);
  assert.match(html, /href="\/\?table=records&amp;view=about"/);
  assert.doesNotMatch(html, /\?table=comments/);
  assert.doesNotMatch(html, /not published/);
  assert.match(html, /not in this catalog/);
});


test('concise copy changes presentation and search, never published membership', () => {
  const raw = review();
  raw.tables.records.copy = { label: 'Clear title', summary: 'Searchable explanation', scope: 'Selected records', gaps: ['Duplicates occur.'] };
  const parsed = parseSourceReview(raw);
  const entries = sourceEntries([table()], [], parsed);
  assert.equal(entries[0].table.label, 'Clear title');
  assert.equal(filterEntries(entries, 'Searchable explanation', '', '').length, 1);
  assert.deepEqual(sourceEntries([], [], parsed), []);
  raw.tables.records.copy.gaps = [42];
  assert.equal(parseSourceReview(raw).tables.records.copy, undefined);
});

test('edited copy matches the reviewed inventory and every shipped table', async () => {
  const copy = JSON.parse(await readFile('content/source-copy.json', 'utf8'));
  const shipped = JSON.parse(await readFile('public/source-inventory.v1.json', 'utf8'));
  assert.equal(copy.inventorySha256, shipped.inputSha256);
  assert.deepEqual(Object.keys(copy.tables).sort(), Object.keys(shipped.tables).sort());
  for (const [id, text] of Object.entries(copy.tables)) assert.deepEqual(shipped.tables[id].copy, text);
});

test('compact source notes preserve attribution and input links without repeating long notes', async () => {
  const { TableProvenance } = await module('components/table-provenance.tsx');
  const parent = { ...table(), inputs: ['comments'], transformation: 'Long transformation explanation', sources: [{ id: 'original', name: 'Original publisher', url: 'https://example.gov', kind: 'government', note: 'Long source explanation' }] };
  const props = { table: parent, catalog: parseComments(comments()) };
  const compact = renderToStaticMarkup(createElement(TableProvenance, { ...props, compact: true }));
  assert.match(compact, /Original publisher/);
  assert.match(compact, /https:\/\/data.spicygov.ai\/comments.parquet/);
  assert.doesNotMatch(compact, /Long (transformation|source) explanation/);
  const full = renderToStaticMarkup(createElement(TableProvenance, props));
  assert.match(full, /Long transformation explanation/);
  assert.match(full, /Long source explanation/);
});


test('source-log preview distinguishes saved responses, missing fields and inherited data', async () => {
  const { parseObservationPreview } = await module('lib/source-observations.ts');
  const lines = [{event:'lineage'}, {event:'capture', requested_url:'https://example.gov/data', status_code:200, body_retained:true}, {event:'capture', requested_url:'https://other.gov/data', body_retained:false}, {event:'capture', requested_url:'javascript:alert(1)'}].map(JSON.stringify).join('\n');
  const preview = parseObservationPreview(lines + '\n{"truncated":', true);
  assert.equal(preview.inherited, true);
  assert.equal(preview.partial, true);
  assert.deepEqual(preview.observations.map(row => [row.source, row.saved, row.status]), [['example.gov', true, 200], ['other.gov', false, undefined]]);
  assert.equal(parseObservationPreview(Array(8).fill(JSON.stringify({event:'capture', requested_url:'https://example.gov'})).join('\n')).observations.length, 5);
});

test('time coverage shows measured gaps without turning missing measurements into gaps', async () => {
  const { periodRows, periodState, parseTimeInventory, currentTimeCoverage, timeFingerprint } = await module('lib/time-coverage.ts');
  const dataset = table(); dataset.rows = 5;
  const measured = { fingerprint: timeFingerprint(dataset), rows: 5, status: 'measured', field: 'filed_date', granularity: 'month', buckets: {'2024-01': 2, '2024-03': 2}, undatedRows: 1 };
  assert.equal(periodRows(measured, '2024'), 4);
  assert.equal(periodRows(measured, '2024-02'), 0);
  assert.equal(periodState([measured], '2024-02').state, 'empty');
  assert.equal(periodState([measured, undefined], '2024-02').state, 'unknown');
  assert.equal(periodState([measured, undefined], '2024-01').state, 'present');
  assert.equal(periodRows({...measured, granularity:'year', buckets:{'2024':4}}, '2024-01'), undefined);
  const raw = {format:'spicygov-time-coverage', version:1, generatedAt:'2026-10-04', tables:{records:measured}};
  const inventory = parseTimeInventory(raw);
  assert.equal(currentTimeCoverage(dataset, inventory).rows, 5);
  assert.equal(currentTimeCoverage({...dataset, rows:6}, inventory), undefined);
  assert.equal(currentTimeCoverage({...dataset, members:[{url:'https://example.gov/new.parquet',rows:5,byteSize:20}]}, inventory), undefined);
  assert.equal(currentTimeCoverage({...dataset, publication:{sha256:sha}}, inventory), undefined);
  raw.tables.records.buckets['2024-13'] = 1;
  assert.deepEqual(parseTimeInventory(raw).tables, {});
});


test('time counts follow identical file content across releases, but not changed content', async () => {
  const { timeFingerprint, currentTimeCoverage } = await module('lib/time-coverage.ts');
  const original = {...table(), rows:2, members:[{url:'https://example.gov/old/data.parquet',rows:2,byteSize:20,sha256:sha}]};
  const coverage = {fingerprint:timeFingerprint(original), rows:2, status:'measured', field:'date', granularity:'month', buckets:{'2024-01':2}, undatedRows:0};
  const inventory = {generatedAt:'2026-10-04', tables:{records:coverage}};
  assert.equal(currentTimeCoverage({...original,members:[{...original.members[0],url:'https://example.gov/new/data.parquet'}]},inventory),coverage);
  assert.equal(currentTimeCoverage({...original,members:[{...original.members[0],sha256:newer}]},inventory),undefined);
});

test('every generated time entry parses and preserves its reconciled counts', async () => {
  const { parseTimeInventory } = await module('lib/time-coverage.ts');
  const raw = JSON.parse(await readFile('public/time-coverage.v1.json', 'utf8'));
  const parsed = parseTimeInventory(raw);
  assert.deepEqual(Object.keys(parsed.tables).sort(), Object.keys(raw.tables).sort());
  for (const [id, entry] of Object.entries(raw.tables)) if (entry.collectionEvidence) assert.deepEqual(parsed.tables[id].collectionEvidence, entry.collectionEvidence);
});


test('edition gaps remain visible without inventing calendar months', async () => {
  const { parseTimeInventory, periodRows, periodState } = await module('lib/time-coverage.ts');
  const edition = {fingerprint:'edition', rows:3, status:'measured', field:'agenda_edition', granularity:'season', buckets:{'2011-spring':1,'2011-fall':1,'2012-fall':1}, undatedRows:0};
  const raw = {format:'spicygov-time-coverage', version:1, generatedAt:'2026-10-04', tables:{agenda:edition}};
  assert.equal(parseTimeInventory(raw).tables.agenda.granularity, 'season');
  assert.equal(periodRows(edition, '2011'), 2);
  assert.equal(periodRows(edition, '2012-spring'), 0);
  assert.equal(periodState([edition], '2012-spring').state, 'empty');
  assert.equal(periodRows(edition, '2012-10'), undefined);
  assert.equal(periodRows({...edition, granularity:'month'}, '2012-fall'), undefined);
  assert.deepEqual(parseTimeInventory({...raw, tables:{agenda:{...edition,buckets:{'2012-winter':3}}}}).tables, {});
});

test('collection outcomes reconcile to the file and never imply dated coverage', async () => {
  const { parseTimeInventory, periodRows, currentTimeCoverage, timeFingerprint } = await module('lib/time-coverage.ts');
  const dataset = {...table(), rows:3};
  const coverage = {fingerprint:timeFingerprint(dataset), rows:3, status:'unmeasured', collectionOutcomes:{empty:1,refused:1,selection_context:1}};
  const raw = {format:'spicygov-time-coverage', version:1, generatedAt:'2026-10-04', tables:{records:coverage}};
  assert.deepEqual(parseTimeInventory(raw).tables.records.collectionOutcomes, coverage.collectionOutcomes);
  assert.equal(periodRows(coverage, '2024'), undefined);
  assert.equal(currentTimeCoverage({...dataset,rows:4}, parseTimeInventory(raw)), undefined);
  assert.equal(parseTimeInventory({...raw,tables:{records:{...coverage,collectionOutcomes:{empty:4}}}}).tables.records.collectionOutcomes, undefined);
});


test('collection links refuse a different release even when table bytes match', async () => {
  const {parseCollectionEvidence, currentCollectionEvidence} = await module('lib/collection-coverage.ts');
  const publication = `${base}/generations/fec-query/${'a'.repeat(64)}/artifact.json`;
  const raw = {policy:1, publication, status:'matched', input:{url:`${base}/generations/fec-observations/${'b'.repeat(64)}/fec_collections.parquet`,generation:newer,sha256:sha,rows:2,owner:publication},matchedRows:2,unmatchedRows:1,collections:1,unmatchedCollections:1,outcomes:{'no-record-rejections':1},cycleRows:{'2026':2},unscopedRows:1,sources:{fec_receipts:{rows:2,collections:1}}};
  const parsed = parseCollectionEvidence(raw,3);
  assert.ok(parsed);
  assert.equal(currentCollectionEvidence({...table(),publication:{recordUrl:publication}},parsed),parsed);
  assert.equal(currentCollectionEvidence({...table(),publication:{recordUrl:publication.replace('a'.repeat(64),'c'.repeat(64))}},parsed),undefined);
  assert.equal(parseCollectionEvidence({...raw,matchedRows:3},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,cycleRows:{'2026':3}},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,outcomes:{empty:2}},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,input:{...raw.input,generation:sha}},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,input:{...raw.input,url:raw.input.url.replace('/generations/', '/generations/../')}},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,queryResults:[{status:'refused',reason:'missing timestamp',completeness:'not-asserted',records:2}]},3),undefined);
  assert.equal(parseCollectionEvidence({...raw,queryResults:[{status:'refused',reason:'missing timestamp',completeness:'not-asserted',records:3}]},3).queryResults[0].status,'refused');
});
