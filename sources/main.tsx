import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { count, metadataMessage, publicationDate, tableMetadataMessage } from '../lib/catalog';
import { useCollection } from '../lib/use-collection';
import { sourceGroups } from '../lib/sources';
import { TableProvenance } from '../components/table-provenance';
import '../app/globals.css';
import './style.css';
function SourcesPage() {
  const [query, setQuery] = useState(''), [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
  const { tables, metadata, error } = useCollection(retry);
  const q = query.trim().toLowerCase();
  const groups = sourceGroups(tables, q);
  return <div className="sources-page">
    <a href="#sources" className="skip-link">Skip to sources</a>
    <header className="topbar">
      <a className="wordmark" href="/">spicygov<span className="brand-star" aria-hidden="true">✳</span></a>
      <nav aria-label="Main"><a href="/">Explore</a><span className="nav-active" aria-current="page">Sources</span><a href="/mcp/">MCP</a><a href="https://docs.spicygov.ai">Data docs</a></nav>
      <span className="header-note">PUBLIC DATA. OPEN POSSIBILITIES.</span>
    </header>
    <main id="sources" className="sources-content">
      <p className="sources-eyebrow">THE PUBLIC RECORD / SOURCES</p>
      <h1>Where the data comes from.</h1>
      <p className="sources-intro">Every published table, its source, and what it covers.</p>
      <div className="sources-controls"><label><span className="sr-only">Find a table or source</span><input type="search" placeholder="Find a table or source…" value={query} onChange={e => setQuery(e.target.value)} /></label><button onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse all' : 'Expand all'}</button></div>
      {metadataMessage(metadata) && tables.length > 0 && <p className="metadata-status" role="status">{metadataMessage(metadata)} {metadata.state !== 'loading' && <button onClick={() => setRetry(retry + 1)}>Refresh</button>}</p>}
      {error ? <p role="alert">{error} <button onClick={() => setRetry(retry + 1)}>Try again</button></p> : !tables.length ? <p role="status">Loading published tables…</p> : <>
        <p className="sources-count" aria-live="polite">{groups.reduce((n, g) => n + g.tables.length, 0)} of {tables.length} tables · {groups.length} {groups.length === 1 ? 'source group' : 'source groups'} · {tables.filter(t => t.rows === 0).length} empty tables</p>
        {!groups.length && <p>No tables or sources match “{query}”.</p>}
        <div className="source-list">{groups.map(({ source, tables: items }) => <details className="source-group" key={`${source.id}-${expanded}-${!!q}`} open={expanded || !!q}>
          <summary><div><h2>{source.name}</h2><p>{source.note}</p></div><span>{items.length}<span className="sr-only"> {items.length === 1 ? 'table' : 'tables'}</span></span></summary>
          <div className="source-body">
            <ul>{items.map(table => <li key={table.id}>
              <a className="source-table-title" href={`/?table=${encodeURIComponent(table.id)}&view=about`}><span>{table.label} ↗</span><code>{table.id}</code></a>
              <p className="source-availability"><strong>{count(table.rows)} rows</strong>{table.rows === 0 && <span className="empty-badge">Empty publication</span>}{table.modelGenerated && <span className="empty-badge">Model-generated</span>}</p>
              <p className="source-publication">{table.published ? `Published ${publicationDate(table.published)}` : publicationDate(table.published)}</p>
              {tableMetadataMessage(table.metadataState) && <p className="source-metadata-state">{tableMetadataMessage(table.metadataState)}</p>}
              {table.rows === 0 && <p className="source-empty-reason">{table.emptyReason || 'No reason for the empty output is documented.'}</p>}
              <p className="source-coverage-preview"><strong>Coverage</strong> {table.coverage || 'Not documented'}</p>
              <details className="source-table-details"><summary>Coverage & origin</summary>
                <p><strong>Coverage</strong> {table.coverage || 'Coverage is not documented.'}</p>
                {table.quality && <p>{table.quality}</p>}
                <TableProvenance table={table} catalog={tables} />
              </details>
            </li>)}</ul>
          </div>
        </details>)}</div>
      </>}
      <footer>Publication dates show when files were published, not when the events happened. Row counts do not establish completeness. Empty tables are published outputs with no rows. <a href="https://docs.spicygov.ai">Coverage and field details ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage />);
