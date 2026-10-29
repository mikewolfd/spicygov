# SpicyGov

Public government data, connected. Live at **https://spicygov.ai**.

A static React application deployed to GitHub Pages. The browser reads Parquet directly from `https://data.spicygov.ai` in a Web Worker; no application server, credentials, or preview-service account is required.

## Development

Requires Node.js 22.13 or newer.

The catalog integration tests also require Python 3.12 or newer and the
maintained `spicy-regs` source checkout at `../spicy-regs`. Set
`SOURCE_CATALOG_PYTHON` and `SOURCE_CATALOG_PYTHONPATH` to use another interpreter
or source directory (the latter must point to `spicy-regs/src`). Both CI
workflows use the exact producer revision pinned in
`.github/actions/catalog-producer/action.yml`. Install its pinned `httpx`,
`loguru` and `pyarrow` dependencies for the catalog integration tests; the full
backend virtual environment is not required.

```sh
npm ci
npm run dev
npm test
npm run build
```

`npm run preview` serves the production build. `npm run check:data` reads a first-column record from each currently published table.

## Deployment

Pushes to `main` and scheduled runs build and retain artifacts. Deployment requires explicit workflow dispatch and reviewed inputs. See the [release runbook](docs/release-runbook.md) for ordinary UI releases, completed coverage data, catalog proposals, exact retained releases and rollback. Repository Pages settings use GitHub Actions and the custom domain `spicygov.ai`.

The site is hosted at the root of its custom domain. It intentionally uses root-relative asset paths. GitHub Pages custom domains for Actions deployments are configured in repository settings, not through a CNAME artifact.

## Data and joins

`lib/catalog.ts` combines the live `publication.v2.json` index with published rulemaking and comments files. Main-index entries resolve immutable generation paths and every member file. Separate files become browsable only when metadata supplies a schema bound to their exact publication identity; otherwise they remain downloads. Metadata alone never makes an unpublished table available. Errors never fall back to example records.

Descriptions, source attribution, derived inputs, coverage and declared joins load from `https://data.spicygov.ai/explorer-metadata.v1.json` on every page load or refresh. The SpicyRegs publication workflow owns that versioned bundle; new tables and declared connections need no website deployment. The old files in `lib/data/` are retained as historical snapshots and are not imported by the application.

Records load as soon as the publication catalog arrives. Metadata has a separate ten-second timeout. If it fails or its format is unsupported, every published table remains browsable with an explicit notice and no hidden bundled fallback. A table's family and full column schema must match before descriptions or connections are applied. Same-schema metadata for an older main-index publication stays usable but is marked older. Separate files require an exact descriptor, identity and schema match. Connections require two browsable published endpoints and complete, distinct key columns; unavailable declarations appear as notes instead of clickable connections.

“Browse by shared fields” carries reviewed categories into other tables without treating them as record identities. Congress, chamber, session, agency, election cycle, source collection cycle, fiscal year, CFR edition and scorecard publisher remain separate scopes. Session browsing also carries Congress. Field meanings stay visible; chamber and Table III spelling variants become exact alternatives in the filter URL, leaving stored values unchanged. Destinations advertise a compatible field, not a precomputed matching row count. Opening one runs the normal bounded page reader.

Self-referencing record links show both the referenced record and records referring back to it. Scalar links require every key component; blank, null and compound values cannot silently become identifiers. The backend registry owns the links, their measured baselines and CI checks. Array and polymorphic references require separate reviewed readers and are not inferred from matching names.

