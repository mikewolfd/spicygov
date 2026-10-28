import type { Dataset } from './catalog';
import { billAvailability, coverageReading, coveragePeriodNoun, preferredCoverageDimension, type CoverageDimension, type CoverageMaps } from './coverage-map';
import type { CatalogCollection, CatalogPeriod } from './source-catalog';
import { sourcePeriodGroups, type SourcePeriodGroup } from './source-periods';

export type CoverageTag = { label: string; detail: string };
type CollectionContext = Pick<CatalogCollection, 'id' | 'families'>;

/** Compress only values actually recorded. A run describes labels, not complete records. */
export function periodRuns(values: number[], step = 1): string {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const first = sorted[index];
    let last = first;
    while (index + 1 < sorted.length && sorted[index + 1] === last + step) last = sorted[++index];
    runs.push(first === last ? String(first) : `${first}–${last}`);
  }
  return runs.join(', ');
}

const integer = (value: string) => /^\d{1,4}$/.test(value) && Number(value) > 0 ? Number(value) : undefined;
const year = (value: string) => {
  const match = /^(\d{4})(?:-(?:\d{2}(?:-\d{2})?(?:T.*)?|spring|fall))?$/.exec(value);
  return match && (/-spring$|-fall$/.test(value) || Number.isFinite(Date.parse(value))) ? match[1] : undefined;
};
const compact = (value: string) => value.length <= 68 ? value : `${value.slice(0, 65).replace(/[,\s–]+$/, '')}…`;
const range = (values: number[]) => {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  return sorted.length === 1 ? String(sorted[0]) : `${sorted[0]}–${sorted.at(-1)}`;
};
const requestOrAvailability = (period: CatalogPeriod) => /requested/.test(period.kind) || period.basis.includes('requested-scope')
  || /documented-publisher|documented-availability|publisher-availability|declared/.test(period.kind);

function sourceTag(group: SourcePeriodGroup, collection?: CollectionContext): CoverageTag | undefined {
  const { periods } = group, kind = periods[0].kind, prefix = /declared/.test(kind) ? 'Declared ' : '';
  if (/download|captur|acquisit|retriev|observed-at|collected-at|snapshot/i.test(kind)) return undefined;
  const examples = (periods.length > 4 ? [...periods.slice(0, 2), ...periods.slice(-2)] : periods)
    .map(period => [period.label, period.start && `start ${period.start}`, period.end && `end ${period.end}`].filter(Boolean).join('; ').slice(0, 120));
  const detail = `${group.label}: ${periods.length} recorded period labels. Examples: ${examples.join(' · ')}. Recorded scopes may be partial; these labels do not establish complete coverage. All recorded values remain in Details.`;
  if (/congress/.test(kind) || /election-cycle/.test(kind)) {
    const values = periods.map(period => integer(period.label.trim()));
    if (values.every((value): value is number => value !== undefined)) {
      const cycles = /cycle/.test(kind);
      const label = `${prefix}${cycles ? 'cycles ending' : 'Congresses'} ${periodRuns(values, cycles ? 2 : 1)}`;
      return { label: compact(label.charAt(0).toUpperCase() + label.slice(1)), detail };
    }
  }
  const agenda = collection?.id === 'family:unified-agenda' || collection?.families.includes('unified-agenda');
  const edition = /edition/.test(kind) || (agenda && kind === 'declared-period');
  const values = periods.flatMap(period => {
    const labelYear = edition && /^\d{4}(?:04|10)$/.test(period.label) ? period.label.slice(0, 4) : year(period.label);
    return [labelYear, period.start && year(period.start), period.end && year(period.end)]
      .filter((value): value is string => !!value && Number(value) > 0).map(Number);
  });
  if (values.length) {
    const subject = edition ? 'edition years' : kind === 'observed-retained-scope' ? 'saved record years'
      : /issue/.test(kind) ? 'issue years' : /publication/.test(kind) ? 'publication years' : 'years';
    const label = `${prefix}${subject} ${range(values)}${new Set(values).size > 1 ? ' · gaps possible' : ''}`;
    return { label: compact(label.charAt(0).toUpperCase() + label.slice(1)), detail };
  }
  return undefined;
}

