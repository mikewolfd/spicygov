import { parseCollectionEvidence, type CollectionEvidence } from './collection-coverage';
import type { Dataset } from './catalog';
import { object } from './publication-evidence';
export type TimeCoverage = { fingerprint: string; publicationSha256?: string; rows: number; status: 'measured' | 'unmeasured'; field?: string; granularity?: 'month' | 'year' | 'season'; buckets?: Record<string, number>; undatedRows?: number; measuredAt?: string; reason?: string; collectionOutcomes?: Record<string, number>; collectionEvidence?: CollectionEvidence };
export type TimeInventory = { generatedAt: string; tables: Record<string, TimeCoverage> };
export function timeFingerprint(table: Dataset): string {
  return JSON.stringify(table.members.map(member => [member.sha256 ?? member.url, member.rows, member.byteSize]));
}
export function parseTimeInventory(raw: unknown): TimeInventory {
  if (!object(raw) || raw.format !== 'spicygov-time-coverage' || raw.version !== 1 || !object(raw.tables) || typeof raw.generatedAt !== 'string' || !Number.isFinite(Date.parse(raw.generatedAt))) throw new Error('Unsupported time inventory');
  const tables: Record<string, TimeCoverage> = {};
  for (const [id, value] of Object.entries(raw.tables)) {
    if (!object(value) || typeof value.fingerprint !== 'string' || !Number.isSafeInteger(value.rows) || value.rows < 0) continue;
    const collectionEvidence = parseCollectionEvidence(value.collectionEvidence, value.rows);
    const outcomes = object(value.collectionOutcomes) && Object.entries(value.collectionOutcomes).every(([key, n]) => key.length > 0 && key.length <= 100 && Number.isSafeInteger(n) && Number(n) > 0) && Object.values(value.collectionOutcomes).reduce((sum: number, n) => sum + Number(n), 0) === value.rows ? value.collectionOutcomes as Record<string, number> : undefined;
    if (value.status === 'unmeasured') { tables[id] = { fingerprint: value.fingerprint, publicationSha256: typeof value.publicationSha256 === 'string' ? value.publicationSha256 : undefined, rows: value.rows, status: 'unmeasured', collectionEvidence, collectionOutcomes: outcomes, reason: typeof value.reason === 'string' ? value.reason : undefined }; continue; }
    if (value.status !== 'measured' || !['month', 'year', 'season'].includes(value.granularity) || typeof value.field !== 'string' || !object(value.buckets) || !Number.isSafeInteger(value.undatedRows) || value.undatedRows < 0) continue;
    const pattern = value.granularity === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/ : value.granularity === 'season' ? /^\d{4}-(spring|fall)$/ : /^\d{4}$/;
    if (!Object.entries(value.buckets).every(([key, n]) => key.slice(0, 4) !== '0000' && pattern.test(key) && Number.isSafeInteger(n) && Number(n) > 0)) continue;
    if (Object.values(value.buckets).reduce((sum: number, n) => sum + Number(n), value.undatedRows) !== value.rows) continue;
    tables[id] = { ...value, collectionEvidence, collectionOutcomes: outcomes } as TimeCoverage;
  }
  return { generatedAt: raw.generatedAt, tables };
}
export function currentTimeCoverage(table: Dataset, inventory?: TimeInventory): TimeCoverage | undefined {
  const coverage = inventory?.tables[table.id];
  return coverage?.fingerprint === timeFingerprint(table) && coverage.rows === table.rows && coverage.publicationSha256 === table.publication?.sha256 ? coverage : undefined;
}
export function periodRows(coverage: TimeCoverage | undefined, period: string): number | undefined {
  if (coverage?.status !== 'measured') return undefined;
  if (period.length === 7 && coverage.granularity !== 'month') return undefined;
  if (/^\d{4}-(spring|fall)$/.test(period) && coverage.granularity !== 'season') return undefined;
  return Object.entries(coverage.buckets ?? {}).reduce((n, [key, rows]) => n + (key === period || key.startsWith(period + '-') ? rows : 0), 0);
}
export function periodState(coverages: (TimeCoverage | undefined)[], period: string) {
  const counts = coverages.map(coverage => periodRows(coverage, period));
  const present = counts.filter(n => n !== undefined && n > 0).length;
  const measured = counts.filter(n => n !== undefined).length;
  return { state: present ? 'present' : measured === counts.length && measured > 0 ? 'empty' : 'unknown', present, measured, total: counts.length };
}
