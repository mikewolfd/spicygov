import type { Dataset } from './catalog';
import { DATA_BASE, digest, object, size } from './publication-evidence';

type CollectionInput = { url: string; sha256: string; generation: string; rows: number; owner: string };
export type CollectionEvidence = {
  policy: number; publication: string; status: 'matched' | 'unknown'; reason?: string;
  input?: CollectionInput; matchedRows?: number; unmatchedRows?: number; collections?: number;
  unmatchedCollections?: number; outcomes?: Record<string, number>; cycleRows?: Record<string, number>;
  unscopedRows?: number; sources?: Record<string, { rows: number; collections: number }>;
  queryResults?: {status: string; reason: string; completeness: string; records: number}[];
};
const release = new RegExp(`^${DATA_BASE.replaceAll('.', '\\.')}\/generations\/[a-z0-9-]+\/[a-f0-9]{64}\/artifact\\.json$`);
const counts = (raw: unknown): raw is Record<string, number> => object(raw) && Object.entries(raw).length <= 20000 && Object.entries(raw).every(([key, n]) => key.length > 0 && key.length <= 200 && size(n) && n > 0);
const total = (raw: Record<string, number>) => Object.values(raw).reduce((sum, n) => sum + n, 0);

export function parseCollectionEvidence(raw: unknown, rows: number): CollectionEvidence | undefined {
  if (!object(raw) || raw.policy !== 1 || typeof raw.publication !== 'string' || !release.test(raw.publication)) return undefined;
  if (raw.status === 'unknown') return {policy: 1, publication: raw.publication, status: 'unknown', reason: typeof raw.reason === 'string' ? raw.reason : undefined};
  if (raw.status !== 'matched' || !object(raw.input) || !digest(raw.input.sha256) || !/^sha256:[a-f0-9]{64}$/.test(raw.input.generation) || !size(raw.input.rows) || typeof raw.input.owner !== 'string' || !release.test(raw.input.owner)) return undefined;
  if (typeof raw.input.url !== 'string' || !release.test(raw.input.url.replace(/\/fec_collections\.parquet$/, '/artifact.json')) || !raw.input.url.endsWith(`/${raw.input.generation.slice(7)}/fec_collections.parquet`)) return undefined;
  if (![raw.matchedRows, raw.unmatchedRows, raw.collections, raw.unmatchedCollections, raw.unscopedRows].every(size) || raw.matchedRows + raw.unmatchedRows !== rows || raw.collections > raw.input.rows) return undefined;
  if (!counts(raw.outcomes) || total(raw.outcomes) !== raw.collections || !counts(raw.cycleRows) || Object.keys(raw.cycleRows).some(key => !/^[0-9]{4}$/.test(key) || key === '0000') || total(raw.cycleRows) + raw.unscopedRows !== rows) return undefined;
  if (!object(raw.sources) || !Object.entries(raw.sources).every(([key, value]) => key.length > 0 && key.length <= 200 && object(value) && size(value.rows) && size(value.collections) && value.collections > 0)) return undefined;
  if (Object.values(raw.sources).reduce((n, v) => n + Number(v.rows), 0) !== raw.matchedRows || Object.values(raw.sources).reduce((n, v) => n + Number(v.collections), 0) !== raw.collections) return undefined;
  if (raw.queryResults !== undefined && (!Array.isArray(raw.queryResults) || raw.queryResults.length > 100 || !raw.queryResults.every(v => object(v) && ['status','reason','completeness'].every(key => typeof v[key] === 'string' && v[key].length <= 1000) && size(v.records) && v.records > 0) || raw.queryResults.reduce((n, v) => n + v.records, 0) !== rows)) return undefined;
  return raw as CollectionEvidence;
}

export function currentCollectionEvidence(table: Dataset, raw?: CollectionEvidence): CollectionEvidence | undefined {
  return raw?.publication === table.publication?.recordUrl ? raw : undefined;
}

export const collectionOutcomeLabels: Record<string, [string, string]> = {
  'no-record-rejections': ['Read without rejected records', 'Records passed the collection checks; this does not prove the source is complete.'],
  empty: ['Checked: no records', 'The requested collection returned no records; this does not mean the source has none.'],
  refused: ['Not accepted', 'The collection was refused by its processing checks.'],
  unresolved: ['Unresolved', 'The collection result could not be resolved.'],
  inventory_only: ['Inventory only', 'An inventory entry, not proof that its records were collected.'],
  selection_context: ['Selection records', 'Records explaining which inputs were selected, not separate collection attempts.'],
};
