import type { CoverageDimension } from './coverage-map';

const quarter = (month: string) => Number(month.slice(0, 4)) * 4 + Math.floor((Number(month.slice(5)) - 1) / 3);
const label = (value: number) => `${Math.floor(value / 4)} Q${value % 4 + 1}`;

function segments(values: number[]) {
  const quarters = [...new Set(values)].sort((a, b) => a - b), result: string[] = [];
  for (let i = 0; i < quarters.length; i++) {
    const start = quarters[i];
    while (i + 1 < quarters.length && quarters[i + 1] === quarters[i] + 1) i++;
    result.push(start === quarters[i] ? label(start) : `${label(start)}–${label(quarters[i])}`);
  }
  return result;
}

/** Display exact missing quarters as runs without listing every quarter. */
export function quarterRanges(quarters: string[]) {
  return segments(quarters.map(value => {
    const match = /^(\d{4}) Q([1-4])$/.exec(value);
    if (!match) throw Error('Invalid quarter label');
    return Number(match[1]) * 4 + Number(match[2]) - 1;
  }));
}

/** Find quarters with no dated records between the first and last recorded months. */
export function quarterCoverage(dimension: Pick<CoverageDimension, 'granularity' | 'overlapping' | 'buckets' | 'unplacedRows' | 'latestDate'>) {
  if (dimension.granularity !== 'month' || dimension.overlapping) return undefined;
  const months = Object.keys(dimension.buckets).filter(month => dimension.buckets[month] > 0).sort();
  if (!months.length || !months.every(month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) return undefined;
  const present = new Set(months.map(quarter));
  const first = quarter(months[0]), last = quarter(months[months.length - 1]);
  const missing: string[] = [];
  for (let value = first; value <= last; value++) if (!present.has(value)) missing.push(label(value));
  return { first: label(first), last: label(last), segments: segments([...present]), missing, undated: dimension.unplacedRows, latestDate: dimension.latestDate };
}

/** Quarters present in the published records without an indexed source date. */
export function unindexedQuarters(sourceMonths: string[], publishedMonths: string[]) {
  const source = new Set(sourceMonths.map(quarter));
  return [...new Set(publishedMonths.map(quarter))].filter(value => !source.has(value)).sort((a, b) => a - b).map(label);
}
