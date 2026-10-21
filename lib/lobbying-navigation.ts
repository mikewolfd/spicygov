import type { Dataset } from './catalog';
import type { Navigation } from './navigation';

export const LOBBYING_TABLES = ['lobbying_filings', 'lobbying_activities', 'lobbying_activity_lobbyists'];
export const LOBBYING_BODY_NAVIGATION_ID = 'gov_lobbying_activity_body';

/** A literal LDA body ID is a source value, not a resolved agency/person key. */
export function lobbyingNavigation(tables: Dataset[]): Navigation[] {
  const source = tables.find(t => t.id === 'lobbying_activities');
  if (!source || source.metadataState !== 'current' || source.recordsAvailable === false ||
    source.family !== 'lobbying-filings' ||
    !source.columns.some(c => c.name === 'government_entities' && c.type === 'STRUCT(id VARCHAR, "name" VARCHAR)[]')) return [];
  return [{
    id: LOBBYING_BODY_NAVIGATION_ID, source: source.id,
    fields: ['government_entities'], mode: 'array', receiptFields: [], elementPath: [],
    meaning: 'Activities listing an exact source-reported LDA body ID. Repeated body entries do not multiply activity rows.',
    ruleVersion: 'source-navigation/1',
    targets: [{
      // These columns name the literal tuple, never a physical target table.
      table: '@value', columns: ['id'],
      keys: [{ parts: [{ path: ['id'], from: 'element' }], separator: '', pattern: '[0-9]+' }],
      guards: [],
    }],
  }];
}
