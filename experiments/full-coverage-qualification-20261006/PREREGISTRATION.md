# Full hosted coverage qualification

This manual diagnostic tests the current complete inputs for documents, federal_register, fr_docket_links, comment_periods and rule_targets using the reviewed website implementation and the exact maintained source reader pin in the workflow. The prior normal run 37483779274 failed their unchanged bridge limits: 600 seconds for documents and federal_register, 300 seconds for the other three. The outer scanner limit remains 900 seconds, and the existing heavy-reader lock serializes these datasets.

The builder retains its full publication plan, exact input and schema bindings, receipt admission, reproduction, count and coverage checks, reader identity checks, and before/after census checks. Candidate checkpoints still require the builder's ordinary current-input validation. A pass requires every selected full dataset to complete and the builder to write the diagnostic map. A failure retains its logs and completed checkpoints; sample results or a partially completed run cannot qualify the full datasets.

The diagnostic writes outside public/ and preserves a partial-marked map as evidence. It cannot deploy. The normal all-table website build and actual deployment remain separate release gates. Source producer publication and sealed court qualification are separate owner-controlled work.
