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

Create new coverage data through the explicit **Prepare coverage data release**
workflow. Its required `backend_revision` is a reviewed 40-hex spicy-regs commit
containing `spicy_regs/coverage_reader.py`; the workflow checks out that one
revision and installs its frozen `source-readers` group. The local equivalent is
`SPICYGOV_COVERAGE_PYTHON=<spicy-regs>/.venv/bin/python python scripts/build-coverage-maps.py --release-output <new-directory>`,
run with a `python` that has the builder dependencies pinned in
`.github/workflows/coverage-data-release.yml` (duckdb, pyarrow, fsspec, aiohttp).
Only the successful complete-build path emits the release. It retains the exact
publication bytes used, effective policies, reader identities through policy and
measurement revisions, map bytes, and implementation hashes. Partial scans remain
checkpoints and cannot create releases. The artifact is a candidate for separate
review and selection.

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

The release may take several workflow runs. Each run checkpoints every table it completes.
A later run reuses a checkpoint only while all of its bindings still match: generation bytes,
schema, policy and dimension digests, the activity month, and the measurement revision. A table
republished between runs is measured again.

Measurement revisions are per scanner:

- Orchestration, release and allowance edits (`build-coverage-maps.py`,
  `coverage_release.py`, `coverage_allowances.py`) keep checkpoints.
- An edit to `coverage_scan.py` or a shared helper re-measures every table.
- An edit to one scanner module re-measures only that scanner's tables.
- A new spicy-regs reader identity re-measures the native tables.

Keep `backend_revision` fixed until the release completes.

To resume an interrupted release, dispatch the workflow again with the **same**
`backend_revision`; a different reader identity re-measures all native tables. The scan
step stops at 300 minutes, inside the 330-minute job, so the checkpoints it completed are
still saved. Each run reuses the checkpoints whose bindings still hold.

- **Deterministic failure.** Fix it, push, re-dispatch. Allowance or orchestration edits keep
  checkpoints. An edit to one scanner module re-measures only that scanner's tables.
- **Memory failure** (exit 137 or "Killed" on documents, Register or court_opinions). Ask the
  owner about a larger runner.
- **Setup time.** Record the first run's time before the scan step starts. If it exceeds about
  20 minutes, raise the job `timeout-minutes` to 345 so the cache save still has room.
- **After the bill-subjects refresh.** `bill_subjects` becomes a native table: add it to
  `native_legislative_coverage.DATASETS` and `bill-subjects` to its `FAMILIES`, update its
  definition if the restored schema differs, probe it, then start the release. Do not add it
  earlier; the current reader does not describe it.

**Completion run.** The final check refuses if any of the 4 captured publication documents
changes during the run (`build-coverage-maps.py`), and every spicy-regs family rollup rewrites
`publication.v2.json`. Start the last, short run between about 07:30 and 12:30 UTC, when no
rollup is scheduled, and only after
`gh run list -R mikewolfd/spicy-regs --status in_progress` and `--status queued` show no rollup.

**Readback that proves completion:**

1. `gh run view <run> -R mikewolfd/spicygov --json conclusion -q .conclusion` returns `success`,
   and the log has `All <N> requested coverage maps verified` and the
   `{"directory": ".cache/completed-coverage-release", "manifestSha256": "sha256:..."}` line.
   N is the census table count.
2. `gh api repos/mikewolfd/spicygov/actions/runs/<run>/artifacts` shows
   `completed-coverage-release-<run>-<attempt>`; record its id and digest.
3. With the owner's approval to download it, `gh run download` it into a new empty directory,
   check `shasum -a 256 <dir>/manifest.json` equals the logged `manifestSha256`, then run
   `node scripts/consume-coverage-release.mjs --release <dir> --sha256 sha256:<hex>` in a
   checkout at the dispatched commit. It is offline and prints `"status":"accepted"`.
4. Retain the run id, attempt, artifact id and digest, and `manifestSha256`. Selecting the
   release in `content/coverage-release-selection.v1.json` and deploying is a separate decision.

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

Run `python -B tests/test_release_workflows.py` for the local condition matrix.
This check does not upload, deploy, publish, or prove hosted readback.
