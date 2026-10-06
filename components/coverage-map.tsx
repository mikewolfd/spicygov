import { coverageViewLabel } from '../lib/source-labels';
import { useState } from 'react';
import { count, type Dataset } from '../lib/catalog';
import { coverageCategoryDisplay, coverageCategoryMatches, coverageFieldLabel, coverageItemNoun, coverageMapCounts, coverageMapForDisplay, coveragePeriodLabel, coveragePeriodNoun, coverageStatement, dimensionPeriodRows, scopeLabel, type CoverageDimension, type CoverageMaps } from '../lib/coverage-map';
import { object } from '../lib/publication-evidence';
import { coveragePublisherNames, type CoveragePublishers } from '../lib/coverage-publishers';
import type { TimeView } from './time-coverage';
import './coverage-map.css';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const unitLabel = (rows: number, unit = 'rows') => rows === 1 ? ({rows: 'row', comments: 'comment', 'index groups': 'index group'} as Record<string, string>)[unit] ?? unit : unit;
const rowsLabel = (rows: number) => `${count(rows)} ${rows === 1 ? 'row' : 'rows'}`;
const coverageDate = (date: string) => new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'}).format(new Date(date));

export function TableCoverageMap({ table, maps, view, publishers, onRetry }: { table: Dataset; maps?: CoverageMaps; view: TimeView; publishers?: CoveragePublishers; onRetry?: () => void }) {
  const [axis, setAxis] = useState('');
  const display = coverageMapForDisplay(table, maps);
  if (!display) return <div className="coverage-map"><p className="coverage-unavailable">Coverage counts are not available for this table.</p>{onRetry && <button type="button" onClick={onRetry}>Reload published counts</button>}</div>;
  const {map, freshness} = display;
  const preferred = map.dimensions.find(dim => ['month', 'year', 'season'].includes(dim.granularity) && dim.placedRows > 0)
    ?? map.dimensions.find(dim => dim.granularity !== 'snapshot' && dim.placedRows > 0) ?? map.dimensions[0];
  const dimension = map.dimensions.find(dim => dim.id === axis) ?? preferred;
  const statement = coverageStatement(dimension);
  const remainingMeaning = dimension.meaning.slice(statement.length).trim();
  const sourceInputs = (Array.isArray(dimension.parent) ? dimension.parent : [dimension.parent]).filter(object).flatMap(input => typeof input.tableId === 'string' ? [input.tableId] : []);
  const notes = [...new Set([remainingMeaning, ...(dimension.notes ?? []), map.note].filter(Boolean))];
  return <div className="coverage-map">
    {freshness !== 'current' && <div className="coverage-previous" role="status">
      <p><strong>{freshness === 'previous-release' ? 'Previous release' : 'Previous measurement'} · Refresh pending</strong></p>
      <p>{freshness === 'previous-release'
        ? <>Counts from {map.publishedAt ? <>the <time dateTime={map.publishedAt}>{coverageDate(map.publishedAt)} UTC</time> release</> : 'the last measured release'} · {rowsLabel(map.rows)}. The current release has not been checked.</>
        : <>Checked <time dateTime={map.measuredAt}>{coverageDate(map.measuredAt)} UTC</time> · {rowsLabel(map.rows)}. Counts have not been refreshed for this month.</>}</p>
      {onRetry && <button type="button" onClick={onRetry}>Reload published counts</button>}
    </div>}
    {map.dimensions.length > 1 ? <label className="coverage-axis"><span>Count by</span><select aria-label={`Count by for ${table.label}`} value={dimension.id} onChange={event => setAxis(event.target.value)}>{map.dimensions.map(dim => <option key={dim.id} value={dim.id}>{coverageViewLabel(dim.label)}</option>)}</select></label> : <p className="coverage-view-label">{coverageViewLabel(dimension.label)}</p>}
    <p className="coverage-meaning">{statement}</p>
    <DimensionGrid key={dimension.granularity === 'category' || dimension.granularity === 'snapshot' ? dimension.id : `${dimension.id}-${view.mode}-${view.year}`} dimension={dimension} view={view} publisherNames={coveragePublisherNames(table, maps, dimension, publishers)} />
    <details className="coverage-checks">
      <summary>How this count was checked<span className="sr-only"> for {table.label}, {coverageViewLabel(dimension.label)}</span></summary>
      <div className="coverage-checks-body">
        <dl className="coverage-check-counts">
          <div><dt>Rows counted for {coverageViewLabel(dimension.label).toLowerCase()}</dt><dd>{count(dimension.placedRows)}</dd></div>
          {dimension.unplacedRows > 0 && <div><dt>Rows not counted for this field</dt><dd>{count(dimension.unplacedRows)}</dd></div>}
          {(dimension.partialRows ?? 0) > 0 && <div><dt>Counted rows with additional missing or unusable values</dt><dd>{count(dimension.partialRows!)}</dd></div>}
          {(dimension.unmatchedRows ?? 0) > 0 && <div><dt>Rows without a matching source record</dt><dd>{count(dimension.unmatchedRows!)}</dd></div>}
        </dl>
        {sourceInputs.length > 0 && <p>Matched source {sourceInputs.length === 1 ? 'table' : 'tables'}: <code>{[...new Set(sourceInputs)].join(', ')}</code>.</p>}
        {dimension.overlapping && <p>A row can count in several cells. Adding cell counts can count the same row more than once.</p>}
        {table.id === 'court_opinion_clusters' && (dimension.fields?.includes('date_filed') || dimension.fields?.includes('date_filed_is_approximate')) && <p>CourtListener’s date precision flag does not verify a date’s accuracy. Unusually early source dates need review.</p>}
        {table.id === 'comments_index' && Object.keys(dimension.buckets).some(key => Number(key.slice(0, 4)) < 1900) && <p>The saved posting index includes unusually early source dates. Those values remain unchanged and need review.</p>}
        {notes.map(note => <p key={note}>{note}</p>)}
        <DimensionFacts dimension={dimension} />
      </div>
    </details>
  </div>;
}

