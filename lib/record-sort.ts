export type RecordSort = { column: string; direction: 'asc' | 'desc' };
export type SortValue = string | number | bigint | boolean | null;
export type SortEntry = { value: SortValue; position: number };

export function sortValue(value: unknown): SortValue {
  if (value == null || (typeof value === 'number' && Number.isNaN(value))) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (['string', 'number', 'bigint', 'boolean'].includes(typeof value)) return value as SortValue;
  return JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v) ?? null;
}

export function compareEntries(a: SortEntry, b: SortEntry, sort: RecordSort): number {
  // Missing values stay last in both directions; physical position breaks ties.
  if (a.value === null || b.value === null) {
    if (a.value !== b.value) return a.value === null ? 1 : -1;
  } else {
    const order = a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    if (order) return sort.direction === 'asc' ? order : -order;
  }
  return a.position - b.position;
}

/** Keep only the next page, with the worst retained entry at the heap root. */
export function retainEntry(heap: SortEntry[], entry: SortEntry, limit: number, sort: RecordSort) {
  if (heap.length < limit) {
    heap.push(entry);
    let child = heap.length - 1;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareEntries(heap[parent], heap[child], sort) >= 0) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      child = parent;
    }
    return;
  }
  if (compareEntries(entry, heap[0], sort) >= 0) return;
  heap[0] = entry;
  let parent = 0;
  while (parent * 2 + 1 < heap.length) {
    const left = parent * 2 + 1, right = left + 1;
    const child = right < heap.length && compareEntries(heap[right], heap[left], sort) > 0 ? right : left;
    if (compareEntries(heap[parent], heap[child], sort) >= 0) break;
    [heap[parent], heap[child]] = [heap[child], heap[parent]];
    parent = child;
  }
}
