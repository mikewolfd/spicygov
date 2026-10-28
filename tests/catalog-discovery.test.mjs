import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['lib/catalog-discovery.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { collectionMatches, periodSummary, loadDiscoveryPeriods } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
const item = { id: 'family:fec-candidates', title: 'Candidate collection', tables: ['fec_candidate_history'], families: ['fec'], statuses: ['held'] };
const tables = [{ id: 'fec_candidate_history', label: 'Historical candidate registrations' }];
const known = [{ kind: 'election-cycle', label: '2024', basis: 'explicit-retained-scope' }];
const unknown = [{ kind: 'unknown', label: 'Unknown', basis: 'no-qualified-period-assertion' }];
const matches = (query = '', period = '', periods = known, includeUnknown = true, status = '') => collectionMatches(item, tables, periods, query, status, period, includeUnknown);

test('dataset and table IDs, readable names, periods and source states compose in one search', () => {
  for (const query of ['fec_candidate_history', 'candidate history', 'Historical registrations', 'FEC 2024', 'election cycle']) assert.equal(matches(query), true, query);
  assert.equal(matches('2022'), false);
  assert.equal(matches('2024', '2024', known, false, 'held'), true);
  assert.equal(matches('2024', '2024', known, false, 'published'), false);
  assert.equal(matches('unrelated table'), false);
});

test('period narrowing respects recorded intervals and keeps unknown periods discoverable', () => {
  const multiple = [...known, { kind: 'filing-year', label: '2022', basis: 'recorded' }];
  assert.equal(matches('', '2022', multiple), true);
  assert.equal(matches('', '2023', multiple, false), false);
  const range = [{ kind: 'reporting-period', label: '2020-10-01/2025-03-31', basis: 'recorded' }];
  assert.equal(matches('', '2023', range, false), true);
  assert.equal(matches('', '2026', range, false), false);
  assert.equal(matches('', '2023', [{ ...range[0], label: 'Reviewed scope', start: '2020-01-01', end: '2025-12-31' }], false), true);
  for (const periods of [[], unknown, [...known, ...unknown]]) assert.equal(matches('', '2023', periods), true);
  assert.equal(matches('', '2023', unknown, false), false);
  assert.equal(matches('unknown', '', unknown), true);
});

test('download timing and incomplete period metadata do not become data coverage', () => {
  const captured = { ...item, periodSummary: { count: 1, observedRetained: { kind: 'capture-date', label: '2026', basis: 'download time' } } };
  assert.equal(collectionMatches(captured, tables, unknown, '2026', '', '', true), false);
  assert.equal(collectionMatches(captured, tables, undefined, '', '', '2026', false), true);
  assert.equal(periodSummary(undefined), 'Data period: not loaded');
  assert.equal(periodSummary(unknown), 'Data period: unknown');
  assert.match(periodSummary([...known, ...unknown]), /Election cycle: 2024.*some periods unknown/);
  assert.doesNotMatch(periodSummary(unknown), /missing/);
  const many = Array.from({ length: 6 }, (_, i) => ({ kind: 'filing-year', label: String(2020 + i), basis: 'recorded' }));
  assert.match(periodSummary(many, '2025'), /^Data periods: Filing year: 2025/);
});

test('period discovery bounds concurrent detail reads and retains failures separately', async () => {
  let active = 0, peak = 0;
  const read = [];
  const manifest = { generation: 'g', collections: Array.from({ length: 15 }, (_, i) => ({ id: `${i}` })) };
  const reader = { detail: async (_manifest, collection) => {
    active++; peak = Math.max(peak, active); read.push(collection.id);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (collection.id === '7') throw Error('Detail unavailable');
    return { collection: { periods: known } };
  } };
  const result = await loadDiscoveryPeriods(reader, manifest, new AbortController().signal);
  assert.equal(peak, 6);
  assert.equal(read.length, 15);
  assert.deepEqual(result.failures, ['7']);
  assert.equal(Object.keys(result.periods).length, 14);
  assert.equal(result.generation, 'g');
  const controller = new AbortController(); controller.abort();
  const stopped = await loadDiscoveryPeriods(reader, manifest, controller.signal);
  assert.deepEqual(stopped.periods, {});
  assert.deepEqual(stopped.failures, []);
});
