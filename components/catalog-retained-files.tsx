import { useEffect, useRef, useState } from 'react';
import type { CatalogDetail, CatalogFilePage, CatalogManifest, SourceCatalogReader } from '../lib/source-catalog';
import { fileAvailabilitySummary } from '../lib/source-browser';
import { CatalogFileEvidence } from './catalog-file-evidence';

/** Separate, on-demand pages keep missing, rejected and unchecked files out of usable source-file counts. */
export function CatalogRetainedFiles({ reader, manifest, detail }: {
  reader: SourceCatalogReader;
  manifest: CatalogManifest;
  detail: CatalogDetail;
}) {
  const request = useRef<AbortController | undefined>(undefined);
  const [page, setPage] = useState<CatalogFilePage>();
  const [index, setIndex] = useState(0), [visible, setVisible] = useState(50);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    request.current?.abort();
    setPage(undefined); setIndex(0); setVisible(50); setLoading(false); setError('');
    return () => request.current?.abort();
  }, [reader, manifest, detail]);
  const inventory = detail.retainedFiles;
  if (!inventory?.total) return null;

  async function load(nextIndex: number) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true); setError('');
    try {
      const result = await reader.retainedFiles(manifest, detail, nextIndex, controller.signal);
      if (!controller.signal.aborted) { setPage(result); setIndex(nextIndex); setVisible(50); }
    } catch {
      if (!controller.signal.aborted) setError('These file references could not be loaded. Any previous page is still shown.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return <details className="evidence-disclosure catalog-retained-files">
    <summary>Files that need attention ({inventory.total.toLocaleString()} references)</summary>
    <p>These file references include missing originals, saved source errors, refusals, incomplete responses or unchecked content. They are separate from the source-file counts above and do not establish usable data.</p>
    <button className="secondary-action" disabled={loading} onClick={() => void load(page ? index : 0)}>
      {loading ? 'Loading these files…' : page ? 'Reload this file page' : 'Browse files needing attention'}
    </button>
    {error && <p role="alert">{error} <button disabled={loading} onClick={() => void load(page ? index : 0)}>Retry these files</button></p>}
    {page && <>
      <ul className="source-file-list catalog-files">{page.files.slice(0, visible).map(file => <li key={file.id}>
        <h3>{file.name}</h3>
        <p>{fileAvailabilitySummary(file)}</p>
        <CatalogFileEvidence file={file} />
        <details><summary>Recorded file identifiers</summary><p>Recorded state: {file.status}</p><code>{file.id}</code></details>
      </li>)}</ul>
      {visible < page.files.length && <button className="text-button" onClick={() => setVisible(visible + 50)}>Show more files on this page</button>}
      <nav className="result-pagination source-list-toolbar" aria-label="Files needing attention pages">
        <button disabled={loading || index === 0} onClick={() => void load(index - 1)}>← Previous</button>
        <span aria-live="polite">Page {index + 1} of {inventory.pages.length}</span>
        <button disabled={loading || index + 1 === inventory.pages.length} onClick={() => void load(index + 1)}>Next →</button>
      </nav>
    </>}
  </details>;
}
