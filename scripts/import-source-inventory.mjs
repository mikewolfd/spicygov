import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Import a dated audit, never counts or live publication membership. The public
// manifests remain the authority for what is available on the Sources page.
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/import-source-inventory.mjs /path/to/inventory.json');
const bytes = await readFile(input);
const inventory = JSON.parse(bytes);
if (inventory.format !== 'spicygov-table-acquisition-inventory' || inventory.version !== 1) throw new Error('Unsupported inventory format');
const tables = {};
for (const record of inventory.records) {
  if (!['generation', 'rulemaking_snapshot', 'comments_export'].includes(record.availability)) continue;
  if (tables[record.table]) throw new Error(`Duplicate table: ${record.table}`);
  const audit = record.acquisition_review;
  tables[record.table] = {
    family: record.family, label: record.label, methods: audit.methods,
    summary: audit.acquisition_summary, mixing: audit.mixing_and_legacy,
    gaps: audit.gaps, scope: record.dictionary_scope,
    evidence: audit.evidence.map(({ url, note }) => ({ url, label: note })),
    sources: record.source_attribution_metadata.sources,
    attributionRevision: record.source_attribution_metadata.revision,
    artifactDigest: record.observed_publication.artifact_digest,
    // These links describe only the reviewed generation, and are suppressed
    // whenever the live artifact digest or family no longer matches.
    generationLinks: record.availability === 'generation' ? record.evidence_links.filter(link =>
      ['Source evidence record', 'Source observation journal'].includes(link.label)) : [],
  };
}
const output = {
  format: 'spicygov-source-review', version: 1, reviewedAt: inventory.created_at,
  sourceRevision: inventory.source_revision,
  inputSha256: createHash('sha256').update(bytes).digest('hex'), tables,
};
await writeFile(new URL('../public/source-inventory.v1.json', import.meta.url), JSON.stringify(output) + '\n');
console.log(`Imported dated acquisition reviews for ${Object.keys(tables).length} tables.`);
