import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadCatalog, type Dataset } from '../lib/catalog';
import { sources, unlistedSource, sourceFor, sourceNote } from '../lib/sources';
import '../app/globals.css';
import './style.css';
function SourcesPage() {
  const [tables,setTables]=useState<Dataset[]>([]),[query,setQuery]=useState(''),[error,setError]=useState(''),[expanded,setExpanded]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{ const c=new AbortController();setError('');loadCatalog(c.signal).then(setTables).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort(); },[retry]);
  const q=query.trim().toLowerCase();
  const groups=[...sources,unlistedSource].map(source=>({source,tables:tables.filter(t=>sourceFor(t).id===source.id && `${t.label} ${t.id} ${source.name} ${source.note} ${sourceNote(t)??''}`.toLowerCase().includes(q))})).filter(g=>g.tables.length);
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
      <p className="sources-intro">Every published table, grouped by origin. Open a source to see its tables.</p>
      <div className="sources-controls"><label><span className="sr-only">Find a table or source</span><input type="search" placeholder="Find a table or source…" value={query} onChange={e=>setQuery(e.target.value)} /></label><button onClick={()=>setExpanded(!expanded)}>{expanded?'Collapse all':'Expand all'}</button></div>
      {error ? <p role="alert">{error} <button onClick={()=>setRetry(retry+1)}>Try again</button></p> : !tables.length ? <p role="status">Loading published tables…</p> : <>
        <p className="sources-count" aria-live="polite">{groups.reduce((n,g)=>n+g.tables.length,0)} of {tables.length} tables · {groups.length} {groups.length === 1 ? 'source' : 'sources'}</p>
        {!groups.length && <p>No tables or sources match “{query}”.</p>}
        <div className="source-list">{groups.map(({source,tables:items})=><details className="source-group" key={`${source.id}-${expanded}-${!!q}`} open={expanded||!!q}>
          <summary><div><h2>{source.name}</h2><p>{source.note}</p></div><span>{items.length}<span className="sr-only"> {items.length === 1 ? 'table' : 'tables'}</span></span></summary>
          <div className="source-body">
            {source.url && <a className="source-website" href={source.url} target="_blank" rel="noreferrer">Visit source ↗</a>}
            <ul>{items.map(t=><li key={t.id}><a href={`/?table=${encodeURIComponent(t.id)}&view=about`}><span>{t.label}</span><code>{t.id}</code>{sourceNote(t)&&<small>{sourceNote(t)}</small>}</a><span aria-hidden="true">↗</span></li>)}</ul>
          </div>
        </details>)}</div>
      </>}
      <footer>Sources describe origin, not completeness. Individual records retain source links and identifiers where available. <a href="https://docs.spicygov.ai">Coverage and field details ↗</a></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<SourcesPage/>);
