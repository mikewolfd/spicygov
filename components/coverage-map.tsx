import { useState } from 'react';
import { count, type Dataset } from '../lib/catalog';
import { coverageFieldLabel, currentCoverageMap, dimensionPeriodRows, scopeLabel, type CoverageDimension, type CoverageMaps } from '../lib/coverage-map';
import { object } from '../lib/publication-evidence';
import type { TimeView } from './time-coverage';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function TableCoverageMap({ table, maps, view }: { table: Dataset; maps?: CoverageMaps; view: TimeView }) {
  const [axis, setAxis] = useState('');
  const map = currentCoverageMap(table, maps);
  if (!map) return <p className="time-caption">{maps?.tables[table.id] ? 'Published files changed; coverage needs recounting.' : 'Coverage map is not available.'}</p>;
  const preferred = map.dimensions.find(dim => ['month', 'year', 'season'].includes(dim.granularity) && dim.placedRows > 0)
    ?? map.dimensions.find(dim => dim.granularity !== 'snapshot' && dim.placedRows > 0) ?? map.dimensions[0];
  const dimension = map.dimensions.find(dim => dim.id === axis) ?? preferred;
  return <div className="coverage-map">
    {map.dimensions.length > 1 ? <label className="coverage-axis"><span>Coverage by</span><select aria-label={`Coverage dimension for ${table.label}`} value={dimension.id} onChange={event => setAxis(event.target.value)}>{map.dimensions.map(dim => <option key={dim.id} value={dim.id}>{dim.label}</option>)}</select></label> : <p className="time-caption"><strong>{dimension.label}</strong></p>}
    <DimensionGrid key={dimension.id} dimension={dimension} view={view} />
    <p className="time-caption">{dimension.meaning}</p>
    {table.id === 'court_opinion_clusters' && (dimension.fields?.includes('date_filed') || dimension.fields?.includes('date_filed_is_approximate')) && <p className="time-caption">CourtListener’s precision flag does not verify a date’s accuracy. Unusually early source dates remain unchanged and need source review.</p>}
    {dimension.unplacedRows > 0 && <p className="time-caption">{count(dimension.unplacedRows)} rows are not counted in this view.</p>}
    {(dimension.partialRows ?? 0) > 0 && <p className="time-caption">{count(dimension.partialRows ?? 0)} rows also have values that could not be placed.</p>}
    {(dimension.unmatchedRows ?? 0) > 0 && <p className="time-caption">{count(dimension.unmatchedRows ?? 0)} rows could not be matched to the recorded parent.</p>}
    {dimension.overlapping && <p className="time-caption">A row can appear in more than one cell. Counts are separate for each cell.</p>}
    {dimension.notes?.map(note => <p className="time-caption" key={note}>{note}</p>)}
    <DimensionFacts dimension={dimension} />
    {map.note && <p className="table-note">{map.note}</p>}
  </div>;
}

export function SourceCoverageSummary({ tables, maps, view }: { tables: Dataset[]; maps?: CoverageMaps; view: TimeView }) {
  const current = tables.map(table => currentCoverageMap(table, maps));
  const measured = current.filter(map => map !== undefined).length;
  const temporal = current.map(map => map?.dimensions.filter(dim => ['month', 'year', 'season'].includes(dim.granularity)) ?? []);
  const temporalTables = temporal.filter(dims => dims.length).length;
  const periods = Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 12 }, (_, i) => view.mode === 'years' ? String(Math.max(1, view.year - 11) + i).padStart(4, '0') : `${String(view.year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`);
  return <div className="time-coverage time-compact">
    {temporalTables > 0 && <div className="time-grid">{periods.map((period, i) => {
      const included = temporal.map(dims => dims.map(dim => dimensionPeriodRows(dim, period)).filter(n => n !== undefined));
      const present = included.filter(counts => counts.some(n => n! > 0)).length;
      const available = included.filter(counts => counts.length).length;
      const state = present ? 'present' : available > 0 && available === temporalTables && measured === tables.length ? 'empty' : 'unknown';
      const text = `${period}: ${present} tables with placed rows; ${available} tables have a count for this view`;
      return <span className={`time-cell time-${state}`} key={period} title={text} aria-label={text}><span>{view.mode === 'years' ? period : months[i]}</span><i aria-hidden="true">{present ? '●' : state === 'empty' ? '—' : '?'}</i></span>;
    })}</div>}
    <p className="time-caption">{measured} of {tables.length} tables mapped{temporalTables > 0 ? ` · any stated date, year, or cycle` : ' · scopes or snapshots'}</p>
  </div>;
}

function DimensionFacts({ dimension }: { dimension: CoverageDimension }) {
  const evidence = object(dimension.evidence) ? dimension.evidence : undefined;
  const empty = Array.isArray(evidence?.qualifiedEmptyRequests) ? evidence.qualifiedEmptyRequests.filter(object).filter(request => typeof request.scope === 'string') : [];
  const refusals = Array.isArray(evidence?.refusals) ? evidence.refusals.filter(object) : [];
  const anomalies = object(dimension.anomalies) ? dimension.anomalies : undefined;
  const futureRows = typeof anomalies?.futureActivityRows === 'number' ? anomalies.futureActivityRows : 0;
  return <>
    {typeof evidence?.usedCollections === 'number' && <p className="time-caption">{count(evidence.usedCollections)} matched collections.</p>}
    {futureRows > 0 && <p className="time-caption">{count(futureRows)} source values have future activity dates and are excluded from the historical grid.</p>}
    {empty.length > 0 && <details className="coverage-facts"><summary>{count(empty.length)} checked-empty requests</summary><p>These exact requests returned no records. They do not prove a whole year or source is empty.</p><ul>{empty.map((request, i) => <li key={i}>{request.scope}</li>)}</ul></details>}
    {refusals.length > 0 && <details className="coverage-facts"><summary>{count(refusals.length)} refusals or unresolved selections</summary><ul>{refusals.map((item, i) => <li key={i}>{typeof item.sourceFamily === 'string' && <strong>{item.sourceFamily.replaceAll('_', ' ')}: </strong>}{typeof item.reason === 'string' ? item.reason : 'No reason recorded.'}</li>)}</ul></details>}
  </>;
}

