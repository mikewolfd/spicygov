import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { outputFiles } = await build({ entryPoints: ['lib/catalog.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { loadCollection, connectionFilters, publicationDate, applyMetadata, noConnectionsMessage, recordDatasets } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const metadataBuild = await build({ entryPoints: ['lib/metadata.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { parseMetadata } = await import(`data:text/javascript;base64,${Buffer.from(metadataBuild.outputFiles[0].contents).toString('base64')}`);
const publication = () => ({ version: 2, families: { records: { artifactDigest: 'sha256:current', prefix: 'records/current', tables: {
  'parent.parquet': { rows: 1, byteSize: 50, columns: [['id', 'VARCHAR'], ['cycle', 'BIGINT']] },
  'child.parquet': { rows: 0, byteSize: 20, columns: [['parent_id', 'VARCHAR'], ['cycle', 'BIGINT']] },
} } } });
const join = { child: 'child', child_columns: ['parent_id', 'cycle'], parent: 'parent', parent_columns: ['id', 'cycle'], kind: 'complete', reason: 'Identity is scoped to a cycle.' };
const bundle = () => ({
  format: 'spicy-regs-explorer-metadata', version: 1, generatedAt: '2026-10-03T18:00:00Z',
  publication: { families: { records: 'sha256:current' } },
  tables: Object.fromEntries(Object.entries(publication().families.records.tables).map(([file, table]) => [file.replace('.parquet', ''), {
    family: 'records', publicationSchema: table.columns, label: file === 'parent.parquet' ? 'Parent records' : 'Child records', summary: 'Published description.', coverage: 'Selected cycles only.', metadataStatus: 'documented', sourceStatus: 'documented',
    sources: [{ id: 'publisher', name: 'Named publisher', url: 'https://example.gov/original', kind: 'government', note: 'Original records' }],
    inputs: file === 'child.parquet' ? ['parent', 'retained_only'] : [], transformation: file === 'child.parquet' ? 'Grouped records.' : null,
    modelGenerated: false, emptyReason: file === 'child.parquet' ? 'No qualifying records.' : undefined,
  }])), joins: [structuredClone(join)],
});
const auditFixture = JSON.parse(await readFile(new URL('./fixtures/metadata-audit.json', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
let currentPublication = publication(), currentMetadata = bundle(), requested = [];
globalThis.fetch = async (url, options) => {
  requested.push({ url, options });
  if (String(url).endsWith('publication.v2.json')) return Response.json(currentPublication);
  if (currentMetadata instanceof Error) throw currentMetadata;
  return Response.json(currentMetadata);
};
try {
  await test('processing evidence remains inspectable but is excluded from the ordinary collection', async () => {
    const value = bundle();
    value.tables.child.category = 'processing_evidence';
    const tables = (await loadCollection()).tables;
    const result = applyMetadata(tables, parseMetadata(value));
    assert.equal(result.tables.find(t => t.id === 'child').category, 'processing_evidence');
    assert.deepEqual(recordDatasets(result.tables).map(t => t.id), ['parent']);
    assert.match(noConnectionsMessage(result.tables.find(t => t.id === 'child')), /collection evidence/);
    assert.equal(recordDatasets([{id:'fec_receipts',category:'native_observation'}]).length, 1);
  });
  await test('missing, null, invalid and impossible publication dates never format as Invalid Date', () => {
    for (const value of [null, undefined, '', 'not a date', 0, '2026-02-30', '2026-13-01', '2026-10-03Tbad']) assert.equal(publicationDate(value), 'Publication date unavailable');
    assert.equal(publicationDate('2026-10-03T23:00:00Z'), 'Oct 3, 2026');
    assert.equal(publicationDate('2024-02-29'), 'Feb 29, 2024');
  });
  await test('loads current descriptions, exact sources, input IDs and empty reason from the live bundle', async () => {
    const result = await loadCollection();
    assert.equal(result.metadata.state, 'current');
    assert.equal(result.joins.length, 1);
    const child = result.tables.find(t => t.id === 'child');
    assert.equal(child.label, 'Child records');
    assert.equal(child.sources[0].url, 'https://example.gov/original');
    assert.deepEqual(child.inputs, ['parent', 'retained_only']);
    assert.equal(child.emptyReason, 'No qualifying records.');
    assert.equal(child.rows, 0);
    assert.equal(child.published, undefined);
    assert.equal(child.coverage, 'Selected cycles only.');
  });
  await test('refresh discovers a new table and composite connection without any website changes', async () => {
    currentPublication.families.records.tables['new_table.parquet'] = { rows: 4, byteSize: 90, columns: [['parent_id', 'VARCHAR'], ['cycle', 'BIGINT']] };
    currentMetadata.tables.new_table = { ...structuredClone(currentMetadata.tables.child), label: 'New table' };
    currentMetadata.joins.push({ ...structuredClone(join), child: 'new_table' });
    const result = await loadCollection();
    assert.equal(result.tables.length, 3);
    assert.equal(result.tables.find(t => t.id === 'new_table').label, 'New table');
    assert.equal(result.joins.length, 2);
    assert.ok(requested.every(request => request.options.cache === 'no-store'));
    currentPublication = publication(); currentMetadata = bundle();
  });
  await test('metadata outage preserves every current table and its file URLs, with no hidden bundled joins', async () => {
    currentMetadata = new Error('offline');
    const result = await loadCollection();
    assert.equal(result.tables.length, 2);
    assert.equal(result.metadata.state, 'unavailable');
    assert.deepEqual(result.joins, []);
    assert.ok(result.tables.every(t => t.metadataState === 'unavailable'));
    assert.equal(result.tables.find(t => t.id === 'parent').members[0].url, 'https://data.spicygov.ai/records/current/parent.parquet');
    currentMetadata = bundle();
  });
  await test('unsupported metadata format falls back to current publication, not an old snapshot', async () => {
    currentMetadata.version = 2;
    const result = await loadCollection();
    assert.equal(result.metadata.state, 'unavailable');
    assert.equal(result.tables.length, 2);
    assert.deepEqual(result.joins, []);
    currentMetadata = bundle();
  });
  await test('catalog becomes browsable before a slow metadata request finishes', async () => {
    const saved = globalThis.fetch;
    let resolveMetadata;
    const pendingMetadata = new Promise(resolve => { resolveMetadata = resolve; });
    globalThis.fetch = async url => String(url).endsWith('publication.v2.json') ? Response.json(publication()) : pendingMetadata;
    let received;
    const pending = loadCollection(undefined, collection => { received = collection; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.tables.length, 2);
    assert.equal(received.metadata.state, 'loading');
    resolveMetadata(Response.json(bundle()));
    assert.equal((await pending).metadata.state, 'current');
    globalThis.fetch = saved;
  });
  await test('missing table metadata is explicit and prevents joins through the undocumented schema', async () => {
    delete currentMetadata.tables.child;
    const result = await loadCollection();
    assert.equal(result.tables.find(t => t.id === 'child').metadataState, 'missing');
    assert.equal(result.metadata.missingTables, 1);
    assert.equal(result.metadata.rejectedJoins, 1);
    assert.equal(result.joins.length, 0);
    assert.match(result.tables.find(t => t.id === 'parent').connectionNotes[0], /paused/);
    currentMetadata = bundle();
  });
  await test('changed column types and family IDs reject descriptions and dependent connections', async () => {
    for (const change of [metadata => metadata.tables.child.publicationSchema[1][1] = 'VARCHAR', metadata => metadata.tables.child.family = 'other']) {
      change(currentMetadata);
      const result = await loadCollection();
      const child = result.tables.find(t => t.id === 'child');
      assert.equal(child.metadataState, 'incompatible');
      assert.equal(child.summary, '');
      assert.deepEqual(child.sources, []);
      assert.deepEqual(result.joins, []);
      currentMetadata = bundle();
    }
  });
  await test('same-schema metadata from an older publication remains usable but explicitly marked older', async () => {
    currentMetadata.publication.families.records = 'sha256:older';
    const result = await loadCollection();
    assert.equal(result.metadata.state, 'partial');
    assert.equal(result.metadata.staleTables, 2);
    assert.ok(result.tables.every(t => t.metadataState === 'older-publication'));
    assert.equal(result.joins.length, 1);
    currentMetadata = bundle();
  });
  await test('invalid, duplicate, missing and unpublished connection keys cannot silently become usable', async () => {
    for (const invalid of [null, {}, { ...join, child_columns: [] }, { ...join, child_columns: ['parent_id'] }, { ...join, child_columns: ['cycle', 'cycle'] }, { ...join, parent_columns: ['id', 'id'] }, { ...join, child_columns: ['wrong', 'cycle'] }, { ...join, parent: 'not_published' }]) {
      currentMetadata.joins = [invalid];
      const result = await loadCollection();
      assert.deepEqual(result.joins, []);
      assert.equal(result.metadata.rejectedJoins, 1);
      assert.equal(result.metadata.state, 'partial');
    }
    const child = (await loadCollection()).tables.find(t => t.id === 'child');
    assert.match(child.connectionNotes[0], /not published/);
    currentMetadata = bundle();
  });
  await test('bidirectional navigation preserves cycle keys, zero values and refuses null or missing keys', () => {
    assert.deepEqual(connectionFilters(join, 'child', { parent_id: 'A', cycle: 0 }), [{ column: 'id', value: 'A' }, { column: 'cycle', value: '0' }]);
    assert.deepEqual(connectionFilters(join, 'parent', { id: 'A', cycle: 2026 }), [{ column: 'parent_id', value: 'A' }, { column: 'cycle', value: '2026' }]);
    assert.equal(connectionFilters(join, 'child', { parent_id: 'A' }), null);
    assert.equal(connectionFilters(join, 'child', { parent_id: null, cycle: 2026 }), null);
    assert.equal(connectionFilters(join, 'unrelated', { parent_id: 'A', cycle: 2026 }), null);
  });
  await test('unknown attribution stays explicit even when the table description is documented', async () => {
    currentMetadata.tables.child.sourceStatus = 'unknown';
    currentMetadata.tables.child.sources = [];
    const result = await loadCollection();
    assert.equal(result.tables.find(t => t.id === 'child').metadataState, 'undocumented');
    assert.equal(result.metadata.undocumentedTables, 1);
    assert.equal(result.metadata.state, 'partial');
    currentMetadata = bundle();
  });
  await test('real audit status and reason survive loading for unavailable parents, arrays and polymorphic identities', async () => {
    for (const audit of Object.values(auditFixture.audits)) {
      currentMetadata.tables.child.joinAudit = structuredClone(audit);
      currentMetadata.joins = [];
      const result = await loadCollection();
      const table = result.tables.find(t => t.id === 'child');
      assert.equal(table.joinAudit.status, audit.status);
      assert.equal(table.joinAudit.reason, audit.reason);
      assert.equal(table.metadataState, 'current');
      assert.deepEqual(result.joins, []);
    }
    currentMetadata = bundle();
  });
  await test('publisher omitted-parent notices survive without pretending a previously connected audit is usable', async () => {
    const omitted = { child: 'child', parent: 'unpublished_parent', reason: 'One or both tables are outside publication.v2.json.' };
    currentMetadata.omittedJoins = [omitted];
    currentMetadata.joins = [];
    currentMetadata.tables.child.joinAudit = { status: 'connected', reason: 'A previous generation had declared navigation.', evidence: ['src/spicy_regs/table_joins.py:JOINS'], reviewedOn: '2026-10-03' };
    const result = await loadCollection();
    const child = result.tables.find(t => t.id === 'child');
    assert.equal(result.metadata.state, 'current', 'Accurate intentional exclusions do not make metadata stale');
    assert.equal(result.metadata.omittedJoins, 1);
    assert.equal(result.metadata.rejectedJoins, 0);
    assert.equal(child.connectionNotes.length, 1);
    assert.match(child.connectionNotes[0], /Unpublished parent.*not published/);
    assert.equal(noConnectionsMessage(child), undefined, 'Specific parent notice replaces stale connected audit reason');
    assert.equal(noConnectionsMessage({ ...child, connectionNotes: [] }), 'No supported connections are declared for this dataset.');
    assert.deepEqual(parseMetadata(currentMetadata).omittedJoins, [omitted]);
    currentMetadata = bundle();
  });
  await test('real court, service-term and scorecard keys preserve scope in both navigation directions', () => {
    for (const declared of auditFixture.joins) {
      // A conflicting scope must remain a filter rather than dropping to an ID-only match.
      const childRow = Object.fromEntries(declared.child_columns.map((key, i) => [key, `scope-${i}`]));
      const parentRow = Object.fromEntries(declared.parent_columns.map((key, i) => [key, `scope-${i}`]));
      assert.deepEqual(connectionFilters(declared, declared.child, childRow), declared.parent_columns.map((column, i) => ({ column, value: `scope-${i}` })));
      assert.deepEqual(connectionFilters(declared, declared.parent, parentRow), declared.child_columns.map((column, i) => ({ column, value: `scope-${i}` })));
      assert.equal(connectionFilters(declared, declared.child, { ...childRow, [declared.child_columns.at(-1)]: null }), null);
    }
  });
  await test('metadata cannot insert executable source links; absent inputs remain explicit', async () => {
    currentMetadata.tables.child.sources[0].url = 'javascript:alert(1)';
    const result = await loadCollection();
    assert.equal(result.tables.find(t => t.id === 'child').sources[0].url, undefined);
    assert.deepEqual(result.tables.find(t => t.id === 'child').inputs, ['parent', 'retained_only']);
    currentMetadata = bundle();
  });
  await test('reapplying metadata does not mutate earlier results or accumulate unavailable-join notices', async () => {
    currentMetadata.joins.push({ ...join, parent: 'not_published' });
    const result = await loadCollection();
    const next = applyMetadata(result.tables, parseMetadata(currentMetadata));
    assert.equal(result.tables.find(t => t.id === 'child').connectionNotes.length, 1);
    assert.equal(next.tables.find(t => t.id === 'child').connectionNotes.length, 1);
    currentMetadata = bundle();
  });
} finally { globalThis.fetch = originalFetch; }
