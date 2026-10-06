import type { Filter, Row } from './catalog';
/** Optional literal alternatives belong to one reviewed field; stored rows stay unchanged. */
export function validFilter(value: unknown): value is Filter {
  if (!value || typeof value !== 'object') return false;
  const f = value as Filter;
  return typeof f.column === 'string' && typeof f.value === 'string' &&
    (f.values === undefined || Array.isArray(f.values) && f.values.length > 0 && f.values.length <= 8 && f.values.every(v => typeof v === 'string'));
}
export function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every(f => row[f.column] != null && (f.values ?? [f.value]).includes(String(row[f.column])));
}
