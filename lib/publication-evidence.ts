export const DATA_BASE = 'https://data.spicygov.ai';
export type EvidenceLink = { label: string; url: string };
export type NativeReceipts = { url: string; generationId: string; rows: number; bytes: number; sha256: string; keyIndex?: {url: string; bytes: number; sha256: string} };
export type PublicationEvidence = {
  kind: 'generation' | 'rulemaking' | 'comments';
  recordUrl: string;
  nativeReceipts?: NativeReceipts;
  snapshotId?: string;
  sha256?: string;
  etag?: string;
};
export const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const digest = (value: unknown): value is string => typeof value === 'string' && /^(sha256:)?[a-f0-9]{64}$/.test(value);
export const size = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function dataUrl(key: unknown): string | undefined {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_./=-]+$/.test(key) || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return `${DATA_BASE}/${key}`;
}
export function generationEvidence(prefix: unknown, raw: unknown, tableId: string): PublicationEvidence | undefined {
  const recordUrl = typeof prefix === 'string' && dataUrl(`${prefix}/artifact.json`);
  if (!recordUrl) return undefined;
  const evidence: PublicationEvidence = { kind: 'generation', recordUrl };
  if (object(raw) && Array.isArray(raw.datasets) && raw.datasets.includes(tableId) &&
      typeof raw.generationId === 'string' && raw.generationId && size(raw.rows) && size(raw.byteSize) && digest(raw.sha256)) {
    const url = dataUrl(`${prefix}/${raw.key}`);
    if (url) {
      evidence.nativeReceipts = { url, generationId: raw.generationId, rows: raw.rows, bytes: raw.byteSize, sha256: raw.sha256 };
      const index = raw.keyIndex;
      if (object(index) && index.format === 'spicy-receipt-keys/1' && index.rows === raw.rows && index.receiptSha256 === raw.sha256 && size(index.byteSize) && digest(index.sha256)) {
        const indexUrl = dataUrl(`${prefix}/${index.key}`);
        if (indexUrl) evidence.nativeReceipts.keyIndex = {url:indexUrl,bytes:index.byteSize,sha256:index.sha256};
      }
    }
  }
  return evidence;
}
export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store' });
  if (!response.ok) throw new Error(`Request failed (${response.status}).`);
  return response.json();
}
