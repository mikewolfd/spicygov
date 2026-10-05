import { Fragment, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { count, publicationDate, type Dataset } from '../lib/catalog';
import { useCollection } from '../lib/use-collection';
import { useSourceDirectory } from '../lib/use-source-directory';
import { evidenceLinkLabel, sourceCatalogMessage, sourceMetadataMessage, sourceMetadataSummary, sourceSections, collectionSteps, filterEntries, methodLabels, parseGenerationDetails, reviewedGenerationLinks, sourceEntries, type GenerationDetails, type SourceEntry } from '../lib/source-directory';
import { loadCoveragePublishers, type CoveragePublishers } from '../lib/coverage-publishers';
import { loadObservationPreview, type ObservationPreview } from '../lib/source-observations';
import { fetchJson, type EvidenceLink } from '../lib/publication-evidence';
import { TableProvenance } from '../components/table-provenance';
import type { TimeView } from '../components/time-coverage';
import { TableCoverageMap } from '../components/coverage-map';
import { currentCoverageMap, parseCoverageMaps, textAvailabilityDetails, type CoverageMaps } from '../lib/coverage-map';
import '../app/globals.css';
import './style.css';

function EvidenceLinks({ links }: { links: EvidenceLink[] }) {
  return <ul className="evidence-links">{links.map((link, index) => <li key={`${link.url}-${index}`}><a href={link.url} target="_blank" rel="noreferrer">{evidenceLinkLabel(link.label)} ↗</a></li>)}</ul>;
}
type ReadableDetails = GenerationDetails & { preview?: ObservationPreview; previewUnavailable?: boolean };
function SourceRow({ entry, catalog, loadDetails, coverageMaps, timeView, publishers, onRetry, coverageLoading }: {
  entry: SourceEntry; catalog: Dataset[]; coverageMaps?: CoverageMaps; timeView: TimeView; publishers?: CoveragePublishers; onRetry: () => void; coverageLoading: boolean;
  loadDetails: (table: Dataset) => Promise<ReadableDetails>;
}) {
  const [open, setOpen] = useState(false), [details, setDetails] = useState<ReadableDetails>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const { table, review: audit } = entry, publication = table.publication, receipts = publication?.nativeReceipts;
  const textDetails = textAvailabilityDetails(table, coverageMaps);
  const reviewedLinks = reviewedGenerationLinks(entry), copy = audit?.copy;
  const titleUrl = entry.explorer ? `/?table=${encodeURIComponent(table.id)}&view=about` : table.members[0]?.url;
  async function inspect() {
    setLoading(true); setError('');
    try { setDetails(await loadDetails(table)); } catch { setError('We could not load the recorded inputs. Try again.'); }
    finally { setLoading(false); }
  }
  return <Fragment>
    <tr>
      <th scope="row"><span className="source-table-title">{table.label}</span>{entry.explorer && <a className="table-note" href={titleUrl}>Explore records →</a>}<p className="table-description"><strong>Contains:</strong> {copy?.summary || table.summary || 'Description not recorded.'}</p>
        {!entry.explorer && <span className="table-note">Data available as a download</span>}
        {entry.historicalAttribution && <span className="table-note">Source list may be out of date</span>}
        <button className="details-toggle" aria-expanded={open} aria-controls={`details-${table.id}`} onClick={() => { setOpen(!open); if (!open && !details && !loading && publication?.kind === 'generation') void inspect(); }}>{open ? '−' : '+'} Source & limits<span className="sr-only"> for {table.label}</span></button>
      </th>
      <td data-label="Available records"><strong className="row-count">{count(table.rows)} rows</strong>{table.rows === 0 && <span className="empty-badge">No rows</span>}
        <span className="table-note">{table.published ? `Data release: ${publicationDate(table.published)}` : 'Release date not recorded'}</span>
        {table.modelGenerated && <span className="empty-badge">AI-generated</span>}
        {textDetails.map(detail => <span className="table-note" key={detail.label}><strong>{detail.label}:</strong> {detail.rows === 0 ? 'No rows' : detail.notSaved === detail.rows ? 'Not saved' : <>{count(detail.withText)} with text{detail.notSaved > 0 && <> · {count(detail.notSaved)} not saved</>}{detail.blank > 0 && <> · {count(detail.blank)} blank</>}</>}</span>)}
      </td>
      <td data-label="Collection"><dl className="method-list">{audit?.methods.length ? collectionSteps(audit.methods).map(step => <div key={step.label}><dt>{step.label}</dt><dd>{step.values.join(' · ')}</dd></div>) : <div><dt>Collection</dt><dd>Not yet reviewed</dd></div>}</dl></td>
      <td data-label="Coverage"><p className="coverage-summary"><strong>Data held:</strong> {copy?.scope ?? 'Collection scope has not been reviewed.'}</p>
        <p className="coverage-gap"><strong>Missing or unknown:</strong> {copy?.gaps[0] ?? 'Source completeness has not been established.'}</p>{coverageLoading ? <p className="coverage-unavailable">Loading coverage counts…</p> : <TableCoverageMap table={table} maps={coverageMaps} view={timeView} publishers={publishers} onRetry={onRetry} />}
      </td>
    </tr>
    {open && <tr className="source-detail-row"><td colSpan={4} id={`details-${table.id}`}>
      <div className="source-detail-grid"><section><h3>How collected</h3>
        {entry.explorer && sourceMetadataMessage(table.metadataState) && <p className="metadata-status">{sourceMetadataMessage(table.metadataState)}</p>}

        {entry.historicalAttribution ? <><p className="review-date">Source names come from an earlier review and may be incomplete.</p><EvidenceLinks links={audit?.sources.flatMap(source => source.url ? [{ label: source.name, url: source.url }] : []) ?? []} /></> : entry.explorer ? <TableProvenance table={table} catalog={catalog} compact /> : null}
        {audit?.evidence.length ? <details className="code-evidence"><summary>Code references</summary><EvidenceLinks links={audit.evidence.map(link => ({ ...link, label: link.url.split('/').pop() || 'Source code' }))} /></details> : null}
      </section><section><h3>Additional limits</h3>{copy?.gaps.length && copy.gaps.length > 1 ? <ul className="gap-list">{copy.gaps.slice(1).map(gap => <li key={gap}>{gap}</li>)}</ul> : <p>No additional reviewed limits are listed.</p>}
      </section></div>
      <section className="readable-evidence"><h3>Evidence for this release</h3><p className="review-date">Receipts link records to saved source material or processing steps. This page does not check individual receipts.</p>
        <p>{receipts ? 'Record receipts are available. They connect records to saved source material or a processing step; they do not always identify an original document.' : 'No record receipts are listed for this table. The collection notes describe its sources, but do not establish each row’s origin.'}</p>
        {publication?.kind === 'comments' && <p>This export records the file size, row count and checksum. The download can change after publication; it does not provide a source receipt for each comment.</p>}
        {publication?.kind === 'rulemaking' && <p>This is a calculated dataset. Its publication records the output files; the collection notes above explain the inputs and matching limits.</p>}
        {loading && <p role="status">Reading the recorded inputs and source observations…</p>}
        {error && <p role="alert">{error} <button onClick={inspect}>Retry</button></p>}
        {details && <>
          {details.parents.length > 0 && <><h4>Built using</h4><ul className="readable-inputs">{details.parents.map(parent => {
            const input = catalog.find(item => item.id === parent.table);
            return <li key={parent.table}><strong>{input?.label ?? parent.table.replaceAll('_', ' ')}</strong><span>A saved version was used for this release.</span><small>The current table may contain newer data.</small></li>;
          })}</ul></>}
          {details.carriedForward && <p>This table was carried over from an earlier release; publication does not mean the source was collected again.</p>}
          {details.preview?.inherited && <p>Earlier source records remain in this release. These request examples do not describe their full collection history.</p>}
          {!!details.preview?.observations.length && <><h4>Observed source requests</h4><p className="review-date">Examples from this release’s collection log, shared by its tables. These do not prove which request produced an individual row.</p><ul className="readable-inputs">{details.preview.observations.map((item, i) => <li key={i}><strong>{item.source}{(item.examples ?? 1) > 1 && <> · {item.examples} request examples</>}</strong><span className="request-endpoint">Endpoint: {item.endpoint}</span>{item.selection && <span className="request-endpoint">Recorded filters: {item.selection}</span>}<span>{item.purpose ?? 'Request purpose not recorded'}</span><span>{item.observedAt ? publicationDate(item.observedAt) : 'Observation date not recorded'}{item.lastObservedAt && publicationDate(item.lastObservedAt) !== publicationDate(item.observedAt) && <>–{publicationDate(item.lastObservedAt)}</>} · {item.status === undefined ? 'Response status unknown' : item.status >= 200 && item.status < 300 ? 'Response received' : `Response status ${item.status}`}</span><small>{item.saved === true ? 'Response content saved' : item.saved === false ? 'Response content not saved' : 'Saved content not documented'}</small></li>)}</ul></>}
          {details.preview?.partial && <p className="review-date">Showing a limited preview of the source log, not the full collection history.</p>}
          {details.previewUnavailable && <p>The source log could not be read. The collection notes above remain available.</p>}
          {!details.previewUnavailable && !details.preview?.observations.length && <p>No source requests are shown in this preview. That does not mean none were made.</p>}
        </>}
        <details className="code-evidence"><summary>Technical files & identifiers</summary>
          <p>Exact file versions and identifiers for this release. File checksums are not verified by this page.</p><p>Table ID: <code>{table.id}</code></p>
          <EvidenceLinks links={[...(publication ? [{label:'Publication file (JSON)',url:publication.recordUrl}] : []), ...(receipts ? [{label:'Receipt file (Parquet)',url:receipts.url}] : []), ...(details?.links ?? reviewedLinks), ...(!entry.explorer && table.members[0] ? [{label:'Data file (Parquet)',url:table.members[0].url}] : [])]} />
          {!!details?.identityFields.length && <p>Record identifiers: {details.identityFields.join(', ')}</p>}
        </details>
      </section>

    </td></tr>}
  </Fragment>;
}
function SourcesPage() {
  const [coverageMaps, setCoverageMaps] = useState<CoverageMaps>();
  const [coveragePublishers, setCoveragePublishers] = useState<CoveragePublishers>();
  const [publisherError, setPublisherError] = useState(false);
  const [timeError, setTimeError] = useState(false);
  const [timeView, setTimeView] = useState<TimeView>({year: new Date().getFullYear(), mode: 'years'});

  const [query, setQuery] = useState(''), [method, setMethod] = useState(''), [evidence, setEvidence] = useState('');
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    const controller = new AbortController(); setTimeError(false);
    void fetchJson('/coverage-maps.v1.json', controller.signal).then(parseCoverageMaps).then(setCoverageMaps).catch(() => { if (!controller.signal.aborted) { setCoverageMaps(undefined); setTimeError(true); } });
    return () => controller.abort();
  }, [retry]);
  const { tables, metadata, error, warnings: publicationWarnings = [], publicationsPending } = useCollection(retry);
  const { review, warnings: reviewWarnings, pending } = useSourceDirectory(retry);
  const warnings = [...publicationWarnings, ...reviewWarnings];
  const entries = useMemo(() => sourceEntries(tables, [], review), [tables, review]);
  const allTables = useMemo(() => entries.map(entry => entry.table), [entries]);
  useEffect(() => {
    const controller = new AbortController(); setCoveragePublishers(undefined); setPublisherError(false);
    void loadCoveragePublishers(allTables, coverageMaps, controller.signal).then(value => {
      if (!controller.signal.aborted) setCoveragePublishers(value);
    }).catch(() => { if (!controller.signal.aborted) setPublisherError(true); });
    return () => controller.abort();
  }, [allTables, coverageMaps, retry]);
  const filtered = useMemo(() => filterEntries(entries, query, method, evidence), [entries, query, method, evidence]);
  const sections = useMemo(() => sourceSections(filtered), [filtered]);
  const metadataSummary = sourceMetadataSummary(entries);
  const filtering = !!query || !!method || !!evidence;
  function clearFilters() { setQuery(''); setMethod(''); setEvidence(''); setGroupOverrides({}); }
  function changeFilter(action: () => void) { action(); setGroupOverrides({}); setLimits({}); }
  const generationCache = useMemo(() => new Map<string, Promise<unknown>>(), [retry]);
  const observationCache = useMemo(() => new Map<string, Promise<ObservationPreview>>(), [retry]);
  function loadDetails(table: Dataset) {
    const url = table.publication!.recordUrl;
    let request = generationCache.get(url);
    if (!request) {
      request = fetchJson(url).catch(error => { generationCache.delete(url); throw error; });
      generationCache.set(url, request);
    }
    return request.then(async raw => {
      const details = parseGenerationDetails(raw, table);
      const log = details.links.find(link => link.label === 'Source observation journal');
      if (!log) return details;
      let preview = observationCache.get(log.url);
      if (!preview) { preview = loadObservationPreview(log.url).catch(error => { observationCache.delete(log.url); throw error; }); observationCache.set(log.url, preview); }
      try { return { ...details, preview: await preview }; } catch { return { ...details, previewUnavailable: true }; }
    }).catch(error => { generationCache.delete(url); throw error; });
  }
  return <div className="sources-page">
    <a href="#sources" className="skip-link">Skip to sources</a>
    <header className="topbar"><a className="wordmark" href="/">spicygov<span className="brand-star" aria-hidden="true">✳</span></a><nav aria-label="Main"><a href="/">Explore</a><span className="nav-active" aria-current="page">Sources</span><a href="/mcp/">MCP</a><a href="https://docs.spicygov.ai">Data docs</a></nav></header>
    <main id="sources" className="sources-content">
      <div className="sources-heading"><h1>Sources</h1><p className="sources-intro">See what data we hold, the periods it covers, and what is missing.</p></div>
      <nav className="topic-shortcuts" aria-label="Jump to topic">{sections.map(section => <a key={section.id} href={`#${section.id}`}>{section.topic}<span>{section.groups.reduce((n,g) => n + g.entries.length, 0)}</span></a>)}</nav>
      <section className="time-controls" aria-label="Time coverage">
        <label>View <select value={timeView.mode} onChange={event => setTimeView({...timeView, mode:event.target.value as TimeView['mode']})}><option value="years">Years</option><option value="months">Months</option></select></label>
        <label>{timeView.mode === 'years' ? 'Through year' : 'Year'} <input aria-label="Coverage year" type="number" min="1" max="9999" value={timeView.year} onChange={event => { const year = Number(event.target.value); if (Number.isInteger(year) && year >= 1 && year <= 9999) setTimeView({...timeView,year}); }} /></label>
        <p className="time-legend"><span>● Records counted</span><span>— No records counted</span><span>? Count unavailable</span></p>
        <details className="time-explanation"><summary>What the colors mean</summary><p>Green shows records in the saved data, not a complete source. Empty periods do not prove the publisher had no records. Each table names the date, cycle, edition or snapshot being counted. Counts can include duplicates.</p></details>
        {timeError ? <p role="status">Coverage counts could not load. <button onClick={() => setRetry(retry + 1)}>Retry coverage</button></p> : !coverageMaps ? <p role="status">Loading coverage counts…</p> : <p className="checked-date">Coverage checked: {new Date(coverageMaps.generatedAt).toLocaleDateString()}</p>}
      </section>
      <div className="sources-controls">
        <label className="source-search"><span>Find a table or source</span><input type="search" placeholder="Try scorecards, bulk, comments…" value={query} onChange={event => changeFilter(() => setQuery(event.target.value))} /></label>
        <label><span>How collected</span><select value={method} onChange={event => changeFilter(() => setMethod(event.target.value))}><option value="">All methods</option>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Show</span><select value={evidence} onChange={event => changeFilter(() => setEvidence(event.target.value))}><option value="">All published tables</option><option value="native">Tables with receipt files</option><option value="journal">With reviewed source logs</option><option value="separate">Download-only tables</option><option value="empty">Empty tables</option><option value="unreviewed">Collection not reviewed</option><option value="source-details">Source descriptions need attention</option></select></label>
        <button onClick={clearFilters}>Clear filters</button>
      </div>
      <div className="source-list-toolbar"><p className="sources-count" aria-live="polite">{filtered.length} of {entries.length} published tables · {filtered.filter(entry => entry.table.publication?.nativeReceipts).length} with receipt files{publicationsPending ? ' · Checking other publications…' : ''}</p><button onClick={() => { setExpanded(true); setGroupOverrides({}); }}>Expand all</button><button onClick={() => { setExpanded(false); setGroupOverrides(Object.fromEntries(sections.flatMap(section => section.groups.map(group => [group.id, false])))); }}>Collapse all</button><button onClick={() => setRetry(retry + 1)}>Reload data</button></div>
      <p className="sources-basis">Counts follow the latest published files. {review ? <>Collection notes reviewed {publicationDate(review.reviewedAt)}</> : pending ? 'Loading collection notes…' : 'Collection notes unavailable.'}</p>
      {metadataSummary ? <p className="metadata-status" role="status">{metadataSummary} This concerns descriptions and connections, not record counts. <button onClick={() => changeFilter(() => { setQuery(''); setMethod(''); setEvidence('source-details'); })}>Show affected tables →</button></p> : sourceCatalogMessage(metadata) && tables.length > 0 ? <p className="metadata-status" role="status">{sourceCatalogMessage(metadata)} <button onClick={() => setRetry(retry + 1)}>Retry source details</button></p> : null}
      {publisherError && <p className="metadata-status" role="status">Publisher names could not load. Recorded IDs remain visible. <button onClick={() => setRetry(retry + 1)}>Retry publisher names</button></p>}
      {error && <p role="alert">Main table list: {error} <button onClick={() => setRetry(retry + 1)}>Retry table list</button></p>}
      {warnings.map(warning => <p className="metadata-status" role="status" key={warning}>{warning} <button onClick={() => setRetry(retry + 1)}>Retry</button></p>)}
      {!entries.length && !error && <p role="status">Loading published tables…</p>}
      {!!entries.length && !sections.length && <p className="empty-results">No matching tables. <button onClick={clearFilters}>Clear filters</button></p>}
      <div className="source-list">{sections.map(section => <section className="topic-section" id={section.id} key={section.id} aria-labelledby={`${section.id}-title`}>
        <h2 id={`${section.id}-title`}>{section.topic}</h2>
        {section.groups.map(group => {
          const isOpen = groupOverrides[group.id] ?? (expanded || filtering);
          const limit = limits[group.id] ?? 8;
          const items = group.entries;
          const measured = items.filter(entry => currentCoverageMap(entry.table, coverageMaps)).length;
          return <div className="source-group" key={group.id}>
            <button className="source-group-toggle" aria-expanded={isOpen} aria-controls={`${group.id}-body`} onClick={() => setGroupOverrides(previous => ({...previous, [group.id]: !isOpen}))}>
              <span><h3>{group.name}</h3><span className="publisher-caption">{group.publishers.length ? `Sources: ${group.publishers[0].name}${group.publishers.length > 1 ? ` + ${group.publishers.length - 1} other ${group.publishers.length === 2 ? 'source' : 'sources'}` : ''}` : 'Publisher not recorded'}{group.historical ? ' · includes earlier source notes' : ''}</span></span>
              <span className="group-count">{items.length} {items.length === 1 ? 'table' : 'tables'}<span>{coverageMaps ? `${measured} with coverage maps` : timeError ? 'Counts unavailable' : 'Loading coverage…'}</span></span><span className="fold-symbol" aria-hidden="true">{isOpen ? '−' : '+'}</span>
            </button>
            {isOpen && <div className="source-body" id={`${group.id}-body`}>
              {group.publishers.length > 1 && <details className="publisher-list"><summary>Recorded source names</summary>{group.historical && <p>Some names come from an earlier review and may be incomplete.</p>}<ul>{group.publishers.map(source => <li key={`${source.id}-${source.name}`}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.name} ↗</a> : source.name}</li>)}</ul></details>}
              <div className="source-table-scroll"><table className="source-table"><thead><tr><th scope="col">Table & contents</th><th scope="col">Available records</th><th scope="col">Collection & processing</th><th scope="col">Coverage</th></tr></thead><tbody>{items.slice(0,limit).map(entry => <SourceRow key={`${entry.table.id}-${entry.table.artifactDigest ?? entry.table.publication?.snapshotId ?? entry.table.publication?.sha256}-${retry}`} entry={entry} catalog={allTables} loadDetails={loadDetails} coverageMaps={coverageMaps} timeView={timeView} publishers={coveragePublishers} onRetry={() => setRetry(retry + 1)} coverageLoading={!coverageMaps && !timeError} />)}</tbody></table></div>
              {items.length > limit && <button className="show-more" onClick={() => setLimits(previous => ({...previous, [group.id]: limit + 8}))}>Show {Math.min(8, items.length-limit)} more tables ({items.length-limit} remaining)</button>}
            </div>}
          </div>;
        })}
      </section>)}</div>
      <footer>Receipts link records to saved source material or processing steps; they do not establish source completeness. Collection methods do not show each method’s share of rows. Download-only tables open as Parquet files. <a href="https://docs.spicygov.ai">Data documentation ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage />);
