import copy from '../content/catalog-coverage-copy.json';

/** Changed evidence falls back to the original; concise copy requires an exact reviewed note. */
export function coverageSummary(note: string) {
  return (copy as Record<string, string>)[note] ?? note;
}
