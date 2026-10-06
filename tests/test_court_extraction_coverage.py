"""Selected opinion PDF receipts restore the reviewed private coverage fields."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_additional_coverage as reader
import additional_native_coverage as adapter
from spicy_regs.court_receipts import local_receipt_selection, write_court_rows


def member(path):
    return {"path": str(path.resolve()), "byteSize": path.stat().st_size,
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


class CourtExtractionFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = {name: None for name in reader.processing_schema("court_opinion_pdf_extractions").names}
        self.raw.update(
            opinion_id="12", cluster_id="34", source_url="https://example.gov/opinion.pdf",
            resolved_url="https://example.gov/retained.pdf", source_sha256="sha256:" + "a" * 64,
            native_sha1="b" * 40, actual_sha1="b" * 40, sha1_matches="true",
            text_content="A retained opinion.\n", observed_at="2026-10-06T10:00:00Z",
            pdf_extraction_results_json='[ {"status":"ok","pages":2} ]',
            parent_opinion_publication_json=' {"artifactDigest":"sha256:exact-parent"} ',
        )
        subject = write_court_rows(
            "court_opinion_pdf_extractions", [self.raw], self.root / "native",
            witnesses=[{"source_id": "retained.pdf", "sha256": "sha256:" + "a" * 64,
                        "source_uri": None, "locator": None, "body_version": None}],
            generation_id="selected",
        )
        receipts, _ = local_receipt_selection(subject)
        self.request = {"dataset": "court_opinion_pdf_extractions", "generationId": "selected",
                        "subjects": [member(subject)], "receipts": member(receipts),
                        "destination": str(self.root / "restored")}


class CourtExtractionCoverageTests(CourtExtractionFixture, unittest.TestCase):
    def test_restores_exact_receipt_literals_and_reviewed_schema(self):
        result = reader.restore(self.request)
        self.assertEqual(result["rows"], 1)
        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [self.raw])
        self.assertEqual(result["generationId"], "selected")
        self.assertNotIn("source_url", dict(result["nativeSchema"]))
        self.assertIn("source_url", dict(result["processingSchema"]))
        self.assertEqual(sum(group["rows"] for group in result["acceptedWitnessGroups"]), 1)
        definitions = json.loads((Path(__file__).resolve().parents[1] /
                                 "content/coverage-definitions/regulation.json").read_text())
        self.assertEqual(result["processingSchema"],
                         [tuple(field) for field in definitions["tables"]["court_opinion_pdf_extractions"]["schema"]])

    def test_unselected_generation_and_modified_member_are_refused(self):
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
                    rows[0]["text_content"] = "Changed after receipt selection."
                    changed = self.root / "changed.parquet"
                    pq.write_table(pa.Table.from_pylist(rows, schema=original.schema), changed)
                    altered["subjects"] = [member(changed)]
                with self.assertRaises(ValueError):
                    reader.restore(altered)


class CourtExtractionParentTests(CourtExtractionFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.source = self.root / "prior.parquet"
        pq.write_table(pa.Table.from_pylist([self.raw], schema=reader.processing_schema(
            "court_opinion_pdf_extractions")), self.source)
        self.pin = member(self.source)
        self.key = "generations/court-opinion-pdf-extractions/" + "a" * 64
        witness = {"source_id": self.key + "/court_opinion_pdf_extractions.parquet",
                   "sha256": self.pin["sha256"], "source_uri": None,
                   "locator": None, "body_version": None}
        subject = write_court_rows("court_opinion_pdf_extractions", [self.raw],
                                  self.root / "parent-native", witnesses=[witness], generation_id="selected")
        receipts, _ = local_receipt_selection(subject)
        self.restored = json.loads(json.dumps(reader.restore({**self.request,
            "subjects": [member(subject)], "receipts": member(receipts)})))
        self.prior = {"family": "court-opinion-pdf-extractions", "artifactDigest": "sha256:" + "a" * 64,
                      "tableId": "court_opinion_pdf_extractions", "recordUrl": "https://example/prior", "rows": 1,
                      "members": [{"key": "court_opinion_pdf_extractions.parquet", "sha256": self.pin["sha256"],
                                   "byteSize": self.pin["byteSize"], "rows": 1}]}
        self.descriptor = {"sha256": self.pin["sha256"], "byteSize": self.pin["byteSize"], "rows": 1,
                           "columns": self.restored["processingSchema"]}
        self.owner = {"family": "court-opinion-pdf-extractions", "artifactDigest": "sha256:" + "b" * 64, "rows": 1,
                      "artifact": {"spec": {"readSnapshot": {"families": {"court-opinion-pdf-extractions": {
                          "artifactDigest": self.prior["artifactDigest"], "prefix": self.key,
                          "tables": {"court_opinion_pdf_extractions.parquet": self.descriptor}}}}}}}
        self.parent_result = {"family": "court-opinions", "artifactDigest": "exact-original-parent", "rows": 1}
        test = self

        class Inputs:
            def producing(self, dataset, child):
                return test.owner

            def table(self, family, generation, dataset):
                test.assertEqual(generation, test.prior["artifactDigest"])
                return test.prior

            def artifact(self, family, generation):
                return test.key, {}, [{"objectKey": "court_opinion_pdf_extractions.parquet", "role": "table",
                                       "sha256": test.pin["sha256"], "byteSize": test.pin["byteSize"], "recordCount": 1}]

            def parent(self, dataset, child, relation):
                test.assertIs(child, test.prior)
                return test.parent_result

        patcher = patch.object(adapter, "bridge", return_value=[])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.adapter = adapter.AdditionalInputs(Inputs(), self.root / "adapter")
        self.adapter.restore = lambda *args: {"urls": self.restored["urls"], "_coverageProcessing": self.restored}
        self.adapter.staging._member = lambda *args: self.pin
        self.relation = {"mode": "recorded-parent", "table": "court_opinions",
                         "keys": [["opinion_id", "opinion_id"], ["cluster_id", "cluster_id"]]}

    def run_parent(self):
        return self.adapter.parent("court_opinion_pdf_extractions", self.owner, self.relation)

    def test_retains_original_parent_even_when_current_snapshot_differs(self):
        self.owner["artifact"]["spec"]["readSnapshot"]["families"]["court-opinions"] = {
            "artifactDigest": "newer-unrelated"}
        result = self.run_parent()
        self.assertEqual(result["artifactDigest"], "exact-original-parent")
        self.assertEqual(result["_additionalParentEvidence"]["matchedSourceRows"], 1)

    def test_refuses_incomplete_keys_or_missing_prior_parent(self):
        self.relation["keys"] = [["opinion_id", "opinion_id"]]
        with self.assertRaisesRegex(ValueError, "does not pin"):
            self.run_parent()
        self.relation["keys"].append(["cluster_id", "cluster_id"])
        self.adapter.inputs.parent = lambda *args: (_ for _ in ()).throw(ValueError("No recorded parent"))
        with self.assertRaisesRegex(ValueError, "No recorded parent"):
            self.run_parent()

    def test_refuses_changed_prior_pin_witness_and_restored_values(self):
        original_groups = copy.deepcopy(self.restored["acceptedWitnessGroups"])
        self.descriptor["sha256"] = "sha256:" + "c" * 64
        with self.assertRaisesRegex(ValueError, "recorded source snapshot"):
            self.run_parent()
        self.descriptor["sha256"] = self.pin["sha256"]
        for groups in ([], [{"rows": 1, "witnesses": []}], [{"rows": 2, "witnesses": []}]):
            self.restored["acceptedWitnessGroups"] = groups
            with self.assertRaisesRegex(ValueError, "receipts do not all witness"):
                self.run_parent()
        self.restored["acceptedWitnessGroups"] = original_groups
        path = Path(self.restored["urls"][0])
        for rows in ([{**self.raw, "source_url": "https://example/changed"}], [self.raw, self.raw]):
            pq.write_table(pa.Table.from_pylist(rows, schema=reader.processing_schema(
                "court_opinion_pdf_extractions")), path)
            with self.assertRaisesRegex(ValueError, "rows differ"):
                self.run_parent()


if __name__ == "__main__":
    unittest.main()