export function SourceCoverageSummary({ tables, maps }: { tables: Dataset[]; maps?: CoverageMaps; view: TimeView }) {
  const {current, previous} = coverageMapCounts(tables, maps);
  return <p className="coverage-source-summary">Coverage counts available for {current + previous} of {tables.length} tables.{previous > 0 && <> {previous} {previous === 1 ? 'map awaits' : 'maps await'} refresh.</>} Open a table to compare its fields.</p>;
}

function DimensionFacts({ dimension }: { dimension: CoverageDimension }) {
  const evidence = object(dimension.evidence) ? dimension.evidence : undefined;
  const empty = Array.isArray(evidence?.qualifiedEmptyRequests) ? evidence.qualifiedEmptyRequests.filter(object).filter(request => typeof request.scope === 'string') : [];
  const refusals = Array.isArray(evidence?.refusals) ? evidence.refusals.filter(object) : [];
  const anomalies = object(dimension.anomalies) ? dimension.anomalies : undefined;
  const futureRows = typeof anomalies?.futureActivityRows === 'number' ? anomalies.futureActivityRows : 0;
  const boundaryMonth = typeof anomalies?.boundaryMonth === 'string' ? anomalies.boundaryMonth : undefined;
  return <>
    {typeof evidence?.usedCollections === 'number' && <p>{count(evidence.usedCollections)} saved {evidence.usedCollections === 1 ? 'collection supplies' : 'collections supply'} matching source records.</p>}
    {futureRows > 0 && <p>{count(futureRows)} source {futureRows === 1 ? 'date falls' : 'dates fall'} {boundaryMonth ? `after ${boundaryMonth}` : 'in the future'} and {futureRows === 1 ? 'is' : 'are'} excluded from this view.</p>}
    {empty.length > 0 && <details className="coverage-facts"><summary>{count(empty.length)} {empty.length === 1 ? 'request confirmed' : 'requests confirmed'} empty</summary><p>These exact requests returned no records. They do not establish that a whole year or source is empty.</p><ul>{empty.map((request, i) => <li key={i}>{request.scope}</li>)}</ul></details>}
    {refusals.length > 0 && <details className="coverage-facts"><summary>{count(refusals.length)} selections not accepted or unresolved</summary><ul>{refusals.map((item, i) => <li key={i}>{typeof item.sourceFamily === 'string' && <strong>{item.sourceFamily.replaceAll('_', ' ')}: </strong>}{typeof item.reason === 'string' ? item.reason : 'No reason recorded.'}</li>)}</ul></details>}
  </>;
}