function DimensionGrid({ dimension, view }: { dimension: CoverageDimension; view: TimeView }) {
  const [selected, setSelected] = useState('');
  const keys = Object.keys(dimension.buckets).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (dimension.granularity === 'snapshot') return <div className="coverage-snapshot"><p><strong>Snapshot</strong> · {count(dimension.rows)} retained rows{dimension.snapshot?.publishedAt && <> · Published {new Date(dimension.snapshot.publishedAt).toLocaleDateString()}</>}</p>
    {dimension.snapshot?.asOf && <p>Calculated {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(dimension.snapshot.asOf))} UTC</p>}
    {!!dimension.snapshot?.facts?.length && <dl className="coverage-snapshot-facts">{dimension.snapshot.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}
    <span className="table-note">This view describes one saved release.</span></div>;
  if (dimension.granularity === 'category') return <CategoryGrid dimension={dimension} />;
  const periods = dimension.granularity === 'season'
    ? Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 1 }, (_, i) => String(view.mode === 'years' ? Math.max(1, view.year - 11) + i : view.year).padStart(4, '0')).flatMap(year => [`${year}-spring`, `${year}-fall`])
    : Array.from({ length: view.mode === 'years' ? Math.min(12, view.year) : 12 }, (_, i) => view.mode === 'years' ? String(Math.max(1, view.year - 11) + i).padStart(4, '0') : `${String(view.year).padStart(4, '0')}-${String(i + 1).padStart(2, '0')}`);
  return <>
    <div className={`time-grid ${dimension.granularity === 'season' ? 'coverage-period-grid' : ''}`}>{periods.map((period, index) => {
      const rows = dimensionPeriodRows(dimension, period);
      const state = rows === undefined ? 'unknown' : rows ? 'present' : 'empty';
      const text = `${period}: ${rows === undefined ? 'No count is available for this view' : `${count(rows)} ${dimension.unit ?? 'rows'}`}`;
      const label = dimension.granularity === 'season' ? period.replace('-spring', ' spring').replace('-fall', ' fall') : view.mode === 'months' ? months[index] : period;
      return <button type="button" key={period} className={`time-cell time-${state}`} aria-label={text} title={text} onClick={() => setSelected(text)}><span>{label}</span><i aria-hidden="true">{rows === undefined ? '?' : rows ? '●' : '—'}</i></button>;
    })}</div>
    {keys.length > 0 && <p className="time-caption">First {keys[0]} · last {keys[keys.length - 1]}</p>}
    {selected && <p className="time-selection" role="status">{selected}</p>}
  </>;
}

function CategoryGrid({ dimension }: { dimension: CoverageDimension }) {
  const [all, setAll] = useState(false), [selected, setSelected] = useState('');
  const label = (key: string) => scopeLabel(key, dimension.fields);
  const entries = Object.entries(dimension.buckets).sort(([a], [b]) => label(a).localeCompare(label(b), undefined, { numeric: true }));
  if (!entries.length) return <p className="time-caption">No rows have a usable scope value.</p>;
  const tuples = entries.map(([key, n]) => {
    try { const values: unknown = JSON.parse(key); return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string') ? { values: values as string[], n } : undefined; } catch { return undefined; }
  });
  if (tuples.every(tuple => tuple !== undefined)) {
    const rows = [...new Set(tuples.map(tuple => tuple!.values[1]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const columns = [...new Set(tuples.map(tuple => tuple!.values[0]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const columnLabel = (value: string) => scopeLabel(value, dimension.fields?.slice(0, 1));
    const rowLabel = (value: string) => scopeLabel(value, dimension.fields?.slice(1, 2));
    if (rows.length <= 60 && columns.length <= 30) return <div className="coverage-matrix-scroll"><table className="coverage-matrix" aria-label={dimension.label}><thead><tr><th scope="col">{coverageFieldLabel(dimension.fields?.[1])}</th>{columns.map(column => <th scope="col" key={column}>{columnLabel(column)}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row}><th scope="row">{rowLabel(row)}</th>{columns.map(column => {
      const n = dimension.buckets[JSON.stringify([column, row])] ?? 0;
      return <td key={column} className={n ? 'scope-present' : 'scope-empty'} title={`${columnLabel(column)} · ${rowLabel(row)}: ${count(n)} rows in this file`}>{n ? count(n) : '—'}</td>;
    })}</tr>)}</tbody></table><p className="time-caption">— No placed rows in this file.</p></div>;
  }
  const visible = all ? entries : entries.slice(0, 18);
  return <>
    <div className="coverage-scope-grid">{visible.map(([key, n]) => <button type="button" key={key} className="coverage-scope-cell" title={`${label(key)}: ${count(n)} ${dimension.unit ?? 'rows'}`} onClick={() => setSelected(`${label(key)}: ${count(n)} ${dimension.unit ?? 'rows'}`)}><span>{label(key)}</span><strong>{count(n)}</strong></button>)}</div>
    {entries.length > 18 && <button className="details-toggle" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${count(entries.length)} scopes`}</button>}
    {selected && <p className="time-selection" role="status">{selected}</p>}
  </>;
}
