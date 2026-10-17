import type { Dataset, Filter } from './catalog';
import { readColumnBatches, renewTableVersion } from './reader';
import { filterKey, keyType, rowKey } from './filter-values';
import { checkMemberCounts, subjectBinding, versionBound } from './reader-binding';

const MAX_ROWS = 500000, MAX_BYTES = 128 * 1024 * 1024;
type KeyCache = { binding: string; positions: Map<string, number[]>; estimatedBytes: number };
let retained: KeyCache | undefined;
/** Binding of a population already measured over MAX_BYTES; lookups keep bounded continuation without another projection. */
let oversized: string | undefined;
const OVERSIZED = new Error('The key population exceeds its memory estimate.');

export function identityKey(table: Dataset, filters: Filter[]): string | undefined {
  const components = table.recordIdentity!.columns.map(name => {
    const filter = filters.find(f => f.column === name)!;
    return filterKey(filter.value, table.columns.find(c => c.name === name)!.type);
  });
  return components.every(c => c !== undefined) ? JSON.stringify(components) : undefined;
}

/** One complete key population. Two witnessed positions represent ambiguity. */
export async function recordKeyCache(table: Dataset, onProgress: (n: number) => void = () => {}): Promise<KeyCache | undefined> {
  checkMemberCounts(table);
  const names = table.recordIdentity?.columns ?? [];
  const types = names.map(n => table.columns.find(c => c.name === n)?.type ?? '');
  if (!names.length || new Set(names).size !== names.length || table.rows > MAX_ROWS ||
      !versionBound(table) || !types.every(keyType)) return;
  const binding = JSON.stringify([subjectBinding(table), names]), prior = retained;
  if (oversized === binding) return;
  retained = undefined;
  if (prior?.binding === binding) {
    await renewTableVersion(table);
    retained = prior;
    return prior;
  }
  const positions = new Map<string, number[]>();
  let position = 0, estimatedBytes = 0;
  const result = await readColumnBatches(table, names, MAX_ROWS, rows => {
    for (const row of rows) {
      const components = names.map((n, i) => rowKey(row[n], types[i]));
      if (components.every(c => c !== undefined)) {
        const key = JSON.stringify(components), existing = positions.get(key);
        if (!existing) { estimatedBytes += 256 + key.length * 2; positions.set(key, [position]); }
        else if (existing.length < 2) { existing.push(position); estimatedBytes += 8; }
        if (estimatedBytes > MAX_BYTES) throw OVERSIZED;
      }
      position++;
    }
    onProgress(position);
  }).catch(error => { if (error !== OVERSIZED) throw error; });
  if (!result) { oversized = binding; return; }
  if (!result.complete || position !== table.rows) throw new Error('The key population is incomplete. No locator was admitted.');
  await renewTableVersion(table);
  retained = { binding, positions, estimatedBytes };
  return retained;
}
