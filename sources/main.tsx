import { Fragment, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { count, metadataMessage, publicationDate, tableMetadataMessage, type Dataset } from '../lib/catalog';
import { useCollection } from '../lib/use-collection';
import { useSourceDirectory } from '../lib/use-source-directory';
import { evidenceLabel, filterEntries, methodLabels, parseGenerationDetails, reviewedGenerationLinks, sourceEntries, type GenerationDetails, type SourceEntry, type SourceReview } from '../lib/source-directory';
import { fetchJson, type EvidenceLink } from '../lib/publication-evidence';
import { TableProvenance } from '../components/table-provenance';
import '../app/globals.css';
import './style.css';

function EvidenceLinks({ links }: { links: EvidenceLink[] }) {
  return <ul className="evidence-links">{links.map((link, index) => <li key={`${link.url}-${index}`}><a href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a></li>)}</ul>;
}
function SourceRow({ entry, catalog, review, loadDetails }: {
  entry: SourceEntry; catalog: Dataset[]; review?: SourceReview;
  loadDetails: (table: Dataset) => Promise<GenerationDetails>;
}) {
  const [open, setOpen] = useState(false), [details, setDetails] = useState<GenerationDetails>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const { table, review: audit } = entry, publication = table.publication, receipts = publication?.nativeReceipts;
  const reviewedLinks = reviewedGenerationLinks(entry);
  const titleUrl = entry.explorer ? `/?table=${encodeURIComponent(table.id)}&view=about` : table.members[0]?.url;
  async function inspect() {
    setLoading(true); setError('');
    try { setDetails(await loadDetails(table)); } catch { setError('Generation details could not be loaded. Try again or open the publication record.'); }
    finally { setLoading(false); }
  }
  return <Fragment>
    <tr>
      <th scope="row"><a className="source-table-title" href={titleUrl} target={entry.explorer ? undefined : '_blank'} rel={entry.explorer ? undefined : 'noreferrer'}>{table.label} ↗</a><code>{table.id}</code>
        {!entry.explorer && <span className="table-note">Parquet download · separate publication</span>}
        {entry.historicalAttribution && <span className="table-note">Source attribution from reviewed metadata</span>}
        <button className="details-toggle" aria-expanded={open} aria-controls={`details-${table.id}`} onClick={() => setOpen(!open)}>{open ? '−' : '+'} Origin & gaps<span className="sr-only"> for {table.label}</span></button>
      </th>
      <td><strong className="row-count">{count(table.rows)} rows</strong>{table.rows === 0 && <span className="empty-badge">Empty publication</span>}
        <span className="table-note">{table.published ? `Published ${publicationDate(table.published)}` : 'Publication date unavailable'}</span>
        {table.modelGenerated && <span className="empty-badge">Model-generated</span>}
      </td>
      <td><ul className="method-list">{audit?.methods.length ? audit.methods.map(method => <li key={method}>{methodLabels[method] ?? method}</li>) : <li className="muted">Not yet reviewed</li>}</ul></td>
      <td><strong className="evidence-level">{evidenceLabel(entry)}</strong>{audit?.artifactDigest && table.artifactDigest !== audit.artifactDigest && <span className="table-note">Generation changed since review</span>}<EvidenceLinks links={[
        ...(publication ? [{ label: publication.kind === 'generation' ? 'Generation record' : publication.kind === 'rulemaking' ? 'Snapshot manifest' : 'Export receipt', url: publication.recordUrl }] : []),
        ...(receipts ? [{ label: 'Row receipts (Parquet)', url: receipts.url }] : []),
        ...reviewedLinks.filter(link => link.label === 'Source observation journal'),
      ]} /></td>
    </tr>
    {open && <tr className="source-detail-row"><td colSpan={4} id={`details-${table.id}`}>
      <div className="source-detail-grid"><section><h3>How it is collected</h3>
        {entry.explorer && tableMetadataMessage(table.metadataState) && <p className="metadata-status">{tableMetadataMessage(table.metadataState)}</p>}
        {audit ? <><p>{audit.summary}</p><p>{audit.mixing}</p><p className="review-date">Code and acquisition history reviewed {publicationDate(review?.reviewedAt)}. Methods are documented paths, not measured shares of current rows.</p></> : <p>Acquisition methods have not been reviewed for this table.</p>}
        {entry.historicalAttribution ? <><p className="review-date">The source names below come from earlier metadata; they are not a current publisher census.</p><EvidenceLinks links={audit?.sources.flatMap(source => source.url ? [{ label: source.name, url: source.url }] : []) ?? []} /></> : entry.explorer ? <TableProvenance table={table} catalog={catalog} /> : null}
        {audit?.evidence.length ? <details className="code-evidence"><summary>Review evidence</summary><EvidenceLinks links={audit.evidence} /></details> : null}
      </section><section><h3>Scope & known gaps</h3><p>{table.coverage || audit?.scope || 'Source scope is not documented.'}</p>
        {table.quality && <p>{table.quality}</p>}
        {table.rows === 0 && <p>{table.emptyReason || 'No reason for the empty output is documented.'}</p>}
        {audit?.gaps.length ? <ul className="gap-list">{audit.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul> : <p>{audit ? 'No specific gaps were recorded in this review.' : 'Known gaps have not been reviewed.'}</p>}
        <p className="review-date">Whole-source completeness has not been measured.</p>
        <h3>Follow the evidence</h3>
        {receipts ? <><p>The published receipt file covers this dataset. Match <code>dataset</code>, <code>generation_id</code>, <code>record_id</code> and <code>subject_version</code> to trace a record.</p><p className="receipt-id">Generation <code>{receipts.generationId}</code></p><p className="review-date">Receipts may point to a retained processing row. They do not always identify one original API response.</p></> : <p>No native row-receipt file is advertised for this table. Its publication record may still contain source or input evidence.</p>}
        {publication?.kind === 'comments' && <p>These file URLs can change. Compare the export receipt’s checksum and ETag with the file before relying on an exact version.</p>}
        {publication?.kind === 'rulemaking' && <p>The snapshot manifest records the input files used for this publication.</p>}
        {publication?.kind === 'generation' && !details && <button className="inspect-button" disabled={loading} onClick={inspect}>{loading ? 'Loading generation…' : error ? 'Retry generation details' : 'Show generation inputs & receipt keys'}</button>}
        {error && <p role="alert">{error}</p>}
        {details && <div className="generation-details"><EvidenceLinks links={details.links} />
          {details.identityFields.length > 0 && <p><strong>Record identity fields</strong> {details.identityFields.map(field => <code key={field}>{field} </code>)}</p>}
          {details.parents.length > 0 && <><h4>Input tables recorded for this generation</h4><ul className="input-pins">{details.parents.map(parent => <li key={parent.table}>{parent.url ? <a href={parent.url} target="_blank" rel="noreferrer">{parent.table} · pinned generation ↗</a> : <code>{parent.table}</code>}{parent.digest && <small>File checksum <code>{parent.digest}</code></small>}</li>)}</ul></>}
          {details.carriedForward && <p>Retained from an earlier generation: <code>{details.carriedForward}</code>.</p>}
          {!details.links.length && !details.parents.length && <p>No source journal or named input tables are recorded in this generation record.</p>}
          <p className="review-date">These links describe the dataset generation. This page does not verify individual row receipts or file checksums.</p>
        </div>}
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
    <header className="topbar"><a className="wordmark" href="/">spicygov<span className="brand-star" aria-hidden="true">✳</span></a><nav aria-label="Main"><a href="/">Explore</a><span className="nav-active" aria-current="page">Sources</span><a href="/mcp/">MCP</a><a href="https://docs.spicygov.ai">Data docs</a></nav><span className="header-note">PUBLIC DATA. OPEN POSSIBILITIES.</span></header>
    <main id="sources" className="sources-content">
      <p className="sources-eyebrow">THE PUBLIC RECORD / SOURCES</p><h1>Where the data comes from.</h1>
      <p className="sources-intro">What’s published, how it was collected, and the evidence behind it.</p>
      <div className="sources-controls">
        <label className="source-search"><span>Find a table or source</span><input type="search" placeholder="Try scorecards, bulk, comments…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label><span>Acquisition method</span><select value={method} onChange={event => setMethod(event.target.value)}><option value="">All methods</option>{Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>Show</span><select value={evidence} onChange={event => setEvidence(event.target.value)}><option value="">All published tables</option><option value="native">With row receipts</option><option value="journal">With reviewed source journals</option><option value="separate">Separate publications</option><option value="empty">Empty tables</option><option value="unreviewed">Acquisition not reviewed</option></select></label>
        <button onClick={() => { setQuery(''); setMethod(''); setEvidence(''); }}>Reset</button>
      </div>
      <div className="source-list-toolbar"><p className="sources-count" aria-live="polite">{filtered.length} of {entries.length} published tables · {filtered.filter(entry => entry.table.publication?.nativeReceipts).length} with row receipts{pending ? ' · Checking other publications…' : ''}</p><button onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse all' : 'Expand all'}</button><button onClick={() => setRetry(retry + 1)}>Refresh</button></div>
      <p className="sources-basis">Publication records are live. {review ? <>Acquisition notes reviewed {publicationDate(review.reviewedAt)} · <a href="/source-inventory.v1.json" target="_blank" rel="noreferrer">Review data ↗</a></> : pending ? 'Loading acquisition notes…' : 'Acquisition notes unavailable.'}</p>
      {metadataMessage(metadata) && tables.length > 0 && <p className="metadata-status" role="status">{metadataMessage(metadata)}</p>}
      {error && <p role="alert">Main publication index: {error}</p>}
      {warnings.map(warning => <p className="metadata-status" role="status" key={warning}>{warning}</p>)}
      {!entries.length && !error && <p role="status">Loading published tables…</p>}
      {!!entries.length && !groups.length && <p>No tables match these filters.</p>}
      <div className="source-list">{groups.map(({ source, entries: items }) => <details className="source-group" key={`${source.id}-${expanded}-${!!query || !!method || !!evidence}`} open={expanded || !!query || !!method || !!evidence}>
        <summary><div><h2>{source.name}</h2><p>{source.note}</p></div><span className="group-count">{items.length} {items.length === 1 ? 'table' : 'tables'}<span>{items.filter(entry => entry.table.publication?.nativeReceipts).length} with row receipts</span></span></summary>
        <div className="source-body"><div className="source-table-scroll"><table className="source-table"><thead><tr><th scope="col">Table</th><th scope="col">Available data</th><th scope="col">Acquisition · reviewed</th><th scope="col">Evidence</th></tr></thead><tbody>{items.map(entry => <SourceRow key={`${entry.table.id}-${entry.table.artifactDigest ?? entry.table.publication?.snapshotId ?? entry.table.publication?.sha256}-${retry}`} entry={entry} catalog={allTables} review={review} loadDetails={loadDetails} />)}</tbody></table></div></div>
      </details>)}</div>
      <footer>Row counts and receipts do not establish complete upstream coverage. Acquisition notes describe code and recorded history, not each method’s share of rows. Separate publications link directly to Parquet files; the explorer currently reads the main index. <a href="https://docs.spicygov.ai">Data documentation ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage />);
