import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({entryPoints:['lib/period-summary.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {dimensionPeriodSummary} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const dates = {kind:'date',granularity:'month',buckets:{'2024-01':1,'2024-08':2},unplacedRows:1,latestDate:'2024-08-12'};

test('scalar and listed dates share segmented quarters without summing overlapping rows', () => {
  const scalar = dimensionPeriodSummary(dates);
  assert.equal(scalar.range,'2024 Q1, 2024 Q3');
  assert.deepEqual(scalar.missing,['2024 Q2']);
  assert.equal(scalar.latestDate,'2024-08-12');
  const listed = dimensionPeriodSummary({...dates,kind:'list',overlapping:true});
  assert.equal(listed.range,scalar.range);
  assert.match(listed.note,/rows may occur in several quarters/);
});

test('spans and edition years preserve meaning and do not invent exact latest dates', () => {
  const span = dimensionPeriodSummary({...dates,kind:'interval',overlapping:true});
  assert.equal(span.range,'2024');
  assert.equal(span.latestDate,undefined);
  assert.deepEqual(span.missing,[]);
  assert.match(span.note,/do not establish dated observations/);
  assert.equal(dimensionPeriodSummary({granularity:'year',buckets:{'2020':1,'2022':1,'2023':1}}).range,'2020, 2022–2023');
});

test('Congress matrices keep absent Congresses out of the displayed runs', () => {
  const congress = dimensionPeriodSummary({granularity:'category',fields:['congress','chamber'],buckets:{'["113","House"]':1,'["117","House"]':1,'["118","Senate"]':1}});
  assert.equal(congress.range,'Congress 113, 117–118');
  assert.equal(dimensionPeriodSummary({granularity:'snapshot',buckets:{}}),undefined);
});

test('future bill printing values stay literal while the headline uses the frozen check month', () => {
  const printing = {...dates,id:'printing-dates',fields:['version_date'],
    buckets:{'2026-10':354,'2066-06':1},latestDate:'2066-06-07'};
  const original = JSON.stringify(printing);
  const context = {tableId:'bill_versions',measuredAt:'2026-10-30T04:01:36.122360+00:00'};
  const summary = dimensionPeriodSummary(printing,context);
  assert.equal(summary.range,'2026 Q4');
  assert.equal(summary.latestDate,undefined);
  assert.match(summary.note,/Latest observed printing month: 2026-10\./);
  assert.match(summary.note,/Future printing values remain in the detailed counts/);
  assert.doesNotMatch(summary.note,/2026-10-01/);
  assert.equal(JSON.stringify(printing),original);
  assert.equal(printing.latestDate,'2066-06-07');
  // A different frozen check date changes display eligibility, without relying
  // on wall-clock time or rewriting the measured observations.
  assert.equal(dimensionPeriodSummary(printing,{...context,measuredAt:'2066-07-01T00:00:00Z'}).latestDate,'2066-06-07');
  assert.equal(dimensionPeriodSummary(printing).latestDate,'2066-06-07');
  assert.equal(dimensionPeriodSummary(printing,{tableId:'bill_versions'}).latestDate,'2066-06-07');
});

test('future-effective, fiscal, election and closing dimensions keep their stated future periods', () => {
  for (const [tableId,id,field] of [['bill_versions','effective-dates','effective_date'],
    ['public_activity_events','fiscal-period-ends','fiscal_year_end'],
    ['fec_disbursements','election_date','election_date'],['feed_summary','comment-end-date','comment_end_date']]) {
    const dimension = {...dates,id,fields:[field],buckets:{'2026-10':1,'2066-06':2},latestDate:'2066-06-07'};
    const summary = dimensionPeriodSummary(dimension,{tableId,measuredAt:'2026-10-30T04:01:36Z'});
    assert.match(summary.range,/2066 Q2/);
    assert.equal(summary.latestDate,'2066-06-07');
  }
});

test('activity printing-source dates exclude the literal 2066 month only from the headline', () => {
  const printing = {...dates,id:'printing-source-dates',fields:['occurred_at'],
    buckets:{'2026-10':354,'2066-06':1},latestDate:'2066-06-07'};
  const original = JSON.stringify(printing);
  const summary = dimensionPeriodSummary(printing,{tableId:'public_activity_events',measuredAt:'2026-10-30T04:00:10.579810+00:00'});
  assert.equal(summary.range,'2026 Q4');
  assert.equal(summary.latestDate,undefined);
  assert.match(summary.note,/Latest observed printing month: 2026-10\./);
  assert.equal(JSON.stringify(printing),original);
  assert.equal(printing.buckets['2066-06'],1);
});

test('FEC transaction dates retain literal future observations without treating 2056 as freshness', () => {
  const transactions = {...dates,id:'transaction_date',fields:['transaction_date'],
    buckets:{'2026-10':6,'2026-11':8,'2026-12':17,'2034-02':1,'2056-04':1},latestDate:'2056-04-17'};
  const original = JSON.stringify(transactions);
  const summary = dimensionPeriodSummary(transactions,{tableId:'fec_disbursements',measuredAt:'2026-10-30T04:50:57.183949+00:00'});
  assert.equal(summary.range,'2026 Q4');
  assert.equal(summary.latestDate,undefined);
  assert.match(summary.note,/Latest observed transaction month: 2026-10\./);
  assert.match(summary.note,/Future transaction values remain in the detailed counts/);
  assert.equal(JSON.stringify(transactions),original);
  assert.equal(transactions.latestDate,'2056-04-17');
  assert.equal(transactions.buckets['2056-04'],1);
});

test('a bill printing summary with only future months makes no past-period claim', () => {
  const printing = {...dates,id:'printing-dates',fields:['version_date'],buckets:{'2066-06':1},latestDate:'2066-06-07'};
  const summary = dimensionPeriodSummary(printing,{tableId:'bill_versions',measuredAt:'2026-10-30T04:01:36Z'});
  assert.equal(summary.range,'No printing months through 2026-10');
  assert.equal(summary.latestDate,undefined);
  assert.deepEqual(summary.missing,[]);
});
