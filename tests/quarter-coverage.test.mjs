import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: ['lib/quarter-coverage.ts'], bundle: true, platform: 'node', format: 'esm', write: false });
const { quarterCoverage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
const dimension = buckets => ({ granularity: 'month', buckets, unplacedRows: 0 });

test('identifies empty quarters across years without requiring every month', () => {
  assert.deepEqual(quarterCoverage(dimension({ '2023-11': 2, '2024-01': 1, '2024-07': 3, '2025-02': 1 })), {
    first: '2023 Q4', last: '2025 Q1', segments: ['2023 Q4–2024 Q1', '2024 Q3', '2025 Q1'], missing: ['2024 Q2', '2024 Q4'], undated: 0, latestDate: undefined,
  });
});

test('does not infer outside the measured range or from non-monthly counts', () => {
  assert.deepEqual(quarterCoverage(dimension({ '2024-02': 1, '2024-06': 1 })), {
    first: '2024 Q1', last: '2024 Q2', segments: ['2024 Q1–2024 Q2'], missing: [], undated: 0, latestDate: undefined,
  });
  assert.equal(quarterCoverage(dimension({})), undefined);
  assert.equal(quarterCoverage({ ...dimension({ '2024-01': 1 }), overlapping: true }), undefined);
  assert.equal(quarterCoverage({ ...dimension({ '2024': 1 }), granularity: 'year' }), undefined);
});
