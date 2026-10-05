import { Fragment, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { count, publicationDate, type Dataset } from '../lib/catalog';
import { useCollection } from '../lib/use-collection';
import { useSourceDirectory } from '../lib/use-source-directory';
import { evidenceLinkLabel, sourceCatalogMessage, sourceMetadataMessage, filterEntries, methodLabels, parseGenerationDetails, reviewedGenerationLinks, sourceEntries, type GenerationDetails, type SourceEntry } from '../lib/source-directory';
import { loadObservationPreview, type ObservationPreview } from '../lib/source-observations';
import { fetchJson, type EvidenceLink } from '../lib/publication-evidence';
import { TableProvenance } from '../components/table-provenance';
import type { TimeView } from '../components/time-coverage';
import { SourceCoverageSummary, TableCoverageMap } from '../components/coverage-map';
import { parseCoverageMaps, textAvailabilityDetails, type CoverageMaps } from '../lib/coverage-map';
import '../app/globals.css';
import './style.css';

function EvidenceLinks({ links }: { links: EvidenceLink[] }) {
  return <ul className="evidence-links">{links.map((link, index) => <li key={`${link.url}-${index}`}><a href={link.url} target="_blank" rel="noreferrer">{evidenceLinkLabel(link.label)} ↗</a></li>)}</ul>;
}
type ReadableDetails = GenerationDetails & { preview?: ObservationPreview; previewUnavailable?: boolean };
function SourceRow({ entry, catalog, loadDetails, coverageMaps, timeView }: {
  entry: SourceEntry; catalog: Dataset[]; coverageMaps?: CoverageMaps; timeView: TimeView;
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
      <th scope="row"><span className="source-table-title">{table.label}</span>{entry.explorer && <a className="table-note" href={titleUrl}>Explore records →</a>}<code>{table.id}</code>
        {!entry.explorer && <span className="table-note">Data available as a download</span>}
        {entry.historicalAttribution && <span className="table-note">Source list may be out of date</span>}
        <button className="details-toggle" aria-expanded={open} aria-controls={`details-${table.id}`} onClick={() => { setOpen(!open); if (!open && !details && !loading && publication?.kind === 'generation') void inspect(); }}>{open ? '−' : '+'} Source & limits<span className="sr-only"> for {table.label}</span></button>
      </th>
      <td><strong className="row-count">{count(table.rows)} rows</strong>{table.rows === 0 && <span className="empty-badge">No rows</span>}
        <span className="table-note">{table.published ? `Published ${publicationDate(table.published)}` : 'Date not recorded'}</span>
        {table.modelGenerated && <span className="empty-badge">AI-generated</span>}
        {textDetails.map(detail => <span className="table-note" key={detail.label}><strong>{detail.label}:</strong> {detail.rows === 0 ? 'No rows' : detail.notSaved === detail.rows ? 'Not saved' : <>{count(detail.withText)} with text{detail.notSaved > 0 && <> · {count(detail.notSaved)} not saved</>}{detail.blank > 0 && <> · {count(detail.blank)} blank</>}</>}</span>)}
      </td>
      <td><ul className="method-list">{audit?.methods.length ? audit.methods.map(method => <li key={method}>{methodLabels[method] ?? method}</li>) : <li className="muted">Not yet reviewed</li>}</ul></td>
      <td><TableCoverageMap table={table} maps={coverageMaps} view={timeView} /><p className="coverage-summary">{copy?.scope ?? 'Collection scope notes are not available.'}</p>
        {copy?.gaps[0] && <p className="table-note"><strong>Watch for:</strong> {copy.gaps[0]}</p>}
      </td>
    </tr>
    {open && <tr className="source-detail-row"><td colSpan={4} id={`details-${table.id}`}>
      <div className="source-detail-grid"><section><h3>How collected</h3>
        {entry.explorer && sourceMetadataMessage(table.metadataState) && <p className="metadata-status">{sourceMetadataMessage(table.metadataState)}</p>}
        <p>{copy?.summary ?? 'Collection notes have not been reviewed yet.'}</p>
        {entry.historicalAttribution ? <><p className="review-date">Source names come from an earlier review and may be incomplete.</p><EvidenceLinks links={audit?.sources.flatMap(source => source.url ? [{ label: source.name, url: source.url }] : []) ?? []} /></> : entry.explorer ? <TableProvenance table={table} catalog={catalog} compact /> : null}
        {audit?.evidence.length ? <details className="code-evidence"><summary>Code references</summary><EvidenceLinks links={audit.evidence.map(link => ({ ...link, label: link.url.split('/').pop() || 'Source code' }))} /></details> : null}
      </section><section><h3>Coverage & limits</h3><p>{copy?.scope ?? 'Collection scope notes are not available.'}</p>
        {copy?.gaps.length ? <ul className="gap-list">{copy.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : null}
      </section></div>
      <section className="readable-evidence"><h3>What we can trace</h3>
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
          {!!details.preview?.observations.length && <><h4>Observed source requests</h4><p className="review-date">Examples from this release’s collection log, shared by its tables. These do not prove which request produced an individual row.</p><ul className="readable-inputs">{details.preview.observations.map((item, i) => <li key={i}><strong>{item.source}</strong><span>{item.observedAt ? publicationDate(item.observedAt) : 'Date not recorded'} · {item.status === undefined ? 'Response status unknown' : item.status >= 200 && item.status < 300 ? 'Response received' : `Response status ${item.status}`}</span><small>{item.saved === true ? 'Response content saved' : item.saved === false ? 'Response content not saved' : 'Saved content not documented'}</small></li>)}</ul></>}
          {details.preview?.partial && <p className="review-date">Showing a limited preview of the source log, not the full collection history.</p>}
          {details.previewUnavailable && <p>The source log could not be read. The collection notes above remain available.</p>}
          {!details.previewUnavailable && !details.preview?.observations.length && <p>No source requests are shown in this preview. That does not mean none were made.</p>}
        </>}
        <details className="code-evidence"><summary>Technical files & identifiers</summary>
          <p>For checking exact file versions. This page does not verify individual receipts or file checksums.</p>
          <EvidenceLinks links={[...(publication ? [{label:'Publication file (JSON)',url:publication.recordUrl}] : []), ...(receipts ? [{label:'Receipt file (Parquet)',url:receipts.url}] : []), ...(details?.links ?? reviewedLinks), ...(!entry.explorer && table.members[0] ? [{label:'Data file (Parquet)',url:table.members[0].url}] : [])]} />
          {!!details?.identityFields.length && <p>Record identifiers: {details.identityFields.join(', ')}</p>}
        </details>
      </section>

    </td></tr>}
  </Fragment>;
}
function SourcesPage() {
  const [coverageMaps, setCoverageMaps] = useState<CoverageMaps>();
  const [timeError, setTimeError] = useState(false);
  const [timeView, setTimeView] = useState<TimeView>({year: new Date().getFullYear(), mode: 'years'});

  const [query, setQuery] = useState(''), [method, setMethod] = useState(''), [evidence, setEvidence] = useState('');
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setTimeError(false);
    void fetchJson('/coverage-maps.v1.json', controller.signal).then(parseCoverageMaps).then(setCoverageMaps).catch(() => { if (!controller.signal.aborted) { setCoverageMaps(undefined); setTimeError(true); } });
    return () => controller.abort();
  }, [retry]);
  const { tables, metadata, error } = useCollection(retry);
  const { extra, review, warnings, pending } = useSourceDirectory(retry);
  const entries = useMemo(() => sourceEntries(tables, extra, review), [tables, extra, review]);
  const allTables = useMemo(() => entries.map(entry => entry.table), [entries]);
  const filtered = useMemo(() => filterEntries(entries, query, method, evidence), [entries, query, method, evidence]);
  const groups = useMemo(() => {
    const groups = new Map<string, { source: SourceEntry['source']; entries: SourceEntry[] }>();
    for (const entry of filtered) {
      const group = groups.get(entry.source.id) ?? { source: entry.source, entries: [] };
      group.entries.push(entry); groups.set(entry.source.id, group);
    }
    return [...groups.values()].sort((a, b) => a.source.id === 'unlisted' ? 1 : b.source.id === 'unlisted' ? -1 : a.source.name.localeCompare(b.source.name));
  }, [filtered]);
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
      <h1>Sources</h1>
      <p className="sources-intro">How each table is collected, what it covers, and where to check it.</p>
      <section className="time-controls" aria-label="Time coverage">
        <div><h2>Coverage</h2><p className="time-legend"><span>● Retained rows</span><span>— No placed rows</span><span>? Not measured for this view</span></p></div>
        <label>View <select value={timeView.mode} onChange={event => setTimeView({...timeView, mode:event.target.value as TimeView['mode']})}><option value="years">Years</option><option value="months">Months</option></select></label>
        <label>{timeView.mode === 'years' ? 'Through year' : 'Year'} <input aria-label="Coverage year" type="number" min="1" max="9999" value={timeView.year} onChange={event => { const year = Number(event.target.value); if (Number.isInteger(year) && year >= 1 && year <= 9999) setTimeView({...timeView,year}); }} /></label>
        <details className="time-explanation"><summary>How to read coverage</summary><p>Each table uses its own meaningful dates, cycles, editions, scopes, or snapshot. Select “Coverage by” to compare its views. Missing, invalid, and approximate values stay separate. A blank period means no placed rows in this file; it does not prove the source had no records. Counts can include duplicates. Green shows presence, not complete source coverage.</p></details>
        {timeError ? <p role="status">Coverage maps could not be loaded.</p> : !coverageMaps ? <p role="status">Loading coverage maps…</p> : <p className="time-caption">Checked {new Date(coverageMaps.generatedAt).toLocaleDateString()}. Maps appear only while the published files still match.</p>}
      </section>
      <div className="sources-controls">
        <label className="source-search"><span>Find a table or source</span><input type="search" placeholder="Try scorecards, bulk, comments…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label><span>How collected</span><select value={method} onChange={event => setMethod(event.target.value)}><option value="">All methods</option>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Show</span><select value={evidence} onChange={event => setEvidence(event.target.value)}><option value="">All published tables</option><option value="native">With record receipts</option><option value="journal">With reviewed source logs</option><option value="separate">Download-only tables</option><option value="empty">Empty tables</option><option value="unreviewed">Collection not reviewed</option></select></label>
        <button onClick={() => { setQuery(''); setMethod(''); setEvidence(''); }}>Reset</button>
      </div>
      <div className="source-list-toolbar"><p className="sources-count" aria-live="polite">{filtered.length} of {entries.length} published tables · {filtered.filter(entry => entry.table.publication?.nativeReceipts).length} with record receipts{pending ? ' · Checking other tables…' : ''}</p><button onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse all' : 'Expand all'}</button><button onClick={() => setRetry(retry + 1)}>Refresh</button></div>
      <p className="sources-basis">Counts follow the latest published files. {review ? <>Collection notes reviewed {publicationDate(review.reviewedAt)}</> : pending ? 'Loading collection notes…' : 'Collection notes unavailable.'}</p>
      {sourceCatalogMessage(metadata) && tables.length > 0 && <p className="metadata-status" role="status">{sourceCatalogMessage(metadata)}</p>}
      {error && <p role="alert">Main table list: {error}</p>}
      {warnings.map(warning => <p className="metadata-status" role="status" key={warning}>{warning}</p>)}
      {!entries.length && !error && <p role="status">Loading published tables…</p>}
      {!!entries.length && !groups.length && <p>No tables match these filters.</p>}
      <div className="source-list">{groups.map(({ source, entries: items }) => <details className="source-group" key={`${source.id}-${expanded}-${!!query || !!method || !!evidence}`} open={expanded || !!query || !!method || !!evidence}>
        <summary><div><h2>{source.name}</h2><SourceCoverageSummary tables={items.map(entry => entry.table)} maps={coverageMaps} view={timeView} /></div><span className="group-count">{items.length} {items.length === 1 ? 'table' : 'tables'}<span>{items.filter(entry => entry.table.publication?.nativeReceipts).length} with record receipts</span></span></summary>
        <div className="source-body"><div className="source-table-scroll"><table className="source-table"><thead><tr><th scope="col">Table</th><th scope="col">Available data</th><th scope="col">How collected</th><th scope="col">Coverage & limits</th></tr></thead><tbody>{items.map(entry => <SourceRow key={`${entry.table.id}-${entry.table.artifactDigest ?? entry.table.publication?.snapshotId ?? entry.table.publication?.sha256}-${retry}`} entry={entry} catalog={allTables} loadDetails={loadDetails} coverageMaps={coverageMaps} timeView={timeView} />)}</tbody></table></div></div>
      </details>)}</div>
      <footer>Counts and receipts do not prove a source is complete. Receipts link records to source files or processing steps. Collection methods describe the process, not each method’s share of rows. Download-only tables open as Parquet data files. <a href="https://docs.spicygov.ai">Data documentation ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage />);
