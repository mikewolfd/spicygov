import type { Dataset, Filter, Row } from './catalog';
import { parseExact } from './exact-json';
import type { RouteCapability } from './metadata';
export type Part = { path: string[]; from: 'row' | 'element'; transform?: string; literal?: string };
export type Key = { parts: Part[]; separator: string; pattern: string };
export type Guard = Part & { values?: string[]; pattern?: string; sameAs?: Part };
export type Target = { table: string; columns: string[]; keys: Key[]; guards: Guard[]; available?: boolean; unavailableReason?: string;sourceAvailable?:boolean;completeKey?:boolean;directions?:{forward:RouteCapability;reverse:RouteCapability};requiredMainFields?:{path:string;status:string}[];requiredElementFields?:{path:string;status:string}[] };
export type Navigation = { id: string; source: string; fields: string[]; field?: string; targets: Target[]; mode: 'row' | 'array'; candidates?: boolean; meaning: string; receiptFields: string[]; elementPath: string[]; ruleVersion: string; available?: boolean; unavailableReason?: string };
export type Connection = { id: string; target: number; values: string[] };
const transforms = [undefined, 'lower', 'bill-type', 'nomination-citation', 'partition', 'partition-value', 'senate-amendment', 'hearing-congress', 'vote-congress', 'native-boolean', 'canonical-date', 'fr-document-number', 'fr-publication-date'];
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
const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'bigint' && v >= -(1n << 63n) && v <= (1n << 64n) - 1n || typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : undefined;
export function at(v: unknown, path: string[]): unknown { for (const p of path) { if (!object(v)) return undefined; v = v[p]; } return v; }
function federalRegisterIdentity(value: unknown): {number: string; date: string} | undefined {
  if (typeof value !== 'string') return;
  const match = /^([A-Za-z0-9._-]+)@([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match || match[0] !== value) return;
  const year = Number(match[2]), month = Number(match[3]), day = Number(match[4]);
  if (year < 1 || month < 1 || month > 12) return;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return;
  return {number: match[1], date: `${match[2]}-${match[3]}-${match[4]}`};
}
function word(p: Part, element: unknown, row: Row): string | undefined {
  if (p.literal !== undefined) return p.literal;
  const raw = at(p.from === 'row' ? row : element, p.path), v = scalar(raw);
  if (p.transform === 'native-boolean') return typeof raw === 'boolean' ? String(raw) : undefined;
  if (p.transform === 'canonical-date') return typeof raw === 'string' ? federalRegisterIdentity(`date@${raw}`)?.date : undefined;
  if (p.transform === 'fr-document-number' || p.transform === 'fr-publication-date') {
    const identity = federalRegisterIdentity(raw);
    return p.transform === 'fr-document-number' ? identity?.number : identity?.date;
  }
  if (p.transform === 'partition' || p.transform === 'partition-value') {
    if (raw == null || raw === '' || raw === '00' || raw === 0 || raw === 0n) return '';
    if (p.transform === 'partition-value') return v && /^[0-9]+$/.test(v) ? v : undefined;
    return v && /^0*[1-9][0-9]*$/.test(v) ? '-' + v.replace(/^0+/, '') : undefined;
  }
  if (v === undefined) return undefined;
  switch (p.transform) {
    case 'lower': return v.toLowerCase();
    case 'bill-type': return v.toLowerCase().replaceAll('.', '');
    case 'nomination-citation': return 'PN' + v;
    case 'senate-amendment': return 'samdt-' + v.replace(/^S\.Amdt\. /, '');
    case 'vote-congress': {const match=/^([1-9][0-9]*)-senate-[12]-[1-9][0-9]*$/.exec(v);return match?.[0]===v?match[1]:undefined;}
    case 'hearing-congress': {const match=/^[SH]\.Hrg\. ?([1-9][0-9]*)-[0-9]+$/.exec(v);return match?.[0]===v?match[1]:undefined;}
    default: return v;
  }
}
const full = (p: string, v: string) => new RegExp(`^(?:${p})$`).exec(v)?.[0] === v;
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
function decoded(v: unknown, integerReferences = false): unknown { if (typeof v !== 'string') return v; try { return parseExact(v, integerReferences); } catch { return undefined; } }
export type FccDocumentOutcome = { state: 'unavailable' | 'unread' | 'unrecorded' | 'malformed' | 'ambiguous' | 'recorded'; message: string; sourceSha256?: string; pageCount?: number; error?: string };
// Main result observations take precedence. The older receipt form remains
// readable for the separate evidence inspector, never for navigation keys.
export function fccDocumentOutcome(url: string, receipt: Row, fieldAvailable = true): FccDocumentOutcome {
  const malformed: FccDocumentOutcome = {state:'malformed',message:'Recorded extraction diagnostics are malformed.'};
  const unrecorded: FccDocumentOutcome = {state:'unrecorded',message:'No extraction attempt recorded for this URL.'};
  if (!fieldAvailable) return {state:'unavailable',message:'Extraction diagnostics are unavailable in the published source details.'};
  if (Object.hasOwn(receipt, 'extraction_results')) {
    if (receipt.extraction_results === null) return unrecorded;
    const results = decoded(receipt.extraction_results);
    if (!Array.isArray(results)) return malformed;
    const matches = results.filter(d => object(d) && d.url === url);
    if (matches.length > 1) return {state:'ambiguous',message:'Multiple recorded outcomes; no outcome chosen.'};
    if (!matches.length) return unrecorded;
    const d = matches[0];
    if (d.url_status !== 'usable' || d.digest_status === 'invalid') return malformed;
    const count = typeof d.page_count === 'bigint' && d.page_count <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(d.page_count) : d.page_count;
    const digest = d.source_sha256;
    if (!['ok','empty','encrypted','error'].includes(d.status) || !(d.error === null || typeof d.error === 'string')
      || !(digest === null || typeof digest === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.exec(digest)?.[0] === digest)
      || !(count === null || Number.isSafeInteger(count) && count >= 0)
      || (digest === null ? d.status !== 'error' || count !== null || !d.error : count === null)
      || d.status === 'ok' && (count < 1 || d.error !== null)) return malformed;
    const label = {ok:'successful',empty:'no extractable text',encrypted:'encrypted',error:'failed'}[
      d.status as 'ok'|'empty'|'encrypted'|'error'];
    return {state:'recorded',message:label ? `Reported extraction: ${label}.` : `Recorded outcome: ${String(d.status ?? 'not stated')}.`,
      ...(typeof d.source_sha256 === 'string' ? {sourceSha256:d.source_sha256} : {}),
      ...(Number.isSafeInteger(count) && count >= 0 ? {pageCount:count} : {}),
      ...(typeof d.error === 'string' && d.error ? {error:d.error} : {})};
  }
  if (!Object.hasOwn(receipt, 'pdf_extraction_results_json')) return {state:'unread',message:'Extraction outcome not read yet.'};
  const raw = receipt.pdf_extraction_results_json;
  if (raw === null) return unrecorded;
  const diagnostics = decoded(raw);
  if (!Array.isArray(diagnostics) || !diagnostics.every(d => object(d) && typeof d.url === 'string' && /^https:\/\/[^\s]+$/.test(d.url))) return malformed;
  const matches = diagnostics.filter(d => d.url === url);
  if (matches.length > 1) return {state:'ambiguous',message:'Multiple recorded outcomes; no outcome chosen.'};
  if (!matches.length) return unrecorded;
  const d = matches[0], digest = d.source_sha256;
  if (!['ok','empty','encrypted','error'].includes(d.status) || !(d.error === null || typeof d.error === 'string')
    || !(digest === null || typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest))
    || !(d.page_count === null || Number.isSafeInteger(d.page_count) && d.page_count >= 0)
    || (digest === null ? d.status !== 'error' || d.page_count !== null || !d.error : d.page_count === null)
    || d.status === 'ok' && (d.page_count < 1 || d.error !== null)) return malformed;
  const label = {ok:'successful',empty:'no extractable text',encrypted:'encrypted',error:'failed'}[d.status as 'ok'|'empty'|'encrypted'|'error'];
  return {state:'recorded',message:`Reported extraction: ${label}.`,
    ...(digest ? {sourceSha256:digest} : {}), ...(d.page_count !== null ? {pageCount:d.page_count} : {}), ...(d.error ? {error:d.error} : {})};
}
export function sourceOccurrences(s: Navigation, row: Row): unknown[] {
  if (s.mode === 'row') return [];
  const field = s.field && s.field in row ? s.field : s.fields.find(f => f in row);
  let value = decoded(field ? row[field] : undefined, true);
  if (s.elementPath.length && field && s.receiptFields.includes(field)) value = at(value, s.elementPath);
  return Array.isArray(value) ? value : [];
}
export function elements(s: Navigation, row: Row): { state: string; values: unknown[] } {
  if (s.mode === 'row') return { state: 'stated', values: [row] };
  const field = s.field && s.field in row ? s.field : s.fields.find(f => f in row);
  const raw = field ? row[field] : undefined;
  if (raw == null) return {state: row.detail_read === 'false' ? 'unread' : row.detail_read === 'true' ? 'not stated' : 'unknown read state', values: []};
  let value = decoded(raw, true);
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
export function forwardLinks(s: Navigation, row: Row): {target: Target; values: string[]; filters: Filter[]; sourceElement?: unknown; sourceOrdinal?: number}[] {
  const seen = new Set<string>();
  const fccDocuments = s.id === 'fcc_filing_documents' && s.source === 'fcc_filings';
  return elements(s, row).values.flatMap((e, sourceOrdinal) => s.targets.flatMap(target => {
    const values = targetKeys(target, e, row);
    if (!values) return [];
    const id = JSON.stringify([target.table, values]);
    if (seen.has(id) && !fccDocuments) return []; seen.add(id);
    return [{target, values, filters: target.columns.map((column, i) => ({column, value: values[i]})), sourceElement:e,sourceOrdinal}];
  }));
}
export function usableNavigation(specs: Navigation[], tables: Dataset[]): Navigation[] {
  const lookup = new Map(tables.map(t => [t.id, t]));
  return specs.filter(s => { const source = lookup.get(s.source); return source && !['missing','incompatible','unavailable'].includes(source.metadataState); }).map(s => {
    const source = lookup.get(s.source)!;
    const field = s.fields.find(f => source.columns.some(c => c.name === f));
    const sourceReady = s.available !== false && (s.mode !== 'array'||!!field);
    return {...s, field, available:sourceReady,
      targets: s.targets.map(t => {
        const mainReady=(t.requiredMainFields??[]).every(f=>f.status!=='missing'&&source.columns.some(c=>c.name===f.path.split('.')[0]))&&navigationColumns({...s,field,targets:[t]}).every(c=>source.columns.some(x=>x.name===c));
        const nestedReady=(t.requiredElementFields??[]).every(f=>f.status!=='missing');
        const targetReady=t.table==='@url'||!t.table.startsWith('@')&&t.columns.every(c=>lookup.get(t.table)?.columns.some(x=>x.name===c))&&!['missing','incompatible','unavailable'].includes(lookup.get(t.table)?.metadataState??'missing');
        const available=sourceReady&&mainReady&&nestedReady&&t.available!==false&&t.sourceAvailable!==false&&targetReady;
        return {...t,available,directions:t.directions?{forward:{...t.directions.forward,available:available&&t.directions.forward.available},reverse:{...t.directions.reverse,available:available&&t.directions.reverse.available}}:undefined};
      })};
  });
}
