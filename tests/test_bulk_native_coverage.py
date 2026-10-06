"""Current bulk writers retain exact reviewed coverage values in selected receipts."""
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_source_navigation_coverage as reader
from spicy_regs.congress_receipts import write_congress_dataset
from spicy_regs.congress_subjects import INPUT_COLUMNS
from spicy_regs.transforms.regulations_receipts import write_held_dataset
from spicy_regs.transforms.regulations_shape import SOURCE_COLUMNS


def member(path):
    return {"path": str(path.resolve()), "byteSize": path.stat().st_size,
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


class BulkNativeCoverageTests(unittest.TestCase):
    def check_restoration(self, dataset, values):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            names = [name for name, _ in SOURCE_COLUMNS[dataset]] if dataset == "documents" else INPUT_COLUMNS[dataset]
            raw = dict.fromkeys(names)
            raw.update(values)
            source = root / "retained.parquet"
            pq.write_table(pa.Table.from_pylist([raw], schema=pa.schema(
                [(name, pa.string()) for name in names])), source)
            if dataset == "documents":
                subject, receipts = write_held_dataset(dataset, source, root / "native",
                                                       generation_id="selected", bulk=True)
            else:
                subject, receipts = write_congress_dataset(source, root / "native", dataset=dataset,
                                                           generation_id="selected", bulk=True)
            self.assertIsNotNone(subject)
            request = {"dataset": dataset, "generationId": "selected", "subjects": [member(subject)],
                       "receipts": member(receipts), "destination": str(root / "restored")}
            result = reader.restore(request)
            self.assertEqual(result["rows"], 1)
            self.assertEqual(result["generationId"], "selected")
            self.assertEqual(result["selection"], {key: request[key] for key in ("subjects", "receipts")})
            self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(),
                             [{name: raw[name] for name, _ in reader.reviewed_schema(dataset)}])
            self.assertEqual(result["processingSchema"], reader.reviewed_schema(dataset))
            for change in ("generation", "hash", "size"):
                with self.subTest(dataset=dataset, change=change):
                    altered = copy.deepcopy(request)
                    altered["destination"] += "-" + change
                    if change == "generation":
                        altered["generationId"] = "different"
                    elif change == "hash":
                        altered["receipts"]["sha256"] = "sha256:" + "0" * 64
                    else:
                        altered["subjects"][0]["byteSize"] += 1
                    with self.assertRaises(ValueError):
                        reader.restore(altered)
            return pq.read_table(subject).to_pylist()[0]

    def test_documents_restore_boolean_repeated_arrays_and_source_only_fields(self):
        native = self.check_restoration("documents", {
            "document_id": "EPA-2026-0001-0002", "docket_id": "EPA-2026-0001",
            "agency_code": "EPA", "title": "Retained document", "posted_date": "2026-06-30",
            "withdrawn": "True", "reason_withdrawn": "",
            "additional_rins": '[ "0099-AB01", null, "0099-AB01" ]',
            "attachments_json": '[ {"url":"https://example.gov/a.pdf","format":"pdf","size":7},'
                                ' {"url":"https://example.gov/a.pdf","format":"pdf","size":7} ]',
            "file_url": "https://example.gov/source.pdf", "text_content": "Retained text.\n",
            "text_extraction_status": "ok", "pdf_extraction_results_json": '[ {"status":"ok"} ]',
        })
        self.assertIs(native["withdrawn"], True)
        self.assertEqual(native["additional_rins"], ["0099-AB01", None, "0099-AB01"])
        self.assertEqual(len(native["attachments"]), 2)
        self.assertNotIn("file_url", native)

    def test_votes_restore_original_integer_spellings_and_repeated_references(self):
        native = self.check_restoration("roll_call_votes", {
            "vote_id": "s119-2025-1", "congress": "00119", "chamber": "senate", "session": "01",
            "roll_number": "0001", "vote_date": "2025-01-03", "vote_day": "2025-01-03",
            "yea": "0007", "nay": "02", "present": "0", "not_voting": "01",
            "member_vote_count": "0010", "source_url": "https://example.gov/vote.xml",
            "match_rule": "explicit_document", "match_action_index": "0002", "conflict_count": "00",
            "tallies_json": '{ "Yea":7, "Nay":2 }',
            "documents_json": '[ {"congress":119,"number":"0001","type":"bill"},'
                               ' {"congress":119,"number":"0001","type":"bill"} ]',
            "amendments_json": '[ {"number":"0002","to_document_number":"0001"},'
                                ' {"number":"0002","to_document_number":"0001"} ]',
        })
        self.assertEqual(native["yea"], 7)
        self.assertEqual(native["member_vote_count"], 10)
        self.assertEqual(len(native["documents"]), 2)
        self.assertEqual(len(native["amendments"]), 2)
        self.assertNotIn("source_url", native)

    def test_member_vote_terms_restore_original_index_and_match_status(self):
        native = self.check_restoration("member_vote_terms", {
            "vote_id": "s119-2025-1", "member_key": "A000001", "chamber": "senate",
            "bioguide_id": "A000001", "vote_day": "2025-01-03", "term_match": "matched",
            "term_index": "0002", "term_start": "2023-01-03", "term_end": "2029-01-03",
        })
        self.assertEqual(native["term_index"], 2)
        self.assertNotIn("term_match", native)


if __name__ == "__main__":
    unittest.main()
