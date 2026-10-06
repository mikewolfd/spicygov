"""Native opinion coverage reads retain the original bulk export literals."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_additional_coverage as reader
from spicy_regs.court_receipts import local_receipt_selection, write_court_rows


def member(path):
    return {"path": str(path.resolve()), "byteSize": path.stat().st_size,
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


class BulkCourtCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = {name: None for name in reader.processing_schema("court_opinions").names}
        self.raw.update(opinion_id="12", cluster_id="34", opinion_type="010combined",
                        author_id="007", author_str="An author", per_curiam="T",
                        joined_by_str="", page_count="0007", sha1="a" * 40,
                        download_url="https://example.gov/opinion.pdf", local_path="retained/12.pdf",
                        extracted_by_ocr="FALSE", date_created="2026-06-30T12:00:00Z",
                        date_modified="2026-07-01T12:00:00Z", dump_date="2026-06-30")
        subject = write_court_rows(
            "court_opinions", [self.raw], self.root / "native", generation_id="selected",
            witnesses=[{"source_id": "retained-opinions.csv", "sha256": "sha256:" + "b" * 64,
                        "source_uri": None, "locator": None, "body_version": None}],
        )
        receipts, _ = local_receipt_selection(subject)
        self.request = {"dataset": "court_opinions", "generationId": "selected",
                        "subjects": [member(subject)], "receipts": member(receipts),
                        "destination": str(self.root / "restored")}

    def test_restores_original_boolean_integer_and_bulk_edition_literals(self):
        native = pq.read_table(self.request["subjects"][0]["path"])
        self.assertIs(native.to_pylist()[0]["per_curiam"], True)
        self.assertEqual(native.to_pylist()[0]["page_count"], 7)
        self.assertNotIn("dump_date", native.schema.names)
        result = reader.restore(self.request)
        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [self.raw])
        self.assertEqual(result["rows"], 1)
        self.assertEqual(result["generationId"], "selected")
        self.assertEqual(sum(g["rows"] for g in result["acceptedWitnessGroups"]), 1)
        self.assertEqual(dict(result["nativeSchema"])["per_curiam"], "BOOLEAN")
        self.assertEqual(dict(result["nativeSchema"])["page_count"], "BIGINT")
        self.assertTrue(all(type_ == "VARCHAR" for _, type_ in result["processingSchema"]))
        definitions = json.loads((Path(__file__).resolve().parents[1] /
                                  "content/coverage-definitions/regulation.json").read_text())
        self.assertEqual(result["processingSchema"],
                         [tuple(field) for field in definitions["tables"]["court_opinions"]["schema"]])

    def test_wrong_generation_member_hash_size_and_subject_are_refused(self):
        for change in ("generation", "hash", "size", "subject"):
            with self.subTest(change=change):
                altered = copy.deepcopy(self.request)
                altered["destination"] += "-" + change
                if change == "generation":
                    altered["generationId"] = "different"
                elif change == "hash":
                    altered["receipts"]["sha256"] = "sha256:" + "0" * 64
                elif change == "size":
                    altered["subjects"][0]["byteSize"] += 1
                else:
                    original = pq.read_table(altered["subjects"][0]["path"])
                    rows = original.to_pylist()
                    rows[0]["page_count"] += 1
                    changed = self.root / "changed.parquet"
                    pq.write_table(pa.Table.from_pylist(rows, schema=original.schema), changed)
                    altered["subjects"] = [member(changed)]
                with self.assertRaises(ValueError):
                    reader.restore(altered)


if __name__ == "__main__":
    unittest.main()
