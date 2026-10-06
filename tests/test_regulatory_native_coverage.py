"""Selected regulatory receipts preserve source values and reviewed coverage meanings."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_source_navigation_coverage as reader
from coverage_dimensions import scan_dimension, validate_definition
from regulation_coverage import scan_special
from spicy_regs.transforms.regulations_receipts import write_held_dataset
from spicy_regs.transforms.regulations_shape import SOURCE_COLUMNS


def member(path):
    return {"path": str(path.resolve()), "byteSize": path.stat().st_size,
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


class RegulatoryNativeCoverageTests(unittest.TestCase):
    def check_restoration(self, dataset, values):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            raw = dict.fromkeys(name for name, _ in SOURCE_COLUMNS[dataset])
            raw.update(values)
            schema = pa.schema([(name, pa.int64() if dtype == "BIGINT" else pa.string())
                                for name, dtype in SOURCE_COLUMNS[dataset]])
            source = root / "source.parquet"
            pq.write_table(pa.Table.from_pylist([raw], schema=schema), source)
            subject, receipts = write_held_dataset(dataset, source, root / "native", generation_id="selected")
            request = {"dataset": dataset, "generationId": "selected", "subjects": [member(subject)],
                       "receipts": member(receipts), "destination": str(root / "restored")}
            result = reader.restore(request)
            self.assertEqual(result["rows"], 1)
            self.assertEqual(result["selection"], {key: request[key] for key in ("subjects", "receipts")})
            self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(),
                             [{name: raw[name] for name, _ in reader.reviewed_schema(dataset)}])
            policy = json.loads((reader.ROOT / "content/coverage-definitions/regulation.json").read_text())["tables"][dataset]
            self.assertEqual(result["processingSchema"], policy["schema"])
            validate_definition(policy, result["processingSchema"])
            table = {"members": [{"url": result["urls"][0]}], "rows": 1,
                     "publishedAt": "2026-10-06T00:00:00Z"}
            measured = {}
            with duckdb.connect() as conn:
                conn.execute("SET memory_limit='256MB'")
                conn.execute("SET threads=2")
                for dim in policy["dimensions"]:
                    value = scan_special(conn, dataset, table, dim, None) if dim.get("special") else scan_dimension(
                        conn, result["urls"], 1, dim)
                    self.assertEqual(value["rows"], 1)
                    self.assertEqual(value["placedRows"] + value["unplacedRows"], 1)
                    measured[dim["id"]] = value
            for change in ("generation", "hash", "size"):
                altered = copy.deepcopy(request)
                altered["destination"] += "-" + change
                if change == "generation":
                    altered["generationId"] = "different"
                elif change == "hash":
                    altered["receipts"]["sha256"] = "sha256:" + "0" * 64
                else:
                    altered["subjects"][0]["byteSize"] += 1
                with self.subTest(dataset=dataset, change=change), self.assertRaises(ValueError):
                    reader.restore(altered)
            return pq.read_table(subject).to_pylist()[0], measured

    def test_cfr_annual_edition_uses_original_title_and_receipt_url(self):
        native, measured = self.check_restoration("cfr_sections", {
            "granule_id": "CFR-2025-title7-vol1-sec1-1", "package_id": "CFR-2025-title7-vol1",
            "part_granule": "False", "title": "07", "part": "01", "section": "1.1",
            "edition_year": "2025", "last_modified": "2026-06-30", "url": "https://example.gov/cfr",
        })
        self.assertIs(native["part_granule"], False)
        self.assertNotIn("url", native)
        self.assertEqual(measured["cfr-titles-by-annual-edition"]["buckets"], {'["2025","07"]': 1})

    def test_agenda_keeps_repeated_month_precision_milestones_and_undated_action(self):
        native, measured = self.check_restoration("unified_agenda", {
            "rin": "0099-AB01", "agenda_edition": "2026spring", "major": "No",
            "timetable_json": '[ {"action":"Proposed rule","date":"06/00/2026","fr_citation":"91 FR 1"},'
                              ' {"action":"Proposed rule","date":"06/00/2026","fr_citation":"91 FR 1"},'
                              ' {"action":"Final rule","date":"To Be Determined","fr_citation":null} ]',
            "cfr_references_json": '[ "7 CFR 1", null, "7 CFR 1" ]',
            "legal_authority_json": '[ "5 USC 301", "5 USC 301" ]',
            "first_action_date": "2026-06-01", "url": "https://example.gov/agenda",
        })
        self.assertEqual(len(native["timetable"]), 3)
        self.assertEqual(native["cfr_references"], ["7 CFR 1", None, "7 CFR 1"])
        self.assertNotIn("url", native)
        milestones = measured["timetable-milestone-months"]
        self.assertEqual(milestones["buckets"], {"2026-06": 1})
        self.assertEqual(milestones["partialRows"], 1)
        self.assertEqual(milestones["evidence"]["milestoneEntriesByPrecision"], {"month": 2, "undated": 1})

    def test_register_separates_publication_from_future_effective_dates(self):
        native, measured = self.check_restoration("federal_register", {
            "document_number": "2026-00001", "publication_date": "2026-06-30", "signing_date": "2026-06-29",
            "effective_on": "2028-01-01", "significant": "True", "volume": "0091",
            "docket_ids_json": '[ "EPA-2026-0001", "EPA-2026-0001" ]',
            "agency_slugs": "environmental-protection-agency,environmental-protection-agency",
            "cfr_references_json": '[ {"title":7,"part":"01","chapter":"I","citation_url":"https://example.gov/cfr"} ]',
            "html_url": "https://example.gov/register", "pdf_url": "https://example.gov/register.pdf",
            "regulations_dot_gov_info_json": ' {"comments_count":7,"comments_url":"https://example.gov/comments"} ',
            "regulations_dot_gov_comments_count": "0007",
        })
        self.assertIs(native["significant"], True)
        self.assertEqual(native["regulations_dot_gov_comments_count"], 7)
        self.assertEqual(len(native["docket_ids"]), 2)
        self.assertNotIn("html_url", native)
        self.assertEqual(measured["federal-register-publication-dates"]["buckets"], {"2026-06": 1})
        self.assertEqual(measured["effective-on"]["buckets"], {"2028-01": 1})

    def test_docket_link_retains_native_occurrence_key_and_source_evidence(self):
        native, measured = self.check_restoration("fr_docket_links", {
            "docket_id": "EPA-2026-0001", "docket_source_ordinal": 2,
            "document_number": "2026-00001", "publication_date": "2026-06-30", "effective_on": "2028-01-01",
            "docket_ids_json": '[ "EPA-2026-0001", "EPA-2026-0001" ]',
            "regulation_id_numbers_json": '[ "0099-AB01", null, "0099-AB01" ]',
            "normalized_docket_candidates_json": '[ "EPA-2026-0001", "EPA-2026-0001" ]',
            "docket_normalization_rule": "literal_source_candidates", "link_source": "printed-docket-label",
            "html_url": "https://example.gov/register", "pdf_url": "https://example.gov/register.pdf",
        })
        self.assertEqual(native["docket_source_ordinal"], 2)
        self.assertEqual(len(native["docket_ids"]), 2)
        self.assertNotIn("normalized_docket_candidates_json", native)
        self.assertEqual(measured["linked-register-publication-dates"]["buckets"], {"2026-06": 1})
        self.assertEqual(measured["effective-on"]["buckets"], {"2028-01": 1})


if __name__ == "__main__":
    unittest.main()
