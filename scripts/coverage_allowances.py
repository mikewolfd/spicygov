"""Time allowances, in seconds, for coverage scans.

An allowance bounds how long a step may run; it never changes what is measured.
This module is in no measurement revision, so tuning a value during a release
keeps every checkpoint. It still matches `scripts/*coverage*.py`, so a release
records the values it ran with.
"""

# One table's scan subprocess (build-coverage-maps.py timed_scan).
SCAN = 900
# Full saved-text reads across the comments release exceed the ordinary table
# budget; the larger allowance is limited to these measured cases. The comments
# probe took 47 minutes on a loaded laptop, so it gets two hours. The court
# tables are the largest published single files (up to 3.4 GB).
SCAN_BY_TABLE = {'comments': 7200, 'fec_receipts': 3600, 'court_opinions': 2700,
                 'court_citation_map': 2700, 'court_citations': 2700, 'court_parentheticals': 2700,
                 'documents': 1500, 'document_attributes': 1500, 'comment_periods': 1500,
                 'federal_register': 1500, 'fr_docket_links': 1500}


def scan_seconds(table_id):
    return SCAN_BY_TABLE.get(table_id, SCAN)
