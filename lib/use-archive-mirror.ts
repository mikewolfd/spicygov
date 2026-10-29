import { useEffect, useState } from 'react';
import { fetchJson } from './publication-evidence';
import { parseArchiveMirror, type ArchiveMirror } from './archive-mirror';
import type { CatalogManifest, SourceCatalogReader } from './source-catalog';

/** Optional mirror evidence never delays or prevents browsing the source catalog. */
export function useArchiveMirror(reader: SourceCatalogReader, manifest: CatalogManifest) {
  const [mirror,setMirror] = useState<ArchiveMirror>();
  useEffect(() => {
    setMirror(undefined);
    if (reader.internal) return;
    const controller = new AbortController();
    void reader.manifestIdentity(manifest).then(identity => identity
      ? fetchJson('/archive-mirror.v1.json',controller.signal).then(raw => parseArchiveMirror(raw,manifest,identity))
      : undefined).then(value => { if (!controller.signal.aborted) setMirror(value); }).catch(() => {});
    return () => controller.abort();
  },[reader,manifest]);
  return mirror;
}
