import { useEffect, useRef, useState } from 'react';
import type { CatalogDetail, CatalogFilePage, CatalogManifest, SourceCatalogReader } from '../lib/source-catalog';
import { CatalogFileList } from './catalog-file-list';
import type { ArchiveMirror } from '../lib/archive-mirror';

/** Separate, on-demand pages keep missing, rejected and unchecked files out of usable source-file counts. */
export function CatalogRetainedFiles({ reader, manifest, detail, mirror }: {
  reader: SourceCatalogReader;
  manifest: CatalogManifest;
  detail: CatalogDetail;
  mirror?: ArchiveMirror;
}) {
  const request = useRef<AbortController | undefined>(undefined);
  const [page, setPage] = useState<CatalogFilePage>();
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    request.current?.abort();
    setPage(undefined); setIndex(0); setLoading(false); setError('');
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
      if (!controller.signal.aborted) { setPage(result); setIndex(nextIndex); }
    } catch {
      if (!controller.signal.aborted) setError('These file references could not be loaded. Any previous page is still shown.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  return <details className="evidence-disclosure catalog-retained-files">
    <summary>Files that need attention ({inventory.total.toLocaleString()} references)</summary>
    <p>Missing files, errors, refusals, incomplete responses, and unchecked content. Excluded from usable source-file counts.</p>
    <button className="secondary-action" disabled={loading} onClick={() => void load(page ? index : 0)}>
      {loading ? 'Loading these files…' : page ? 'Reload this file page' : 'Browse files needing attention'}
    </button>
    {error && <p role="alert">{error} <button disabled={loading} onClick={() => void load(page ? index : 0)}>Retry these files</button></p>}
    {page && <>
      <CatalogFileList key={index} files={page.files} routes={detail.routes} mirror={mirror} />
      <nav className="result-pagination source-list-toolbar" aria-label="Files needing attention pages">
        <button disabled={loading || index === 0} onClick={() => void load(index - 1)}>← Previous</button>
        <span aria-live="polite">Page {index + 1} of {inventory.pages.length}</span>
        <button disabled={loading || index + 1 === inventory.pages.length} onClick={() => void load(index + 1)}>Next →</button>
      </nav>
    </>}
  </details>;
}
