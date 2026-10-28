import type { CoverageDimension } from './coverage-map';

/** Find quarters with no dated records between the first and last recorded months. */
export function quarterCoverage(dimension: CoverageDimension) {
  if (dimension.granularity !== 'month' || dimension.overlapping) return undefined;
  const months = Object.keys(dimension.buckets).sort();
  if (!months.length || !months.every(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) return undefined;
  const quarter = (month: string) => Number(month.slice(0, 4)) * 4 + Math.floor((Number(month.slice(5)) - 1) / 3);
  const label = (value: number) => `${Math.floor(value / 4)} Q${value % 4 + 1}`;
  const present = new Set(months.map(quarter));
  const first = quarter(months[0]), last = quarter(months[months.length - 1]);
  const missing: string[] = [];
  for (let value = first; value <= last; value++) if (!present.has(value)) missing.push(label(value));
  const quarters = [...present].sort((a, b) => a - b);
  const segments: string[] = [];
  for (let i = 0; i < quarters.length; i++) {
    const start = quarters[i];
    while (i + 1 < quarters.length && quarters[i + 1] === quarters[i] + 1) i++;
    segments.push(start === quarters[i] ? label(start) : `${label(start)}–${label(quarters[i])}`);
  }
  return { first: label(first), last: label(last), segments, missing, undated: dimension.unplacedRows, latestDate: dimension.latestDate };
}
