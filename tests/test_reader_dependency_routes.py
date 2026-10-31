"""The final measurement revision follows the reader code each route actually runs."""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import coverage_scan
import restore_additional_coverage as additional
import restore_source_navigation_coverage as navigation
from spicy_regs import coverage_reader as maintained


class RouteDependencyTests(unittest.TestCase):
    def revisions(self):
        result = {}
        for dataset in ('court_citation_map', 'amendments', 'documents', 'committee_meetings',
                        'roll_call_votes', 'member_vote_terms', 'bill_versions', 'fcc_filings', 'fec_committees', 'document_citations'):
            if dataset in additional.DATASETS:
                identity = additional.description(dataset)['implementationSha256']
            elif dataset in navigation.DATASETS:
                identity = navigation.description(dataset)['implementationSha256']
            else:
                identity = maintained.implementation_identity(dataset)
            policy = {'_scanner': 'fec' if dataset == 'fec_committees' else 'regulation' if dataset in ('documents', 'court_citation_map', 'fcc_filings') else 'congress',
                      'restorationImplementationSha256': identity,
                      '_nativeProcessing' if dataset in ('bill_versions', 'fec_committees', 'document_citations') else '_additionalNativeProcessing': True}
            result[dataset] = coverage_scan.measurement_revision(policy)
        return result

    def test_whole_file_mutations_invalidate_only_real_dataset_dependencies(self):
        baseline = self.revisions()
        everyone = set(baseline)
        congress = {'amendments', 'committee_meetings', 'roll_call_votes', 'member_vote_terms'}
        matrix = {
            'transforms/regulations_receipts.py': {'documents'},
            'regulations_bulk.py': {'documents'},
            'court_restore.py': {'court_citation_map'},
            'sources/regulatory_catalog.py': {'documents'},
            'transforms/fec_identity_receipts.py': {'fec_committees'},
            'transforms/government_receipts.py': {'fcc_filings'},
            'government_bulk.py': {'fcc_filings'},
            'court_receipts.py': {'court_citation_map'},
            'court_subjects.py': {'court_citation_map', 'document_citations'},
            'votes_batch_receipts.py': congress,
            'congress_bulk.py': congress,
            'legislative_receipts.py': {'bill_versions', 'document_citations'},
            'pipelines/rollups/subject_receipts.py': everyone - {'court_citation_map', 'fcc_filings'},
            'selected_generations.py': everyone - {'court_citation_map', 'fcc_filings'},
            'etl_receipts.py': everyone,
            'etl_bulk.py': everyone,
            'local_data.py': everyone,
            'runtime_bounds.py': everyone,
            'earlier_receipt_policies.py': everyone,
            'navigation_policy_history.json': everyone,
        }
        read_bytes = Path.read_bytes
        for relative, expected in matrix.items():
            changed = maintained.PACKAGE_ROOT / relative
            def mutated(path):
                data = read_bytes(path)
                return data + b'\n# mutation probe\n' if path == changed else data
            with self.subTest(module=relative), patch.object(Path, 'read_bytes', mutated):
                after = self.revisions()
                self.assertEqual({dataset for dataset in baseline if baseline[dataset] != after[dataset]}, expected)

    def test_route_identities_keep_the_sha256_shape(self):
        for value in self.revisions().values():
            self.assertRegex(value, r'^sha256:[0-9a-f]{64}$')


if __name__ == '__main__':
    unittest.main()
