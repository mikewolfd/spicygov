# Build, review and release SpicyGov

Pushes to `main` and scheduled runs build and retain a Pages artifact. They do
not deploy. The ordinary deployment route is a manual **Deploy SpicyGov** run
with `build_only=false` and `source_catalog=false`. It requires an independently
selected completed coverage release. The default local `npm run build` remains
usable offline and explicitly serves coverage as unavailable.

## UI builds and coverage data

`npm run build` builds the UI without restoring source data. It puts an explicit
coverage-unavailable document and `coverage-build-status.json` in `dist/`.
Sources already reports a coverage load failure while keeping records browsable.
The historical `public/coverage-maps.v1.json` and qualified checkpoint files stay
unchanged. `npm run build:assets` is the internal asset compiler; use the supported
build commands to apply the intended coverage status.

For completed coverage, run `npm run build:ui -- --selection <selection.json>`.
When the build includes a source catalog, it compiles the browser to read that
same catalog at `/source-catalog/manifest.json`. A stale remote URL setting cannot
replace the bundled selection. Check the production preview before packaging.
The selection has the format shown in
`content/coverage-release-selection.v1.example.json`. Review and supply the
release directory and exact manifest SHA-256; never use a mutable latest pointer.
For CI, retain the selected release directory in the checkout and select it with
`content/coverage-release-selection.v1.json`. Missing selection, changed bytes,
policy/schema/scanner changes, incomplete membership and expired measurement
months fail the strict build. There is no source-restoration fallback.

The independent consumer checks all retained members, effective policies,
measurement revisions and the actual Sources parsers against captured publication
documents. Browser runtime checks remain independent: a newer live publication
marks retained coverage as previous or unavailable. A successful offline build
proves agreement with the retained selection, not currentness of live sources.

Create coverage data locally from a reviewed SpicyGov checkout. Record its exact
revision and the reviewed 40-hex spicy-regs revision containing
`spicy_regs/coverage_reader.py`. Select an existing backend environment that imports
that exact reader through `SPICYGOV_COVERAGE_PYTHON`; an interpreter path alone
does not establish its source revision. Keep the environment and source unchanged
through completion.

Use an existing builder environment with the dependencies pinned in
`.github/workflows/coverage-data-release.yml` (duckdb, pyarrow, fsspec, aiohttp),
plus the repository's locked Node dependencies for the offline consumer. From
the selected SpicyGov checkout, run:

```sh
SPICYGOV_COVERAGE_PYTHON=/path/to/backend-environment/bin/python \
  /path/to/builder-environment/bin/python scripts/build-coverage-maps.py \
  --output /owned/run/coverage-maps.v1.json \
  --release-output /owned/run/completed-coverage-release
```

Choose a release directory that does not already exist. Keep the command, source
and environment identities, exit status and log with the local run evidence.
A successful full build emits the release. It retains the exact
publication bytes used, effective policies, reader identities through policy and
measurement revisions, map bytes, and implementation hashes. Standalone partial
scans remain checkpoints; selected refreshes use the path below. The artifact is a candidate for separate
review and selection.

### Refresh selected tables

To correct a specific table without a full inventory rescan, use the same builder
with an explicitly selected prior map. Supply the retained map's reviewed SHA-256:

```sh
SPICYGOV_COVERAGE_PYTHON=/path/to/backend-environment/bin/python \
  /path/to/builder-environment/bin/python scripts/build-coverage-maps.py \
  --only cfr_sections --refresh-from /owned/prior/coverage-maps.v1.json \
  --base-sha256 sha256:<reviewed-hash> \
  --output /owned/run/coverage-maps.v1.json \
  --release-output /owned/run/coverage-refresh
```

This creates a `spicygov-coverage-refresh-release`, not a full coverage release.
Every selected table receives the normal schema, source, reader and reconciliation
checks. The release retains the exact prior map and current publication documents.
The independent consumer refuses any change to an unselected measurement, verifies
the refreshed tables against their publications, and keeps existing stale or
unavailable labels for the others. Select its manifest through the same selection
file and `build:ui` command; the build status reports `refreshed`. A plain `--only`
scan still cannot create a release, and full releases still require every table.

