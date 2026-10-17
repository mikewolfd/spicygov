import {fecReadColumns, enrichFecRows} from './fec-compatibility';
import { matchesConnection, navigationColumns, validConnection, type Connection, type Navigation } from './navigation';
import { matchesFilters, parquetFilter, validFilter } from './filter-values';
import { exactParsers } from './exact-parquet';
import { asyncBufferFromUrl, parquetMetadataAsync, parquetReadObjects, rowIndex } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { Dataset, Filter, Row } from "./catalog";
import { compareEntries, retainEntry, sortValue, type RecordSort, type SortEntry } from "./record-sort";
import { checkMemberCounts, subjectBinding, versionBound } from './reader-binding';
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

/** Offline audit projection: one footer per pinned member, bounded batches. */
export async function readColumnBatches(table: Dataset, columns: string[], maxRows: number, onBatch: (rows: Row[]) => void | Promise<void>, startRow = 0): Promise<{rows: number; complete: boolean}> {
  checkMemberCounts(table);
  if (table.recordsAvailable === false || columns.some(name => !table.columns.some(column => column.name === name))) throw new Error('Audit fields are unavailable in this publication.');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error('Invalid audit row limit.');
  if (!Number.isSafeInteger(startRow) || startRow < 0 || startRow > table.rows) throw new Error('Invalid audit continuation.');
  let rows = 0, offset = 0;
  for (const member of table.members) {
    // A completed projection still checks declared-empty trailing members.
    if (rows >= maxRows && startRow + rows < table.rows) break;
    const memberStart = Math.max(0, startRow - offset);
    offset += member.rows;
    if (member.rows && memberStart >= member.rows) continue;
    const file = await remoteFile(member);
    const metadata = await parquetMetadataAsync(file, {parsers:exactParsers});
    if (Number(metadata.num_rows) !== member.rows) throw new Error('The Parquet footer differs from the published row count.');
    if(!member.rows)continue;
    for (let start = memberStart; start < member.rows && rows < maxRows;) {
      const end = Math.min(member.rows, start + 50000, start + maxRows - rows);
      const batch = await parquetReadObjects({parsers:exactParsers,file, metadata, compressors, columns:fecReadColumns(table,columns), rowStart:start, rowEnd:end, useOffsetIndex:true, usePageIndex:true});
      if (batch.length !== end - start) throw new Error('The audit projection returned an incomplete batch.');
      await onBatch(enrichFecRows(table,batch));
      rows += batch.length; start = end;
    }
  }
  return {rows, complete:startRow + rows === table.rows};
}