/** Headline source tags describe retained periods; request and availability scopes stay in Details. */
export function sourceCoverageTags(periods: CatalogPeriod[] | undefined, collection?: CollectionContext): CoverageTag[] {
  if (periods === undefined) return [];
  const tags: CoverageTag[] = [];
  for (const group of sourcePeriodGroups(periods.filter(period => !requestOrAvailability(period)), collection)) {
    const tag = sourceTag(group, collection);
    if (tag) tags.push(tag);
    if (tags.length === 2) break;
  }
  if (tags.length && periods.some(period => period.kind === 'unknown')) tags[0].detail += ' Some periods remain unknown.';
  return tags.slice(0, 2);
}

function categoryValues(dimension: CoverageDimension, field: string): string[] {
  const index = dimension.fields?.indexOf(field) ?? -1;
  if (index < 0) return [];
  return Object.keys(dimension.buckets).flatMap(key => {
    try {
      const parsed: unknown = JSON.parse(key);
      const value = Array.isArray(parsed) ? parsed[index] : index === 0 ? parsed : undefined;
      return typeof value === 'number' || typeof value === 'string' ? [String(value)] : [];
    } catch { return index === 0 && dimension.fields?.length === 1 ? [key] : []; }
  });
}

function categoryNumbers(dimension: CoverageDimension, field: string): number[] {
  return categoryValues(dimension, field).flatMap(value => {
    const number = integer(value);
    return number === undefined ? [] : [number];
  });
}

const requestedDimension = (dimension: CoverageDimension) => dimension.fields?.some(field => /requested/i.test(field))
  || /(?:^|[_-])requested(?:[_-]|$)/i.test(dimension.id) || /^requested\b/i.test(dimension.label);
const actualPeriodFields = new Set(['congress', 'congress_text', 'covered_congress', 'year_text', 'edition_year', 'agenda_edition', 'cycle', 'reported_cycle', 'cycles', 'cycles_json',
  'publication_date', 'published_date', 'date_issued', 'publication_year', 'native_publication_year', 'action_date', 'introduced_date', 'vote_day',
  'date_filed', 'filed_date', 'filing_date', 'posted_date', 'post_date', 'transaction_date', 'expenditure_date', 'disbursement_date',
  'record_date', 'benefit_year', 'fiscal_year', 'economic_fiscal_year', 'report_year', 'period_start', 'period_end']);
const collectorDimension = (dimension: CoverageDimension) => [dimension.id, ...(dimension.fields ?? [])]
  .some(value => /download|captur|acquir|acquisit|retriev|fetch|receipt|snapshot|control|source.scope|observed_at|recorded_at|read_at|measured_at/i.test(value));
const actualPeriodDimension = (dimension: CoverageDimension) => dimension.placedRows > 0 && !requestedDimension(dimension)
  && !collectorDimension(dimension)
  && dimension.fields?.some(field => actualPeriodFields.has(field));

