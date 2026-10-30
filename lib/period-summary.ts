import type { CoverageDimension } from './coverage-map';
import { quarterCoverage, quarterRanges } from './quarter-coverage';

/** Compress only recorded numeric labels, preserving gaps. */
export function periodRuns(values: number[], step = 1): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b), runs: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const first = sorted[index];
    let last = first;
    while (index + 1 < sorted.length && sorted[index + 1] === last + step) last = sorted[++index];
    runs.push(first === last ? String(first) : `${first}–${last}`);
  }
  return runs.join(', ');
}

/** One presence summary for directory tags, overviews and detailed counts.
 * List values may overlap across periods; presence does not add their row counts.
 * Interval buckets describe stated spans, so they never become observed quarters.
 */
export function dimensionPeriodSummary(dimension: CoverageDimension, context?: { tableId: string; measuredAt?: string }) {
  let historicalDateNote = '';
  const checkedDay = context?.measuredAt?.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  const field = dimension.fields?.[0];
  const historicalMeaning = (context?.tableId === 'bill_versions' && dimension.id === 'printing-dates' && field === 'version_date')
    || (context?.tableId === 'public_activity_events' && dimension.id === 'printing-source-dates' && field === 'occurred_at')
    ? 'printing'
    : context?.tableId === 'fec_disbursements' && dimension.id === 'transaction_date' && field === 'transaction_date'
      ? 'transaction' : undefined;
  if (historicalMeaning && dimension.kind === 'date' && dimension.granularity === 'month' && checkedDay) {
    const checkedMonth = checkedDay.slice(0, 7);
    const futureMonth = Object.keys(dimension.buckets).some(month => month > checkedMonth && dimension.buckets[month] > 0);
    const futureLatest = !!dimension.latestDate && dimension.latestDate > checkedDay;
    if (futureMonth || futureLatest) {
      // The measured counts remain literal. Only these explicit historical
      // meanings exclude future months from headlines; other date meanings retain theirs.
      const buckets = Object.fromEntries(Object.entries(dimension.buckets).filter(([month]) => month <= checkedMonth));
      const lastMonth = Object.keys(buckets).filter(month => buckets[month] > 0).sort().at(-1);
      historicalDateNote = `${lastMonth ? `Latest observed ${historicalMeaning} month: ${lastMonth}. ` : ''}Future ${historicalMeaning} values remain in the detailed counts.`;
      dimension = { ...dimension, buckets, latestDate: futureLatest ? undefined : dimension.latestDate };
      if (!lastMonth) return { range: `No ${historicalMeaning} months through ${checkedMonth}`, granularity: 'quarter' as const,
        missing: [], latestDate: undefined, note: historicalDateNote };
    }
  }
  const observed = !dimension.overlapping || dimension.kind === 'list';
  const quarters = observed ? quarterCoverage({ ...dimension, overlapping: false }) : undefined;
  if (quarters) return {
    range: quarters.segments.join(', '), granularity: 'quarter' as const,
    missing: quarterRanges(quarters.missing), latestDate: dimension.latestDate,
    note: [dimension.kind === 'list' ? 'At least one listed date in each shown quarter; rows may occur in several quarters.'
      : 'At least one dated value in each shown quarter; quarters may be incomplete.', historicalDateNote].filter(Boolean).join(' '),
  };
  const keys = Object.keys(dimension.buckets).filter(key => dimension.buckets[key] > 0).sort();
  if (dimension.granularity === 'category') {
    const fields = dimension.fields ?? [];
    const field = ['covered_congress', 'congress', 'congress_text', 'edition_year', 'requested_year', 'native_publication_year']
      .find(name => fields.includes(name));
    if (!field) return undefined;
    const index = fields.indexOf(field);
    const values = keys.flatMap(key => {
      try {
        const value = JSON.parse(key), part = Array.isArray(value) ? value[index] : value;
        return /^\d{1,4}$/.test(String(part)) && Number(part) > 0 ? [Number(part)] : [];
      } catch { return []; }
    });
    return values.length ? { range: `${field.includes('congress') ? 'Congress ' : ''}${periodRuns(values)}`,
      granularity: 'category' as const, missing: [], latestDate: undefined, note: '' } : undefined;
  }
  if (!['month', 'year', 'season'].includes(dimension.granularity) || !keys.length) return undefined;
  const years = keys.map(key => Number(key.slice(0, 4))).filter(year => year > 0);
  return { range: periodRuns(years), granularity: 'year' as const, missing: [], latestDate: undefined,
    note: dimension.kind === 'interval' ? 'Source-stated spans; intervening periods do not establish dated observations.'
      : dimension.granularity === 'season' ? 'Recorded edition years; individual editions remain in the counts.' : '' };
}