[Hyparquet](https://github.com/hyparam/hyparquet) reads selected fields over HTTP byte ranges. The reader handles multipart tables, exact filters, compound join keys, physical row cursors, and 64-bit integers. Filters apply across the whole table. Large scans may take time and can be stopped. Missing or null join values are not fabricated. Declared relationships do not prove the underlying source data is complete or correctly linked.

Click a Records column header to cycle through ascending, descending, and original order. Sorting applies across every published file and respects active filters. Numbers and dates keep their value order, text uses lexicographic order, structured values use their JSON text, and missing values stay last. The URL retains the field and direction. A sorted scan reads the sort and filter fields in a worker, then reads visible fields only for the selected records. The worker keeps a bounded sort population for smaller version-bound tables and a bounded lookahead window for larger ones, so covered pages reuse the completed scan after renewing every file version; exhausted windows and changed queries scan again. Progress and Stop remain available; [docs/reader-cache.md](docs/reader-cache.md) gives the limits. Sorted cursors identify the last record's physical position, with position breaking equal-value ties, so paging and record details retain exact row identity.

Vite gives the explorer's worker a content-based filename, so each deployment loads the matching reader instead of reusing a cached older version.

Dataset/filter state is stored in the URL. The mobile drawer, coverage notes, record details, and optional WebMCP browser tools use the same explorer state.

The dedicated MCP connection guide is at `/mcp/`. Vite builds a separate HTML entry so direct links work on GitHub Pages. The public connection endpoint remains `https://mcp.spicygov.ai/mcp`.

Composite connection filters preserve every declared key in both directions, including edition, cycle, snapshot, dump date, or term when required. NULL or missing identifiers cannot be followed. Connections browse current published records; source fields such as `input_pins_json` retain historical input identity. Declared links are not inferred from matching column names.

Forward links with a complete declared main identity offer **Open record**. The worker checks the current files for exactly one match before loading its details. Missing, duplicate and incomplete lookups remain explicit; broad keys and reverse links offer **Show related records**. Back restores the source filters and sort. Operational keys come from main columns and arrays; receipts remain separately inspectable evidence. Source-occurrence details preserve repeated references.

Each lookup worker reuses one complete, version-bound key map for a declared primitive or composite identity across multipart files, within 500,000 rows and an estimated 128 MiB. Duplicate identities stay ambiguous, and a unique position is re-read against the original filters. Larger, oversized or unsupported populations use 250,000-row continuations; the worker remembers a bounded set of completed answers, but a new key on such a table still scans. See [docs/reader-cache.md](docs/reader-cache.md). Integer and date filters use native Parquet predicates. Timestamp filters preserve microseconds and nanoseconds and use an exact scan; decimal filtering reports an explicit precision limitation.

`scripts/compare-bill-lookup.mjs` compares projected scans, the key cache and an experimental sorted locator against retained bytes that match the current publication. Write the preregistered decision and bounds beside its output before running. Measurements distinguish the first projection from repeated lookups; no experimental sidecar is published by this script.

`npm test` covers metadata refresh, outage, unsupported formats, schema changes, missing and duplicate join keys, source URL safety, bidirectional composite navigation, missing publication dates, and Parquet reading. `node scripts/check-scorecard-joins.mjs` optionally checks live scorecard schemas and five record traversals.

## Sources directory

Production pins the public catalog URL in `.env.production`. The small JSON
summaries and separate Parquet inventories live on R2, alongside a separate raw
archive of originals and receipts. Catalog rows hold searchable facts and exact
archive references; they do not repeat receipt bodies. Local development uses
`public/source-catalog`, unless `VITE_SOURCE_CATALOG_URL` is set. Explicit catalog
proposal builds use their staged catalog instead of the production URL.

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

Run `python scripts/build-coverage-maps.py` with the Python dependencies pinned in `.github/workflows/coverage-data-release.yml`. The builder inventories the main publication, rulemaking snapshot, and comments receipt using the same logical membership as Sources. The main publication takes precedence; agency comment partitions are not counted twice. A missing publication, unreviewed table, changed schema, failed required scan, or unreconciled count fails the build and preserves the previous published maps. The restoration bridges run with `SPICYGOV_COVERAGE_PYTHON`, the Python of a spicy-regs environment synced with `uv sync --frozen --no-default-groups --group source-readers` at one reviewed backend revision.

`content/coverage-definitions/` contains the website's reviewed measurement rules: named fields, precision conditions, source meaning, and exact parent lookup. These define how to measure the published data; they do not replace the data dictionary, source registry, or navigation joins. `content/coverage-reviews/` retains the table-by-table probe evidence and producer traces behind those rules. The live publication determines which tables exist.

Every map binds member identities, row counts, schema, publication generation and date, and the definition and measurement-code digests. Each member's schema and count is checked independently; a later partition cannot hide behind the first member. Matching maps can be reused; changed inputs or measurement code require recounting. Interrupted successes are retained under ignored `.cache/coverage-maps/` and never served as a partial inventory. The coverage data-release workflow restores these checkpoints from earlier runs and saves newly completed tables even if another scan fails. A cache hit never skips validation: changed files, schemas, rules, scanner code, paired-export receipts, or a clock-based month boundary require a recount. A table's measurement revision hashes `scripts/coverage_scan.py`, the shared helpers and only its own scanner's modules (plus the reader bridge and its reader identity for native tables), so editing the builder, release assembly or the time allowances in `scripts/coverage_allowances.py` keeps every checkpoint and editing one scanner re-measures only that scanner's tables. A final check rejects publication or policy changes during scanning. Before atomic publication, the actual generated file must pass the frontend parser and match every table returned by the live Sources loaders. Typed timestamp instants are grouped in an explicit UTC session; text date literals retain their stated calendar dates. One reviewed spicy-regs revision restores all native tables: `python -m spicy_regs.coverage_reader` for bill and print families, and `scripts/restore_additional_coverage.py` and `scripts/restore_source_navigation_coverage.py` for amendments, courts, navigation, regulatory, rulemaking, votes and FCC. Each reader’s implementation identity is bound to the table’s checkpoint. Receipts must use the current dataset policy or one of its declared earlier policy versions (carried receipts keep the version they were written under); undeclared or null policies, missing receipt fields and empty or null generations are refused and need a current-format data refresh. Carried receipts also keep the generation that first wrote them, so a receipt may name an earlier generation; the pinned receipt-file bytes, not the receipts' labels, bind the selection. Flat published tables are measured directly by the published-table scanner; native tables must be the reviewed native subject and use receipts under the current or a declared earlier policy version, and any other published schema in a native family is refused. Changed native schemas and reader identities require new measurements.

Inherited periods resolve the producing release, including carried-forward tables, then its exact retained parent. Parent and child counts reconcile; a unique-parent join cannot multiply rows. Multiple terms, hearing sessions, lists, and related legal events count a root record once per period, with separately deduplicated annual counts. Unmatched, partial, approximate, invalid, and unknown values remain explicit. Source-stated spans do not imply an observation in every intervening month.

For converted bill and print families, coverage binds the physical native tables to their exact generation and uses the backend’s maintained private restoration reader for original source fields. Receipt-only supporting tables stay private. Install the backend’s frozen `source-readers` dependency group and set `SPICYGOV_COVERAGE_PYTHON` to its `.venv/bin/python`; the explicit coverage data-release workflow checks out and installs the reviewed `backend_revision`. A reader, policy, receipt or file mismatch refuses reuse and publication. GAO origin maps accept the current major-rule listing and older-index routes while preserving literal receipt labels.

Native government receipts match saved rows by their natural identity and exact content version. The bounded reader accepts only reviewed policy versions, verifies the subject and receipt file hashes, and refuses missing, duplicate, or mismatched records. Recipient observation dates describe the last saved ranking read, not award activity. GAO origin routes do not attribute every field added by later updates. Activity-spike snapshots show their recorded calculation time and comparison windows separately from publication.

Source and content views distinguish listed bill printings from acquired text, recorded acquisition routes from evidence sources, and saved text from blank or absent values. Comment text and extracted attachment text remain separate. These views describe retained fields; they do not establish whether the publisher has other content. Loan deadlines preserve literal terms and leave ambiguous dates outside the calendar.

FEC scope maps retain exact collection/witness generation pins, bulk-directory or mapping cycles, selected members, and literal query filters. Qualified empty requests remain limited to those filters; refusals and inventory-only records never become checked-empty periods. Large source-record key scans use exact constant row-group statistics and read every mixed or inexact group with maintained PyArrow/fsspec readers. Pinned collection metadata downloads are hash-verified before batch parsing.

Comments use the paired monthly index to count comments separately from index groups, reconciling both totals. Both maps bind both exports' recorded hashes, counts, sizes, and ETags. The builder checks both exports' receipt ETags and sizes before and after scanning, and before cache reuse. The older `build-time-coverage.py` and `time-coverage.v1.json` remain historical compatibility artifacts; Sources uses `coverage-maps.v1.json`.

Current documents, votes, court opinions, CFR, agenda, Federal Register and docket-link subjects use the same selected receipt readers to restore their original coverage inputs. Typed public values do not replace source spellings or processing evidence used by the reviewed dimensions.

Native rulemaking tables keep their snapshot identity. Coverage binds the selected pointer, manifest, subject and receipt hashes, sizes, counts and receipt generation. The browser derives the same bindings before displaying a map as current. Older rulemaking snapshots keep their existing behavior. Immutable snapshot receipt hashes support reuse; mutable comments exports still require their recorded ETags.

Explicit coverage data refreshes save and restore validated checkpoints. Every reused result still passes the existing input, schema, scanner and publication checks. If a publication changes during a build, deployment stops and the next refresh checks the new state.

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

The existing native coverage adapter also admits the small committee-report, roster, law, legal-reference, press-release, Record, Senate-expenditure, treaty and court-extraction families. It restores original values from the selected receipts before applying the reviewed dimensions. Section coverage keeps the complete same-generation parent keys; court extraction resolves its witnessed prior and that prior's recorded opinion input. Snapshot dimensions describe the selected publication.

## Shared source catalog

The Sources page begins with shared catalog collections, including advertised
sources and retained inputs without published tables. Existing published-table
navigation, coverage and provenance remain below it. Missing or invalid catalog
metadata produces an explicit error while the table directory remains usable.

The public reader defaults to `/source-catalog/manifest.json`.
`VITE_SOURCE_CATALOG_URL` may select another HTTP(S) manifest at build time.
Partition paths stay under that manifest's directory and each returned partition
must match its generation and collection ID. The reader cancels a response above
16 MiB, including chunked transfers, and reports an error. Opening a collection requests its
detail; file inventory loads only when requested, one page at a time. The reader
rejects file pages above the exporter's supported maximum of 5,000 aliases.
Route periods preserve their recorded kind and evidence basis; unknown periods
remain unknown. Advertised, enumerated, held, planned and published states retain
their separate meanings. Catalog table pins that differ from a loaded current
table display a stale-evidence notice.

Generate exports using the `spicy-regs` source-catalog CLI documented in that
repository. Copy only its **public** directory into `public/source-catalog/` for
a local production candidate, or serve it through the separately authorized data
publication path. `npm run check:catalog` and `npm run build` reject internal
fields, local paths, credential-bearing URLs and symlinks in catalog artifacts.
The production build excludes the operations HTML entry and checks built files
again before completion. Preserve the previous public generation until the
candidate is validated; restoring the previous public directory restores its
manifest and partitions together. No refresh or publication occurs in the UI.

Each UI build also derives Federal Register quarter coverage from dates observed
in the selected catalog's saved local files. It binds the summary to that catalog
generation; missing or mismatched summaries display as unchecked. A quarter with
at least one dated record is present, but that does not prove it is complete.
For a local archive refresh, run `scripts/refresh-local-catalog.py --help` with
the SpicyRegs source-readers Python environment. This command builds and validates
a candidate from the selected inventory plus receipt additions, preserves published table versions, exports and selects the catalog,
and updates this site's quarter summary. It checks both stored and original byte
hashes for locally held Federal Register sources, then compares the source dates
with the summary generated by the website build. Unknown file formats stay
explicitly undated. It performs no downloads or deployment.
Pass `--coverage-selection` to retain an existing completed table coverage release.
Keep catalog readers and writers paused during the selection, as required by the
catalog CLI. A failed check stops the workflow before its next step.
An unchanged Federal Register content reader reuses its existing date observations.
Changed base manifests require an explicit `--full-rebuild`.

On failure, keep the run directory and check its last completed report before
retrying. Before selection, `--candidate` reuses the prepared inventory in a new
run; validation, the file audit, and export still repeat. After selection, the
candidate has moved into the selected cache. If only the UI build failed, run
use `--finish-selected` with the existing `--run`, `--raw-root`, `--cache`,
`--public`, and coverage selection. Omit `--candidate` and `--full-rebuild`.
This checks the native selection controls and exact exported member pins, then
finishes only the website. It does not repeat inventory construction, the byte
audit, validation or export. A lost selection acknowledgement is reconciled with
the native controls; backups without an acknowledged owner are retained.
The command retires only this run's named backups after the build and readback
checks pass. For an interrupted catalog switch with inconsistent controls, keep readers
paused and follow its `selection-backup-*/recovery.json` through the maintained
catalog selection procedure before retrying.

Source dates mean recognized publication dates; undated-file counts remain in
the supporting detail. A changed published release keeps its previous measurement
clearly labelled until the exact new release can be measured. Archive-relative
file and receipt keys remain usable locally; their public mirror locations are
explicitly unverified until separate mirror evidence establishes availability.

For the read-only local operations screen, keep the separate **internal** export
outside this repository's `public/` and build directories:

```sh
SPICY_CATALOG_INTERNAL_DIR=/absolute/path/to/catalog/export/internal npm run dev:ops
```

Open the loopback URL at `/ops/`. This explicit dev-only configuration serves
internal JSON from the selected real directory. It restricts remote address,
Host and Origin to loopback, rejects writes and traversal, and refuses symlinks
that leave that directory. Internal files add local paths, stored sizes and
verification states. Local evidence and lineage remain inside the operations
view. Both views use the same collection IDs and generation. Normal `npm run dev`
blocks the operations entry and internal endpoint. The operations configuration
refuses production builds and preview serving.

`tests/source-catalog.test.mjs` covers lazy loading, upstream-only collections,
route distinctions, generation drift, failure fallback, partition boundaries,
public privacy validation and the operations server's access boundary.
