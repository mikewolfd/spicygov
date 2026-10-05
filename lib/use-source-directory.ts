import { useEffect, useState } from 'react';
import { fetchJson } from './publication-evidence';
import { parseSourceReview, type SourceReview } from './source-directory';

export function useSourceDirectory(retry: number) {
  const [state, setState] = useState<{ review?: SourceReview; warnings: string[]; pending: boolean }>({ warnings: [], pending: true });
  useEffect(() => {
    const controller = new AbortController();
    setState({ warnings: [], pending: true });
    const review = fetchJson('/source-inventory.v1.json', controller.signal).then(parseSourceReview).then(review => {
      if (!controller.signal.aborted) setState(state => ({ ...state, review }));
    }).catch(() => {
      if (!controller.signal.aborted) setState(state => ({ ...state, warnings: [...state.warnings, 'Collection notes could not be loaded. Published tables are still listed.'] }));
    });
    Promise.allSettled([review]).then(() => {
      if (!controller.signal.aborted) setState(state => ({ ...state, pending: false }));
    });
    return () => controller.abort();
  }, [retry]);
  return state;
}
