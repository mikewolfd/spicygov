import { validConnection, type Connection } from './navigation';
import { validFilter } from './filter-values';
import type { Filter } from './catalog';
import type { RecordSort } from './record-sort';
export type View = 'records' | 'connections' | 'about';
export type LocationState = {
  id: string; filters: Filter[]; cursor: number; view: View;
  connection?: Connection; sort?: RecordSort; from?: string; trail?: number[];
};
export const initial: LocationState = { id: 'congress_bills', filters: [], cursor: 0, view: 'records' };
export function readLocation(search = window.location.search): LocationState {
  const p = new URLSearchParams(search);
  let filters: Filter[] = [];
  try {
    const f = JSON.parse(p.get('where') ?? '[]');
    if (Array.isArray(f) && f.every(validFilter)) filters = f;
  } catch {}
  let connection: Connection | undefined;
  try { const c = JSON.parse(p.get("connection") ?? "null"); if (validConnection(c)) connection = c; } catch {}
  return {
    ...(connection ? {connection} : {}), id: p.get('table') ?? initial.id, filters, cursor: Math.max(0, Number(p.get('at')) || 0),
    view: ['records', 'connections', 'about'].includes(p.get('view') ?? '') ? p.get('view') as View : 'records',
    sort: p.get('sort') ? {column: p.get('sort')!, direction: p.get('order') === 'desc' ? 'desc' : 'asc'} : undefined,
    from: p.get('from') ?? undefined,
    trail: (p.get('prev') ?? '').split(',').filter(Boolean).map(Number).filter(n => Number.isSafeInteger(n) && n >= 0),
  };
}
export function makeHref(state: LocationState) {
  const p = new URLSearchParams({table: state.id});
  if (state.connection) p.set("connection", JSON.stringify(state.connection));
  if (state.filters.length) p.set('where', JSON.stringify(state.filters));
  if (state.cursor) p.set('at', String(state.cursor));
  if (state.view !== 'records') p.set('view', state.view);
  if (state.sort) { p.set('sort', state.sort.column); if (state.sort.direction === 'desc') p.set('order', 'desc'); }
  if (state.from) p.set('from', state.from);
  if (state.trail?.length) p.set('prev', state.trail.join(','));
  return `/?${p}`;
}
