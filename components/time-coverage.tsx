import { useState } from 'react';
import { count, type Dataset } from '../lib/catalog';
import { currentTimeCoverage, periodRows, periodState, type TimeCoverage, type TimeInventory } from '../lib/time-coverage';
export type TimeView = { year: number; mode: 'years' | 'months' };
const dateLabels: Record<string, string> = { year_text: 'publisher year', 'year + month': 'recorded year and month', period_end: 'reporting period end', pub_date: 'publication date', date: 'vote reference date', vote_day: 'vote date', receipt_date: 'date received by FEC' };
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function TimeGrid({ tables, inventory, view, compact = false }: { tables: Dataset[]; inventory?: TimeInventory; view: TimeView; compact?: boolean }) {
  const [selected, setSelected] = useState('');
  const coverages = tables.map(table => currentTimeCoverage(table, inventory));
  const periods = Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 12 }, (_, i) => view.mode === 'years' ? String(Math.max(1, view.year - 11) + i).padStart(4, '0') : `${String(view.year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`);
  const dates = coverages.flatMap(c => c?.status === 'measured' ? Object.keys(c.buckets ?? {}).map(key => tables.length === 1 ? key : key.slice(0, 4)) : []).sort();
  const measured = coverages.filter(c => c?.status === 'measured').length;
  const single = tables.length === 1 ? coverages[0] : undefined;
  if (single?.granularity === 'season') return <EditionGrid coverage={single} view={view} compact={compact} />;
  if (single?.collectionOutcomes) return <CollectionResults outcomes={single.collectionOutcomes} compact={compact} />;
  return <div className={`time-coverage ${compact ? 'time-compact' : ''}`}>
    <div className="time-grid">{periods.map((period, i) => {
      const cell = periodState(coverages, period), rows = tables.length === 1 ? periodRows(single, period) : undefined;
      const text = `${period}: ${rows !== undefined ? `${count(rows)} dated rows` : `${cell.present} tables with dated rows; ${cell.measured} of ${cell.total} measured`}`;
      return <button key={period} type="button" className={`time-cell time-${cell.state}`} aria-label={text} title={text} onClick={event => { event.preventDefault(); event.stopPropagation(); setSelected(`${view.mode}:${view.year}|${text}`); }}><span>{view.mode === 'years' ? period : months[i]}</span><i aria-hidden="true">{cell.state === 'present' ? '●' : cell.state === 'empty' ? '—' : '?'}</i></button>;
    })}</div>
    {dates.length > 0 && <p className="time-caption">First {dates[0]} · last {dates[dates.length - 1]}</p>}
    <p className="time-caption">{single?.status === 'measured' ? <>By {dateLabels[single.field ?? ''] ?? single.field?.replaceAll('_', ' ')}{single.granularity === 'year' ? ' · year only' : ''}{(single.undatedRows ?? 0) > 0 && <> · {count(single.undatedRows ?? 0)} rows not placed on this timeline</>}</> : tables.length === 1 ? inventory?.tables[tables[0].id]?.status === 'measured' ? 'Files changed; dates need recounting.' : currentTimeCoverage(tables[0], inventory)?.reason ?? 'Time coverage not measured.' : `${measured} of ${tables.length} tables measured · presence does not mean complete coverage`}</p>
    {selected.startsWith(`${view.mode}:${view.year}|`) && <p className="time-selection" role="status">{selected.split('|')[1]}</p>}
  </div>;
}

function editionLabel(period: string) {
  const [year, season] = period.split('-');
  return `${season === 'spring' ? 'Spring' : 'Fall'} ${year}`;
}
function EditionGrid({ coverage, view, compact }: { coverage: TimeCoverage; view: TimeView; compact: boolean }) {
  const [selection, setSelection] = useState('');
  const years = view.mode === 'years' ? Array.from({ length: Math.min(12, view.year) }, (_, i) => Math.max(1, view.year - 11) + i) : [view.year];
  const periods = Object.keys(coverage.buckets ?? {}).sort((a, b) => a.slice(0, 4).localeCompare(b.slice(0, 4)) || (a.endsWith('spring') ? -1 : 1));
  return <div className={`time-coverage ${compact ? 'time-compact' : ''}`}>
    <p className="time-caption"><strong>Agenda editions</strong> · ● Present · — No rows in this file</p>
    <div className={`edition-grid ${years.length === 1 ? 'edition-one-year' : ''}`}>{years.map(year => <div key={year} className="edition-year">
      <span>{year}</span><div>{['spring', 'fall'].map(season => {
        const period = `${String(year).padStart(4, '0')}-${season}`, rows = periodRows(coverage, period) ?? 0;
        const text = `${editionLabel(period)}: ${count(rows)} agenda rows`;
        return <button type="button" key={season} className={`time-cell time-${rows > 0 ? 'present' : 'empty'}`} aria-label={text} title={text} onClick={event => { event.preventDefault(); event.stopPropagation(); setSelection(`${view.mode}:${view.year}|${text}`); }}><span>{season === 'spring' ? 'Spring' : 'Fall'}</span><i aria-hidden="true">{rows > 0 ? '●' : '—'}</i></button>;
      })}</div>
    </div>)}</div>
    {periods.length > 0 && <p className="time-caption">First {editionLabel(periods[0])} · last {editionLabel(periods[periods.length - 1])}</p>}
    <p className="time-caption">Each cell is an edition, not a month. Presence does not establish a complete edition.{(coverage.undatedRows ?? 0) > 0 && ` ${count(coverage.undatedRows ?? 0)} rows have no recognized edition.`}</p>
    {selection.startsWith(`${view.mode}:${view.year}|`) && <p className="time-selection" role="status">{selection.split('|')[1]}</p>}
  </div>;
}
const outcomeLabels: Record<string, [string, string]> = {
  'no-record-rejections': ['Read without rejected records', 'Records passed the collection checks; this does not prove the source is complete.'],
  empty: ['Checked: no records', 'The requested collection returned no records; this does not mean the source has none.'],
  refused: ['Not accepted', 'The collection was refused by its processing checks.'],
  unresolved: ['Unresolved', 'The collection result could not be resolved.'],
  inventory_only: ['Inventory only', 'An inventory entry, not proof that its records were collected.'],
  selection_context: ['Selection records', 'Records explaining which inputs were selected, not separate collection attempts.'],
};
function CollectionResults({ outcomes, compact }: { outcomes: Record<string, number>; compact: boolean }) {
  return <div className="collection-results">
    <p className="time-caption"><strong>Collection results</strong></p>
    <dl>{Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b)).map(([key, n]) => <div key={key}>
      <dt title={outcomeLabels[key]?.[1]}>{outcomeLabels[key]?.[0] ?? key.replaceAll('_', ' ')}</dt><dd>{count(n)}</dd>
    </div>)}</dl>
    <p className="time-caption">Counts describe collection records, not years or complete datasets.</p>
    {!compact && <details onClick={event => event.stopPropagation()}><summary>What these results mean</summary><ul>{Object.entries(outcomes).map(([key]) => <li key={key}><strong>{outcomeLabels[key]?.[0] ?? key}:</strong> {outcomeLabels[key]?.[1] ?? 'A source-reported outcome; its meaning has not been reviewed.'}</li>)}</ul></details>}
  </div>;
}
