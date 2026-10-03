import type { Dataset } from './catalog';
import type { Source } from './metadata';
export type { Source } from './metadata';
export const unlistedSource: Source = { id: 'unlisted', name: 'Source not yet documented', note: 'Published tables awaiting source details.', kind: 'unknown' };
const derivedSource: Source = { id: 'derived', name: 'Calculated from other tables', note: 'Follow the input links to the original records.', kind: 'derived' };
export function sourceFor(table: Dataset): Source {
  if (table.inputs.length) return derivedSource;
  if (table.sources.length > 1) return {
    id: table.sources.map(source => source.id).sort().join('+'),
    name: table.family === 'scorecards' ? 'Scorecard publishers' : table.sources.map(source => source.name).join(' & '),
    note: 'The named sources contribute to these tables. See each table for original links.', kind: 'multiple',
  };
  return table.sources[0] ?? unlistedSource;
}
export function sourceGroups(tables: Dataset[], query = '') {
  const q = query.trim().toLowerCase();
  const groups = new Map<string, { source: Source; tables: Dataset[] }>();
  for (const table of tables) {
    const source = sourceFor(table);
    if (q && !`${table.label} ${table.id} ${table.summary} ${table.sources.map(s => `${s.name} ${s.note}`).join(' ')} ${table.inputs.join(' ')}`.toLowerCase().includes(q)) continue;
    const group = groups.get(source.id) ?? { source, tables: [] };
    group.tables.push(table);
    groups.set(source.id, group);
  }
  return [...groups.values()].sort((a, b) => a.source.id === 'unlisted' ? 1 : b.source.id === 'unlisted' ? -1 : a.source.name.localeCompare(b.source.name));
}
