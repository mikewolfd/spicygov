import type { Dataset, Member, Row } from './catalog';
import { currentCoverageMap, type CoverageDimension, type CoverageMaps } from './coverage-map';
import { digest, object } from './publication-evidence';

const maximumPublishers = 200, maximumBytes = 1024 * 1024;
export type CoveragePublishers = { source: Dataset; names: ReadonlyMap<string, string> };
type PublisherReaders = {
  fetchMember: (member: Member, signal?: AbortSignal) => Promise<ArrayBuffer>;
  decode: (buffer: ArrayBuffer, rows: number) => Promise<Row[]>;
};

export function publisherNames(rows: Row[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.publisher_id !== 'string' || !row.publisher_id) throw new Error('A publisher has no recorded identifier.');
    if (typeof row.name !== 'string' || !row.name.trim()) continue;
    const previous = names.get(row.publisher_id);
    if (previous !== undefined && previous !== row.name) throw new Error('A publisher identifier has conflicting names.');
    names.set(row.publisher_id, row.name);
  }
  return names;
}

async function fetchPublisherFile(member: Member, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(member.url, {signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), cache: 'no-store', headers: {Range: `bytes=0-${member.byteSize - 1}`}});
  if (!response.ok || !response.body) throw new Error('The saved publisher file could not be read.');
  const reader = response.body.getReader(), bytes = new Uint8Array(member.byteSize);
  let position = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (position + value.byteLength > member.byteSize) throw new Error('The publisher file exceeds its recorded size.');
      bytes.set(value, position); position += value.byteLength;
    }
  } finally { await reader.cancel(); }
  if (position !== member.byteSize) throw new Error('The publisher file size does not match its release.');
  return bytes.buffer;
}

async function decodePublisherFile(buffer: ArrayBuffer, rows: number): Promise<Row[]> {
  const [{parquetReadObjects}, {compressors}] = await Promise.all([import('hyparquet'), import('hyparquet-compressors')]);
  return parquetReadObjects({file: {byteLength: buffer.byteLength, slice: async (start, end) => buffer.slice(start, end)}, compressors, columns: ['publisher_id', 'name'], rowStart: 0, rowEnd: rows});
}

export async function loadCoveragePublishers(
  tables: Dataset[], maps?: CoverageMaps, signal?: AbortSignal,
  readers: PublisherReaders = {fetchMember: fetchPublisherFile, decode: decodePublisherFile},
): Promise<CoveragePublishers | undefined> {
  const source = tables.find(table => table.id === 'scorecard_publishers' && table.family === 'scorecards');
  if (!source || !digest(source.artifactDigest) || !currentCoverageMap(source, maps)
      || source.rows < 1 || source.rows > maximumPublishers || !source.members.length || source.members.length > maximumPublishers
      || source.members.some(member => !digest(member.sha256) || !Number.isSafeInteger(member.byteSize) || member.byteSize < 1 || !Number.isSafeInteger(member.rows) || member.rows < 0)
      || source.members.reduce((sum, member) => sum + member.byteSize, 0) > maximumBytes
      || source.members.reduce((sum, member) => sum + member.rows, 0) !== source.rows
      || !['publisher_id', 'name'].every(field => source.columns.some(column => column.name === field && column.type === 'VARCHAR'))) return undefined;
  const rows: Row[] = [];
  for (const member of source.members) {
    signal?.throwIfAborted();
    const buffer = await readers.fetchMember(member, signal);
    signal?.throwIfAborted();
    if (buffer.byteLength !== member.byteSize) throw new Error('The publisher file size does not match its release.');
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (sha256 !== member.sha256!.replace(/^sha256:/, '')) throw new Error('The publisher file checksum does not match its release.');
    const decoded = await readers.decode(buffer, member.rows);
    if (decoded.length !== member.rows) throw new Error('The saved publisher list could not be read in full.');
    rows.push(...decoded);
  }
  signal?.throwIfAborted();
  return {source, names: publisherNames(rows)};
}

export function coveragePublisherNames(table: Dataset, maps: CoverageMaps | undefined, dimension: CoverageDimension, publishers?: CoveragePublishers): ReadonlyMap<string, string> | undefined {
  const map = currentCoverageMap(table, maps);
  if (!publishers || !map?.dimensions.includes(dimension) || !dimension.fields?.includes('publisher_id')
      || !currentCoverageMap(publishers.source, maps)) return undefined;
  const held = publishers.source.artifactDigest;
  if (dimension.parent !== undefined) {
    const parents = (Array.isArray(dimension.parent) ? dimension.parent : [dimension.parent]).filter(object);
    if (!parents.length || parents.some(parent => parent.family !== 'scorecards' || parent.artifactDigest !== held)) return undefined;
    return publishers.names;
  }
  return map.family === 'scorecards' && map.artifactDigest === held ? publishers.names : undefined;
}