function DimensionGrid({ dimension, view, publisherNames }: { dimension: CoverageDimension; view: TimeView; publisherNames?: ReadonlyMap<string, string> }) {
  const [selected, setSelected] = useState('');
  const keys = Object.keys(dimension.buckets).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (dimension.granularity === 'snapshot') return <div className="coverage-snapshot"><p><strong>{rowsLabel(dimension.rows)}</strong> in one saved release{dimension.snapshot?.publishedAt && <> · Released {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(dimension.snapshot.publishedAt))}</>}</p>
    {dimension.snapshot?.asOf && <p>Calculated {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(dimension.snapshot.asOf))} UTC</p>}
    {!!dimension.snapshot?.facts?.length && <dl className="coverage-snapshot-facts">{dimension.snapshot.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}</div>;
  if (dimension.granularity === 'category') return <CategoryGrid dimension={dimension} publisherNames={publisherNames} />;
  const yearOnlyMonths = dimension.granularity === 'year' && view.mode === 'months';
  const cycles = dimension.granularity === 'year' && coveragePeriodNoun(dimension) === 'cycle';
  const periods = dimension.granularity === 'season'
    ? Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 1 }, (_, i) => String(view.mode === 'years' ? Math.max(1, view.year - 11) + i : view.year).padStart(4, '0')).flatMap(year => [`${year}-spring`, `${year}-fall`])
    : Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 12 }, (_, i) => view.mode === 'years' ? String(Math.max(1, view.year - 11) + i).padStart(4, '0') : `${String(view.year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`);
  const annual = yearOnlyMonths ? dimensionPeriodRows(dimension, String(view.year).padStart(4, '0')) : undefined;
  return <>
    {yearOnlyMonths ? <p className="coverage-unavailable">Month counts are unavailable: this field records {cycles ? 'two-year election cycles' : 'years'} only.{annual !== undefined && <> {rowsLabel(annual)} counted for {coveragePeriodLabel(dimension, String(view.year).padStart(4, '0'))}.</>}</p> : <>
      {dimension.granularity === 'season' && view.mode === 'months' && <p className="coverage-unavailable">Month counts are unavailable. Spring and fall editions are shown below.</p>}
      <div className={`time-grid coverage-time-grid ${cycles ? 'coverage-cycle-grid' : ''} ${dimension.granularity === 'season' ? 'coverage-period-grid' : ''}`}>{periods.map((period, index) => {
        const rows = dimensionPeriodRows(dimension, period);
        const state = rows === undefined ? 'unknown' : rows ? 'present' : 'empty';
        const text = `${coveragePeriodLabel(dimension, period)}: ${rows === undefined ? 'Count unavailable for this view' : `${count(rows)} ${unitLabel(rows, dimension.unit)} counted here`}`;
        const label = dimension.granularity === 'season' ? coveragePeriodLabel(dimension, period) : view.mode === 'months' ? months[index] : period;
        const cycleSpan = cycles && Number(period) >= 2 && Number(period) % 2 === 0 ? `${Number(period) - 1}–${period}` : undefined;
        return <button type="button" key={period} className={`time-cell time-${state}`} aria-label={text} title={text} onClick={() => setSelected(text)}><span>{label}</span>{cycleSpan && <small>{cycleSpan}</small>}<i aria-hidden="true">{rows === undefined ? '?' : rows ? '●' : '—'}</i></button>;
      })}</div>
    </>}
    {keys.length > 0 ? <dl className="coverage-range"><div><dt>First recorded {coveragePeriodNoun(dimension)}</dt><dd>{coveragePeriodLabel(dimension, keys[0])}</dd></div><div><dt>Last recorded {coveragePeriodNoun(dimension)}</dt><dd>{coveragePeriodLabel(dimension, keys[keys.length - 1])}</dd></div></dl> : <p className="coverage-empty">No records have a usable value for {coverageViewLabel(dimension.label).toLowerCase()}.</p>}
    {selected && <p className="time-selection" role="status">{selected}</p>}
  </>;
}

