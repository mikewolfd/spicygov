import type { Dataset } from './catalog';
import { periodLabel, periodPreview } from './source-browser';
import type { CatalogCollection, CatalogManifest, CatalogPeriod, SourceCatalogReader } from './source-catalog';

const normalized = (value: string) => value.toLowerCase().replace(/[_-]+/g, ' ');
export const dataPeriods = (periods: CatalogPeriod[]) => periods.filter(period => period.kind !== 'unknown');
export const hasUnknownPeriod = (periods: CatalogPeriod[]) => !periods.length || periods.some(period => period.kind === 'unknown');

function periodMatches(period: CatalogPeriod, query: string) {
  if (normalized(`${period.kind} ${period.label} ${period.start ?? ''} ${period.end ?? ''}`).includes(normalized(query))) return true;
  // A recorded range can include a year without spelling out every year in between.
  if (/^\d{4}$/.test(query)) {
    const range = /^(\d{4})(?:-\d{2}-\d{2})?\s*[/–]\s*(\d{4})(?:-\d{2}-\d{2})?$/.exec(period.label);
    const start = period.start?.match(/^\d{4}/)?.[0] ?? range?.[1];
    const end = period.end?.match(/^\d{4}/)?.[0] ?? range?.[2];
    return !!start && !!end && Number(start) <= Number(query) && Number(query) <= Number(end);
  }
  return false;
}

export function collectionMatches(collection: CatalogCollection, tables: Dataset[], periods: CatalogPeriod[] | undefined, query: string, status: string, period: string, includeUnknown: boolean) {
  if (status && !collection.statuses.includes(status)) return false;
  const tableNames = tables.filter(table => collection.tables.includes(table.id)).map(table => table.label);
  const description = normalized([collection.title, collection.publisher, collection.id, collection.description, ...collection.families, ...collection.tables, ...tableNames].join(' '));
  const terms = normalized(query.trim()).split(/\s+/).filter(Boolean);
  if (!terms.every(term => description.includes(term) || periods?.some(item => periodMatches(item, term)))) return false;
  if (!period.trim()) return true;
  // Unloaded or failed detail metadata stays visible and is identified separately in the UI.
  if (periods === undefined) return true;
  return dataPeriods(periods).some(item => periodMatches(item, period.trim())) || (includeUnknown && hasUnknownPeriod(periods));
}

export function periodSummary(periods: CatalogPeriod[] | undefined, match = "") {
  if (periods === undefined) return 'Data period: not loaded';
  const known = dataPeriods(periods);
  if (!known.length) return 'Data period: unknown';
  const ordered = match.trim() ? [...known].sort((a, b) => Number(periodMatches(b, match.trim())) - Number(periodMatches(a, match.trim()))) : known;
  const labels = [...new Set(ordered.map(period => `${periodLabel(period)}: ${periodPreview(period)}`))];
  return `Data periods: ${labels.slice(0, 3).join(' · ')}${labels.length > 3 ? ` · ${labels.length - 3} more recorded periods` : ''}${hasUnknownPeriod(periods) ? ' · some periods unknown' : ''}`;
}

/** Read only collection metadata, with bounded requests; never read file inventories. */
export async function loadDiscoveryPeriods(reader: SourceCatalogReader, manifest: CatalogManifest, signal: AbortSignal) {
  const pending = [...manifest.collections];
  const periods: Record<string, CatalogPeriod[]> = {}, failures: string[] = [];
  async function worker() {
    while (pending.length && !signal.aborted) {
      const item = pending.shift()!;
      try { periods[item.id] = (await reader.detail(manifest, item, signal)).collection.periods; }
      catch { if (!signal.aborted) failures.push(item.id); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  return { periods, failures, generation: manifest.generation };
}
