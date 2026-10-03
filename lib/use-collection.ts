import { useEffect, useState } from 'react';
import { loadCollection, type Collection } from './catalog';
import { loadingMetadata } from './metadata';
export function useCollection(retry = 0) {
  const [collection, setCollection] = useState<Collection>({ tables: [], joins: [], metadata: loadingMetadata });
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    loadCollection(controller.signal, setCollection).then(setCollection).catch(error => {
      if (!controller.signal.aborted) setError(error.message);
    });
    return () => controller.abort();
  }, [retry]);
  return { ...collection, error };
}