/** Headline dataset tags show known periods measured for the current release only. */
export function tableCoverageTags(table: Dataset, maps?: CoverageMaps, tables: Dataset[] = []): CoverageTag[] {
  const availability = billAvailability(table, tables, maps);
  if (availability) {
    const congresses = Object.entries(availability.byCongress).flatMap(([key, counts]) => {
      const value = integer(key);
      return value !== undefined && (counts.policyAreas > 0 || counts.subjects > 0) ? [value] : [];
    });
    return congresses.length ? [{label: compact(`Congresses ${periodRuns(congresses)}`),
      detail: 'Congresses with at least one bill having a policy area or subject. Coverage varies by Congress.'}] : [];
  }
  const reading = coverageReading(table, maps);
  if (!reading || reading.freshness !== 'current' || collectorDimension(reading.dimension)) return [];
  let dimension = reading.dimension;
  let requestedScope = '';
  if (requestedDimension(dimension)) {
    const examples = Object.keys(dimension.buckets).slice(0, 4).map(value => value.slice(0, 80)).join(', ');
    requestedScope = `${dimension.label}: ${examples || 'no usable requested labels'}. Request scope does not establish retained edition or period coverage; it remains in Details.`;
    const map = maps!.tables[table.id];
    const actual = map.dimensions.filter(actualPeriodDimension);
    if (!actual.length) return [];
    dimension = preferredCoverageDimension({ ...map, dimensions: actual });
  }
  // Prefer the Congress described by a record over an incidental event date.
  // Some report tables distinguish the Congress covered from publication time.
  const congressDimension = maps!.tables[table.id].dimensions.find(dim => actualPeriodDimension(dim)
    && ['congress', 'congress_text', 'covered_congress'].some(field => categoryNumbers(dim, field).length));
  if (congressDimension) dimension = congressDimension;
  const covered = categoryNumbers(dimension, 'covered_congress');
  const congress = categoryNumbers(dimension, 'congress').concat(categoryNumbers(dimension, 'congress_text'), covered);
  const editionField = dimension.fields?.find(field => ['edition_year', 'requested_year', 'requested_edition_year'].includes(field));
  const editions = editionField ? categoryNumbers(dimension, editionField) : [];
  const publisherYears = categoryValues(dimension, 'year_text');
  const literalPublisherYears = publisherYears.filter(value => /^\d{4}$/.test(value) && Number(value) > 0).map(Number);
  const otherPublisherYears = [...new Set(publisherYears.filter(value => !/^\d{4}$/.test(value) || Number(value) === 0))];
  const periodYears = Object.keys(dimension.buckets).flatMap(key => {
    const value = year(key);
    return value && Number(value) > 0 ? [Number(value)] : [];
  });
  const cycles = coveragePeriodNoun(dimension) === 'cycle';
  let label: string;
  if (congress.length) label = `${covered.length ? 'Reports covering Congresses' : 'Congresses'} ${periodRuns(congress)}`;
  else if (editions.length) label = `${editionField?.startsWith('requested') ? 'Requested edition years' : 'Edition years'} ${periodRuns(editions)}`;
  else if (literalPublisherYears.length) label = `Edition years ${periodRuns(literalPublisherYears)}`;
  else if (periodYears.length) {
    if (cycles) label = `Cycles ending ${periodRuns(periodYears, 2)}`;
    else {
      const subject = dimension.granularity === 'season' ? 'Edition years'
        : editionField?.startsWith('requested') ? 'Requested edition years'
        : /edition/i.test(dimension.label) ? 'Edition years'
        : /\b(?:dates?|months?|years?)\b/i.test(dimension.label) ? dimension.label.replace(/\b(?:dates?|months?|years?)\b/i, 'years') : `${dimension.label} years`;
      label = `${subject} ${range(periodYears)}${new Set(periodYears).size > 1 ? ' · gaps possible' : ''}`;
    }
  } else return [];
  const otherLabels = otherPublisherYears.length ? ` Other publisher year labels: ${otherPublisherYears.slice(0, 3).map(value => value.slice(0, 80)).join(', ')}${otherPublisherYears.length > 3 ? `; ${otherPublisherYears.length - 3} more in Details` : ''}. These labels were not expanded into individual years.` : '';
  const detail = `${dimension.label}: ${dimension.meaning} ${reading.release}. Recorded labels and date bounds do not establish complete or gap-free coverage.${otherLabels}${requestedScope ? ` ${requestedScope}` : ''}${dimension.unplacedRows ? ` ${dimension.unplacedRows.toLocaleString()} rows have no usable value for this view.` : ''}`;
  return [{ label: compact(label), detail }];
}
