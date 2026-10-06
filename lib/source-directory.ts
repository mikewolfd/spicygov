import { sourceControlLabel, sourceGroupLabel } from './source-labels';
import { groupFor, pretty, type Dataset, type CoverageInput } from './catalog';
import { validDate, type Source, type MetadataStatus, type TableMetadataState } from './metadata';
import { sourceFor } from './sources';
import { DATA_BASE, dataUrl, digest, fetchJson, object, size, type EvidenceLink } from './publication-evidence';
import { canonicalJson } from './separate-publications';

export const methodLabels: Record<string, string> = {
  bulk_download: 'Bulk downloads', structured_download: 'Structured file downloads', feed_download: sourceControlLabel('RSS feeds'),
  api: sourceControlLabel('API'), web_scraping: 'Web scraping', document_extraction: 'Text extracted from documents',
  retained_input: 'Saved source files', legacy_carry_forward: sourceControlLabel('Earlier records'),
  derived: sourceControlLabel('Calculated'), model_generated: 'AI-generated', unknown: 'Not documented',
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
    group: groupFor(id), summary: '', coverage: '', kind: 'published', recordsAvailable: false, metadataState: 'missing', sources: [], inputs: [], modelGenerated: false, connectionNotes: [] };
}
export async function rulemakingManifestDigest(manifest: unknown): Promise<string> {
  const text = canonicalJson(manifest).replace(/[^\x00-\x7f]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function parseRulemaking(pointer: unknown, manifest: unknown, manifestDefinitionDigest?: string): Dataset[] {
  if (!object(pointer) || pointer.format_version !== 2 || pointer.dataset !== 'rulemaking' || !/^snapshot_[a-zA-Z0-9]+$/.test(pointer.snapshot_id)) throw new Error('Rulemaking pointer has an unsupported format.');
  const prefix = `materialized/rulemaking/snapshots/${pointer.snapshot_id}`;
  if (pointer.manifest_key !== `${prefix}/manifest.json` || !object(manifest) || manifest.format_version !== 2 || manifest.dataset !== 'rulemaking' || manifest.snapshot_id !== pointer.snapshot_id || !object(manifest.artifacts)) throw new Error('Rulemaking snapshot does not match its publication pointer.');
  const native = manifest.etlReceipts;
  const receipt = object(native) ? manifest.artifacts[native.key] : undefined;
  if (native !== undefined && (!object(native) || native.key !== 'etl_receipts.parquet'
      || typeof native.generationId !== 'string' || !native.generationId || native.generationId !== manifest.run_id
      || !Array.isArray(native.policies) || !native.policies.length || !object(receipt) || receipt.visibility !== 'internal'
      || receipt.remote_key !== `${prefix}/etl_receipts.parquet` || !size(receipt.rows) || !size(receipt.bytes) || !digest(receipt.sha256)
      || typeof manifestDefinitionDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifestDefinitionDigest))) throw new Error('Rulemaking contains invalid selected receipts.');
  const selectedMember = (key: string, file: Record<string, any>) => ({key, rows:file.rows as number, byteSize:file.bytes as number, sha256:`sha256:${String(file.sha256).replace(/^sha256:/, '')}`});
  return Object.entries(manifest.artifacts).flatMap(([key, file]) => {
    if (!object(file) || file.visibility !== 'public') return [];
    if (!/^[a-z0-9_]+\.parquet$/.test(key) || file.remote_key !== `${prefix}/${key}` || !size(file.rows) || !size(file.bytes) || !digest(file.sha256)) throw new Error('Rulemaking contains an invalid public file.');
    return [{ ...extraTable(key.replace(/\.parquet$/, ''), 'rulemaking', file.rows, file.bytes, dataUrl(file.remote_key)!),
      ...(native ? {rulemakingSnapshot:{pointer:{...pointer},manifestDefinitionDigest:manifestDefinitionDigest!,generationId:native.generationId,
        subjects:[selectedMember(key,file)],receipts:selectedMember(native.key,receipt)},} : {}),
      published: validDate(manifest.asserted_at), publication: { kind: 'rulemaking' as const, recordUrl: dataUrl(pointer.manifest_key)!, snapshotId: pointer.snapshot_id, sha256: file.sha256,
        ...(native ? {nativeReceipts:{url:dataUrl(receipt.remote_key)!,generationId:native.generationId,rows:receipt.rows,bytes:receipt.bytes,sha256:receipt.sha256}} : {}) } }];
  });
}
export function parseComments(raw: unknown): Dataset[] {
  if (!object(raw) || raw.format_version !== 1 || !object(raw.files) || !object(raw.source)) throw new Error('Comments export receipt has an unsupported format.');
  // Agency partitions repeat the same records; list the two logical tables once.
  const coverageInputs: CoverageInput[] = ['comments.parquet', 'comments_index.parquet'].flatMap(key => {
    const file = raw.files[key];
    if (file === undefined) return [];
    if (!object(file) || !size(file.rows) || !size(file.bytes) || !digest(file.sha256) || typeof file.etag !== 'string') throw new Error('Comments receipt contains an invalid public file.');
    return [{ id: key.replace(/\.parquet$/, ''), url: dataUrl(key)!, rows: file.rows, byteSize: file.bytes, sha256: file.sha256, etag: file.etag }];
  }).sort((a, b) => a.id.localeCompare(b.id));
  return coverageInputs.map(file => ({ ...extraTable(file.id, 'comments', file.rows, file.byteSize, file.url), coverageInputs,
    members: [{url: file.url, rows: file.rows, byteSize: file.byteSize, etag: file.etag}],
    publication: { kind: 'comments' as const, recordUrl: `${DATA_BASE}/comments-publication.json`, sha256: file.sha256, etag: file.etag } }));
}
export async function loadOtherPublications(signal?: AbortSignal): Promise<{ tables: Dataset[]; warnings: string[] }> {
  const results = await Promise.allSettled([
    (async () => {
      const pointer = await fetchJson(`${DATA_BASE}/materialized/rulemaking/latest.json`, signal);
      if (!object(pointer) || !/^snapshot_[a-zA-Z0-9]+$/.test(pointer.snapshot_id) || pointer.manifest_key !== `materialized/rulemaking/snapshots/${pointer.snapshot_id}/manifest.json`) throw new Error('Invalid rulemaking pointer.');
      const manifest = await fetchJson(dataUrl(pointer.manifest_key)!, signal);
      return parseRulemaking(pointer, manifest, object(manifest) && manifest.etlReceipts !== undefined ? await rulemakingManifestDigest(manifest) : undefined);
    })(),
    fetchJson(`${DATA_BASE}/comments-publication.json`, signal).then(parseComments),
  ]);
  if (signal?.aborted) throw signal.reason;
  return { tables: results.flatMap(result => result.status === 'fulfilled' ? result.value : []),
    warnings: results.flatMap((result, i) => result.status === 'rejected' ? [`${i === 0 ? 'Rulemaking' : 'Comments'} files could not be checked. Some tables may be missing here.`] : []) };
}
export function sourceEntries(tables: Dataset[], extra: Dataset[], review?: SourceReview): SourceEntry[] {
  // A table that migrates into the main index must not be counted twice.
  const current = new Map(tables.map(table => [table.id, { table, explorer: table.recordsAvailable !== false }]));
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
function sourceFamilyName(family: string): string {
  return sourceGroupLabel(family) ?? pretty(family.replaceAll('-', '_')).replace(/\b(crs|fcc|fec|gao|cfr|sam|pdf|fr)\b/gi, word => word.toUpperCase()).replace(/Usaspending/i, 'USAspending').replace(/Courtlistener/i, 'CourtListener');
}
function searchText(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}
export function filterEntries(entries: SourceEntry[], query: string, method: string, evidence: string): SourceEntry[] {
  const q = searchText(query);
  return entries.filter(entry => {
    const { table, review, source } = entry;
    if (q && !searchText([table.id, table.family, sourceFamilyName(table.family), table.label, table.summary, source.name, ...table.inputs, ...(review?.sources.map(s => s.name) ?? []), review?.summary, review?.copy?.summary, review?.copy?.scope, ...(review?.copy?.gaps ?? []), ...(review?.methods.map(m => methodLabels[m] ?? m) ?? [])].join(' ')).includes(q)) return false;
    if (method && !review?.methods.includes(method)) return false;
    if (evidence === 'native' && !table.publication?.nativeReceipts || evidence === 'journal' && !reviewedGenerationLinks(entry).length || evidence === 'empty' && table.rows !== 0 || evidence === 'separate' && entry.explorer || evidence === 'unreviewed' && review || evidence === 'source-details' && !sourceMetadataNeedsAttention(entry)) return false;
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

export function sourceMetadataNeedsAttention(entry: SourceEntry): boolean {
  return entry.explorer && !['current', 'loading'].includes(entry.table.metadataState);
}
export function sourceMetadataSummary(entries: SourceEntry[]): string | undefined {
  const affected = entries.filter(sourceMetadataNeedsAttention);
  if (!affected.length) return undefined;
  const reasons: [TableMetadataState, string, string][] = [
    ['incompatible', 'has changed fields', 'have changed fields'],
    ['older-publication', 'has a newer release', 'have newer releases'],
    ['missing', 'has no source descriptions', 'have no source descriptions'],
    ['undocumented', 'has incomplete source descriptions', 'have incomplete source descriptions'],
    ['unavailable', 'could not load source descriptions', 'could not load source descriptions'],
  ];
  const details = reasons.flatMap(([state, singular, plural]) => {
    const total = affected.filter(entry => entry.table.metadataState === state).length;
    return total ? [`${total} ${total === 1 ? singular : plural}`] : [];
  });
  return `Missing or older source details for ${affected.length} ${affected.length === 1 ? 'table' : 'tables'}: ${details.join('; ')}.`;
}
export function collectionSteps(methods: string[]): { label: string; values: string[] }[] {
  const categories = [
    { label: 'Collection', keys: ['bulk_download', 'structured_download', 'feed_download', 'api', 'web_scraping', 'unknown'] },
    { label: 'Reuses', keys: ['retained_input', 'legacy_carry_forward'] },
    { label: 'Processing', keys: ['document_extraction', 'derived', 'model_generated'] },
  ];
  return categories.flatMap(({label, keys}) => {
    const values = methods.filter(method => keys.includes(method)).map(method => methodLabels[method]);
    return values.length ? [{label, values}] : [];
  });
}
export type SourceSection = { topic: string; id: string; groups: { id: string; name: string; publishers: Source[]; historical: boolean; entries: SourceEntry[] }[] };
export function sourceSections(entries: SourceEntry[]): SourceSection[] {
  const topics = ['Congress', 'Regulation', 'Elections', 'Law & courts'];
  const sections = new Map<string, SourceSection>();
  for (const entry of entries) {
    const topic = entry.table.group || groupFor(entry.table.id);
    const section = sections.get(topic) ?? { topic, id: `topic-${topic.toLowerCase().replace(/[^a-z]+/g, '-')}`, groups: [] };
    const id = `${section.id}-${entry.table.family}`;
    let group = section.groups.find(group => group.id === id);
    if (!group) {
      group = { id, name: sourceFamilyName(entry.table.family), publishers: [], historical: false, entries: [] };
      section.groups.push(group);
    }
    group.entries.push(entry);
    group.historical ||= entry.historicalAttribution;
    const publishers = entry.table.sources.length ? entry.table.sources : entry.historicalAttribution ? entry.review?.sources ?? [] : [];
    for (const publisher of publishers) if (!group.publishers.some(source => source.id === publisher.id && source.name === publisher.name)) group.publishers.push(publisher);
    sections.set(topic, section);
  }
  return [...sections.values()].sort((a,b) => topics.indexOf(a.topic) - topics.indexOf(b.topic)).map(section => ({...section, groups: section.groups.sort((a,b) => a.name.localeCompare(b.name))}));
}
