# Retained FEC renderer inputs

`fec-research-publication.json` contains the unchanged private publication index
and the matching table definitions selected from the FEC lane's retained
`private-publication-final/objects/explorer-metadata.v1.json`. `fixture_sources`
records both original file hashes. This test-only selection does not replace
published metadata or the producer's whole-file FEC metadata identity check.

The family pins are the previously retained research, election and repaired
sector candidates. `fec-research-profiles.json` contains exact rows from those
candidates, including contribution decisions, spender detail and separate FEC
and LDA sector examples. Its issue example uses the authoritative repaired LDA
generation, preserving the same native filing and issue. No source was fetched
or rebuilt for these controls.

Supported row versions come from the coordinated SpicyRegs transforms
`fec_committee_profiles`, `fec_contribution_profiles`, `fec_outside_profiles`,
`fec_election_results` and `sector_comparisons`, and the SpicyDocs election
reader. Tables without a `policy_version` use their existing mapping,
interpretation or amount-basis fields. The renderer tests apply the ordinary
catalog's family-generation and schema matching before rendering known rows,
then perturb metadata and row versions independently.