There is one supported reader route: the packaged
`spicy_regs.coverage_reader` and the two spicygov adapters that run on it
(`restore_additional_coverage.py`, `restore_source_navigation_coverage.py`).
Undeclared or null receipt policies and missing receipt fields or generation labels
are refused. Carried receipts keep their original generation and may use a declared
earlier policy version. The selected receipt-file size and SHA-256 bind the exact
bytes; complete subject-to-receipt admission still proves every selected row. Flat published
tables are measured directly by the published-table scanner; native tables must
be the reviewed native subject and use receipts under the current or a declared
earlier policy version.

The checked-in `public/coverage-maps.v1.json`, the pre-2026-10-17 `.cache/coverage-maps`
checkpoints and the archived fixture releases are retained evidence. They carry measurement
revisions the current code does not issue, so the first coverage data release measures every
published table again.

That includes the 73 tables whose generations have not changed since 2026-10-05: the owner
chose a rescan over a one-time compatibility re-bind.

The release may take several attempts. Each run checkpoints every table it completes
under the selected checkout's `.cache/coverage-maps` directory.
A later run reuses a checkpoint only while all of its bindings still match: generation bytes,
schema, policy and dimension digests, the activity month, and the measurement revision. A table
republished between runs is measured again.

Measurement revisions are per scanner:

- Orchestration, release and allowance edits (`build-coverage-maps.py`,
  `coverage_release.py`, `coverage_allowances.py`) keep checkpoints.
- An edit to `coverage_scan.py` or a shared helper re-measures every table.
- An edit to one scanner module re-measures only that scanner's tables.
- A new spicy-regs reader identity re-measures the native tables.

Keep the reviewed backend revision fixed until the release completes. Resume an
interrupted release with the same local command, checkout and checkpoint directory;
a changed reader identity re-measures native tables. The builder rechecks every
checkpoint's bindings before reuse. Retain failed attempts and diagnose their
specific failure before retrying; do not discard compatible checkpoints or repeat
the producer merely to read back a completed release.

`bill_subjects` and its `bill-subjects` family are already registered in
`scripts/native_legislative_coverage.py`. The existing definition/schema gate
checks their selected source; no registration step remains.

**Completion run.** The final check refuses if any captured publication document
changes during the run (`build-coverage-maps.py`). Coordinate with active source
writers, including local jobs, before starting the completion attempt. A scheduled
quiet period or an empty GitHub queue does not establish that no writer is active;
the final byte-binding check remains authoritative.

**Readback that proves completion:**

1. The local process exits zero, and its log has
   `All <N> requested coverage maps verified` plus the completed directory and
   `manifestSha256` JSON result. N is the selected census table count; a partial
   `--only` scan cannot produce a completed release.
2. Check `shasum -a 256 <dir>/manifest.json` against the logged `manifestSha256`.
   Reuse the completed local directory; no artifact download or producer rerun
   is needed.
3. The producer runs the offline consumer before declaring completion. For
   independent review, use the same maintained command from the selected source
   revision: `node scripts/consume-coverage-release.mjs --release <dir> --sha256 sha256:<hex>`.
   It checks the retained complete membership and Sources parsing, prints
   `"status":"accepted"`, and performs no source restorations or network requests.
4. Retain the source/backend and environment identities, command, log, exit status,
   completed directory, `manifestSha256` and consumer result. Selecting the release
   in `content/coverage-release-selection.v1.json` and deploying is a separate decision.

No completed production release was invented for the historical checked-in map.
Strict production adoption depends on an authorized full data refresh and review
of the resulting release and selection. Constructed fixture builds qualify the
local route only.

## Ordinary Pages release

Review the source revision, coverage selection, workflow inputs, tests and built
artifact before authorizing deployment. A manual ordinary run with
`build_only=true` retains a build with unavailable coverage. With
`build_only=false` it requires completed coverage and deploys the same run's
Pages artifact. `source_catalog=true, build_only=false` refuses immediately.
The `runner` input selects the runner for build and deployment; it does not
change release selection or grant deployment authority.

