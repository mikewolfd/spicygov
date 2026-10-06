This branch measures why five unchanged coverage restores timed out in hosted run37483779274. It does not deploy the website, alter cache acceptance or refresh source data.

The workflow at .github/workflows/deploy-pages.yml runs only when manually dispatched on this diagnostic branch. It checks out the failing032c reader, installs its locked dependencies, checks wrapped admission/refusal, then runs unchanged maintained restores on exact retained input subsets. Every exit retains raw requests, settings, stage logs, profiles, outputs and failures. No original full corpus is downloaded or reprocessed by the workflow.

Read PREREGISTRATION.md first. It preserves the initial design, failed setup and subsequent corrections. samples.json binds each2,000/8,000-row subset to its sample SHA/size, original generation/member declarations, original ordinals and copied parent evidence. Parent full-member hashes come from retained prior proofs; preparation performed size/stat checks and full sampled identity matching rather than rehashing full parents. The subset validator still validates every included receipt and the complete selected subject/receipt join. It cannot rule out duplicate identities or bad records outside the subset. All actual prefix samples contain accepted receipts only; they do not establish the absence of nonaccepted outcomes elsewhere. Separate controls cover observed metadata and refusal.

Interpret phases as follows:
- selected_inputs includes original sample integrity hashes and receipt scoping, with their normal bridge stage diagnostics in stderr.log.
- validate_receipt_bundle includes receipt validation, subject identity hashing and whole selected joins. _check_receipts and _check_subjects identify its maintained SQL stages. _validate_receipt_bundle_rows records whole-validator row fallback; etl_bulk._load_receipts.loadedRows measures only SQL-unproven receipt fallback. Unproven subject reference rows are explicitly unmeasured.
- _materialize_selected includes admission plus restoration. Its elapsed time minus completed admission time is a restoration residual, not an independent phase measurement.
- write_regulatory_facts includes SQLite loading, subject matching and caller reproduction/writing. _joined_subjects.active_next times active joining/decompression without suspended caller work. Inclusive generator time remains labeled separately.
- aggregates time unchanged shape_record, processing JSON decoding/index decoding and ReceiptContext.__post_init__. These are nested function costs, so do not add them to inclusive parents. The small cProfile run identifies Arrow conversion, exact encoding/comparison, compression and writing costs.

Witness/context checks here validate retained receipt structures, diagnostics and digests. This restore path does not acquire or externally resolve source witness bodies. Zero Python ReceiptContext calls on a SQL-admitted sample does not mean witness validation was skipped: the SQL admission checks those fields. Small profiles cannot independently assign the combined SQL query's witness-expression cost.

Local validation:43 maintained Federal Register/docket-link/base restoration tests passed. Instrumented controls passed valid, bad receipt digest, missing accepted receipt and retained-input disagreement. Both original and revised15 sample runs passed locally. Original inclusive results remain at /tmp/spicygov-hosted-restore-sample-local-20261006; corrected active-generator results at /tmp/spicygov-hosted-restore-sample-local-active-20261006. These are local measurements, not hosted results or full-map certification. The current exact full Federal Register prior proof records270.609seconds; it is copied in parent-evidence and linked in samples.json.

To reproduce locally with the maintained reader on PYTHONPATH:
python experiments/hosted-restore-profile-20261006/test_profile_restore.py
python experiments/hosted-restore-profile-20261006/profile_restore.py --out /new/absolute/private/directory

Do not run prepare_samples.py again over an existing output; it deliberately refuses to overwrite the preserved selections. Root owns review, branch publication and any workflow dispatch.
