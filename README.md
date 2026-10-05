# SpicyGov

Public government data, connected. Live at **https://spicygov.ai**.

A static React application deployed to GitHub Pages. The browser reads Parquet directly from `https://data.spicygov.ai` in a Web Worker; no application server, credentials, or preview-service account is required.

## Development

Requires Node.js 22.13 or newer.

```sh
npm ci
npm run dev
npm test
npm run build
```

`npm run preview` serves the production build. `npm run check:data` reads a first-column record from each currently published table.

## Deployment

Push to `main` or run **Deploy SpicyGov** in Actions. The workflow tests and builds the site, then deploys `dist/` to GitHub Pages. Repository Pages settings use GitHub Actions and the custom domain `spicygov.ai`. With the apex and `www` DNS records pointing to GitHub Pages, GitHub redirects `www.spicygov.ai` to the apex domain. Enable HTTPS enforcement when GitHub finishes provisioning the certificate.

The site is hosted at the root of its custom domain. It intentionally uses root-relative asset paths. GitHub Pages custom domains for Actions deployments are configured in repository settings, not through a CNAME artifact.

## Data and joins

`lib/catalog.ts` loads `publication.v2.json` live, resolving immutable generation paths and all member files for every published table. Metadata-only tables absent from that index are not represented as available. Errors never fall back to example records.

Descriptions, source attribution, derived inputs, coverage and declared joins load from `https://data.spicygov.ai/explorer-metadata.v1.json` on every page load or refresh. The SpicyRegs publication workflow owns that versioned bundle; new tables and declared connections need no website deployment. The old files in `lib/data/` are retained as historical snapshots and are not imported by the application.

Records load as soon as the publication catalog arrives. Metadata has a separate ten-second timeout. If it fails or its format is unsupported, every published table remains browsable with an explicit notice and no hidden bundled fallback. A table's family and full column schema must match before descriptions or connections are applied. Same-schema metadata for an older publication stays usable but is marked older. Connections require two published endpoints and complete, distinct key columns; unavailable declarations appear as notes instead of clickable connections.

[Hyparquet](https://github.com/hyparam/hyparquet) reads selected fields over HTTP byte ranges. The reader handles multipart tables, exact filters, compound join keys, physical row cursors, and 64-bit integers. Filters apply across the whole table. Large scans may take time and can be stopped. Missing or null join values are not fabricated. Declared relationships do not prove the underlying source data is complete or correctly linked.

Dataset/filter state is stored in the URL. The mobile drawer, coverage notes, record details, and optional WebMCP browser tools use the same explorer state.

The dedicated MCP connection guide is at `/mcp/`. Vite builds a separate HTML entry so direct links work on GitHub Pages. The public connection endpoint remains `https://mcp.spicygov.ai/mcp`.

Composite connection filters preserve every declared key in both directions, including edition, cycle, snapshot, dump date, or term when required. NULL or missing identifiers cannot be followed. Connections browse current published records; source fields such as `input_pins_json` retain historical input identity. Declared links are not inferred from matching column names.

`npm test` covers metadata refresh, outage, unsupported formats, schema changes, missing and duplicate join keys, source URL safety, bidirectional composite navigation, missing publication dates, and Parquet reading. `node scripts/check-scorecard-joins.mjs` optionally checks live scorecard schemas and five record traversals.

## Sources directory

`/sources/` combines the main publication index with the live rulemaking snapshot at `materialized/rulemaking/latest.json` and the comments export receipt at `comments-publication.json`. Only public snapshot artifacts are listed. Comments agency partitions are not counted again. Main-index entries take precedence when tables migrate between publication formats. Separate publications link directly to Parquet files; the explorer still uses the main index. Failure to read one publication leaves the others visible with an explicit warning.

The source tables show live row counts, publication dates, acquisition methods and evidence links. Search and filters find methods, empty outputs, separate publications, reviewed journals and native row receipts. Expanded details show acquisition history, known gaps, original source links and on-demand generation inputs. Parent links retain their pinned generation rather than silently switching to current data. Native receipts appear only for datasets explicitly listed in the live family's `etlReceipts` descriptor. Merely displaying a receipt does not verify its rows or file checksum.

`public/source-inventory.v1.json` is a dated acquisition review, generated from the table inventory. It supplies explanatory notes and code references, never live table membership, row counts or joins. Earlier source attribution is labeled explicitly. Reviewed journal links are shown only while the reviewed family and artifact digest match the live publication. New tables still appear without a review; generation records can be inspected on demand for their current evidence.

`content/source-copy.json` holds the concise table labels, collection summaries, scope and essential limits shown on the page. Its inventory checksum binds the wording to the evidence reviewed. Edit this copy when reviewing an inventory, preserving material warnings from the data dictionary as well as the inventory. The importer requires copy for every published table and rejects a different inventory checksum or extra tables. Original audit notes remain in the generated review for reference.

To import a newly reviewed inventory, run `node scripts/import-source-inventory.mjs /path/to/inventory.json`, then `npm test` and `npm run build`. Commit the generated review with the importer changes, when any. The Sources entry point fetches it separately, so the explorer does not download acquisition notes. The importer records the inventory checksum, review date and inspected source revision.

Publication dates describe file publication, never record coverage. Missing dates and undocumented scope are labeled explicitly; zero rows do not establish failure or completeness. Acquisition tags describe inspected code and documented history, not measured shares of current rows. Receipts and source journals establish recorded lineage; expected upstream populations still need to be defined before completeness can be measured.
