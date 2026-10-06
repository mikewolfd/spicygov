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

`lib/catalog.ts` combines the live `publication.v2.json` index with published rulemaking and comments files. Main-index entries resolve immutable generation paths and every member file. Separate files become browsable only when metadata supplies a schema bound to their exact publication identity; otherwise they remain downloads. Metadata alone never makes an unpublished table available. Errors never fall back to example records.

Descriptions, source attribution, derived inputs, coverage and declared joins load from `https://data.spicygov.ai/explorer-metadata.v1.json` on every page load or refresh. The SpicyRegs publication workflow owns that versioned bundle; new tables and declared connections need no website deployment. The old files in `lib/data/` are retained as historical snapshots and are not imported by the application.

Records load as soon as the publication catalog arrives. Metadata has a separate ten-second timeout. If it fails or its format is unsupported, every published table remains browsable with an explicit notice and no hidden bundled fallback. A table's family and full column schema must match before descriptions or connections are applied. Same-schema metadata for an older main-index publication stays usable but is marked older. Separate files require an exact descriptor, identity and schema match. Connections require two browsable published endpoints and complete, distinct key columns; unavailable declarations appear as notes instead of clickable connections.

“Browse by shared fields” carries reviewed categories into other tables without treating them as record identities. Congress, chamber, session, agency, election cycle, source collection cycle, fiscal year, CFR edition and scorecard publisher remain separate scopes. Session browsing also carries Congress. Field meanings stay visible; chamber and Table III spelling variants become exact alternatives in the filter URL, leaving stored values unchanged. Destinations advertise a compatible field, not a precomputed matching row count. Opening one runs the normal bounded page reader.

Self-referencing record links show both the referenced record and records referring back to it. Scalar links require every key component; blank, null and compound values cannot silently become identifiers. The backend registry owns the links, their measured baselines and CI checks. Array and polymorphic references require separate reviewed readers and are not inferred from matching names.

