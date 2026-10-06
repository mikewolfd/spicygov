import type { Dataset } from './catalog';
import { object } from './publication-evidence';
import { timeFingerprint } from './time-coverage';

export type CoverageDimension = {
  id: string; label: string; meaning: string; status: 'measured'; kind?: string;
  granularity: 'month' | 'year' | 'season' | 'category' | 'snapshot'; unit?: string;
  rows: number; placedRows: number; unplacedRows: number; partialRows?: number;
  overlapping?: boolean; buckets: Record<string, number>; fields?: string[];
  yearBuckets?: Record<string, number>;
  snapshot?: { publishedAt?: string; artifactDigest?: string; recordUrl?: string; asOf?: string; facts?: { label: string; value: string }[] };
  matchedRows?: number; unmatchedRows?: number; notes?: string[];
  anomalies?: unknown; parent?: unknown; evidence?: unknown;
  activityBoundary?: { month: string; basis: 'publication-month' | 'measurement-month' };
};
export type CoverageMap = {
  fingerprint: string; rows: number; family: string; artifactDigest?: string;
  inputsFingerprint: string; publishedAt?: string | null;
  publicationSha256?: string; schema: [string, string][]; status: 'measured';
  classification: string; note: string; measuredAt: string; definitionDigest: string;
  dimensions: CoverageDimension[];
};
export type CoverageMaps = { generatedAt: string; censusDigest: string; tables: Record<string, CoverageMap> };

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const instant = (value: unknown): value is string => {
  if (!date(value)) return false;
  const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.exec(value);
  if (!parts) return false;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
};
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const validActivityBoundary = (boundary: unknown, publishedAt: unknown): boolean => {
  if (boundary === undefined) return true;
  if (!object(boundary) || typeof boundary.month !== 'string'
      || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(boundary.month) || boundary.month.startsWith('0000')) return false;
  if (boundary.basis === 'publication-month') return instant(publishedAt)
    && boundary.month === new Date(publishedAt).toISOString().slice(0, 7);
  return boundary.basis === 'measurement-month' && publishedAt == null;
};

