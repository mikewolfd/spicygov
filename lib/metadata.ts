/** Published manifests own file membership. Separate-file schemas require metadata bound to their exact publication identity. */
export type Source = { id: string; name: string; url?: string; kind: string; note: string };
export type Join = {
  child: string;
  child_columns: string[];
  parent: string;
  parent_columns: string[];
  kind: string;
  reason: string;
};
export type TableMetadataState = 'loading' | 'current' | 'older-publication' | 'missing' | 'incompatible' | 'unavailable' | 'undocumented';
export type MetadataStatus = {
  state: 'loading' | 'current' | 'partial' | 'unavailable';
  generatedAt?: string;
  missingTables: number;
  staleTables: number;
  undocumentedTables: number;
  rejectedJoins: number;
  omittedJoins: number;
};
export const loadingMetadata: MetadataStatus = { state: 'loading', missingTables: 0, staleTables: 0, undocumentedTables: 0, rejectedJoins: 0, omittedJoins: 0 };
export type TableMetadata = {
  label?: string;
  summary?: string;
  coverage?: string;
  kind?: string;
  data_quality?: string;
  columns?: { column_name: string; description: string }[];
  family: string;
  publicationSchema: [string, string][];
  publicationIdentity?: string;
  sources: Source[];
  inputs: string[];
  transformation?: string;
  modelGenerated: boolean;
  emptyReason?: string;
  metadataStatus: 'documented' | 'unknown';
  sourceStatus: 'documented' | 'unknown';
  joinAudit?: { status: string; reason: string };
};
export type PublicationDescriptor = {
  kind: 'rulemaking' | 'comments'; family: string;
  members: { path: string; sha256: string; byteSize: number; rows: number; etag?: string }[];
  snapshotId?: string;
};
export type ExtraTableMetadata = { family: string; publicationSchema: [string, string][]; publicationIdentity: string; descriptor: PublicationDescriptor };
export type MetadataBundle = {
  format: 'spicy-regs-explorer-metadata';
  version: 1;
  generatedAt: string;
  sourceRevision?: string;
  publication: { sha256?: string; families: Record<string, string> };
  tables: Record<string, TableMetadata>;
  joins: Join[];
  omittedJoins: { child: string; parent: string; reason: string }[];
  extra_tables: Record<string, ExtraTableMetadata>;
};
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
export function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  // Date.parse silently rolls February 30 into March; reject invalid calendar dates.
  if (new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.slice(0, 10)) return undefined;
  return value;
}
export function publicationDate(value: unknown): string {
  const date = validDate(value);
  return date ? new Date(date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : 'Publication date unavailable';
}
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function parseTable(value: unknown): TableMetadata | undefined {
  if (!isObject(value) || typeof value.family !== 'string' || !Array.isArray(value.publicationSchema) || !value.publicationSchema.every(c => Array.isArray(c) && c.length === 2 && c.every(v => typeof v === 'string'))) return undefined;
  const sources = Array.isArray(value.sources) ? value.sources.filter(isObject).filter(s => typeof s.id === 'string' && typeof s.name === 'string').map(s => ({ id: s.id as string, name: s.name as string, url: safeUrl(s.url), kind: text(s.kind) ?? 'unknown', note: text(s.note) ?? '' })) : [];
  const columns = Array.isArray(value.columns) ? value.columns.filter(isObject).filter(c => typeof c.column_name === 'string' && typeof c.description === 'string').map(c => ({ column_name: c.column_name as string, description: c.description as string })) : [];
  return {
    family: value.family, publicationSchema: value.publicationSchema as [string, string][],
    publicationIdentity: text(value.publicationIdentity),
    label: text(value.label), summary: text(value.summary), coverage: text(value.coverage), kind: text(value.kind), data_quality: text(value.data_quality), columns,
    sources, inputs: Array.isArray(value.inputs) ? value.inputs.filter((input): input is string => typeof input === 'string') : [],
    transformation: text(value.transformation), modelGenerated: value.modelGenerated === true, emptyReason: text(value.emptyReason),
    metadataStatus: value.metadataStatus === 'documented' ? 'documented' : 'unknown',
    sourceStatus: value.sourceStatus === 'documented' ? 'documented' : 'unknown',
    joinAudit: isObject(value.joinAudit) && typeof value.joinAudit.status === 'string' && typeof value.joinAudit.reason === 'string' ? { status: value.joinAudit.status, reason: value.joinAudit.reason } : undefined,
  };
}
function parseExtra(value: unknown): ExtraTableMetadata | undefined {
  if (!isObject(value) || typeof value.family !== 'string' || typeof value.publicationIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.publicationIdentity)
      || !Array.isArray(value.publicationSchema) || !value.publicationSchema.length || !value.publicationSchema.every(column => Array.isArray(column) && column.length === 2 && column.every(item => typeof item === 'string' && item.length > 0))
      || new Set(value.publicationSchema.map(column => column[0])).size !== value.publicationSchema.length || !isObject(value.descriptor)) return undefined;
  const descriptor = value.descriptor;
  if (!['rulemaking', 'comments'].includes(String(descriptor.kind)) || descriptor.family !== value.family || !Array.isArray(descriptor.members) || !descriptor.members.length
      || !descriptor.members.every(member => isObject(member) && typeof member.path === 'string' && /^[a-zA-Z0-9_./=-]+$/.test(member.path) && !member.path.startsWith('/') && !member.path.split('/').some(part => !part || part === '.' || part === '..')
        && typeof member.sha256 === 'string' && /^sha256:[a-f0-9]{64}$/.test(member.sha256) && Number.isSafeInteger(member.rows) && Number(member.rows) >= 0 && Number.isSafeInteger(member.byteSize) && Number(member.byteSize) >= 0
        && (member.etag === undefined || typeof member.etag === 'string' && member.etag.length > 0))
      || descriptor.snapshotId !== undefined && typeof descriptor.snapshotId !== 'string') return undefined;
  return {family: value.family, publicationSchema: value.publicationSchema as [string, string][], publicationIdentity: value.publicationIdentity, descriptor: descriptor as PublicationDescriptor};
}
export function parseMetadata(value: unknown): MetadataBundle {
  if (!isObject(value) || value.format !== 'spicy-regs-explorer-metadata' || value.version !== 1 || !validDate(value.generatedAt) || !isObject(value.tables) || !Array.isArray(value.joins) || !isObject(value.publication) || !isObject(value.publication.families)) throw new Error('Metadata has an unsupported format.');
  return {
    format: 'spicy-regs-explorer-metadata', version: 1, generatedAt: value.generatedAt as string,
    sourceRevision: text(value.sourceRevision),
    publication: { sha256: text(value.publication.sha256), families: Object.fromEntries(Object.entries(value.publication.families).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) },
    tables: Object.fromEntries(Object.entries(value.tables).flatMap(([id, raw]) => { const parsed = parseTable(raw); return parsed ? [[id, parsed]] : []; })),
    // Join endpoints and complete composite keys are checked against current table schemas when applied.
    joins: value.joins as Join[],
    omittedJoins: Array.isArray(value.omittedJoins) ? value.omittedJoins.filter(isObject)
      .filter(join => typeof join.child === 'string' && typeof join.parent === 'string' && typeof join.reason === 'string')
      .map(join => ({ child: join.child as string, parent: join.parent as string, reason: join.reason as string })) : [],
    extra_tables: isObject(value.extra_tables) ? Object.fromEntries(Object.entries(value.extra_tables).flatMap(([id, raw]) => {const parsed = parseExtra(raw); return parsed ? [[id, parsed]] : [];})) : {},
  };
}
export function tableMetadataMessage(state: TableMetadataState): string | undefined {
  switch (state) {
    case 'loading': return 'Loading descriptions and connections…';
    case 'missing': return 'This new table is waiting for descriptions and connections.';
    case 'incompatible': return 'This table changed. Descriptions and connections are paused until metadata catches up.';
    case 'older-publication': return 'Descriptions and connections match the fields, but describe an earlier publication.';
    case 'undocumented': return 'This table’s source and coverage are not yet fully documented.';
    case 'unavailable': return 'Descriptions and connections are unavailable. Records remain available.';
    default: return undefined;
  }
}
export function metadataMessage(status: MetadataStatus): string | undefined {
  if (status.state === 'loading') return 'Loading source descriptions…';
  if (status.state === 'unavailable') return 'Source descriptions are unavailable. All published tables remain browsable.';
  if (status.state === 'partial') return 'Some descriptions or connections are unavailable or describe an earlier publication. Check the table notes for details.';
  return undefined;
}
