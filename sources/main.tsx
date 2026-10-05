import { Fragment, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { count, publicationDate, type Dataset } from '../lib/catalog';
import { useCollection } from '../lib/use-collection';
import { useSourceDirectory } from '../lib/use-source-directory';
import { evidenceLinkLabel, sourceCatalogMessage, sourceMetadataMessage, filterEntries, methodLabels, parseGenerationDetails, reviewedGenerationLinks, sourceEntries, type GenerationDetails, type SourceEntry } from '../lib/source-directory';
import { fetchJson, type EvidenceLink } from '../lib/publication-evidence';
import { TableProvenance } from '../components/table-provenance';
import '../app/globals.css';
import './style.css';

function EvidenceLinks({ links }: { links: EvidenceLink[] }) {
  return <ul className="evidence-links">{links.map((link, index) => <li key={`${link.url}-${index}`}><a href={link.url} target="_blank" rel="noreferrer">{evidenceLinkLabel(link.label)} ↗</a></li>)}</ul>;
}
function SourceRow({ entry, catalog, loadDetails }: {
  entry: SourceEntry; catalog: Dataset[];
  loadDetails: (table: Dataset) => Promise<GenerationDetails>;
}) {
  const [open, setOpen] = useState(false), [details, setDetails] = useState<GenerationDetails>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const { table, review: audit } = entry, publication = table.publication, receipts = publication?.nativeReceipts;
  const reviewedLinks = reviewedGenerationLinks(entry), copy = audit?.copy;
  const titleUrl = entry.explorer ? `/?table=${encodeURIComponent(table.id)}&view=about` : table.members[0]?.url;
  async function inspect() {
    setLoading(true); setError('');
    try { setDetails(await loadDetails(table)); } catch { setError('Release details could not be loaded. Try again or open publication details.'); }
    finally { setLoading(false); }
  }
  return <Fragment>
    <tr>
      <th scope="row"><a className="source-table-title" href={titleUrl} target={entry.explorer ? undefined : '_blank'} rel={entry.explorer ? undefined : 'noreferrer'}>{table.label} ↗</a><code>{table.id}</code>
        {!entry.explorer && <span className="table-note">Download data (Parquet)</span>}
        {entry.historicalAttribution && <span className="table-note">Source list may be out of date</span>}
        <button className="details-toggle" aria-expanded={open} aria-controls={`details-${table.id}`} onClick={() => setOpen(!open)}>{open ? '−' : '+'} Source & limits<span className="sr-only"> for {table.label}</span></button>
      </th>
      <td><strong className="row-count">{count(table.rows)} rows</strong>{table.rows === 0 && <span className="empty-badge">No rows</span>}
        <span className="table-note">{table.published ? `Published ${publicationDate(table.published)}` : 'Date not recorded'}</span>
        {table.modelGenerated && <span className="empty-badge">AI-generated</span>}
      </td>
      <td><ul className="method-list">{audit?.methods.length ? audit.methods.map(method => <li key={method}>{methodLabels[method] ?? method}</li>) : <li className="muted">Not yet reviewed</li>}</ul></td>
      <td>{audit?.artifactDigest && table.artifactDigest !== audit.artifactDigest && <span className="table-note">File version differs from review</span>}<EvidenceLinks links={[
        ...(publication ? [{ label: publication.kind === 'generation' ? 'Publication details' : publication.kind === 'rulemaking' ? 'Files & inputs' : 'Export details', url: publication.recordUrl }] : []),
        ...(receipts ? [{ label: 'Download receipts (Parquet)', url: receipts.url }] : []),
        ...reviewedLinks.filter(link => link.label === 'Source observation journal'),
      ]} /></td>
    </tr>
    {open && <tr className="source-detail-row"><td colSpan={4} id={`details-${table.id}`}>
      <div className="source-detail-grid"><section><h3>How collected</h3>
        {entry.explorer && sourceMetadataMessage(table.metadataState) && <p className="metadata-status">{sourceMetadataMessage(table.metadataState)}</p>}
        <p>{copy?.summary ?? 'Collection notes have not been reviewed yet.'}</p>
        {entry.historicalAttribution ? <><p className="review-date">Source names come from an earlier review and may be incomplete.</p><EvidenceLinks links={audit?.sources.flatMap(source => source.url ? [{ label: source.name, url: source.url }] : []) ?? []} /></> : entry.explorer ? <TableProvenance table={table} catalog={catalog} compact /> : null}
        {audit?.evidence.length ? <details className="code-evidence"><summary>Code references</summary><EvidenceLinks links={audit.evidence.map(link => ({ ...link, label: link.url.split('/').pop() || 'Source code' }))} /></details> : null}
      </section><section><h3>Coverage & limits</h3><p>{copy?.scope ?? 'Coverage has not been reviewed yet.'}</p>
        {copy?.gaps.length ? <ul className="gap-list">{copy.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : null}
        <details className="code-evidence"><summary>Receipt & file details</summary>

        {receipts ? <><p>Match <code>dataset</code>, <code>generation_id</code>, <code>record_id</code> and <code>subject_version</code> to connect a row to its receipt.</p><p className="receipt-id">Release <code>{receipts.generationId}</code></p><p className="review-date">Receipts may identify a processing step rather than an original source document.</p></> : <p>No record receipts are listed. Publication details may still name source files.</p>}
        {publication?.kind === 'comments' && <p>These file URLs can change. Check the checksum and ETag in the export details when you need an exact file version.</p>}
        {publication?.kind === 'rulemaking' && <p>Publication details list the files used to build this release.</p>}
        {publication?.kind === 'generation' && !details && <button className="inspect-button" disabled={loading} onClick={inspect}>{loading ? 'Loading release details…' : error ? 'Retry release details' : 'Load release details'}</button>}
        {error && <p role="alert">{error}</p>}
        {details && <div className="generation-details"><EvidenceLinks links={details.links} />
          {details.identityFields.length > 0 && <p><strong>Record identity fields</strong> {details.identityFields.map(field => <code key={field}>{field} </code>)}</p>}
          {details.parents.length > 0 && <><h4>Input tables for this release</h4><ul className="input-pins">{details.parents.map(parent => <li key={parent.table}>{parent.url ? <a href={parent.url} target="_blank" rel="noreferrer">{parent.table} · saved version ↗</a> : <code>{parent.table}</code>}{parent.digest && <small>File checksum <code>{parent.digest}</code></small>}</li>)}</ul></>}
          {details.carriedForward && <p>Copied from an earlier release: <code>{details.carriedForward}</code>.</p>}
          {!details.links.length && !details.parents.length && <p>No source log or input tables are listed for this release.</p>}
          <p className="review-date">This page does not check individual receipts or file checksums.</p>
        </div>}
        </details>
      </section></div>
    </td></tr>}
  </Fragment>;
}
function SourcesPage() {
  const [query, setQuery] = useState(''), [method, setMethod] = useState(''), [evidence, setEvidence] = useState('');
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
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
  function loadDetails(table: Dataset) {
    const url = table.publication!.recordUrl;
    let request = generationCache.get(url);
    if (!request) {
      request = fetchJson(url).catch(error => { generationCache.delete(url); throw error; });
      generationCache.set(url, request);
    }
    return request.then(raw => parseGenerationDetails(raw, table)).catch(error => { generationCache.delete(url); throw error; });
  }
  return <div className="sources-page">
    <a href="#sources" className="skip-link">Skip to sources</a>
    <header className="topbar"><a className="wordmark" href="/">spicygov<span className="brand-star" aria-hidden="true">✳</span></a><nav aria-label="Main"><a href="/">Explore</a><span className="nav-active" aria-current="page">Sources</span><a href="/mcp/">MCP</a><a href="https://docs.spicygov.ai">Data docs</a></nav></header>
    <main id="sources" className="sources-content">
      <h1>Sources</h1>
      <p className="sources-intro">How each table is collected, what it covers, and where to check it.</p>
      <div className="sources-controls">
        <label className="source-search"><span>Find a table or source</span><input type="search" placeholder="Try scorecards, bulk, comments…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label><span>How collected</span><select value={method} onChange={event => setMethod(event.target.value)}><option value="">All methods</option>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Show</span><select value={evidence} onChange={event => setEvidence(event.target.value)}><option value="">All published tables</option><option value="native">With record receipts</option><option value="journal">With reviewed source logs</option><option value="separate">Download-only tables</option><option value="empty">Empty tables</option><option value="unreviewed">Collection not reviewed</option></select></label>
        <button onClick={() => { setQuery(''); setMethod(''); setEvidence(''); }}>Reset</button>
      </div>
      <div className="source-list-toolbar"><p className="sources-count" aria-live="polite">{filtered.length} of {entries.length} published tables · {filtered.filter(entry => entry.table.publication?.nativeReceipts).length} with record receipts{pending ? ' · Checking other tables…' : ''}</p><button onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse all' : 'Expand all'}</button><button onClick={() => setRetry(retry + 1)}>Refresh</button></div>
      <p className="sources-basis">Counts follow the latest published files. {review ? <>Collection notes reviewed {publicationDate(review.reviewedAt)} · <a href="/source-inventory.v1.json" target="_blank" rel="noreferrer">Full review data ↗</a></> : pending ? 'Loading collection notes…' : 'Collection notes unavailable.'}</p>
      {sourceCatalogMessage(metadata) && tables.length > 0 && <p className="metadata-status" role="status">{sourceCatalogMessage(metadata)}</p>}
      {error && <p role="alert">Main table list: {error}</p>}
      {warnings.map(warning => <p className="metadata-status" role="status" key={warning}>{warning}</p>)}
      {!entries.length && !error && <p role="status">Loading published tables…</p>}
      {!!entries.length && !groups.length && <p>No tables match these filters.</p>}
      <div className="source-list">{groups.map(({ source, entries: items }) => <details className="source-group" key={`${source.id}-${expanded}-${!!query || !!method || !!evidence}`} open={expanded || !!query || !!method || !!evidence}>
        <summary><div><h2>{source.name}</h2></div><span className="group-count">{items.length} {items.length === 1 ? 'table' : 'tables'}<span>{items.filter(entry => entry.table.publication?.nativeReceipts).length} with record receipts</span></span></summary>
        <div className="source-body"><div className="source-table-scroll"><table className="source-table"><thead><tr><th scope="col">Table</th><th scope="col">Available data</th><th scope="col">How collected</th><th scope="col">Evidence</th></tr></thead><tbody>{items.map(entry => <SourceRow key={`${entry.table.id}-${entry.table.artifactDigest ?? entry.table.publication?.snapshotId ?? entry.table.publication?.sha256}-${retry}`} entry={entry} catalog={allTables} loadDetails={loadDetails} />)}</tbody></table></div></div>
      </details>)}</div>
      <footer>Counts and receipts do not prove a source is complete. Receipts link records to source files or processing steps. Collection methods describe the process, not each method’s share of rows. Download-only tables open as Parquet data files. <a href="https://docs.spicygov.ai">Data documentation ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage />);