export function parseCoverageMaps(raw: unknown): CoverageMaps {
  if (!object(raw) || raw.format !== 'spicygov-coverage-maps' || raw.version !== 1 || raw.partial !== false
      || !date(raw.generatedAt) || !digest(raw.censusDigest) || !object(raw.tables)) throw new Error('Unsupported coverage maps');
  const tables: Record<string, CoverageMap> = {};
  for (const [id, value] of Object.entries(raw.tables)) {
    if (!object(value) || value.status !== 'measured' || typeof value.fingerprint !== 'string'
        || typeof value.inputsFingerprint !== 'string' || ('publishedAt' in value && value.publishedAt !== null && !date(value.publishedAt))
        || !integer(value.rows) || typeof value.family !== 'string' || typeof value.classification !== 'string'
        || typeof value.note !== 'string' || !date(value.measuredAt) || !digest(value.definitionDigest)
        || !Array.isArray(value.schema) || !value.schema.length
        || !value.schema.every((pair: unknown) => Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string' && item.length > 0))
        || new Set(value.schema.map((pair: string[]) => pair[0])).size !== value.schema.length
        || !Array.isArray(value.dimensions) || !value.dimensions.length) throw new Error('Invalid table coverage map: ' + id);
    const dimensions: CoverageDimension[] = [], ids = new Set<string>();
    for (const dim of value.dimensions) {
      if (!object(dim) || typeof dim.id !== 'string' || ids.has(dim.id) || typeof dim.label !== 'string'
          || typeof dim.meaning !== 'string' || dim.status !== 'measured'
          || !['month', 'year', 'season', 'category', 'snapshot'].includes(dim.granularity)
          || !integer(dim.rows) || dim.rows !== value.rows || !integer(dim.placedRows) || !integer(dim.unplacedRows)
          || dim.placedRows + dim.unplacedRows !== value.rows || !object(dim.buckets)
          || ('overlapping' in dim && typeof dim.overlapping !== 'boolean')
          || !Object.entries(dim.buckets).every(([key, n]) => key && integer(n) && n > 0)) throw new Error('Invalid coverage dimension: ' + id);
      ids.add(dim.id);
      if (dim.granularity === 'snapshot' && Object.keys(dim.buckets).length) throw new Error('Snapshot coverage cannot contain periods: ' + id);
      if (dim.snapshot !== undefined && (!object(dim.snapshot)
          || ('asOf' in dim.snapshot && !instant(dim.snapshot.asOf))
          || ('facts' in dim.snapshot && (!Array.isArray(dim.snapshot.facts) || !dim.snapshot.facts.every((fact: unknown) => object(fact) && typeof fact.label === 'string' && fact.label.trim() && typeof fact.value === 'string' && fact.value.trim()))))) throw new Error('Invalid snapshot facts: ' + id);
      for (const key of ['partialRows', 'matchedRows', 'unmatchedRows']) {
        if (key in dim && (!integer(dim[key]) || dim[key] > value.rows)) throw new Error('Invalid auxiliary coverage count: ' + id);
      }
      if (('matchedRows' in dim && 'unmatchedRows' in dim && dim.matchedRows + dim.unmatchedRows !== value.rows)
          || ('partialRows' in dim && dim.partialRows > dim.placedRows)) throw new Error('Auxiliary coverage counts do not reconcile: ' + id);
      const sum = Object.values(dim.buckets).reduce((total: number, n) => total + Number(n), 0);
      if (dim.granularity !== 'snapshot' && (dim.overlapping ? sum < dim.placedRows || Object.values(dim.buckets).some(n => Number(n) > value.rows) : sum !== dim.placedRows)) throw new Error('Coverage counts do not reconcile: ' + id);
      const pattern = dim.granularity === 'month' ? /^[0-9]{4}-(0[1-9]|1[0-2])$/ : dim.granularity === 'year' ? /^[0-9]{4}$/ : dim.granularity === 'season' ? /^[0-9]{4}-(spring|fall)$/ : undefined;
      if (pattern && !Object.keys(dim.buckets).every(key => pattern.test(key) && key.slice(0, 4) !== '0000')) throw new Error('Invalid coverage period: ' + id);
      if (dim.yearBuckets !== undefined && (!object(dim.yearBuckets) || !Object.entries(dim.yearBuckets).every(([year, n]) => /^[0-9]{4}$/.test(year) && year !== '0000' && integer(n) && n > 0 && n <= value.rows))) throw new Error('Invalid annual coverage counts: ' + id);
      if (dim.notes !== undefined && (!Array.isArray(dim.notes) || !dim.notes.every((note: unknown) => typeof note === 'string'))) throw new Error('Invalid coverage notes: ' + id);
      if (!validActivityBoundary(dim.activityBoundary, value.publishedAt)) throw new Error('Invalid activity boundary: ' + id);
      dimensions.push(dim as CoverageDimension);
    }
    tables[id] = { ...value, dimensions } as CoverageMap;
  }
  return { generatedAt: raw.generatedAt, censusDigest: raw.censusDigest, tables };
}

function matchesCoverageRelease(table: Dataset, map: CoverageMap): boolean {
  return map.family === table.family && map.fingerprint === timeFingerprint(table) && map.rows === table.rows
    && (map.publishedAt ?? undefined) === (table.published ?? undefined)
    && map.inputsFingerprint === JSON.stringify([...(table.coverageInputs ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(i => [i.id, i.url, i.rows, i.byteSize, i.sha256, i.etag]))
    && (map.artifactDigest ?? undefined) === table.artifactDigest
    && (map.publicationSha256 ?? undefined) === table.publication?.sha256
    && (!table.columns.length || JSON.stringify(map.schema) === JSON.stringify(table.columns.map(c => [c.name, c.type])));
}

export function currentCoverageMap(table: Dataset, maps?: CoverageMaps): CoverageMap | undefined {
  const map = maps?.tables[table.id];
  return map && matchesCoverageRelease(table, map)
    && !map.dimensions.some(dim => !validActivityBoundary(dim.activityBoundary, map.publishedAt)
      || (dim.activityBoundary?.basis === 'measurement-month' && dim.activityBoundary.month !== new Date().toISOString().slice(0, 7))) ? map : undefined;
}

export function coverageMapForDisplay(table: Dataset, maps?: CoverageMaps): {
  map: CoverageMap; freshness: 'current' | 'previous-release' | 'previous-measurement';
} | undefined {
  const map = maps?.tables[table.id];
  if (!map || map.family !== table.family) return undefined;
  return {map, freshness: currentCoverageMap(table, maps) ? 'current'
    : matchesCoverageRelease(table, map) ? 'previous-measurement' : 'previous-release'};
}

export function coverageMapCounts(tables: Dataset[], maps?: CoverageMaps): { current: number; previous: number } {
  const counts = {current: 0, previous: 0};
  for (const table of tables) {
    const display = coverageMapForDisplay(table, maps);
    if (display) counts[display.freshness === 'current' ? 'current' : 'previous']++;
  }
  return counts;
}

export function textAvailabilityDetails(table: Dataset, maps?: CoverageMaps): { label: string; rows: number; withText: number; notSaved: number; blank: number }[] {
  const labels: Record<string, string> = { 'saved-extracted-text': 'Extracted text', 'saved-comment-text': 'Comment text', 'saved-attachment-text': 'Attachment text', 'saved-inline-text': 'Inline text' };
  const states = ['["saved_nonblank_text"]', '["no_saved_text"]', '["saved_blank_text"]'];
  return (currentCoverageMap(table, maps)?.dimensions ?? []).filter(dim => Object.hasOwn(labels, dim.id)
    && dim.granularity === 'category' && !dim.overlapping && dim.placedRows === dim.rows
    && Object.keys(dim.buckets).every(key => states.includes(key))
    && Object.values(dim.buckets).reduce((n, value) => n + value, 0) === dim.rows).map(dim => ({
    label: labels[dim.id], rows: dim.rows,
    withText: dim.buckets['["saved_nonblank_text"]'] ?? 0,
    notSaved: dim.buckets['["no_saved_text"]'] ?? 0,
    blank: dim.buckets['["saved_blank_text"]'] ?? 0,
  }));
}

export function dimensionPeriodRows(dimension: CoverageDimension, period: string): number | undefined {
  if (dimension.granularity === 'snapshot' || dimension.granularity === 'category') return undefined;
  if (period.length === 7 && dimension.granularity !== 'month') return undefined;
  if (/^[0-9]{4}-(spring|fall)$/.test(period) && dimension.granularity !== 'season') return undefined;
  // A row counted in multiple months cannot be added into a distinct annual row count.
  if (period.length === 4 && dimension.overlapping && dimension.granularity !== 'year') return dimension.yearBuckets ? dimension.yearBuckets[period] ?? 0 : undefined;
  return Object.entries(dimension.buckets).reduce((sum, [key, n]) => sum + (key === period || key.startsWith(period + '-') ? n : 0), 0);
}

const originLabels: Record<string, string> = {
  gao_rss: 'GAO feed', gao_listing: 'GAO listing', gao_r_package: 'GAO R package',
  gao_major_rule_listing: 'GAO major-rule listing', gao_major_rule_index: 'GAO older major-rule index',
  gao_repair: 'GAO repairs', upstream_copy: 'Upstream copy', govinfo: 'GovInfo',
  full_text: 'Full-text classification', kind_uncertain: 'Text completeness uncertain',
  procedural_amendments: 'Procedural amendments', procedural_summary: 'Procedural summary',
  unknown: 'Unknown',
  no_saved_text: 'Not saved', saved_blank_text: 'Saved blank text',
  saved_nonblank_text: 'Saved text',
};
const literalLabel = (value: string) => Object.hasOwn(originLabels, value) ? originLabels[value] : value;

const fieldValueLabels: Record<string, Record<string, string>> = {
  record_outcome: {
    empty: 'Confirmed empty request', inventory_only: 'File or source listing',
    selection_context: 'Selection notes', 'no-record-rejections': 'Selected records parsed',
    refused: 'Not accepted for parsing', unresolved: 'Selection unresolved',
  },
  ingest_source: { bulk: 'Bulk export', search: 'Search results' },
  link_source: { printed: 'Printed docket labels', regulations_dot_gov_info: 'Regulations.gov link', both: 'Printed labels and Regulations.gov link' },
  source: {
    congress: 'Congress.gov',
    docket_document_cites_action_notice: 'Docket document cites an action notice',
    docket_rin: 'Docket regulation identifier', document_rin: 'Document regulation identifier',
    document_fr_doc: 'Document cites a Federal Register notice', fr_cfr_ref: 'Federal Register regulation citation',
    federal_register_rin: 'Federal Register regulation identifier',
    'documents.comment_end_date': 'Regulations.gov',
    'federal_register.comments_close_on': 'Federal Register',
    'documents.comment_end_date+federal_register.comments_close_on': 'Regulations.gov + Federal Register',
  },
  withdrawal_source: { federal_register: 'Federal Register', unified_agenda: 'Unified Agenda' },
  scope_status: { recurring: 'Routine and frequent', single_observed: 'One linked proceeding', unresolved: 'Zero or multiple linked proceedings' },
  observation_kind: { native_reference: 'Native reference', source_credit: 'Source credit', source_note: 'Source note', authority: 'Authority note' },
  interpretation_status: {
    native_public_law_href: 'Public-law link', native_section_href: 'U.S. Code section link',
    native_statute_href: 'Statutes-at-Large link', unsupported_href: 'Unsupported link',
    partial_text_findings: 'Some references found in text', no_qualified_text_findings: 'No accepted text findings',
  },
  uslm_outcome: { captured: 'Metadata saved', captured_partial: 'Partial metadata saved', captured_refused: 'Metadata capture refused', request_failed: 'Metadata request failed', unavailable: 'Source unavailable', not_requested: 'Not requested' },
  law_text_outcome: { parsed: 'Sections parsed', refused: 'Text reading refused', not_requested: 'Not requested' },
  date_filed_is_approximate: { f: 'Marked exact', t: 'Marked approximate' },
};
function fieldLabel(value: unknown, field?: string): string {
  if (field === 'publisher_id' || field === 'scorecard_id') return typeof value === 'string' ? value : JSON.stringify(value);
  if (value === null && field === 'withdrawal_source') return 'Not recorded';
  const labels = field && Object.hasOwn(fieldValueLabels, field) ? fieldValueLabels[field] : undefined;
  return typeof value === 'string' ? labels && Object.hasOwn(labels, value) ? labels[value] : literalLabel(value) : JSON.stringify(value);
}
export function coverageFieldLabel(field?: string): string {
  const labels: Record<string, string> = { interpretation_status: 'Reading result', observation_kind: 'Evidence type', scope_status: 'Proceeding link', kind: 'Text classification', uslm_outcome: 'Native metadata reading', law_text_outcome: 'Section text reading', edition_year: 'Edition year' };
  return field ? Object.hasOwn(labels, field) ? labels[field] : field.replaceAll('_', ' ') : 'Scope';
}

export function scopeLabel(key: string, fields?: string[]): string {
  try {
    const parsed = JSON.parse(key);
    if (Array.isArray(parsed)) return parsed.map((value, index) => fieldLabel(value, fields?.[index])).join(' · ');
    if (typeof parsed === 'string') return fieldLabel(parsed, fields?.[0]);
    if (object(parsed)) {
      const labels = [typeof parsed.period_text === 'string' ? parsed.period_text : undefined,
        typeof parsed.year_text === 'string' ? parsed.year_text : undefined,
        typeof parsed.congress_text === 'string' ? `Congress ${parsed.congress_text}` : undefined,
        typeof parsed.session_text === 'string' ? `Session ${parsed.session_text}` : undefined,
        typeof parsed.chamber_text === 'string' ? parsed.chamber_text : undefined].filter((label): label is string => !!label);
      if (labels.length) return [...new Set(labels)].join(' · ');
      if ('action' in parsed || 'fr_citation' in parsed) {
        const action = typeof parsed.action === 'string' && parsed.action ? parsed.action : 'Milestone';
        const literalDate = typeof parsed.date === 'string' && parsed.date ? parsed.date : 'Date not stated';
        const detail = parsed.precision === 'invalid' ? `${literalDate} (invalid date)` : literalDate;
        const citation = typeof parsed.fr_citation === 'string' && parsed.fr_citation ? parsed.fr_citation : undefined;
        return [action, detail, citation].filter(Boolean).join(' · ');
      }
      if (parsed.precision === 'invalid timetable') return 'Unreadable timetable';
    }
  } catch { /* Literal publisher labels need not be JSON. */ }
  return fieldLabel(key, fields?.[0]);
}

export function coverageStatement(dimension: CoverageDimension): string {
  // The complete source meaning remains available with the counting checks.
  for (const boundary of dimension.meaning.matchAll(/[.!?]\s+(?=[A-Z])/g)) {
    const statement = dimension.meaning.slice(0, boundary.index! + 1);
    // Initials in names such as U.S. Code are part of the same sentence.
    if (/\b(?:[A-Za-z]\.){2,}$/.test(statement)) continue;
    return statement;
  }
  return dimension.meaning;
}

export function coveragePeriodLabel(dimension: CoverageDimension, period: string): string {
  if (dimension.granularity === 'year' && /\bcycles?\b/i.test(dimension.label) && /^\d{4}$/.test(period)) {
    const year = Number(period);
    // FEC cycles use their even ending year. Preserve unusual source labels.
    return year >= 2 && year % 2 === 0 ? `Cycle ending ${period} (${year - 1}–${period})` : `Cycle label ${period}`;
  }
  return period.replace('-spring', ' spring').replace('-fall', ' fall');
}

export function coveragePeriodNoun(dimension: CoverageDimension): string {
  if (/\bcycles?\b/i.test(dimension.label) && dimension.granularity === 'year') return 'cycle';
  return dimension.granularity === 'season' ? 'edition' : dimension.granularity === 'month' ? 'month' : 'year';
}

export function coverageItemNoun(dimension: CoverageDimension): string {
  if (dimension.id === 'selected_source_scopes') return 'selected files and requests';
  if (dimension.fields?.includes('publisher_id')) return 'publishers';
  if (dimension.fields?.includes('scorecard_id')) return 'editions';
  if (dimension.fields?.includes('form')) return 'filing layouts';
  return 'recorded values';
}

function conciseSelection(value: string): string {
  return value.replace(/https?:\/\/[^\s;]+/g, address => {
    try {
      const url = new URL(address);
      const segments = url.pathname.split('/').filter(Boolean);
      const endpoint = segments.slice(-2).join('/').replaceAll('_', ' ') || url.hostname;
      const filters = [...url.searchParams].slice(0, 2).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join(' · ');
      return `${endpoint}${filters ? ` · ${filters}` : ''}`;
    } catch { return address; }
  });
}

export function coverageCategoryDisplay(dimension: CoverageDimension, key: string, publisherNames?: ReadonlyMap<string, string>): { label: string; exact: string } {
  const exact = scopeLabel(key, dimension.fields);
  let label = exact;
  const publisherIndex = dimension.fields?.indexOf('publisher_id') ?? -1;
  if (publisherIndex >= 0 && publisherNames) {
    try {
      const values: unknown = JSON.parse(key);
      if (Array.isArray(values) && values.every(value => typeof value === 'string')) {
        const name = publisherNames.get(values[publisherIndex]);
        if (name) return {label: values.map((value, index) => index === publisherIndex ? name : fieldLabel(value, dimension.fields?.[index])).join(' · '), exact};
      }
    } catch { /* Unrecognized values keep their recorded identifier. */ }
  }
  if (dimension.id === 'selected_source_scopes') {
    try {
      const values: unknown = JSON.parse(key);
      if (Array.isArray(values) && values.length === 3 && values.every(value => typeof value === 'string')) {
        const [family, outcome, scope] = values;
        const source = family === 'fec_access' ? 'FEC' : family.replace(/^fec_/, 'FEC ').replaceAll('_', ' ');
        const state = fieldLabel(outcome, 'record_outcome');
        label = `${source} · ${conciseSelection(scope)} · ${state}`;
      }
    } catch { /* The exact recorded scope stays available even when it is not a tuple. */ }
  } else if (dimension.fields?.length === 1 && ['publisher_id', 'scorecard_id'].includes(dimension.fields[0])) {
    label = `${dimension.fields[0] === 'publisher_id' ? 'Publisher ID' : 'Edition ID'}: ${exact}`;
  }
  const trimmed = label.length > 140 ? `${label.slice(0, 137).trimEnd()}…` : label;
  return { label: trimmed, exact };
}

export function coverageCategoryMatches(dimension: CoverageDimension, key: string, query: string, publisherNames?: ReadonlyMap<string, string>): boolean {
  const shown = coverageCategoryDisplay(dimension, key, publisherNames);
  return `${shown.label} ${shown.exact}`.toLowerCase().includes(query.trim().toLowerCase());
}
