import { matchesConnection, navigationColumns, validConnection, type Connection, type Navigation } from './navigation';
import { matchesFilters, validFilter } from './filter-values';
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects, rowIndex } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { Dataset, Filter, Row } from "./catalog";
import { compareEntries, retainEntry, sortValue, type RecordSort, type SortEntry } from "./record-sort";
export type ReadRequest = {
  table: Dataset;
  columns: string[];
  filters: Filter[];
  cursor: number;
  limit?: number;
  maxScanRows?: number;
  sort?: RecordSort;
  connection?: Connection;
  navigation?: Navigation;
};
export type ReadResult = { rows: Row[]; positions: number[]; cursor: number; done: boolean };

async function remoteFile(member: Dataset['members'][number]) {
  const expectedEtag = member.etag?.replace(/^"|"$/g, '');
  const remote = await asyncBufferFromUrl({ url: member.url, byteLength: member.byteSize,
    ...(expectedEtag ? {requestInit: {headers: {'If-Match': `"${expectedEtag}"`}}, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      const received = response.headers.get('etag')?.replace(/^"|"$/g, '');
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const requested = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('range') ?? '');
      if (response.status !== 206 || received !== expectedEtag || !range || !requested || Number(range[3]) !== member.byteSize
          || Number(range[1]) !== Number(requested[1]) || Number(range[2]) !== (requested[2] ? Number(requested[2]) : member.byteSize - 1)) {
        await response.body?.cancel();
        throw new Error('This published file changed or its identity could not be checked. Reload the catalog before reading records.');
      }
      return response;
    }} : {}),
  });
  const cache = new Map<string, ArrayBuffer>();
  let cacheBytes = 0;
  return {
    byteLength: remote.byteLength,
    async slice(start: number, end?: number) {
      const key = `${start}:${end}`;
      if (cache.has(key)) return cache.get(key)!;
      const buffer = await remote.slice(start, end);
      if (buffer.byteLength <= 16 * 1024 * 1024) {
        while (cacheBytes + buffer.byteLength > 16 * 1024 * 1024 && cache.size) {
          const k = cache.keys().next().value!;
          cacheBytes -= cache.get(k)!.byteLength;
          cache.delete(k);
        }
        cache.set(key, buffer);
        cacheBytes += buffer.byteLength;
      }
      return buffer;
    },
  };
}

