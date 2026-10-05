import { groupFor, pretty, type Dataset } from './catalog';
import { validDate, type Source, type MetadataStatus, type TableMetadataState } from './metadata';
import { sourceFor } from './sources';
import { DATA_BASE, dataUrl, digest, fetchJson, object, size, type EvidenceLink } from './publication-evidence';

export const methodLabels: Record<string, string> = {
  bulk_download: 'Bulk downloads', structured_download: 'Data files', feed_download: 'RSS feeds',
  api: 'Data service (API)', web_scraping: 'Web pages', document_extraction: 'Document text',
  retained_input: 'Saved source files', legacy_carry_forward: 'Earlier records',
  derived: 'Calculated', model_generated: 'AI-generated', unknown: 'Not documented',
};
export type SourceCopy = { label: string; summary: string; scope: string; gaps: string[] };
export type TableReview = {
  family: string; label: string; methods: string[]; summary: string; mixing: string;
  gaps: string[]; scope?: string; evidence: EvidenceLink[]; sources: Source[];
  attributionRevision?: string; artifactDigest?: string; generationLinks: EvidenceLink[];
  copy?: SourceCopy;
};
export type SourceReview = { reviewedAt: string; sourceRevision: string; tables: Record<string, TableReview> };
export type SourceEntry = { table: Dataset; review?: TableReview; explorer: boolean; source: Source; historicalAttribution: boolean };
const strings = (raw: unknown): string[] => Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
function links(raw: unknown): EvidenceLink[] {
  return Array.isArray(raw) ? raw.filter(object).flatMap(value => {
    if (typeof value.label !== 'string' || typeof value.url !== 'string') return [];
    try { const url = new URL(value.url); return url.protocol === 'https:' ? [{ label: value.label, url: url.href }] : []; } catch { return []; }
  }) : [];
}
export function parseSourceReview(raw: unknown): SourceReview {
  if (!object(raw) || raw.format !== 'spicygov-source-review' || raw.version !== 1 || !validDate(raw.reviewedAt) || !/^[a-f0-9]{40}$/.test(raw.sourceRevision) || !object(raw.tables)) throw new Error('Acquisition review has an unsupported format.');
  const tables: Record<string, TableReview> = {};
  for (const [id, item] of Object.entries(raw.tables)) {
    if (!object(item) || typeof item.family !== 'string' || typeof item.label !== 'string' || typeof item.summary !== 'string' || typeof item.mixing !== 'string') continue;
    const sources = Array.isArray(item.sources) ? item.sources.filter(object).flatMap(s => {
      if (typeof s.id !== 'string' || typeof s.name !== 'string') return [];
      const url = links([{ label: s.name, url: s.url }])[0]?.url;
      return [{ id: s.id, name: s.name, url, kind: typeof s.kind === 'string' ? s.kind : 'unknown', note: typeof s.note === 'string' ? s.note : '' }];
    }) : [];
    tables[id] = { family: item.family, label: item.label, summary: item.summary, mixing: item.mixing,
      methods: strings(item.methods), gaps: strings(item.gaps), scope: typeof item.scope === 'string' ? item.scope : undefined,
      copy: object(item.copy) && ['label', 'summary', 'scope'].every(key => typeof item.copy[key] === 'string' && item.copy[key].trim()) && Array.isArray(item.copy.gaps) && item.copy.gaps.every((gap: unknown) => typeof gap === 'string')
        ? { label: item.copy.label, summary: item.copy.summary, scope: item.copy.scope, gaps: item.copy.gaps } : undefined,
      evidence: links(item.evidence), sources, attributionRevision: typeof item.attributionRevision === 'string' ? item.attributionRevision : undefined,
      artifactDigest: digest(item.artifactDigest) ? item.artifactDigest : undefined,
      generationLinks: links(item.generationLinks).filter(link => link.url.startsWith(`${DATA_BASE}/source-evidence/`)),
    };
  }
  return { reviewedAt: raw.reviewedAt, sourceRevision: raw.sourceRevision, tables };
}
function extraTable(id: string, family: string, rows: number, bytes: number, url: string): Dataset {
  return { id, family, label: pretty(id), rows, bytes, columns: [], members: [{ url, rows, byteSize: bytes }],
    group: groupFor(id), summary: '', coverage: '', kind: 'published', metadataState: 'missing', sources: [], inputs: [], modelGenerated: false, connectionNotes: [] };
}
export function parseRulemaking(pointer: unknown, manifest: unknown): Dataset[] {
  if (!object(pointer) || pointer.format_version !== 2 || pointer.dataset !== 'rulemaking' || !/^snapshot_[a-zA-Z0-9]+$/.test(pointer.snapshot_id)) throw new Error('Rulemaking pointer has an unsupported format.');
  const prefix = `materialized/rulemaking/snapshots/${pointer.snapshot_id}`;
  if (pointer.manifest_key !== `${prefix}/manifest.json` || !object(manifest) || manifest.format_version !== 2 || manifest.dataset !== 'rulemaking' || manifest.snapshot_id !== pointer.snapshot_id || !object(manifest.artifacts)) throw new Error('Rulemaking snapshot does not match its publication pointer.');
  return Object.entries(manifest.artifacts).flatMap(([key, file]) => {
    if (!object(file) || file.visibility !== 'public') return [];
    if (!/^[a-z0-9_]+\.parquet$/.test(key) || file.remote_key !== `${prefix}/${key}` || !size(file.rows) || !size(file.bytes) || !digest(file.sha256)) throw new Error('Rulemaking contains an invalid public file.');
    return [{ ...extraTable(key.replace(/\.parquet$/, ''), 'rulemaking', file.rows, file.bytes, dataUrl(file.remote_key)!),
      published: validDate(manifest.asserted_at), publication: { kind: 'rulemaking' as const, recordUrl: dataUrl(pointer.manifest_key)!, snapshotId: pointer.snapshot_id, sha256: file.sha256 } }];
  });
}
export function parseComments(raw: unknown): Dataset[] {
  if (!object(raw) || raw.format_version !== 1 || !object(raw.files) || !object(raw.source)) throw new Error('Comments export receipt has an unsupported format.');
  // Agency partitions repeat the same records; list the two logical tables once.
  return ['comments.parquet', 'comments_index.parquet'].flatMap(key => {
    const file = raw.files[key];
    if (file === undefined) return [];
    if (!object(file) || !size(file.rows) || !size(file.bytes) || !digest(file.sha256) || typeof file.etag !== 'string') throw new Error('Comments receipt contains an invalid public file.');
    return [{ ...extraTable(key.replace(/\.parquet$/, ''), 'comments', file.rows, file.bytes, dataUrl(key)!),
      publication: { kind: 'comments' as const, recordUrl: `${DATA_BASE}/comments-publication.json`, sha256: file.sha256, etag: file.etag } }];
  });
}
export async function loadOtherPublications(signal?: AbortSignal): Promise<{ tables: Dataset[]; warnings: string[] }> {
  const results = await Promise.allSettled([
    (async () => {
      const pointer = await fetchJson(`${DATA_BASE}/materialized/rulemaking/latest.json`, signal);
      if (!object(pointer) || !/^snapshot_[a-zA-Z0-9]+$/.test(pointer.snapshot_id) || pointer.manifest_key !== `materialized/rulemaking/snapshots/${pointer.snapshot_id}/manifest.json`) throw new Error('Invalid rulemaking pointer.');
      return parseRulemaking(pointer, await fetchJson(dataUrl(pointer.manifest_key)!, signal));
    })(),
    fetchJson(`${DATA_BASE}/comments-publication.json`, signal).then(parseComments),
  ]);
  if (signal?.aborted) throw signal.reason;
  return { tables: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    warnings: results.flatMap((result, i) => result.status === 'rejected' ? [`${i === 0 ? 'Rulemaking' : 'Comments'} files could not be checked. Some tables may be missing here.`] : []) };
}
export function sourceEntries(tables: Dataset[], extra: Dataset[], review?: SourceReview): SourceEntry[] {
  // A table that migrates into the main index must not be counted twice.
  const current = new Map(tables.map(table => [table.id, { table, explorer: true }]));
  for (const table of extra) if (!current.has(table.id)) current.set(table.id, { table, explorer: false });
  return [...current.values()].map(({ table, explorer }) => {
    const candidate = review?.tables[table.id];
    const audit = candidate?.family === table.family ? candidate : undefined;
    const historicalAttribution = !table.sources.length && !table.inputs.length && !!audit?.sources.length;
    let source = sourceFor(historicalAttribution ? { ...table, sources: audit!.sources } : table);
    if (!explorer && source.id === 'unlisted') source = table.publication?.kind === 'rulemaking'
      ? { id: 'rulemaking-publication', name: 'Rulemaking data', kind: 'derived', note: 'Calculated from regulatory records.' }
      : { id: 'comments-publication', name: 'Public comments', kind: 'publication', note: 'Comments and comment counts.' };
    return { table: { ...table, label: audit?.copy?.label ?? (table.label === pretty(table.id) && audit ? audit.label : table.label) }, review: audit, explorer, source, historicalAttribution };
  }).sort((a, b) => a.table.label.localeCompare(b.table.label));
}
export function reviewedGenerationLinks(entry: SourceEntry): EvidenceLink[] {
  return entry.table.artifactDigest && entry.table.artifactDigest === entry.review?.artifactDigest ? entry.review.generationLinks : [];
}
export function evidenceLinkLabel(label: string): string {
  return ({ 'Generation record': 'Publication details', 'Source evidence record': 'Source log details', 'Source observation journal': 'Source log' } as Record<string, string>)[label] ?? label;
}
export function sourceMetadataMessage(state: TableMetadataState): string | undefined {
  return ({ loading: 'Loading source details…', missing: 'Current source details are not available.', incompatible: 'This table has changed since its source details were written.',
    'older-publication': 'Source details describe an earlier release.', undocumented: 'Some source details are missing.', unavailable: 'Source details could not be loaded.' } as Partial<Record<TableMetadataState, string>>)[state];
}
export function sourceCatalogMessage(status: MetadataStatus): string | undefined {
  if (status.state === 'loading') return 'Loading source details…';
  if (status.state === 'unavailable') return 'Source details could not be loaded. Published tables are still listed.';
  if (status.state === 'partial') return 'Some source details are missing or older. See each table’s notes.';
}
export function filterEntries(entries: SourceEntry[], query: string, method: string, evidence: string): SourceEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter(entry => {
    const { table, review, source } = entry;
    if (q && ![table.id, table.label, table.summary, source.name, ...table.inputs, ...(review?.sources.map(s => s.name) ?? []), review?.summary, review?.copy?.summary, review?.copy?.scope, ...(review?.copy?.gaps ?? []), ...(review?.methods.map(m => methodLabels[m] ?? m) ?? [])].join(' ').toLowerCase().includes(q)) return false;
    if (method && !review?.methods.includes(method)) return false;
    if (evidence === 'native' && !table.publication?.nativeReceipts || evidence === 'journal' && !reviewedGenerationLinks(entry).length || evidence === 'empty' && table.rows !== 0 || evidence === 'separate' && entry.explorer || evidence === 'unreviewed' && review) return false;
    return true;
  });
}
export type GenerationDetails = { links: EvidenceLink[]; parents: { table: string; url?: string; digest?: string }[]; carriedForward?: string; identityFields: string[] };
export function parseGenerationDetails(raw: unknown, table: Dataset): GenerationDetails {
  if (!object(raw) || raw.kind !== 'spicy-regs-rollup-generation' || raw.artifactDigest !== table.artifactDigest || !object(raw.spec) || raw.spec.family !== table.family) throw new Error('The generation record does not match this publication.');
  const evidence = Array.isArray(raw.inputs) ? raw.inputs.filter(object).filter(input => input.role === 'source-evidence' && digest(input.artifactDigest)) : [];
  const result: GenerationDetails = { links: evidence.flatMap(input => {
    const prefix = `${DATA_BASE}/source-evidence/${input.artifactDigest.replace(/^sha256:/, '')}`;
    return [{ label: 'Source evidence record', url: `${prefix}/artifact.json` }, { label: 'Source observation journal', url: `${prefix}/journal.jsonl` }];
  }), parents: [], identityFields: [] };
  if (object(raw.spec.parents)) for (const [file, pin] of Object.entries(raw.spec.parents)) {
    if (!object(pin)) continue;
    result.parents.push({ table: file.replace(/\.parquet$/, ''), digest: digest(pin.sha256) ? pin.sha256 : undefined,
      url: digest(pin.artifactDigest) && typeof pin.family === 'string' ? dataUrl(`generations/${pin.family}/${pin.artifactDigest.replace(/^sha256:/, '')}/artifact.json`) : undefined });
  }
  const carried = raw.spec.carriedForward?.[`${table.id}.parquet`];
  if (digest(carried)) result.carriedForward = carried;
  if (Array.isArray(raw.spec.etlReceipts?.policies)) {
    const policy = raw.spec.etlReceipts.policies.find((policy: unknown) => object(policy) && policy.dataset === table.id);
    result.identityFields = strings(policy?.identity_fields);
  }
  return result;
}
