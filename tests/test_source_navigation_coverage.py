"""New navigation schemas retain the existing receipt-bound coverage facts."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import subprocess

import pyarrow as pa
import pyarrow.parquet as pq
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_source_navigation_coverage as reader
import additional_native_coverage as adapter
from spicy_regs.congress_receipts import write_congress_dataset
from spicy_regs.congress_subjects import INPUT_COLUMNS
from spicy_regs.etl_receipts import ReceiptContext, write_dataset
from spicy_regs.transforms.government_receipts import POLICIES
from spicy_regs.transforms.government_source_shapes import map_subject


def member(path):
    return {"path":str(path.resolve()), "byteSize":path.stat().st_size, "sha256":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest()}


class SourceCoverageTests(unittest.TestCase):
    def test_source_navigation_routes_keep_the_existing_readers_separate(self):
        env = {"SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE": str(Path(reader.__file__).resolve()), "SPICYGOV_SOURCE_NAVIGATION_COVERAGE_PYTHON": sys.executable, "SPICYGOV_ADDITIONAL_COVERAGE_BRIDGE": str(Path(reader.__file__).with_name("restore_additional_coverage.py").resolve()), "SPICYGOV_ADDITIONAL_COVERAGE_PYTHON": sys.executable}
        with patch.dict("os.environ", env), patch.object(adapter.subprocess, "run", return_value=subprocess.CompletedProcess([],0,stdout="{}")) as run:
            for name in reader.DATASETS:
                adapter.bridge(["--schema",name])
                self.assertEqual(run.call_args.args[0][1],env["SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE"])
                adapter.bridge(request={"dataset":name})
                self.assertEqual(run.call_args.args[0][1],env["SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE"])
            adapter.bridge(["--verify-artifacts"],request=[{"spec":{"family":"fcc-filings"}}])
            self.assertEqual(run.call_args.args[0][1],env["SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE"])
            adapter.bridge(["--schema","amendments"])
            self.assertEqual(run.call_args.args[0][1],env["SPICYGOV_ADDITIONAL_COVERAGE_BRIDGE"])

    def test_new_subjects_preserve_old_coverage_facts_and_exact_generation(self):
        for dataset in reader.DATASETS:
            with self.subTest(dataset=dataset), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                if dataset == "fcc_filings":
                    native = {"id_submission":"s1", "date_received":"2026-08-25", "text_data":"source text", "documents":[{"filename":"a.pdf", "description":"", "src":"https://example.gov/a.pdf"}]}
                    text = json.dumps(native)
                    raw = {"id_submission":"s1", "date_received":"2026-08-25", "text_data":"source text", "native_fields_json":text, "native_fields_sha256":"sha256:"+hashlib.sha256(text.encode()).hexdigest()}
                    subject, receipts = write_dataset([({**map_subject(dataset, raw), "raw_record":raw}, ReceiptContext("selected", "one", POLICIES[dataset].policy_version, [{"source_id":"fixture", "sha256":"sha256:"+hashlib.sha256(text.encode()).hexdigest(), "source_uri":None, "locator":None, "body_version":None}]))], root / "native", POLICIES[dataset])
                else:
                    raw = dict.fromkeys(INPUT_COLUMNS[dataset])
                    raw.update(congress="119")
                    if dataset == "nominations":
                        raw.update(citation="PN129-10", number="129", part_number="10", received_date="2025-04-29", committees_json='[{"systemCode":"hsag"}]', hearings_json='[]', detail_read="true")
                    elif dataset == "committee_meetings":
                        raw.update(chamber="senate", event_id="1", meeting_date="2026-10-01", nomination_references_json='[{"number":129,"part":10}]', treaty_references_json='[]', detail_read="true")
                    elif dataset == "members":
                        raw.update(bioguide_id="A000001", name_first="Patricia", name_nickname="Pat", fec_ids_json='["H0CA00001"]', term_count="1", first_term_start="1990-01-03")
                    else:
                        raw.update(communication_id="ec1-119", communication_type="ec", number="1", source_route="congressional-record", record_package_id="CREC-2026-10-01", record_entry_text="Exact retained passage", detail_read="true")
                    source = root / "source.parquet"
                    pq.write_table(pa.Table.from_pylist([raw], schema=pa.schema([(n,pa.string()) for n in INPUT_COLUMNS[dataset]])), source)
                    subject, receipts = write_congress_dataset(source, root / "native", dataset=dataset, generation_id="selected")
                request = {"dataset":dataset, "generationId":"selected", "subjects":[member(subject)], "receipts":member(receipts), "destination":str(root / "restored")}
                facts = reader.restore(request)
                self.assertEqual(facts["selection"], {k:request[k] for k in ("subjects", "receipts")})
                self.assertEqual(facts["rows"],1)
                measured = pq.read_table(facts["urls"][0]).to_pylist()[0]
                if dataset == "fcc_filings":
                    self.assertEqual(measured["date_received"],"2026-08-25")
                    self.assertEqual(measured["text_data"],"source text")
                    self.assertEqual(pq.read_table(subject).to_pylist()[0]["documents"][0]["src"],"https://example.gov/a.pdf")
                else:
                    self.assertEqual(measured, {name:raw.get(name) for name,_ in reader.reviewed_schema(dataset)})
                    if dataset == "members":
                        self.assertEqual(pq.read_table(subject).to_pylist()[0]["name_nickname"], "Pat")
                wrong = copy.deepcopy(request)
                wrong["generationId"] = "different"
                wrong["destination"] += "-wrong"
                with self.assertRaises(ValueError):
                    reader.restore(wrong)
                changed = copy.deepcopy(request)
                changed["destination"] += "-changed"
                changed["subjects"][0]["sha256"] = "sha256:" + "0" * 64
                with self.assertRaises(ValueError):
                    reader.restore(changed)


if __name__ == "__main__":
    unittest.main()
