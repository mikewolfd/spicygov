import { asyncBufferFromUrl, parquetReadObjects, rowIndex } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import type { Dataset, Filter, Row } from "./catalog";
export type ReadRequest = {
  table: Dataset;
  columns: string[];
  filters: Filter[];
  cursor: number;
  limit?: number;
};
export async function readPage(
  { table, columns, filters, cursor, limit = 40 }: ReadRequest,
  onProgress: (n: number) => void = () => {},
) {
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new Error("Invalid record position.");
  if (
    columns.some((n) => !table.columns.some((c) => c.name === n)) ||
    filters.some((f) => !table.columns.some((c) => c.name === f.column))
  )
    throw new Error("Unknown field in this dataset.");
  let offset = 0,
    position = cursor;
  const results: Row[] = [],
    positions: number[] = [];
  const canPrune =
    filters.length > 0 &&
    filters.every(
      (f) => table.columns.find((c) => c.name === f.column)?.type === "VARCHAR",
    );
  const filter = canPrune
    ? { $and: filters.map((f) => ({ [f.column]: { $eq: f.value } })) }
    : undefined;
  for (const member of table.members) {
    if (offset + member.rows <= position) {
      offset += member.rows;
      continue;
    }
    const remote = await asyncBufferFromUrl({
      url: member.url,
      byteLength: member.byteSize,
    });
    const cache = new Map<string, ArrayBuffer>();
    let cacheBytes = 0;
    const file = {
      byteLength: remote.byteLength,
      async slice(start: number, end?: number) {
        const key = `${start}:${end}`;
        if (cache.has(key)) return cache.get(key)!;
        const buffer = await remote.slice(start, end);
        if (buffer.byteLength <= 16 * 1024 * 1024) {
          while (
            cacheBytes + buffer.byteLength > 16 * 1024 * 1024 &&
            cache.size
          ) {
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
    let local = Math.max(0, position - offset);
    while (local < member.rows && results.length < limit) {
      const end = Math.min(
        member.rows,
        local + (filters.length ? 50000 : limit - results.length),
      );
      const rows = await parquetReadObjects({
        file,
        compressors,
        columns: [...new Set([...columns, ...filters.map((f) => f.column)])],
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
          filters.every(
            (f) => row[f.column] != null && String(row[f.column]) === f.value,
          )
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
    if (results.length === limit) break;
    offset += member.rows;
  }
  return {
    rows: results,
    positions,
    cursor: position,
    done: position >= table.rows,
  };
}
