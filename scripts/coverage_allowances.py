"""Time allowances, in seconds, for coverage scans and the readers they call.

An allowance bounds how long a step may run; it never changes what is measured.
This module is in no measurement revision, so tuning a value during a release
keeps every checkpoint. It still matches `scripts/*coverage*.py`, so a release
records the values it ran with.
"""

# One table's scan subprocess (build-coverage-maps.py timed_scan).
SCAN = 900
# Full saved-text reads across the comments release exceed the ordinary table
# budget; the larger allowance is limited to these measured cases. The comments
# probe took 47 minutes on a loaded laptop, so it gets two hours.
SCAN_BY_TABLE = {'comments': 7200, 'fec_receipts': 3600}
# Native restoration only: each allowance covers the table's bridge request
# (BRIDGE_BY_RESTORE) plus preparation and coverage checks.
SCAN_BY_NATIVE_TABLE = {'court_opinions': 2700, 'documents': 1500, 'federal_register': 1500,
                        'fr_docket_links': 1500,
                        'court_citation_map': 9000, 'court_citations': 9000,
                        'court_parentheticals': 9000, 'court_opinion_clusters': 9000}

# One restoration request to a spicygov adapter (additional_native_coverage.bridge).
# Schema and verification requests always use BRIDGE. Full current documents and
# Register restores exceeded five minutes on hosted runners; a Federal Register
# restore took 206-240 seconds on a loaded laptop.
BRIDGE = 300
# The retained court-citations family admission took 3,611.7 seconds:
# recovery-20261018/court-citations-september-local-20261019.log:8-9.
# These serialized bulk restores allow twice that observed admission, plus
# outer preparation in SCAN_BY_NATIVE_TABLE. A ceiling is not a runtime estimate.
BRIDGE_BY_RESTORE = {'court_opinions': 1800, 'documents': 900, 'federal_register': 900,
                     'fr_docket_links': 900,
                     'court_citation_map': 7200, 'court_citations': 7200,
                     'court_parentheticals': 7200, 'court_opinion_clusters': 7200}

# One request to the packaged reader (native_legislative_coverage.bridge).
LEGISLATIVE_BRIDGE = 900


def scan_seconds(table_id, additional_native):
    return SCAN_BY_TABLE.get(table_id) or (SCAN_BY_NATIVE_TABLE.get(table_id) if additional_native else None) or SCAN


def bridge_seconds(dataset):
    return BRIDGE_BY_RESTORE.get(dataset, BRIDGE)