function CategoryGrid({ dimension, publisherNames }: { dimension: CoverageDimension; publisherNames?: ReadonlyMap<string, string> }) {
  const [all, setAll] = useState(false), [selected, setSelected] = useState(''), [query, setQuery] = useState('');
  const display = (key: string) => coverageCategoryDisplay(dimension, key, publisherNames);
  const entries = Object.entries(dimension.buckets).sort(([a], [b]) => display(a).label.localeCompare(display(b).label, undefined, { numeric: true }) || a.localeCompare(b));
  if (!entries.length) return <p className="coverage-empty">No records have a usable value for {coverageViewLabel(dimension.label).toLowerCase()}.</p>;
  const tuples = entries.map(([key, n]) => {
    try { const values: unknown = JSON.parse(key); return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string') ? { values: values as string[], n } : undefined; } catch { return undefined; }
  });
  if (tuples.every(tuple => tuple !== undefined)) {
    const rows = [...new Set(tuples.map(tuple => tuple!.values[1]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const columns = [...new Set(tuples.map(tuple => tuple!.values[0]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const columnLabel = (value: string) => dimension.fields?.[0] === 'publisher_id' ? publisherNames?.get(value) ?? `Publisher ID: ${value}` : scopeLabel(value, dimension.fields?.slice(0, 1));
    const rowLabel = (value: string) => dimension.fields?.[1] === 'publisher_id' ? publisherNames?.get(value) ?? `Publisher ID: ${value}` : scopeLabel(value, dimension.fields?.slice(1, 2));
    const axes = [
      {values: columns, display: columnLabel, field: dimension.fields?.[0]},
      {values: rows, display: rowLabel, field: dimension.fields?.[1]},
    ];
    if (rows.length <= 60 && columns.length <= 30) return <>
      <p className="coverage-scroll-hint">Scroll across or down to compare all values.</p>
      <div className="coverage-matrix-scroll" role="region" aria-label={`${coverageViewLabel(dimension.label)}; scroll to compare values`} tabIndex={0}><table className="coverage-matrix"><caption>{coverageFieldLabel(dimension.fields?.[1])} by {coverageFieldLabel(dimension.fields?.[0])} · {dimension.unit ?? 'rows'} counted</caption><thead><tr><th scope="col">{coverageFieldLabel(dimension.fields?.[1])}</th>{columns.map(column => <th scope="col" key={column} title={column}>{columnLabel(column)}{dimension.fields?.[0] === 'publisher_id' && publisherNames?.has(column) && <small className="coverage-publisher-id">Publisher ID: {column}</small>}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row}><th scope="row" title={row}>{rowLabel(row)}{dimension.fields?.[1] === 'publisher_id' && publisherNames?.has(row) && <small className="coverage-publisher-id">Publisher ID: {row}</small>}</th>{columns.map(column => {
        const n = dimension.buckets[JSON.stringify([column, row])] ?? 0;
        return <td key={column} className={n ? 'scope-present' : 'scope-empty'}>{n ? count(n) : <><span aria-hidden="true">—</span><span className="sr-only">0</span></>}</td>;
      })}</tr>)}</tbody></table></div>
      <p className="coverage-matrix-legend">— No records counted for this combination.</p>
      {axes.some(axis => axis.values.some(value => axis.display(value) !== value)) && <details className="coverage-facts"><summary>Original field values</summary><dl>{axes.map((axis, index) => <div key={index}><dt>{coverageFieldLabel(axis.field)}</dt><dd><ul>{axis.values.map(value => <li key={value}>{axis.display(value)} · <code>{value}</code></li>)}</ul></dd></div>)}</dl></details>}
    </>;
  }
  const noun = coverageItemNoun(dimension);
  const filtered = entries.filter(([key]) => coverageCategoryMatches(dimension, key, query, publisherNames));
  const visible = all ? filtered : entries.slice(0, 6);
  const selection = selected ? display(selected) : undefined;
  return <>
    {all && <label className="coverage-category-search">Find {noun}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <div className={`coverage-scope-grid${all ? ' coverage-scope-expanded' : ''}`} {...(all ? { role: 'region', 'aria-label': `All ${noun} for ${coverageViewLabel(dimension.label)}`, tabIndex: 0 } : {})}>{visible.map(([key, n]) => <button type="button" key={key} className="coverage-scope-cell" aria-label={`${display(key).label}: ${count(n)} ${unitLabel(n, dimension.unit)}; show exact recorded value`} onClick={() => setSelected(key)}><span>{display(key).label}</span><strong>{count(n)}</strong></button>)}</div>
    {all && !filtered.length && <p role="status">No {noun} match this search. <button type="button" onClick={() => setQuery('')}>Clear search</button></p>}
    {entries.length > 6 && <button type="button" className="coverage-show-all" onClick={() => { setAll(!all); setQuery(''); }}>{all ? 'Show fewer' : `Show all ${count(entries.length)} ${noun}`}</button>}
    {selection && <div className="coverage-selection" role="status"><strong>{selection.label}</strong><p>{count(dimension.buckets[selected])} {unitLabel(dimension.buckets[selected], dimension.unit)} counted here.</p><details><summary>Exact recorded value</summary><p className="coverage-exact-value">{selection.exact}</p><details><summary>Stored identifier</summary><code>{selected}</code></details></details></div>}
  </>;
}
