import type { Dataset } from './catalog';
import type { MetadataBundle, PublicationDescriptor } from './metadata';
import { DATA_BASE, digest } from './publication-evidence';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
export function publicationDescriptor(table: Dataset): PublicationDescriptor | undefined {
  const publication = table.publication;
  if (!publication || !['rulemaking', 'comments'].includes(publication.kind) || !digest(publication.sha256) || !table.members.length) return undefined;
  if (table.members.some(member => !member.url.startsWith(`${DATA_BASE}/`))) return undefined;
  return {kind: publication.kind as PublicationDescriptor['kind'], family: table.family,
    members: table.members.map(member => ({path: member.url.slice(DATA_BASE.length + 1), sha256: `sha256:${publication.sha256!.replace(/^sha256:/, '')}`, byteSize: member.byteSize, rows: member.rows,
      ...(member.etag ? {etag: member.etag} : {})})), ...(publication.snapshotId ? {snapshotId: publication.snapshotId} : {})};
}
export async function descriptorIdentity(descriptor: PublicationDescriptor): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(descriptor));
  return 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function extraMetadataMatches(table: Dataset, bundle: MetadataBundle): boolean {
  const descriptor = publicationDescriptor(table), extra = bundle.extra_tables[table.id], metadata = bundle.tables[table.id];
  return !!descriptor && !!extra && !!metadata && table.publicationIdentity === extra.publicationIdentity && metadata.publicationIdentity === extra.publicationIdentity
    && table.family === extra.family && metadata.family === extra.family && canonicalJson(descriptor) === canonicalJson(extra.descriptor)
    && JSON.stringify(metadata.publicationSchema) === JSON.stringify(extra.publicationSchema);
}
export async function bindExtraTables(tables: Dataset[], bundle: MetadataBundle | null): Promise<Dataset[]> {
  return Promise.all(tables.map(async table => {
    const descriptor = publicationDescriptor(table);
    const publicationIdentity = descriptor ? await descriptorIdentity(descriptor) : undefined;
    const bound = {...table, publicationIdentity, recordsAvailable: false};
    if (!bundle || !extraMetadataMatches(bound, bundle)) return bound;
    return {...bound, recordsAvailable: true, columns: bundle.extra_tables[table.id].publicationSchema.map(([name, type]) => ({name, type, description: ''}))};
  }));
}
