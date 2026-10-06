import { elements, targetKeys, type Navigation, type Target } from './navigation';
import type { Row, Dataset } from './catalog';

// Count source occurrences, including repeats. A target lookup returns undefined
// when its complete pinned key population has not been checked.
export type TargetLookup = (target: Target, values: string[]) => number | undefined;
export type NavigationCounts = {
  sourceRows: number; occurrences: number; eligible: number; matched: number;
  missing: number; unchecked: number; offeredUrls: number; unsupported: number;
  recordedAmbiguousAlternatives: number; referencesWithMultipleTargetRows: number;
  states: Record<string, number>;
};
export const emptyCounts = (): NavigationCounts => ({sourceRows:0,occurrences:0,eligible:0,matched:0,missing:0,unchecked:0,offeredUrls:0,unsupported:0,recordedAmbiguousAlternatives:0,referencesWithMultipleTargetRows:0,states:{}});
export function countNavigation(spec: Navigation, rows: Row[], lookup: TargetLookup, counts = emptyCounts()): NavigationCounts {
  for (const row of rows) {
    counts.sourceRows++;
    const held = elements(spec, row);
    counts.states[held.state] = (counts.states[held.state] ?? 0) + 1;
    for (const element of held.values) {
      counts.occurrences++;
      if (element && typeof element === 'object' && 'target_status' in element && element.target_status === 'ambiguous') counts.recordedAmbiguousAlternatives++;
      let supported = false;
      for (const target of spec.targets) {
        const values = targetKeys(target, element, row);
        if (!values) continue;
        supported = true; counts.eligible++;
        if (target.table === '@url') { counts.offeredUrls++; continue; }
        const matches = lookup(target, values);
        if (matches === undefined) counts.unchecked++;
        else if (matches === 0) counts.missing++;
        else { counts.matched++; if (matches > 1) counts.referencesWithMultipleTargetRows++; }
      }
      if (!supported) counts.unsupported++;
    }
  }
  return counts;
}
export function targetIdentity(row: Row, columns: string[]): string | undefined {
  const values = columns.map(column => row[column]);
  if (values.some(value => value == null || !['string','number','bigint'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value))) return;
  return JSON.stringify(values.map(String));
}

/** Reuse a full scalar measurement only when both current file selections match. */
export function retainedScalarCounts(measurement: any, source: Dataset, target: Dataset): NavigationCounts | undefined {
  const matches = (held: any, table: Dataset) => held && (held.publicationIdentity ?? null) === (table.publicationIdentity ?? null)
    && Array.isArray(held.members) && held.members.length === table.members.length
    && table.members.every((member, i) => {
      const pin = held.members[i];
      return pin && pin.url === member.url && pin.rows === member.rows && pin.byteSize === member.byteSize
        && (!member.sha256 || pin.sha256 === member.sha256)
        && (!member.etag || pin.etag?.replace(/^"|"$/g, '') === member.etag.replace(/^"|"$/g, ''));
    });
  if (!measurement || measurement.scope !== 'full_selected_inputs' || !matches(measurement.selected_inputs?.child, source)
    || !matches(measurement.selected_inputs?.parent, target) || measurement.child_input_rows !== source.rows
    || measurement.parent_input_rows !== target.rows || !Number.isSafeInteger(measurement.max_matched_parent_multiplicity)
    || measurement.max_matched_parent_multiplicity > 1 || ![measurement.child_nonnull_rows, measurement.inner_join_rows].every(n => Number.isSafeInteger(n) && n >= 0)
    || measurement.child_nonnull_rows > source.rows || measurement.inner_join_rows > measurement.child_nonnull_rows) return;
  return {...emptyCounts(),sourceRows:source.rows,occurrences:source.rows,eligible:measurement.child_nonnull_rows,
    matched:measurement.inner_join_rows,missing:measurement.child_nonnull_rows-measurement.inner_join_rows,
    unsupported:source.rows-measurement.child_nonnull_rows,states:{stated:source.rows}};
}
