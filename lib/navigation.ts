import type { Dataset, Filter, Row } from './catalog';
export type Part = { path: string[]; from: 'row' | 'element'; transform?: string; literal?: string };
export type Key = { parts: Part[]; separator: string; pattern: string };
export type Guard = Part & { values?: string[]; pattern?: string; sameAs?: Part };
export type Target = { table: string; columns: string[]; keys: Key[]; guards: Guard[]; available?: boolean; unavailableReason?: string };
export type Navigation = { id: string; source: string; fields: string[]; field?: string; targets: Target[]; mode: 'row' | 'array'; candidates?: boolean; meaning: string; receiptFields: string[]; elementPath: string[]; ruleVersion: string; available?: boolean; unavailableReason?: string };
export type Connection = { id: string; target: number; values: string[] };
const transforms = [undefined, 'lower', 'bill-type', 'nomination-citation', 'partition', 'partition-value', 'senate-amendment', 'hearing-congress', 'vote-congress'];
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const pattern = (v: unknown) => { try { return typeof v === 'string' && v.length <= 300 && !!new RegExp(`^(?:${v})$`); } catch { return false; } };
const validPart = (v: unknown) => object(v) && strings(v.path) && ['row','element'].includes(v.from) && transforms.includes(v.transform) && (v.literal === undefined || typeof v.literal === 'string' && v.literal.length > 0 && v.literal.length <= 4096 && !v.transform);
export function parseNavigation(value: unknown): Navigation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid source connection definitions.');
  const ids = new Set<string>();
  for (const s of value) {
    if (!object(s) || typeof s.id !== 'string' || ids.has(s.id) || typeof s.source !== 'string' || !strings(s.fields) || !strings(s.receiptFields) || !strings(s.elementPath) || !['row','array'].includes(s.mode) || typeof s.meaning !== 'string' || s.ruleVersion !== 'source-navigation/1' || !Array.isArray(s.targets) || !s.targets.length) throw new Error('Invalid source connection definitions.');
    ids.add(s.id);
    for (const t of s.targets) {
      if (!object(t) || typeof t.table !== 'string' || !strings(t.columns) || !t.columns.length || !Array.isArray(t.keys) || t.keys.length !== t.columns.length || !Array.isArray(t.guards)
        || !t.keys.every((k: any) => object(k) && Array.isArray(k.parts) && k.parts.length && k.parts.every(validPart) && typeof k.separator === 'string' && pattern(k.pattern))
        || !t.guards.every((g: any) => validPart(g) && (g.values === undefined || strings(g.values)) && (g.pattern === undefined || pattern(g.pattern)) && (g.sameAs === undefined || validPart(g.sameAs)))) throw new Error('Invalid source connection keys.');
    }
  }
  return value as Navigation[];
}
export const validConnection = (v: unknown): v is Connection => object(v) && typeof v.id === 'string' && Number.isSafeInteger(v.target) && v.target >= 0 && strings(v.values) && v.values.length > 0 && v.values.length <= 8 && v.values.every(s => s.length <= 4096);
const scalar = (v: unknown) => ['string','bigint'].includes(typeof v) || typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined;
export function at(v: unknown, path: string[]): unknown { for (const p of path) { if (!object(v)) return undefined; v = v[p]; } return v; }
function word(p: Part, element: unknown, row: Row): string | undefined {
  if (p.literal !== undefined) return p.literal;
  const raw = at(p.from === 'row' ? row : element, p.path), v = scalar(raw);
  if (p.transform === 'partition' || p.transform === 'partition-value') {
    if (raw == null || raw === '' || raw === '00' || raw === 0) return '';
    return v && /^[1-9][0-9]*$/.test(v) ? (p.transform === 'partition' ? '-' : '') + v : undefined;
  }
  if (v === undefined) return undefined;
  switch (p.transform) {
    case 'lower': return v.toLowerCase();
    case 'bill-type': return v.toLowerCase().replaceAll('.', '');
    case 'nomination-citation': return 'PN' + v;
    case 'senate-amendment': return 'samdt-' + v.replace(/^S\.Amdt\. /, '');
    case 'vote-congress': return /^([1-9][0-9]*)-senate-[12]-[1-9][0-9]*$/.exec(v)?.[1];
    case 'hearing-congress': return /^[SH]\.Hrg\. ([1-9][0-9]*)-[0-9]+$/.exec(v)?.[1];
    default: return v;
  }
}
const full = (p: string, v: string) => new RegExp(`^(?:${p})$`).test(v);
export function targetKeys(t: Target, element: unknown, row: Row): string[] | undefined {
  if (!t.guards.every(g => { const v = word(g, element, row); return v !== undefined && (!g.sameAs || v === word(g.sameAs, element, row)) && (!g.values || g.values.includes(v)) && (!g.pattern || full(g.pattern, v)); })) return;
  const result: string[] = [];
  for (const k of t.keys) {
    const parts = k.parts.map(p => word(p, element, row));
    if (parts.some(v => v === undefined)) return;
    const value = parts.join(k.separator);
    if (!full(k.pattern, value)) return;
    result.push(value);
  }
  return result;
}
function decoded(v: unknown): unknown { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return undefined; } }
export function elements(s: Navigation, row: Row): { state: string; values: unknown[] } {
  if (s.mode === 'row') return { state: 'stated', values: [row] };
  const field = s.field && s.field in row ? s.field : s.fields.find(f => f in row);
  const raw = field ? row[field] : undefined;
  if (raw == null) return {state: row.detail_read === 'false' ? 'unread' : row.detail_read === 'true' ? 'not stated' : 'unknown read state', values: []};
  let value = decoded(raw);
  if (s.elementPath.length && field && s.receiptFields.includes(field)) value = at(value, s.elementPath);
  if (!Array.isArray(value)) return {state: 'unsupported shape', values: []};
  const ambiguous = s.candidates && value.some(candidate => object(candidate) && candidate.target_status === 'ambiguous');
  if (s.candidates) value = value.flatMap(candidate => object(candidate) && Array.isArray(candidate.candidate_keys) ? candidate.candidate_keys.filter(object).map(identity => ({...candidate, ...identity})) : []);
  const values = value as unknown[];
  return { state: values.length ? ambiguous ? 'ambiguous targets' : 'stated' : s.candidates ? 'unresolved targets' : 'empty', values };
}
export function matchesConnection(row: Row, s: Navigation, c: Connection): boolean {
  const t = s.targets[c.target];
  return !!t && t.columns.length === c.values.length && elements(s, row).values.some(e => {
    const keys = targetKeys(t, e, row); return keys?.every((v, i) => v === c.values[i]);
  });
}
export function navigationColumns(s: Navigation): string[] {
  return [...new Set([...(s.field ? [s.field] : []), ...s.targets.flatMap(t => [...t.guards, ...t.keys.flatMap(k => k.parts)].filter(p => p.from === 'row' && p.path.length).map(p => p.path[0]))])];
}
export function forwardLinks(s: Navigation, row: Row): {target: Target; values: string[]; filters: Filter[]}[] {
  const seen = new Set<string>();
  return elements(s, row).values.flatMap(e => s.targets.flatMap(target => {
    const values = targetKeys(target, e, row);
    if (!values) return [];
    const id = JSON.stringify([target.table, values]);
    if (seen.has(id)) return []; seen.add(id);
    return [{target, values, filters: target.columns.map((column, i) => ({column, value: values[i]}))}];
  }));
}
export function usableNavigation(specs: Navigation[], tables: Dataset[]): Navigation[] {
  const lookup = new Map(tables.map(t => [t.id, t]));
  return specs.filter(s => { const source = lookup.get(s.source); return source && !['missing','incompatible','unavailable'].includes(source.metadataState); }).map(s => {
    const source = lookup.get(s.source)!;
    const field = s.fields.find(f => source.columns.some(c => c.name === f));
    const canReadReceipt = !!source.publication?.nativeReceipts && !!source.receiptIdentity?.length;
    const rowColumns = navigationColumns({...s, field});
    return {...s, field, available: s.mode === 'array' ? !!field || canReadReceipt && !!s.receiptFields.length : rowColumns.every(c => source.columns.some(x => x.name === c)) || canReadReceipt && !!s.receiptFields.length,
      targets: s.targets.map(t => ({...t, available: t.table === '@url' || t.table.startsWith('@receipt:') && canReadReceipt || t.columns.every(c => lookup.get(t.table)?.columns.some(x => x.name === c)) && !['missing','incompatible','unavailable'].includes(lookup.get(t.table)?.metadataState ?? 'missing')}))};
  });
}