async function readSortedPage(request: ReadRequest & { sort: RecordSort; limit: number }, onProgress: (n: number) => void): Promise<ReadResult> {
  const { table, columns, filters, cursor, sort, limit, connection, navigation } = request;
  if (cursor > table.rows || !['asc', 'desc'].includes(sort.direction)) throw new Error('Invalid sort or record position.');
  if (limit > 1000) throw new Error('Sorted pages are limited to 1,000 records.');
  let boundary: SortEntry | undefined;
  if (cursor) {
    const page = await readPage({ table, columns: [sort.column], filters: [], cursor: cursor - 1, limit: 1 });
    if (page.positions[0] !== cursor - 1) throw new Error('The sorted page boundary is no longer available.');
    boundary = { value: sortValue(page.rows[0][sort.column]), position: cursor - 1 };
  }
  const heap: SortEntry[] = [];
  let offset = 0, remaining = 0;
  const scanColumns = [...new Set([sort.column, ...filters.map(f => f.column), ...(navigation ? navigationColumns(navigation) : [])])];
  for (const member of table.members) {
    if (!member.rows) continue;
    const file = await remoteFile(member);
    const metadata = await parquetMetadataAsync(file);
    for (let start = 0; start < member.rows; start += 50000) {
      const end = Math.min(member.rows, start + 50000);
      const rows = await parquetReadObjects({ file, metadata, compressors, columns: scanColumns, rowStart: start, rowEnd: end, includeRowIndex: true, useOffsetIndex: true, usePageIndex: true });
      for (const row of rows) {
        if (!matchesFilters(row, filters) || connection && navigation && !matchesConnection(row, navigation, connection)) continue;
        const entry = { value: sortValue(row[sort.column]), position: offset + row[rowIndex]! };
        if (boundary && compareEntries(entry, boundary, sort) <= 0) continue;
        remaining++;
        retainEntry(heap, entry, limit, sort);
      }
      onProgress(offset + end);
    }
    offset += member.rows;
  }
  heap.sort((a, b) => compareEntries(a, b, sort));
  // Read full visible fields only for the selected records, preserving their identities.
  const selected = [...heap].sort((a, b) => a.position - b.position);
  const records = new Map<number, Row>();
  offset = 0;
  for (const member of table.members) {
    const positions = selected.filter(entry => entry.position >= offset && entry.position < offset + member.rows).map(entry => entry.position - offset);
    if (positions.length) {
      const file = await remoteFile(member);
      const metadata = await parquetMetadataAsync(file);
      for (let i = 0; i < positions.length;) {
        const start = positions[i];
        let end = start + 1;
        while (++i < positions.length && positions[i] === end) end++;
        const rows = await parquetReadObjects({ file, metadata, compressors, columns, rowStart: start, rowEnd: end, includeRowIndex: true, useOffsetIndex: true, usePageIndex: true });
        for (const row of rows) records.set(offset + row[rowIndex]!, row);
      }
    }
    offset += member.rows;
  }
  if (records.size !== heap.length) throw new Error('Some sorted records could not be read. Retry this dataset.');
  return { rows: heap.map(entry => records.get(entry.position)!), positions: heap.map(entry => entry.position), cursor: heap.length ? heap.at(-1)!.position + 1 : cursor, done: remaining <= limit };
}
export async function readPage(
  { table, columns, filters, cursor, limit = 40, sort, connection, navigation, maxScanRows = connection ? 250000 : undefined }: ReadRequest,
  onProgress: (n: number) => void = () => {},
): Promise<ReadResult> {
  if (table.recordsAvailable === false) throw new Error('Records are paused until the physical fields match this data release. Reload the catalog to try again.');
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid record position.");
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid page size.');
  if (maxScanRows !== undefined && (!Number.isSafeInteger(maxScanRows) || maxScanRows < 1)) throw new Error('Invalid scan size.');
  if (
    columns.some((n) => !table.columns.some((c) => c.name === n)) ||
    filters.some((f) => !table.columns.some((c) => c.name === f.column)) ||
    (sort && !table.columns.some((c) => c.name === sort.column))
  )
    throw new Error("Unknown field in this dataset.");
  if (!filters.every(validFilter)) throw new Error('Invalid filter values.');
  if (connection && (!validConnection(connection) || !navigation || navigation.id !== connection.id || navigation.source !== table.id || !navigation.targets[connection.target] || navigation.targets[connection.target].columns.length !== connection.values.length)) throw new Error('This source connection is unavailable. Reload the catalog.');
  const connectionColumns = navigation ? navigationColumns(navigation) : [];
  if (connection && (navigation?.candidates && navigation.receiptFields.length || connectionColumns.some(c => !table.columns.some(x=>x.name===c)))) {
    const {readReceiptConnectionPage} = await import('./receipt-reader');
    if (sort || filters.length) throw new Error('Clear the sort and field filters before following a receipt connection.');
    return readReceiptConnectionPage({table,columns,cursor,limit,connection,navigation:navigation!},onProgress);
  }
  if (sort) return readSortedPage({ table, columns, filters, cursor, limit, sort, connection, navigation }, onProgress);
  let offset = 0,
    position = cursor;
  const scanEnd = Math.min(table.rows, maxScanRows === undefined ? table.rows : cursor + maxScanRows);
  const results: Row[] = [],
    positions: number[] = [];
  const canPrune =
    !connection && filters.length > 0 &&
    filters.every(
      (f) => table.columns.find((c) => c.name === f.column)?.type === "VARCHAR",
    );
  const filter = canPrune
    ? { $and: filters.map((f) => ({ [f.column]: f.values ? { $in: f.values } : { $eq: f.value } })) }
    : undefined;
  for (const member of table.members) {
    if (offset + member.rows <= position) {
      offset += member.rows;
      continue;
    }
    const file = await remoteFile(member);
    const metadata = await parquetMetadataAsync(file);
    let local = Math.max(0, position - offset);
    while (local < member.rows && position < scanEnd && results.length < limit) {
      const end = Math.min(
        member.rows,
        scanEnd - offset,
        local + (filters.length || connection ? 50000 : limit - results.length),
      );
      const rows = await parquetReadObjects({
        file,
        metadata,
        compressors,
        columns: [...new Set([...columns, ...filters.map((f) => f.column), ...connectionColumns])],
        rowStart: local,
        rowEnd: end,
        filter,
        includeRowIndex: true,
        useOffsetIndex: true,
        usePageIndex: true,
      });
      let last = end;
      for (const row of rows) {
        if (
          matchesFilters(row, filters) && (!connection || matchesConnection(row, navigation!, connection))
        ) {
          results.push(row);
          positions.push(offset + row[rowIndex]!);
          if (results.length === limit) {
            last = row[rowIndex]! + 1;
            break;
          }
        }
      }
      local = last;
      position = offset + local;
      onProgress(position);
    }
    if (results.length === limit || position >= scanEnd) break;
    offset += member.rows;
  }
  return {
    rows: results,
    positions,
    cursor: position,
    done: position >= table.rows,
  };
}
