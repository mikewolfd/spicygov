import copy from '../content/catalog-coverage-copy.json';
import alerts from '../content/catalog-coverage-alerts.json';

/** Changed evidence falls back to the original; concise copy requires an exact reviewed note. */
export function coverageSummary(note: string) {
  return (copy as Record<string, string>)[note] ?? note;
}

/** Only exact reviewed wording promotes a file or date issue into the overview. */
export function coverageAttentionSummary(note: string): string | undefined {
  const reviewed = (copy as Record<string, string>)[note];
  return reviewed ? (alerts as Record<string, string>)[reviewed] : undefined;
}
