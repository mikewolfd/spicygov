import type { CatalogCollection, CatalogPeriod } from './source-catalog';
import { periodLabel, periodRange } from './source-browser';

export type SourcePeriodGroup = { id: string; label: string; periods: CatalogPeriod[] };
type CollectionContext = Pick<CatalogCollection, 'id' | 'families'>;

const congressionalFamilies = new Set([
  'amendments', 'bill-family', 'bill-subjects', 'committee-meetings', 'committee-reports',
  'committee-rosters', 'congress-committees', 'house-communications', 'laws', 'members',
  'member-vote-terms', 'nominations', 'press-releases', 'record-issues', 'roll-call-votes',
  'scorecards', 'scorecard-analysis', 'treaties',
]);
const editionFamilies = new Set(['cfr-sections', 'uscode', 'uscode-editions', 'unified-agenda']);
const requested = (period: CatalogPeriod) => /requested/.test(period.kind) || period.basis.includes('requested-scope');
const dated = (period: CatalogPeriod) => !!period.start
  && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(period.start) && Number.isFinite(Date.parse(period.start));

/** Choose among recorded periods; requested scopes never become observed coverage. */
export function sourcePeriodGroups(periods: CatalogPeriod[], collection?: CollectionContext): SourcePeriodGroup[] {
  const families = [collection?.id.replace(/^[^:]+:/, '').replace(/^retained-/, ''), ...(collection?.families ?? [])];
  const agenda = families.includes('unified-agenda');
  const naturalKinds = families.some(family => family && congressionalFamilies.has(family))
    ? ['congress', 'requested-congress']
    : families.some(family => family?.startsWith('fec-'))
      ? ['election-cycle', 'requested-election-cycle']
      : families.some(family => family && editionFamilies.has(family))
        ? ['edition', 'agenda-edition', 'edition-year', 'requested-edition', ...(agenda ? ['declared-period'] : [])]
        : [];
  const groups = new Map<string, { group: SourcePeriodGroup; seen: Set<string> }>();
  for (const period of periods) {
    if (period.kind === 'unknown' || !period.label.trim() || /^unknown$/i.test(period.label.trim())) continue;
    const label = agenda && period.kind === 'declared-period' && !requested(period)
      ? 'Declared agenda edition' : periodLabel(period);
    const id = `${period.kind}:${label}`;
    let entry = groups.get(id);
    if (!entry) {
      entry = { group: { id, label, periods: [] }, seen: new Set() };
      groups.set(id, entry);
    }
    const value = periodRange(period);
    if (!entry.seen.has(value)) {
      entry.group.periods.push(period);
      entry.seen.add(value);
    }
  }
  function priority(group: SourcePeriodGroup): number {
    const kind = group.periods[0].kind;
    const native = naturalKinds.indexOf(kind);
    if (native >= 0) return native + (requested(group.periods[0]) ? 0.5 : 0);
    if (kind === 'observed-retained-scope' && group.periods.some(dated)) return 10;
    if (['publication-date', 'issue-date', 'date'].includes(kind) && !requested(group.periods[0])) return 20;
    if (requested(group.periods[0])) return 40;
    if (kind === 'documented-publisher-scope') return 50;
    return 30;
  }
  return [...groups.values()].map(entry => entry.group).sort((a, b) => priority(a) - priority(b));
}
