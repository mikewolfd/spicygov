import { useState } from 'react';
import { count, type Dataset } from '../lib/catalog';
import { currentTimeCoverage, periodRows, periodState, type TimeInventory } from '../lib/time-coverage';
export type TimeView = { year: number; mode: 'years' | 'months' };
const dateLabels: Record<string, string> = { year_text: 'publisher year', 'year + month': 'recorded year and month', period_end: 'reporting period end', pub_date: 'publication date' };
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function TimeGrid({ tables, inventory, view, compact = false }: { tables: Dataset[]; inventory?: TimeInventory; view: TimeView; compact?: boolean }) {
  const [selected, setSelected] = useState('');
  const coverages = tables.map(table => currentTimeCoverage(table, inventory));
  const periods = Array.from({ length: 12 }, (_, i) => view.mode === 'years' ? String(view.year - 11 + i) : `${view.year}-${String(i + 1).padStart(2, '0')}`);
  const dates = coverages.flatMap(c => c?.status === 'measured' ? Object.keys(c.buckets ?? {}).map(key => tables.length === 1 ? key : key.slice(0, 4)) : []).sort();
  const measured = coverages.filter(c => c?.status === 'measured').length;
  const single = tables.length === 1 ? coverages[0] : undefined;
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
