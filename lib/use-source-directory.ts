import { useEffect, useState } from 'react';
import type { Dataset } from './catalog';
import { fetchJson } from './publication-evidence';
import { loadOtherPublications, parseSourceReview, type SourceReview } from './source-directory';

export function useSourceDirectory(retry: number) {
  const [state, setState] = useState<{ extra: Dataset[]; review?: SourceReview; warnings: string[]; pending: boolean }>({ extra: [], warnings: [], pending: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ extra: [], warnings: [], pending: true });
    // Optional publications and dated notes never delay the main catalog.
    const publications = loadOtherPublications(controller.signal).then(result => {
      if (!controller.signal.aborted) setState(state => ({ ...state, extra: result.tables, warnings: [...state.warnings, ...result.warnings] }));
    });
    const review = fetchJson('/source-inventory.v1.json', controller.signal).then(parseSourceReview).then(review => {
      if (!controller.signal.aborted) setState(state => ({ ...state, review }));
    }).catch(() => {
      if (!controller.signal.aborted) setState(state => ({ ...state, warnings: [...state.warnings, 'Collection notes could not be loaded. Published tables are still listed.'] }));
    });
    Promise.allSettled([publications, review]).then(() => {
      if (!controller.signal.aborted) setState(state => ({ ...state, pending: false }));
    });
    return () => controller.abort();
  }, [retry]);
  return state;
}