[Hyparquet](https://github.com/hyparam/hyparquet) reads selected fields over HTTP byte ranges. The reader handles multipart tables, exact filters, compound join keys, physical row cursors, and 64-bit integers. Filters apply across the whole table. Large scans may take time and can be stopped. Missing or null join values are not fabricated. Declared relationships do not prove the underlying source data is complete or correctly linked.

Click a Records column header to cycle through ascending, descending, and original order. Sorting applies across every published file and respects active filters. Numbers and dates keep their value order, text uses lexicographic order, structured values use their JSON text, and missing values stay last. The URL retains the field and direction. Each sorted page scans the sort and filter fields in a worker, keeps only its next page of candidates, and then reads their visible fields. Large tables require a full scan for each page; progress and Stop remain available. Sorted cursors identify the last record's physical position, with position breaking equal-value ties, so paging and record details retain exact row identity.

Vite gives the explorer's worker a content-based filename, so each deployment loads the matching reader instead of reusing a cached older version.

Dataset/filter state is stored in the URL. The mobile drawer, coverage notes, record details, and optional WebMCP browser tools use the same explorer state.

The dedicated MCP connection guide is at `/mcp/`. Vite builds a separate HTML entry so direct links work on GitHub Pages. The public connection endpoint remains `https://mcp.spicygov.ai/mcp`.

Composite connection filters preserve every declared key in both directions, including edition, cycle, snapshot, dump date, or term when required. NULL or missing identifiers cannot be followed. Connections browse current published records; source fields such as `input_pins_json` retain historical input identity. Declared links are not inferred from matching column names.

`npm test` covers metadata refresh, outage, unsupported formats, schema changes, missing and duplicate join keys, source URL safety, bidirectional composite navigation, missing publication dates, and Parquet reading. `node scripts/check-scorecard-joins.mjs` optionally checks live scorecard schemas and five record traversals.

## Sources directory

`/sources/` combines the main publication index with the live rulemaking snapshot at `materialized/rulemaking/latest.json` and the comments export receipt at `comments-publication.json`. Only public snapshot artifacts are listed. Comments agency partitions are not counted again. Main-index entries take precedence when tables migrate between publication formats. Separate publications offer record browsing when their exact schema metadata is available and Parquet downloads otherwise. Failure to read one publication leaves the others visible with an explicit warning.

The source tables show live row counts, publication dates, acquisition methods and evidence links. Search matches displayed family headings, readable table names and raw identifiers, treating spaces, underscores and hyphens alike. Filters find methods, empty outputs, separate publications, reviewed journals and native row receipts. Expanded details show acquisition history, known gaps, original source links and on-demand generation inputs. Parent links retain their pinned generation rather than silently switching to current data. Native receipts appear only for datasets explicitly listed in the live family's `etlReceipts` descriptor. Merely displaying a receipt does not verify its rows or file checksum.

`public/source-inventory.v1.json` is a dated acquisition review, generated from the table inventory. It supplies explanatory notes and code references, never live table membership, row counts or joins. Earlier source attribution is labeled explicitly. Reviewed journal links are shown only while the reviewed family and artifact digest match the live publication. New tables still appear without a review; generation records can be inspected on demand for their current evidence.

`content/source-copy.json` holds the concise table labels, collection summaries, scope and essential limits shown on the page. Its inventory checksum binds the wording to the evidence reviewed. Edit this copy when reviewing an inventory, preserving material warnings from the data dictionary as well as the inventory. The importer requires copy for every published table and rejects a different inventory checksum or extra tables. Original audit notes remain in the generated review for reference.

To import a newly reviewed inventory, run `node scripts/import-source-inventory.mjs /path/to/inventory.json`, then `npm test` and `npm run build`. Commit the generated review with the importer changes, when any. The Sources entry point fetches it separately, so the explorer does not download acquisition notes. The importer records the inventory checksum, review date and inspected source revision.

Publication dates describe file publication, never record coverage. Missing dates and undocumented scope are labeled explicitly; zero rows do not establish failure or completeness. Acquisition tags describe inspected code and documented history, not measured shares of current rows. Receipts and source journals establish recorded lineage; expected upstream populations still need to be defined before completeness can be measured.

The Sources page renders coverage and limits in the list. Opening a table loads recorded inputs and a bounded preview of source requests (up to 64 KiB and five observations). Logs apply to a release family, not necessarily an individual table or row; this distinction is shown in the page. Raw downloads remain under technical details.

## Coverage maps

The Sources page shows each table's meaningful dates, election cycles, Congresses, publisher editions, reporting spans, or saved release. “Count by” switches between independent views. Regulation titles and editions appear together; source labels preserve relative and lifetime scorecard periods. A period with no placed rows means only that this file has none. It does not establish complete collection or an empty publisher population.

`content/source-labels.json` owns readable coverage-view names, source-group headings, controls, field names and known category values. `lib/source-labels.ts` applies them only for display. Unknown values remain literal; publisher identifiers, calendar years, election cycles and edition codes retain their meaning. Category details show original values beside readable labels, and searches match both. Label edits do not change measurement definitions, stored records, release checks or coverage-cache keys, so they require only the website tests and build, without coverage rescans.

Run `python scripts/build-coverage-maps.py` with the Python dependencies pinned in `.github/workflows/deploy-pages.yml`. The builder inventories the main publication, rulemaking snapshot, and comments receipt using the same logical membership as Sources. The main publication takes precedence; agency comment partitions are not counted twice. A missing publication, unreviewed table, changed schema, failed required scan, or unreconciled count fails the build and preserves the previous published maps.

`content/coverage-definitions/` contains the website's reviewed measurement rules: named fields, precision conditions, source meaning, and exact parent lookup. These define how to measure the published data; they do not replace the data dictionary, source registry, or navigation joins. `content/coverage-reviews/` retains the table-by-table probe evidence and producer traces behind those rules. The live publication determines which tables exist.

Every map binds member identities, row counts, schema, publication generation and date, and the definition and measurement-code digests. Each member's schema and count is checked independently; a later partition cannot hide behind the first member. Matching maps can be reused; changed inputs or measurement code require recounting. Interrupted successes are retained under ignored `.cache/coverage-maps/` and never served as a partial inventory. CI restores these checkpoints from earlier runs and saves newly completed tables even if another scan fails. A cache hit never skips validation: changed files, schemas, rules, scanner code, paired-export receipts, or a clock-based month boundary require a recount. A final check rejects publication or policy changes during scanning. Before atomic publication, the actual generated file must pass the frontend parser and match every table returned by the live Sources loaders. Typed timestamp instants are grouped in an explicit UTC session; text date literals retain their stated calendar dates. `select_native_coverage_reader.py` routes document citations to the maintained historical court-key reader; other legislative tables retain their qualified reader. Each reader reports its implementation identity, which is bound to that table’s checkpoint. Newly promoted member, meeting, nomination, communication and FCC schemas use `restore_source_navigation_coverage.py`: it verifies the selected receipts and retains the existing date and source-detail inputs for coverage. Navigation fields stay in the public subjects and receipts. The compatibility review preserves unchanged legacy scans; changed native schemas and reader identities require new measurements.

Inherited periods resolve the producing release, including carried-forward tables, then its exact retained parent. Parent and child counts reconcile; a unique-parent join cannot multiply rows. Multiple terms, hearing sessions, lists, and related legal events count a root record once per period, with separately deduplicated annual counts. Unmatched, partial, approximate, invalid, and unknown values remain explicit. Source-stated spans do not imply an observation in every intervening month.

For converted bill and print families, coverage binds the physical native tables to their exact generation and uses the backend’s maintained private restoration reader for original source fields. Receipt-only supporting tables stay private. Install the backend’s frozen `source-readers` dependency group and set `SPICYGOV_NATIVE_COVERAGE_BRIDGE` to its `scripts/restore_coverage_processing.py` and `SPICYGOV_NATIVE_COVERAGE_PYTHON` to its `.venv/bin/python`; the deployment workflow checks out and installs its pinned reader automatically. A reader, policy, receipt or file mismatch refuses reuse and publication. Native amendments and courts use `SPICYGOV_ADDITIONAL_COVERAGE_BRIDGE` with `scripts/restore_additional_coverage.py` and `SPICYGOV_ADDITIONAL_COVERAGE_PYTHON`. The workflow pins that reader separately so the qualified print measurements keep their producing reader. GAO origin maps accept the current major-rule listing and older-index routes while preserving literal receipt labels.

Native government receipts match saved rows by their natural identity and exact content version. The bounded reader accepts only reviewed policy versions, verifies the subject and receipt file hashes, and refuses missing, duplicate, or mismatched records. Recipient observation dates describe the last saved ranking read, not award activity. GAO origin routes do not attribute every field added by later updates. Activity-spike snapshots show their recorded calculation time and comparison windows separately from publication.

Source and content views distinguish listed bill printings from acquired text, recorded acquisition routes from evidence sources, and saved text from blank or absent values. Comment text and extracted attachment text remain separate. These views describe retained fields; they do not establish whether the publisher has other content. Loan deadlines preserve literal terms and leave ambiguous dates outside the calendar.

FEC scope maps retain exact collection/witness generation pins, bulk-directory or mapping cycles, selected members, and literal query filters. Qualified empty requests remain limited to those filters; refusals and inventory-only records never become checked-empty periods. Large source-record key scans use exact constant row-group statistics and read every mixed or inexact group with maintained PyArrow/fsspec readers. Pinned collection metadata downloads are hash-verified before batch parsing.

Comments use the paired monthly index to count comments separately from index groups, reconciling both totals. Both maps bind both exports' recorded hashes, counts, sizes, and ETags. The builder checks both exports' receipt ETags and sizes before and after scanning, and before cache reuse. The older `build-time-coverage.py` and `time-coverage.v1.json` remain historical compatibility artifacts; Sources uses `coverage-maps.v1.json`.

## Column and relationship audit

Capture the public explorer's schemas, publication identities, and bounded column samples:

```sh
node scripts/audit-columns.mjs --out /path/to/column-audit
node scripts/render-column-audit.mjs --out /path/to/column-audit
```

Open the resulting `report.html` to search field names, definitions, table occurrences, samples, and declared connections. The sampler reads up to three rows at each of the first, middle, and last positions, with at most three nonblank values retained per field. It uses range requests, limits downloaded bytes, records incomplete samples, and reuses completed samples only when the captured table and sampler fingerprint match. Large Parquet footers can exceed the bounds and require a separately recorded reader exception. These samples do not establish a field's completeness, uniqueness, or suitability for a join.

The renderer can also display separately captured `key-checks.json` and `findings.json` in the output directory. Full key checks must record the selected publications, missing destinations, and parent uniqueness before a proposed connection is added to the backend's canonical join registry. Shared categories such as Congress or chamber can support browsing filters without identifying individual records.

## Source references

Open a record to follow its recorded references: nominations and treaties at meetings, nomination committees and hearings, vote documents and amendments, FCC proceedings and offered documents, Congressional Record passages, legal citation candidates, and FEC source records. Composite keys retain every required part, including nomination partitions. Missing keys and ambiguous candidates remain explicit; a shared name alone does not identify a record.

Reverse links find records containing the selected reference. Array searches read the needed columns in pages; a partially checked page is labeled incomplete. Native source fields load only when requested, from receipts paired with the selected publication generation and exact record identity. Receipt searches check up to 50,000 rows per page and can continue. These references do not establish source completeness, document capture or extraction, or financial totals.

`explorer-metadata.v1.json` supplies the backend's canonical navigation recipes and receipt field definitions. The browser supports physical arrays and JSON, complete scalar keys, and explicitly declared receipt fields. Undeployed fields stay visible as unavailable connections. It never scans source receipts while rendering the table. Unsorted reverse links check up to 250,000 source rows per page; Next continues from the last checked row, including when a page has no matches. Sorted results still check the whole table to preserve global order. Each read reuses the Parquet footer across its batches.

### Measure connections against the published files

`node scripts/audit-navigation.mjs --output /tmp/navigation-audit.json` checks
both scalar joins and the array/composite recipes used by the explorer. It
records the selected file and receipt pins with each result. Counts retain
repeated source references; multiple retained target rows do not automatically
mean an ambiguous identity. Offered document URLs count separately from captures.

The default scan checks up to 25,000 source rows and indexes targets with up to
100,000 rows. `--tables fcc_filings,native_legal_references` selects source tables;
`--max-source-rows` and `--max-target-rows` set explicit limits. `partial` means
the source scan or target check is incomplete. `unmeasured` means required
source fields cannot be checked through this projection. Neither status asserts
that references or targets are absent.

Rerunning with the same output file reuses complete results only when the
recipes, reader implementation, and source/target file pins still match. Existing
full scalar measurements are also reused when both selected file populations
match exactly and their counts do not amplify source rows. Within a run, each
source projection and target key population is shared across its recipes; each
member's footer is parsed once per projection. This audit runs separately from
site builds and does not republish or recount the source data.

A partial source scan continues after its last checked row when all targets
were checked. A partial result with unchecked targets is reused until its limits
or pins change; repeatedly scanning the same source prefix would add no evidence.

The existing native coverage adapter also admits the small committee-report, roster, law, legal-reference, press-release, Record, Senate-expenditure, treaty and court-extraction families. It restores original values from the selected receipts before applying the reviewed dimensions. Section coverage keeps the complete same-generation parent keys; court extraction resolves its witnessed prior and that prior's recorded opinion input. Snapshot dimensions describe the selected publication. The original legacy scanners and their validated checkpoints keep their reviewed revision.