After an authorized deployment, retain the workflow run/head, actual upload ID
and digest, Pages deployment identity and complete static-member readback.
Check the custom-domain root and saved deep links against the exact reviewed
artifact. The public data publication is a separate release: verify its selected
publication documents and coverage bindings independently.

## Catalog proposal and exact retained releases

For a catalog build proposal choose `source_catalog=true, build_only=true`.
`content/source-catalog-release.v1.json` pins the immutable generation, selection,
archive hashes and finite sizes. The fetcher accepts `--manifest` for a separately
reviewed pin and `--local-inputs` for existing selection/archive files. It rehashes
cache inputs, bounds canonical extraction, and reruns maintained semantic staging.
Retry the same `--work-dir` and output after failure. Interrupted attempts remain
diagnostic evidence; never replace a pin with a mutable latest generation.
Concurrent use of the same work directory or output refuses. Corrupt completed
inputs/output refuse and require an explicit recovery decision.

Catalog deployment uses **Retained T01 Pages artifact**, not the ordinary route.
That workflow is bound to `.github/pages-retained-binding.json` and its pinned
implementation revision; it is not a generic selector for new proposals.
`upload_only` verifies prior and forward containers and full member maps, then
retains actual artifact IDs/digests for review. Separately authorized
`deploy_forward` and `restore_prior` verify immutable role content, package it,
upload it in the deployment run, download that exact upload, and check full
members and current writer state before deploying. Keep its prior role and
original evidence for rollback. New selections require a separately reviewed
binding and workflow revision. Do not substitute a newly rebuilt directory for
an archived exact release.

The native inventory site is about 685 MiB. Retained transfers and expanded
content are each capped at 768 MiB, below the Pages site limit. The workflow
requires 4 GiB of free temporary storage for overlapping verification copies.

Run `python -B tests/test_release_workflows.py` for the local condition matrix.
This check does not upload, deploy, publish, or prove hosted readback.

## Changed coverage before a local catalog refresh

Add `--prepare-coverage` to `scripts/refresh-local-catalog.py` to prepare the
published-table measurements before its existing catalog and website finish.
Use `--coverage-selection` for the retained base selection. Preparation freezes
publication metadata under the run's `coverage/` directory, reuses valid table
checkpoints and exact member caches, and measures changed dependencies with the
existing guarded scanners. It writes `coverage/selection.json` and a per-table
`coverage/report.json`. Failed measurements keep their earlier release labels.
Unchanged comments, expensive court measurements and the named multi-GB FEC,
U.S. Code and comment-attribute checks remain held by default;
`--hold-unchanged` configures that list for independent preparation. Changed
publication identities still run. Additive public state codes keep held or failed
checks labelled **Earlier measurement**, with a short explanation inside checks;
the retained table measurements remain unchanged. Changed bill-family and
Federal Register publications run before unchanged work.
New source captures and catalog selection remain owned by the normal refresh.

Set `SPICYGOV_COVERAGE_PYTHON` to the exact reviewed reader interpreter. For a
source checkout, also set `SPICYGOV_COVERAGE_PYTHONPATH` to its `src` directory;
the source-catalog maintenance runtime can then use its own `PYTHONPATH`.
`SPICYGOV_NATIVE_COVERAGE_CACHE` locates the existing hash-bound member cache.
Preparation uses one scan at a time, the readers' existing memory/time/staging
limits, and at least 25 GiB of free-space reserve. Input totals in its report are
not transfer or scratch measurements.

For independent preparation without selecting a catalog or building the site:

```sh
python scripts/prepare-coverage-refresh.py \
  --base-selection /absolute/path/to/selection.json \
  --run /absolute/path/to/new-coverage-run
```

Resume the same directory with identical code, base and resource settings.
Completed scans survive interruption. A completed release is immutable; use a
new run for a different publication snapshot, policy, reader or resource budget.
