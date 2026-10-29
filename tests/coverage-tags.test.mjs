import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['lib/coverage-tags.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { periodRuns, registerSourceCoverageTags, sourceCoverageTags, tableCoverageTags } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const period = (kind, label, extra = {}) => ({ kind, label, basis: 'Selected retained source scope; completeness unknown', ...extra });
const context = (family) => ({ id: `family:${family}`, families: [family] });
const hash = 'sha256:' + 'a'.repeat(64);
test('Register source tags match the selected indexed quarters', () => {
  const source = {generation:hash, months:['2026-01','2026-04','2026-09'], latestIndexedDate:'2026-09-23'};
  assert.equal(registerSourceCoverageTags(source)[0].label, 'Saved sources 2026 Q1–2026 Q3');
  assert.deepEqual(registerSourceCoverageTags(undefined), []);
});
function measured(dimension) {
  const table = { id: 'records', family: 'test', rows: 3, columns: [{ name: 'date', type: 'DATE' }], members: [{ url: 'https://example.test/records.parquet', rows: 3, byteSize: 100, sha256: hash }] };
  const map = { family: 'test', rows: 3, schema: [['date', 'DATE']], fingerprint: JSON.stringify([[hash, 3, 100]]), inputsFingerprint: '[]', measuredAt: '2026-10-05T00:00:00Z', dimensions: [{ id: 'period', label: 'Publication dates', meaning: 'Counts selected source records by their publication date.', granularity: 'month', fields: ['publication_date'], rows: 3, placedRows: 3, unplacedRows: 0, buckets: { '2021-01': 1, '2023-02': 2 }, ...dimension }] };
  return { table, maps: { tables: { records: map } }, map };
}

test('Congress runs retain gaps and source context chooses Congress before incidental issue dates', () => {
  assert.equal(periodRuns([119, 117, 118, 113, 114, 119]), '113–114, 117–119');
  const tags = sourceCoverageTags([
    period('issue-date', '2026-10-28'),
    ...[113, 114, 117, 118, 119].map(value => period('congress', String(value))),
  ], context('bill-family'));
  assert.equal(tags[0].label, 'Congresses 113–114, 117–119');
  assert.match(tags[0].detail, /do not establish complete coverage/);
  assert.equal(tags.length, 2);
});

test('election cycle headlines retain native cycles and leave requested cycles in Details', () => {
  assert.equal(periodRuns([2020, 2022, 2026], 2), '2020–2022, 2026');
  const tags = sourceCoverageTags([
    period('requested-election-cycle', '2024'),
    ...[2020, 2022, 2026].map(value => period('election-cycle', String(value))),
  ], context('fec-query'));
  assert.equal(tags[0].label, 'Cycles ending 2020–2022, 2026');
  assert.equal(tags.length, 1);
  assert.equal(periodRuns([2023, 2024, 2026], 2), '2023, 2024–2026');
});

test('CFR request-only editions have no headline while Agenda native edition labels remain', () => {
  const cfr = sourceCoverageTags([
    period('requested-issue-date', '2026-08-18'),
    period('requested-edition', '2023'), period('requested-edition', '2025'),
  ], context('cfr-sections'));
  assert.deepEqual(cfr, []);
  const agenda = sourceCoverageTags([period('declared-period', '202410'), period('declared-period', '202504')], context('unified-agenda'));
  assert.deepEqual(agenda, []); // Declared periods do not prove what was retained.
});

test('data dates summarize years without using capture dates or assuming an unknown range end', () => {
  const tags = sourceCoverageTags([
    period('capture-date', '2026-10-28'),
    period('download-date', '2026-10-28'),
    period('observed-retained-scope', 'Selected dated rows', { start: '1995-01-01', end: '2024-12-31' }),
  ]);
  assert.equal(tags[0].label, 'Saved record years 1995–2024 · gaps possible');
  assert.equal(tags.length, 1);
  assert.equal(sourceCoverageTags([period('observed-retained-scope', 'Start known', { start: '2001-01-01' })])[0].label, 'Saved record years 2001');
  assert.deepEqual(sourceCoverageTags([period('download-date', '2026-10-28')]), []);
  assert.deepEqual(sourceCoverageTags([period('issue-date', '2026-00-50')]), []);
});

test('unloaded and unknown evidence produce no generic headline tag', () => {
  assert.deepEqual(sourceCoverageTags(undefined), []);
  assert.deepEqual(sourceCoverageTags([]), []);
  assert.deepEqual(sourceCoverageTags([period('unknown', 'Unknown')]), []);
  assert.deepEqual(sourceCoverageTags([period('snapshot', '2026-10-28')]), []);
  const tags = sourceCoverageTags([period('congress', '119'), period('unknown', 'Unknown')], context('bill-family'));
  assert.match(tags[0].detail, /Some periods remain unknown/);
});

test('publisher availability is not a holdings headline and tooltip size stays bounded', () => {
  const offered = sourceCoverageTags([period('documented-publisher-scope', 'Source archive', { start: '1997-01-01' })]);
  assert.deepEqual(offered, []);
  const many = Array.from({ length: 8000 }, (_, index) => period('issue-date', new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString()));
  const tags = sourceCoverageTags(many);
  assert.ok(tags[0].detail.length < 800);
  assert.match(tags[0].detail, /8000 recorded period labels/);
});

test('scorecard headline shows native Congresses without requested Congress 119', () => {
  const periods = [period('congress', '118'), period('requested-congress', '119'), period('congress', '120', { basis: 'requested-scope from an API selector' })];
  const before = structuredClone(periods);
  const tags = sourceCoverageTags(periods, context('scorecards'));
  assert.deepEqual(tags.map(tag => tag.label), ['Congresses 118']);
  assert.deepEqual(periods, before);
  const requestOnly = sourceCoverageTags([period('requested-congress', '119')], { ...context('scorecards'), holdings: { objects: 12 } });
  assert.deepEqual(requestOnly, []);
});

test('dataset requested edition labels remain in Details without becoming held coverage', () => {
  const requested = measured({ id: 'requested-edition-years', label: 'Requested edition years', fields: ['requested_year'], granularity: 'year', buckets: { '2023': 1, '2025': 2 } });
  const tags = tableCoverageTags(requested.table, requested.maps);
  assert.deepEqual(tags, []);
  assert.deepEqual(tableCoverageTags({ ...requested.table, rows: 4 }, requested.maps), []);
  requested.map.dimensions.push({ ...requested.map.dimensions[0], id: 'native-publication-years', label: 'Native publication years', fields: ['native_publication_year'], buckets: { '2024': 3 } });
  assert.equal(tableCoverageTags(requested.table, requested.maps)[0].label, 'Native publication years 2024');
  assert.match(tableCoverageTags(requested.table, requested.maps)[0].detail, /2023, 2025/);
});

test('requested dataset periods cannot fall back to collector timestamps or source controls', () => {
  const requested = measured({ id: 'requested-edition-years', label: 'Requested edition years', fields: ['requested_year'], granularity: 'year', buckets: { '2025': 3 } });
  for (const field of ['captured_at', 'acquired_at', 'fetched_at', 'observed_at', 'receipt_date', 'recorded_at']) {
    const original = requested.map.dimensions[0];
    requested.map.dimensions = [original, { ...original, id: field, label: field, fields: [field], granularity: 'month', buckets: { '2026-10': 3 } }];
    assert.deepEqual(tableCoverageTags(requested.table, requested.maps), [], field);
  }
  requested.map.dimensions.push({ ...requested.map.dimensions[0], id: 'selected_source_scopes', label: 'Selected source scopes', fields: ['period_start'], granularity: 'month', buckets: { '2026-10': 3 } });
  assert.deepEqual(tableCoverageTags(requested.table, requested.maps), []);
});

test('dataset Congress and edition matrices use their numeric category values', () => {
  const congress = measured({ label: 'Congress', fields: ['congress'], granularity: 'category', buckets: { '["113"]': 1, '["117"]': 1, '["118"]': 1 } });
  assert.equal(tableCoverageTags(congress.table, congress.maps)[0].label, 'Congresses 113, 117–118');
  const editions = measured({ label: 'CFR titles by annual edition', fields: ['edition_year', 'title'], granularity: 'category', buckets: { '["2025","1"]': 1, '["2026","1"]': 1, '["2026","2"]': 1 } });
  assert.equal(tableCoverageTags(editions.table, editions.maps)[0].label, 'Edition years 2025–2026');
});

test('report coverage prefers the Congress covered over the date a report was issued', () => {
  const dated = measured({label:'Report issue dates',fields:['date_issued']});
  dated.map.dimensions.push({...dated.map.dimensions[0], id:'covered', label:'Congress covered by the source report',
    fields:['covered_congress'],granularity:'category',buckets:{'["117"]':1,'["118"]':2}});
  assert.equal(tableCoverageTags(dated.table, dated.maps)[0].label,'Reports covering Congresses 117–118');
  assert.deepEqual(tableCoverageTags({...dated.table,rows:4}, dated.maps),[]);
});

test('period end and report period labels read naturally as year ranges', () => {
  const periods = measured({label:'Printed report periods',fields:['period_start'],granularity:'month',buckets:{'2023-01':1,'2026-01':2}});
  assert.equal(tableCoverageTags(periods.table,periods.maps)[0].label,'Printed report years 2023–2026 · gaps possible');
  const ends = measured({label:'Statement period ends',fields:['period_end'],granularity:'month',buckets:{'2024-10':1,'2026-09':2}});
  assert.equal(tableCoverageTags(ends.table,ends.maps)[0].label,'Statement period end years 2024–2026 · gaps possible');
});

test('publisher year categories preserve discrete edition years and nonnumeric source labels', () => {
  const mixed = measured({ id: 'publisher-year-labels', label: 'Publisher year labels', fields: ['year_text'], granularity: 'category', buckets: { '["2005"]': 1, '["2005-2006"]': 1, '["2008"]': 1 } });
  const tags = tableCoverageTags(mixed.table, mixed.maps);
  assert.equal(tags[0].label, 'Edition years 2005, 2008');
  assert.match(tags[0].detail, /Other publisher year labels: 2005-2006/);
  assert.match(tags[0].detail, /not expanded into individual years/);
  assert.doesNotMatch(tags[0].label, /2005–2008|2006/);
  const textOnly = measured({ id: 'publisher-year-labels', label: 'Publisher year labels', fields: ['year_text'], granularity: 'category', buckets: { '["Lifetime"]': 1, '["2005-2006"]': 2 } });
  assert.deepEqual(tableCoverageTags(textOnly.table, textOnly.maps), []);
  assert.deepEqual(tableCoverageTags({ ...mixed.table, rows: 4 }, mixed.maps), []);
});

test('dataset cycle labels describe current periods and omit earlier releases from the headline', () => {
  const { table, maps } = measured({ label: 'Source election cycle', fields: ['source_cycle'], granularity: 'year', buckets: { '2020': 1, '2022': 1, '2026': 1 } });
  assert.equal(tableCoverageTags(table, maps)[0].label, 'Cycles ending 2020–2022, 2026');
  assert.deepEqual(tableCoverageTags({ ...table, rows: 4 }, maps), []);
  assert.deepEqual(tableCoverageTags({ ...table, family: 'unrelated' }, maps), []);
  assert.deepEqual(tableCoverageTags(table), []);
});

test('dataset date ranges state gaps and snapshots produce no generic headline', () => {
  const dated = measured({});
  assert.equal(tableCoverageTags(dated.table, dated.maps)[0].label, 'Publication years 2021–2023 · gaps possible');
  const snapshot = measured({ label: 'Published release', granularity: 'snapshot', fields: [], buckets: {}, snapshot: { publishedAt: '2026-10-28T00:00:00Z' } });
  assert.deepEqual(tableCoverageTags(snapshot.table, snapshot.maps), []);
  const capture = measured({ label: 'Capture dates', fields: ['captured_at'] });
  assert.deepEqual(tableCoverageTags(capture.table, capture.maps), []);
});

test('expired period measurements stay in Details and produce no headline period claim', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-01T00:00:00Z').getTime() });
  const { table, maps, map } = measured({});
  map.dimensions[0].activityBoundary = { month: '2026-10', basis: 'measurement-month' };
  assert.deepEqual(tableCoverageTags(table, maps), []);
});