async function remoteFile(member: Dataset['members'][number]) {
  const expectedEtag = member.etag?.replace(/^"|"$/g, '');
  const remote = await asyncBufferFromUrl({ url: member.url, byteLength: member.byteSize,
    ...(expectedEtag ? {requestInit: {cache: 'no-store' as RequestCache, headers: {'If-Match': `"${expectedEtag}"`}}, fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
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
      if (buffer.byteLength !== (end ?? member.byteSize) - start) throw new Error('The published byte range is incomplete.');
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

/** Renew the complete population, including members absent from a cached page. */
export async function renewTableVersion(table: Dataset): Promise<void> {
  if (!versionBound(table)) throw new Error('This publication has no checked file version for cached records.');
  for (const member of table.members) {
    const file = await remoteFile(member);
    await file.slice(0, 1);
    if (!member.rows) {
      const metadata = await parquetMetadataAsync(file, {parsers:exactParsers});
      if (Number(metadata.num_rows) !== 0) throw new Error('The Parquet footer differs from the published row count.');
    }
  }
}

const SORT_ROWS = 100000, SORT_BYTES = 32 * 1024 * 1024;
type SortedCache = { binding: string; entries: SortEntry[]; startCursor: number; remaining: number; complete: boolean };
let sortedCache: SortedCache | undefined;
const entryBytes = (entry: SortEntry) => 128 + (typeof entry.value === 'string' ? entry.value.length * 2 : 16);

async function readSortedPage(request: ReadRequest & { sort: RecordSort; limit: number }, onProgress: (n: number) => void): Promise<ReadResult> {
  const { table, columns, filters, cursor, sort, limit, connection, navigation } = request;
  if (cursor > table.rows || !['asc', 'desc'].includes(sort.direction)) throw new Error('Invalid sort or record position.');
  if (limit > 1000) throw new Error('Sorted pages are limited to 1,000 records.');
  const binding = JSON.stringify([subjectBinding(table), filters, sort, connection, navigation]);
  const prior = sortedCache;
  sortedCache = undefined;
  let heap: SortEntry[] = [], remaining = 0, reused = false;
  if (prior?.binding === binding && versionBound(table)) {
    let start = cursor === prior.startCursor ? 0 : prior.entries.findIndex(e => e.position === cursor - 1) + 1;
    // A physical cursor absent from a complete filtered population still has a value boundary.
    if (cursor !== prior.startCursor && start === 0 && prior.complete && cursor) {
      const page = await readPage({ table, columns: [sort.column], filters: [], cursor: cursor - 1, limit: 1 });
      if (page.positions[0] !== cursor - 1) throw new Error('The sorted page boundary is no longer available.');
      const boundary = { value: sortValue(page.rows[0][sort.column]), position: cursor - 1 };
      start = prior.entries.findIndex(e => compareEntries(e, boundary, sort) > 0);
      if (start < 0) start = prior.entries.length;
    } else if (cursor !== prior.startCursor && start === 0) start = -1;
    if (start >= 0 && (prior.entries.length - start >= limit || prior.remaining === prior.entries.length)) {
      await renewTableVersion(table);
      heap = prior.entries.slice(start, start + limit);
      remaining = prior.remaining - start;
      sortedCache = prior;
      reused = true;
      onProgress(table.rows);
    }
  }
  let boundary: SortEntry | undefined;
  if (!reused && cursor) {
    const page = await readPage({ table, columns: [sort.column], filters: [], cursor: cursor - 1, limit: 1 });
    if (page.positions[0] !== cursor - 1) throw new Error('The sorted page boundary is no longer available.');
    boundary = { value: sortValue(page.rows[0][sort.column]), position: cursor - 1 };
  }
  let offset = 0;
  const scanColumns = [...new Set([sort.column, ...filters.map(f => f.column), ...(navigation ? navigationColumns(navigation) : [])])];
  let all: SortEntry[] | undefined = !reused && versionBound(table) && table.rows <= SORT_ROWS ? [] : undefined;
  let window: SortEntry[] | undefined = !reused && versionBound(table) && !all ? [] : undefined;
  let allBytes = 0, windowBytes = 0;
  const windowLimit = Math.min(limit * 8, 8000);
  if (!reused) for (const member of table.members) {
    const file = await remoteFile(member);
    const metadata = await parquetMetadataAsync(file, {parsers:exactParsers});
    if (Number(metadata.num_rows) !== member.rows) throw new Error('The Parquet footer differs from the published row count.');
    if (!member.rows) continue;
    for (let start = 0; start < member.rows; start += 50000) {
      const end = Math.min(member.rows, start + 50000);
      const rows = await parquetReadObjects({parsers:exactParsers, file, metadata, compressors, columns: fecReadColumns(table,scanColumns), rowStart: start, rowEnd: end, includeRowIndex: true, useOffsetIndex: true, usePageIndex: true });
      if (rows.length !== end - start) throw new Error('The sort projection returned an incomplete batch.');
      for (const row of enrichFecRows(table,rows)) {
        if (!matchesFilters(row, filters, table.columns) || connection && navigation && !matchesConnection(row, navigation, connection)) continue;
        const entry = { value: sortValue(row[sort.column]), position: offset + row[rowIndex]! };
        if (boundary && compareEntries(entry, boundary, sort) <= 0) continue;
        remaining++;
        retainEntry(heap, entry, limit, sort);
        if (all) {
          allBytes += entryBytes(entry);
          if (allBytes <= SORT_BYTES) all.push(entry);
          else all = undefined;
        }
        if (window) {
          if (window.length < windowLimit) windowBytes += entryBytes(entry);
          else if (compareEntries(entry, window[0], sort) < 0) windowBytes += entryBytes(entry) - entryBytes(window[0]);
          if (windowBytes > SORT_BYTES) window = undefined;
          else retainEntry(window, entry, windowLimit, sort);
        }
      }
      onProgress(offset + end);
    }
    offset += member.rows;
  }
  heap.sort((a, b) => compareEntries(a, b, sort));
  const admitted = all ?? window;
  if (!reused && admitted) {
    admitted.sort((a, b) => compareEntries(a, b, sort));
    await renewTableVersion(table);
    sortedCache = { binding, entries: admitted, startCursor: cursor, remaining, complete: cursor === 0 && !!all };
  }
  // Read full visible fields only for the selected records, preserving their identities.
  const selected = [...heap].sort((a, b) => a.position - b.position);
  const records = new Map<number, Row>();
  offset = 0;
  for (const member of table.members) {
    const positions = selected.filter(entry => entry.position >= offset && entry.position < offset + member.rows).map(entry => entry.position - offset);
    if (positions.length) {
      const file = await remoteFile(member);
      const metadata = await parquetMetadataAsync(file, {parsers:exactParsers});
      for (let i = 0; i < positions.length;) {
        const start = positions[i];
        let end = start + 1;
        while (++i < positions.length && positions[i] === end) end++;
        const rows = await parquetReadObjects({parsers:exactParsers, file, metadata, compressors, columns: fecReadColumns(table,columns), rowStart: start, rowEnd: end, includeRowIndex: true, useOffsetIndex: true, usePageIndex: true });
        for (const row of enrichFecRows(table,rows)) records.set(offset + row[rowIndex]!, row);
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
  checkMemberCounts(table);
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
  if(filters.some(f=>table.columns.find(c=>c.name===f.column)?.type.startsWith('DECIMAL')))throw new Error('Exact decimal filtering is unavailable in this reader. Decimal values cannot safely use a rounded numeric match.');
  if (connection && (!validConnection(connection) || !navigation || navigation.id !== connection.id || navigation.source !== table.id || !navigation.targets[connection.target] || navigation.targets[connection.target].columns.length !== connection.values.length)) throw new Error('This source connection is unavailable. Reload the catalog.');
  const connectionColumns = navigation ? navigationColumns(connection?{...navigation,targets:[navigation.targets[connection.target]]}:navigation) : [];
  if (connection && connectionColumns.some(c => !table.columns.some(x=>x.name===c))) {
    throw new Error('The main source fields for this connection are not published. Receipts remain available as evidence.');
  }
  if (sort) {
    if (maxScanRows !== undefined && table.rows > maxScanRows)
      throw new Error('Sorting requires checking every source row. This related-record search is bounded; clear sorting to continue checking it in batches.');
    return readSortedPage({ table, columns, filters, cursor, limit, sort, connection, navigation }, onProgress);
  }
  let offset = 0,
    position = cursor;
  const scanEnd = Math.min(table.rows, maxScanRows === undefined ? table.rows : cursor + maxScanRows);
  const results: Row[] = [],
    positions: number[] = [];
  const filter = connection || table.fecCompatibility ? undefined : parquetFilter(filters,table.columns);
  for (const member of table.members) {
    if(!member.rows){const file=await remoteFile(member);const metadata=await parquetMetadataAsync(file,{parsers:exactParsers});if(Number(metadata.num_rows)!==0)throw new Error('The Parquet footer differs from the published row count.');continue;}
    if (offset + member.rows <= position) {
      offset += member.rows;
      continue;
    }
    const file = await remoteFile(member);
    const metadata = await parquetMetadataAsync(file, {parsers:exactParsers});
    let local = Math.max(0, position - offset);
    if(Number(metadata.num_rows)!==member.rows)throw new Error('The Parquet footer differs from the published row count.');
    while (local < member.rows && position < scanEnd && results.length < limit) {
      const end = Math.min(
        member.rows,
        scanEnd - offset,
        local + (filters.length || connection ? 50000 : limit - results.length),
      );
      const rows = await parquetReadObjects({parsers:exactParsers,
        file,
        metadata,
        compressors,
        columns: fecReadColumns(table,[...new Set([...columns, ...filters.map((f) => f.column), ...connectionColumns])]),
        rowStart: local,
        rowEnd: end,
        filter,
        includeRowIndex: true,
        useOffsetIndex: true,
        usePageIndex: true,
      });
      let last = end;
      for (const row of enrichFecRows(table,rows)) {
        if (
          matchesFilters(row, filters, table.columns) && (!connection || matchesConnection(row, navigation!, connection))
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
