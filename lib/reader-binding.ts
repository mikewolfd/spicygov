import type { Dataset } from './catalog';

/** File, schema, publication and compatibility inputs that every read depends on.
 *  Descriptions and declared identity arrive with metadata and must not restart an
 *  active read; identity-keyed caches add the identity themselves. */
export function subjectBinding(table: Dataset): string {
  return JSON.stringify(['record-reader/2', table.id, table.rows, table.recordsAvailable,
    table.artifactDigest, table.publicationIdentity, table.fecCompatibility?.sha256,
    table.columns.map(c => [c.name, c.type]), table.physicalColumns?.map(c => [c.name, c.type]),
    table.members]);
}

export function versionBound(table: Dataset): boolean {
  return table.members.every(m => !!m.etag?.replace(/^"|"$/g, '') && !m.etag.startsWith('W/'));
}

export function checkMemberCounts(table: Dataset): void {
  if (!Number.isSafeInteger(table.rows) || table.rows < 0 ||
      table.members.some(m => !Number.isSafeInteger(m.rows) || m.rows < 0) ||
      table.members.reduce((n, m) => n + m.rows, 0) !== table.rows)
    throw new Error('The selected member counts do not agree with this publication.');
}
