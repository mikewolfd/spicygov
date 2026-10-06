import labels from '../content/source-labels.json';

const lookup = (entries: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(entries, key) ? entries[key] : undefined;

export const coverageViewLabel = (label: string): string => lookup(labels.dimensions, label) ?? label;
export const sourceGroupLabel = (family: string): string | undefined => lookup(labels.families, family);
export const sourceControlLabel = (label: string): string => lookup(labels.controls, label) ?? label;
export const sourceFieldLabel = (field?: string): string => field
  ? lookup(labels.fields, field) ?? field.replaceAll('_', ' ') : 'Scope';

const values: Record<string, Record<string, string>> = labels.values;
const requestedDate = new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeZone: 'UTC'});

export function sourceValueLabel(value: unknown, field?: string): string {
  // Publisher identifiers and literal source periods are not internal status codes.
  if (field === 'publisher_id' || field === 'scorecard_id') return typeof value === 'string' ? value : JSON.stringify(value);
  if (value === null && field === 'withdrawal_source') return 'Not recorded';
  const fieldValues = field && Object.hasOwn(values, field) ? values[field] : undefined;
  if (fieldValues && (typeof value === 'string' || typeof value === 'boolean')) {
    const label = lookup(fieldValues, String(value));
    if (label) return label;
  }
  if (typeof value !== 'string') return JSON.stringify(value);
  if (field === 'source_record_key') {
    const ecfr = /^ecfr\/title\/([1-9][0-9]*)$/.exec(value);
    if (ecfr) return `eCFR Title ${ecfr[1]}`;
    const uscode = /^\/us\/usc\/t([1-9][0-9]*)$/.exec(value);
    if (uscode) return `U.S. Code Title ${uscode[1]}`;
  }
  if (field === 'edition' && /^requested-as-of:[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) {
    const literal = value.slice('requested-as-of:'.length), date = new Date(`${literal}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === literal)
      return `Requested as of ${requestedDate.format(date)}`;
  }
  return lookup(labels.commonValues, value) ?? value;
}

// Keep original evidence beside its readable label, including unknown codes and missing values.
export function recordedScopeLabel(key: string): string {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed)) return parsed.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' · ');
    if (typeof parsed === 'string') return parsed;
  } catch { /* Literal source labels need not be JSON. */ }
  return key;
}
