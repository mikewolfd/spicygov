import { coverageViewLabel } from '../lib/source-labels';
import { useState } from 'react';
import { count, publicationDate, type Dataset } from '../lib/catalog';
import { coverageReading, preferredCoverageDimension, coverageCategoryDisplay, coverageCategoryMatches, coverageFieldLabel, coverageItemNoun, coverageMapCounts, coverageMapForDisplay, coveragePeriodLabel, coveragePeriodNoun, coverageStatement, dimensionPeriodRows, scopeLabel, type CoverageDimension, type CoverageMaps } from '../lib/coverage-map';
import { object } from '../lib/publication-evidence';
import { coveragePublisherNames, type CoveragePublishers } from '../lib/coverage-publishers';
import type { TimeView } from './time-coverage';
import { dimensionPeriodSummary } from '../lib/period-summary';
import './coverage-map.css';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const unitLabel = (rows: number, unit = 'rows') => rows === 1 ? ({rows: 'row', comments: 'comment', 'index groups': 'index group'} as Record<string, string>)[unit] ?? unit : unit;
const rowsLabel = (rows: number) => `${count(rows)} ${rows === 1 ? 'row' : 'rows'}`;
const coverageDate = (date: string) => new Intl.DateTimeFormat('en', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'}).format(new Date(date));

export function TableCoverageMap({ table, maps, view: suppliedView, publishers, onRetry }: { table: Dataset; maps?: CoverageMaps; view?: TimeView; publishers?: CoveragePublishers; onRetry?: () => void }) {
  const [axis, setAxis] = useState('');
  const [timeChoice, setTimeChoice] = useState<TimeView>();
  const display = coverageMapForDisplay(table, maps);
  if (!display) return <div className="coverage-map"><p className="coverage-unavailable">Coverage counts are not available for this table.</p>{onRetry && <button type="button" onClick={onRetry}>Reload published counts</button>}</div>;
  const {map, freshness} = display;
  const preferred = preferredCoverageDimension(map);
  const reading = coverageReading(table, maps)!;
  const dimension = map.dimensions.find(dim => dim.id === axis) ?? preferred;
  const periodSummary = dimensionPeriodSummary(dimension, { tableId: table.id, measuredAt: map.measuredAt });
  const years = Object.keys(dimension.buckets).flatMap(key => { const value = /^([0-9]{4})(?:-|$)/.exec(key)?.[1]; return value ? [Number(value)] : []; }).sort((a,b) => a-b);
  const currentYear = new Date().getFullYear();
  // A distant source-date outlier must not hide the useful contemporary records.
  const lastYear = years.filter(year => year <= currentYear).at(-1) ?? years[0] ?? currentYear;
  const view = suppliedView ?? timeChoice ?? {mode: 'years', year: lastYear};
  const temporal = ['month', 'year', 'season'].includes(dimension.granularity);
  const cycles = coveragePeriodNoun(dimension) === 'cycle';
  const statement = coverageStatement(dimension);
  const remainingMeaning = dimension.meaning.slice(statement.length).trim();
  const sourceInputs = (Array.isArray(dimension.parent) ? dimension.parent : [dimension.parent]).filter(object).flatMap(input => typeof input.tableId === 'string' ? [input.tableId] : []);
  const notes = [...new Set([remainingMeaning, ...(dimension.notes ?? []), map.note].filter(Boolean))];
  return <div className="coverage-map">
    <div className={freshness === 'current' ? 'coverage-measurement' : 'coverage-previous'} role="status">
      {freshness === 'current'
        ? <p>{reading.release} · {rowsLabel(map.rows)}</p>
        : <p>{freshness === 'previous-release' ? 'Counts are from an earlier dataset' : 'Earlier measurement'}{map.publishedAt && freshness === 'previous-release' ? ` (${publicationDate(map.publishedAt)})` : ''} · {rowsLabel(map.rows)}.</p>}
    </div>
    {map.dimensions.length > 1 ? <label className="coverage-axis"><span>Count by</span><select aria-label={`Count by for ${table.label}`} value={dimension.id} onChange={event => { setAxis(event.target.value); setTimeChoice(undefined); }}>{map.dimensions.map(dim => <option key={dim.id} value={dim.id}>{coverageViewLabel(dim.label)}</option>)}</select></label> : <p className="coverage-view-label">{coverageViewLabel(dimension.label)}</p>}
    {temporal && !suppliedView && <div className="coverage-controls">
      {dimension.granularity !== 'year' && <label>View<select aria-label="Coverage view" value={view.mode} onChange={event => setTimeChoice({...view, mode: event.target.value as TimeView['mode']})}>
        <option value="years">{dimension.granularity === 'season' ? 'Editions across years' : 'Years'}</option>
        <option value="months">{dimension.granularity === 'season' ? 'One year' : 'Months'}</option>
      </select></label>}
      <label>{view.mode === 'months' ? 'Year' : cycles ? 'Cycles ending in' : 'Years ending in'}
        <input aria-label="Coverage year" type="number" min={1} max={9999} value={view.year} onChange={event => {
          const year = Number(event.target.value);
          if (Number.isInteger(year) && year >= 1 && year <= 9999) setTimeChoice({...view, year});
        }} />
      </label>
    </div>}
    <p className="coverage-meaning">{statement}</p>
    {periodSummary && <div className="coverage-range">
      <p><strong>{periodSummary.range}</strong></p>
      {periodSummary.latestDate && <p>Latest dated value: {publicationDate(periodSummary.latestDate)}</p>}
      {periodSummary.missing.length > 0 && <p>No dated values: {periodSummary.missing.join(', ')}</p>}
      {periodSummary.note && <p>{periodSummary.note}</p>}
    </div>}
    <DimensionGrid key={dimension.granularity === 'category' || dimension.granularity === 'snapshot' ? dimension.id : `${dimension.id}-${view.mode}-${view.year}`} dimension={dimension} view={view} publisherNames={coveragePublisherNames(table, maps, dimension, publishers)} />
    <details className="coverage-checks">
      <summary>How this count was checked<span className="sr-only"> for {table.label}, {coverageViewLabel(dimension.label)}</span></summary>
      <div className="coverage-checks-body">
        {reading.explanation && <p>{reading.explanation}</p>}
        <p>Measured <time dateTime={map.measuredAt}>{coverageDate(map.measuredAt)} UTC</time>.{map.publishedAt && <> Release published <time dateTime={map.publishedAt}>{coverageDate(map.publishedAt)} UTC</time>.</>}</p>
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
  let periods = dimension.granularity === 'season'
    ? Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 1 }, (_, i) => String(view.mode === 'years' ? Math.max(1, view.year - 11) + i : view.year).padStart(4, '0')).flatMap(year => [`${year}-spring`, `${year}-fall`])
    : Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 12 }, (_, i) => view.mode === 'years' ? String(Math.max(1, view.year - 11) + i).padStart(4, '0') : `${String(view.year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`);
  if (cycles && view.mode === 'years') {
    // Odd years are not missing election cycles; preserve unusual labels only when recorded.
    periods = periods.filter(period => Number(period) % 2 === 0 || Object.hasOwn(dimension.buckets, period));
  }
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
  const latestFirst = dimension.fields?.length === 1 && ['congress', 'congress_text', 'year_text', 'edition_year', 'requested_year'].includes(dimension.fields[0]);
  const entries = Object.entries(dimension.buckets).sort(([a], [b]) => (latestFirst ? -1 : 1) * display(a).label.localeCompare(display(b).label, undefined, { numeric: true }) || a.localeCompare(b));
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
