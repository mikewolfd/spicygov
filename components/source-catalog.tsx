import { useEffect, useMemo, useRef, useState } from 'react';
import { SourceCatalogReader, type CatalogManifest, type CatalogCollection, type CatalogDetail, type CatalogFilePage, type CatalogCoverage, type PublicationObservation, type CatalogTable, coverageStages } from '../lib/source-catalog';
import type { Dataset } from '../lib/catalog';
import { CatalogTableEvidence } from './catalog-table-evidence';
import { CatalogFileEvidence } from './catalog-file-evidence';
import { CatalogRetainedFiles } from './catalog-retained-files';
import { useArchiveMirror } from '../lib/use-archive-mirror';
import { collectionTitle, collectionDescription, collectionLimitations, fileAvailabilitySummary } from '../lib/source-browser';
import { collectionMatches, loadDiscoveryPeriods, periodSummary } from '../lib/catalog-discovery';
const stateLabels: Record<string, string> = {
  held: 'Files saved', reviewed: 'Evidence reviewed', 'unknown-scope': 'Full coverage unknown',
  'publication-pinned': 'Publication version recorded', 'inventory-unresolved': 'Source files not linked',
  'integration-unresolved': 'Published-data connection needs checking', complete: 'Recorded scope checked', partial: 'Partial collection',
  'external-by-choice': 'Kept elsewhere by choice', 'parse-error': 'Saved response contains an error',
  'refused-source': 'Saved refusal or source error', 'failed-response': 'Saved failed request',
  'incomplete-response': 'Incomplete saved response', 'partial-source': 'Partial saved source',
  'unclassified-source': 'Saved content not classified',
  'missing-bytes': 'Source files missing', 'receipt-only': 'Download record only', 'known-not-acquired': 'Not downloaded',
  'observed-traversal-complete-stability-unqualified': 'Source pages checked; changes during collection unknown',
  'current-publication-source-and-receipt-qualified-scoped': 'Current publication checked for the stated scope',
};
function stateLabel(state: string) { return stateLabels[state] ?? 'Other recorded state (see technical evidence)'; }
function text(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value); }
export function CoverageAccounting({ coverage }: { coverage: CatalogCoverage }) {
  return <section aria-label="Source coverage accounting"><h4>Source coverage</h4>
    <p>Each measurement applies to its stated source version, period and unit. Expected inventories and retained-file counts can use different units; compare the scoped review results before claiming complete coverage.</p>
    <div className="source-table-scroll"><table className="catalog-route-table"><thead><tr><th scope="col">Stage</th><th scope="col">Recorded measurement</th><th scope="col">Scope and evidence</th></tr></thead><tbody>
      {coverageStages.map(stage => { const data = coverage.stages[stage]; return <tr key={stage}><th scope="row">{stage.charAt(0).toUpperCase() + stage.slice(1)}</th>
        <td>{data.measurements.length ? data.measurements.map((item, i) => <p key={i}>{item.count.toLocaleString()} {item.unit}</p>) : data.status === 'scope-withheld' ? 'Selected scope cannot be shown publicly.' : 'Unknown. No qualified measurement recorded.'}</td>
        <td>{data.measurements.map((item, i) => <div key={i}>{item.scope.table && <p>Table: {item.scope.table}</p>}{item.scope.qualificationScope && <p>{item.scope.qualificationScope}</p>}{item.scope.capturedAt && <p>Publication snapshot: {item.scope.capturedAt}</p>}{item.scope.observationId && <p>Observation: <code>{item.scope.observationId}</code></p>}{item.routeId && <p>Route: <code>{item.routeId}</code></p>}<p>{item.period ? Object.values(item.period).join(' · ') : 'Covered period unknown.'}</p><p>{item.evidenceBasis}</p>{item.version && <code>{item.version}</code>}</div>)}</td>
      </tr>; })}
    </tbody></table></div>
  </section>;
}
export function RetainedPublications({ observations }: { observations: PublicationObservation[] }) {
  return <section aria-label="Retained publication observations"><h4>Retained publication observations</h4>
    <p>These captured publication descriptions retain exact artifact and member identities. They do not establish current live status, source completeness or member content verification. Historical inventory and coverage remain separately recorded.</p>
    {observations.map(item => <details key={item.id}><summary>{item.family} · captured {item.captureAt}</summary>
      <p>Client capture time: {item.captureAt}<br />Family publication time: {item.familyPublishedAt}<br />Server HTTP Date: {item.serverDate}</p>
      <p>{item.associationStatus === 'unqualified' ? 'Inventory association unqualified. No family alias or coverage assignment is inferred.' : 'Associated by exact inventory family and table names.'}</p>
      <p>Response: <code>{item.responseSha256}</code><br />Artifact: <code>{item.artifactDigest}</code><br />Artifact prefix: <code>{item.artifactPrefix}</code></p>
      <ul>{item.tables.map(table => <li key={table.table}><strong>{table.table}</strong> · {table.rows.toLocaleString()} rows · {table.bytes.toLocaleString()} bytes
        {table.sha256 ? <p>Member: <code>{table.sha256}</code></p> : <details><summary>Partition member identities</summary><ul>{table.members?.map(member => <li key={member.key}><code>{member.key}</code> · {member.rows.toLocaleString()} rows · {member.bytes.toLocaleString()} bytes<br /><code>{member.sha256}</code></li>)}</ul></details>}
      </li>)}</ul>
    </details>)}
  </section>;
}
export function TableDestinations({ destinations, tables }: { destinations: CatalogTable[]; tables: Dataset[] }) {
  return destinations.length ? <ul className="readable-inputs">{destinations.map(item => {
    const current = tables.find(table => table.id === item.id);
    return <li key={`${item.family}-${item.id}`}><strong>{current?.label ?? item.id.replaceAll('_', ' ')}</strong><details><summary>Recorded dataset identifiers</summary><p>{item.id} · {item.family} · {item.status}</p></details>
      <CatalogTableEvidence destination={item} current={current} />
      {current && <a href={`/?table=${encodeURIComponent(current.id)}&view=about`}>View published dataset →</a>}
    </li>;
  })}</ul> : <p>No published dataset is linked here.</p>;
}
export function CollectionDetail({ reader, manifest, collection, tables }: { reader: SourceCatalogReader; manifest: CatalogManifest; collection: CatalogCollection; tables: Dataset[] }) {
  const mirror = useArchiveMirror(reader,manifest);
  const pageRequest = useRef<AbortController | undefined>(undefined);
  const [detail, setDetail] = useState<CatalogDetail>(), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [page, setPage] = useState<CatalogFilePage>(), [pageIndex, setPageIndex] = useState<number>(), [pageError, setPageError] = useState(''), [loadingPage, setLoadingPage] = useState(false);
  useEffect(() => { const controller = new AbortController(); pageRequest.current?.abort(); setLoadingPage(false); setDetail(undefined); setError(''); setPage(undefined); setPageIndex(undefined); setPageError(''); void reader.detail(manifest, collection, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); return () => { controller.abort(); pageRequest.current?.abort(); }; }, [reader, manifest, collection, retry]);
  async function loadPage(index: number) { if (!detail) return; pageRequest.current?.abort(); const controller = new AbortController(); pageRequest.current = controller; setLoadingPage(true); setPageError(''); try { const next = await reader.files(manifest, detail, index, controller.signal); if (!controller.signal.aborted) { setPage(next); setPageIndex(index); } } catch (reason) { if (!controller.signal.aborted) setPageError((reason as Error).message); } finally { if (!controller.signal.aborted) setLoadingPage(false); } }
  if (error) return <p role="alert">Collection details unavailable: {error}. <button onClick={() => setRetry(retry + 1)}>Retry details</button></p>;
  if (!detail) return <p role="status">Loading collection details…</p>;
  return <div className="catalog-detail">
    <p>{periodSummary(detail.collection.periods)}</p>
    <ul>{collectionLimitations(collection).map(note => <li key={note}>{note}</li>)}</ul>
    <details><summary>Source dates, coverage measurements and history</summary>
    {detail.coverage && <CoverageAccounting coverage={detail.coverage} />}
    {detail.publicationObservations && <RetainedPublications observations={detail.publicationObservations} />}
    <h4>Sources and recorded dates</h4><p>Each route keeps its recorded scope. Overlap or replacement requires supporting evidence.</p>
    {detail.routes.length ? <div className="source-table-scroll"><table className="catalog-route-table"><thead><tr><th scope="col">Route</th><th scope="col">Delivery and lifecycle</th><th scope="col">Custodian and behavior</th><th scope="col">Period and evidence basis</th></tr></thead><tbody>{detail.routes.map(route => <tr key={route.id}><th scope="row">{route.accessUrl ? <a href={route.accessUrl} target="_blank" rel="noreferrer">{route.label} ↗</a> : route.label}{route.status && <span className="table-note">{route.status}</span>}{route.note && <p>{route.note}</p>}</th><td>{route.deliveryMethod}<br />{route.lifecycle}</td><td>{route.custodian}<br />{route.contentBehavior}</td><td>{route.periods.length ? route.periods.map((period, i) => <p key={i}><strong>{period.kind}: {period.label}</strong><br />{period.start && <>{period.start}{period.end && `–${period.end}`}<br /></>}{period.basis}</p>) : 'Period unknown'}</td></tr>)}</tbody></table></div> : <p>No acquisition route recorded.</p>}
    </details>
    <h4>Published datasets and build checks</h4><TableDestinations destinations={detail.tables} tables={tables} />
    <details><summary>Source choices and technical history</summary>
    {!!detail.planned.length && <><h4>Source choices and planned work</h4><ul>{detail.planned.map(item => <li key={text(item.id)}>{item.table ? `${text(item.table)}: ` : ''}{text(item.status)}{typeof item.routeId === 'string' && <span className="table-note">Route: {detail.routes.find(route => route.id === item.routeId)?.label ?? text(item.routeId)}</span>}{item.reason ? ` · ${text(item.reason)}` : ''}</li>)}</ul></>}
    {!!detail.observations.length && <><h4>Recorded observations</h4><ul>{detail.observations.map(item => <li key={text(item.id)}>{text(item.status)}{item.observedAt ? ` · ${text(item.observedAt)}` : ''}{item.scope ? ` · ${text(item.scope)}` : ''}{item.note ? ` · ${text(item.note)}` : ''}{item.declaredCount !== undefined && <span className="table-note">Advertised: {text(item.declaredCount)} · Enumerated: {item.observedCount === undefined ? 'unknown' : text(item.observedCount)}</span>}</li>)}</ul></>}
    {!!detail.relationships.length && <><h4>Route relationships</h4><ul>{detail.relationships.map(item => <li key={text(item.id)}>{text(item.fromId)} → {text(item.toId)} · {text(item.kind)}{item.scope ? ` · ${text(item.scope)}` : ''}{item.note ? ` · ${text(item.note)}` : ''}</li>)}</ul></>}
    </details>
    <h4>Source files</h4><p>{detail.files.total.toLocaleString()} file references recorded. Several references may point to the same saved file.</p>
    {detail.files.pages.length > 0 && <button disabled={loadingPage} onClick={() => void loadPage(pageIndex ?? 0)}>{page ? 'Reload this file page' : 'Load first file page'}</button>}
    {loadingPage && <p role="status">Loading one file page…</p>}{pageError && <p role="alert">File page unavailable: {pageError}</p>}
    {page && <><ul className="catalog-files">{page.files.map(file => <li key={file.id}><strong>{file.name}</strong><span>{fileAvailabilitySummary(file)}</span><CatalogFileEvidence file={file} mirror={mirror} /><details><summary>Recorded file identifiers</summary><p>Recorded state: {file.status}</p><code>{file.id}</code>{file.routeId && <p>Source identifier: <code>{file.routeId}</code></p>}</details>{reader.internal && <details><summary>Local file details</summary><p>Recorded state: {file.status}</p>{file.routeId && <p>Source identifier: <code>{file.routeId}</code></p>}{file.localPath && <code>{file.localPath}</code>}{file.encodedBytes !== undefined && <span>{file.encodedBytes.toLocaleString()} stored bytes</span>}{file.verification && <span>Verification: {file.verification}</span>}</details>}</li>)}</ul><div className="source-list-toolbar"><button disabled={loadingPage || pageIndex === 0} onClick={() => void loadPage(pageIndex! - 1)}>Previous files</button><span>Page {pageIndex! + 1} of {detail.files.pages.length}</span><button disabled={loadingPage || pageIndex === detail.files.pages.length - 1} onClick={() => void loadPage(pageIndex! + 1)}>Next files</button></div></>}
    <CatalogRetainedFiles key={`${manifest.generation}-${detail.collection.id}`} reader={reader} manifest={manifest} detail={detail} mirror={mirror} />
    {reader.internal && !!detail.internalOnly && <details><summary>Local evidence and lineage</summary><pre className="catalog-internal">{JSON.stringify(detail.internalOnly, null, 2)}</pre></details>}
    <details><summary>Collection identifier</summary><code>{collection.id}</code></details>
  </div>;
}
export function SourceCatalog({ tables = [], internal = false, manifestUrl, retry = 0 }: { tables?: Dataset[]; internal?: boolean; manifestUrl?: string; retry?: number }) {
  const reader = useMemo(() => new SourceCatalogReader(manifestUrl ?? '/source-catalog/manifest.json', internal), [manifestUrl, internal]);
  const [manifest, setManifest] = useState<CatalogManifest>(), [error, setError] = useState(''), [reload, setReload] = useState(0), [query, setQuery] = useState(''), [status, setStatus] = useState(''), [limit, setLimit] = useState(20), [openId, setOpenId] = useState<string>();
  const [period, setPeriod] = useState(''), [includeUnknown, setIncludeUnknown] = useState(true);
  const [discovery, setDiscovery] = useState<Awaited<ReturnType<typeof loadDiscoveryPeriods>>>(), [loadingPeriods, setLoadingPeriods] = useState(false);
  const needsPeriods = !!(query.trim() || period.trim());
  useEffect(() => { const controller = new AbortController(); setManifest(undefined); setError(''); setOpenId(undefined); void reader.manifest(controller.signal).then(value => { if (!controller.signal.aborted) setManifest(value); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }); return () => controller.abort(); }, [reader, retry, reload]);
  useEffect(() => { setDiscovery(undefined); }, [manifest]);
  useEffect(() => {
    if (!manifest || !needsPeriods) { setLoadingPeriods(false); return; }
    if (discovery?.generation === manifest.generation) return;
    const controller = new AbortController(); setLoadingPeriods(true);
    void loadDiscoveryPeriods(reader, manifest, controller.signal).then(value => { if (!controller.signal.aborted) { setDiscovery(value); setLoadingPeriods(false); } });
    return () => controller.abort();
  }, [reader, manifest, needsPeriods]);
  const items = manifest?.collections.filter(item => collectionMatches(item, tables, discovery?.periods[item.id] ?? item.periods, query, status, period, includeUnknown)) ?? [];
  const statuses = [...new Set(manifest?.collections.flatMap(item => item.statuses) ?? [])].sort();
  return <section className="shared-source-catalog" aria-labelledby="catalog-title"><h2 id="catalog-title">Source collections{internal ? ' · local operations' : ''}</h2><p>Find saved source files and published datasets, see known gaps, and choose where to look next.</p>
    {error ? <p role="alert">Source catalog unavailable: {error}. {!internal && 'Published tables and their coverage remain available.'} <button onClick={() => setReload(reload + 1)}>Retry catalog</button></p> : !manifest ? <p role="status">Loading source catalog…</p> : <>
      <p className="checked-date">Catalog input snapshot: {new Date(manifest.generatedAt).toLocaleString()}</p><details><summary>Catalog version identifier</summary><code>{manifest.generation}</code></details>
      <div className="sources-controls"><label className="source-search"><span>Find a collection, dataset or table</span><input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(20); }} /></label><label><span>Source state</span><select value={status} onChange={event => { setStatus(event.target.value); setLimit(20); }}><option value="">All states</option>{statuses.map(item => <option key={item} value={item}>{stateLabel(item)}</option>)}</select></label><label><span>Data year or period</span><input type="search" placeholder="e.g. 2024 or election cycle" value={period} onChange={event => { setPeriod(event.target.value); setLimit(20); }} /></label><label><input type="checkbox" checked={includeUnknown} onChange={event => { setIncludeUnknown(event.target.checked); setLimit(20); }} /> Include unknown periods</label><button onClick={() => { setQuery(''); setStatus(''); setPeriod(''); setIncludeUnknown(true); setLimit(20); }}>Clear collection filters</button></div>
      <p className="table-note">Data periods describe recorded source scope, which may be requested or partial. Download dates do not establish data coverage. Unknown periods do not mean data is missing.</p>
      {loadingPeriods && <p role="status">Loading recorded data periods… Search results may change.</p>}
      {!!discovery?.failures.length && <p role="alert">Data periods unavailable for {discovery.failures.length} collections. Those collections stay visible when narrowing by period.</p>}
      <p aria-live="polite">{items.length} of {manifest.collections.length} known collections</p>{!items.length && !loadingPeriods && <p>No matching collections.</p>}
      {items.slice(0, limit).map(item => <div className="source-group" key={item.id}><button className="source-group-toggle" aria-expanded={openId === item.id} aria-controls={`catalog-${item.id}`} onClick={() => setOpenId(openId === item.id ? undefined : item.id)}><span><h3>{collectionTitle(item)}</h3><span className="publisher-caption">{item.publisher ?? 'Publisher not recorded'}</span><span className="table-note">{collectionDescription(item)}</span><span className="table-note">{collectionLimitations(item).join(' ')}</span><span className="table-note">{periodSummary(discovery?.periods[item.id] ?? item.periods)}</span>{item.tables.includes('sam_entities') && <span className="table-note">SAM registration years describe registrations, not historical database snapshots.</span>}</span><span className="group-count">{item.holdings.objects.toLocaleString()} distinct files saved<span>{item.holdings.missing.toLocaleString()} recorded files missing · {item.tables.length} linked datasets</span></span><span className="fold-symbol" aria-hidden="true">{openId === item.id ? '−' : '+'}</span></button>{openId === item.id && <div className="source-body" id={`catalog-${item.id}`}><CollectionDetail reader={reader} manifest={manifest} collection={item} tables={tables} /></div>}</div>)}
      {items.length > limit && <button className="show-more" onClick={() => setLimit(limit + 20)}>Show more collections</button>}
    </>}
  </section>;
}
