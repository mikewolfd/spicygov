These are synthetic Parquet fixtures, not publisher evidence. The receipt fixtures use the backend's canonical receipt codec and hashes. They exercise exact identities, generation selection, indexed reads, duplicate receipts and mismatched index pointers. Meetings exercise composite array references; communications exercise an inline recorded passage.

`detail-attempts.parquet` is a synthetic four-observation `congress_acquisition`
receipt fixture. It records a failed and successful read for PN129-10 and a
separate read for PN129-11 and an unrelated event with the same identity, in generation g1. Private-path and credential-shaped
sentinel fields verify that the evidence display exposes only useful facts.

`fcc-receipts.parquet` is a synthetic `government-sources/2` receipt for filing
123 in generation g1. The maintained writer and bundle validator produced and
checked it. Its `raw_record` contains one offered URL and a five-field successful
extraction diagnostic, with synthetic source digests. It proves exact filing and
generation lookup; it is not evidence of a captured public document.
