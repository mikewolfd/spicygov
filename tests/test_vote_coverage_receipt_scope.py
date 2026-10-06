"""Vote coverage admits every selected outcome without decoding sibling datasets."""
import copy
import hashlib
import io
import importlib.util
import json
from contextlib import redirect_stderr
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_source_navigation_coverage as reader
import additional_native_coverage as adapter
from spicy_regs.congress_receipts import policy, write_congress_dataset
from spicy_regs.congress_subjects import INPUT_COLUMNS
from spicy_regs.etl_receipts import RECEIPT_SCHEMA, ReceiptContext, _digest, decode_exact_json, exact_json, failure_receipt


def member(path):
    return {"path":str(path.resolve()), "byteSize":path.stat().st_size,
            "sha256":"sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


def fixture(root, dataset="roll_call_votes", count=3):
    names = INPUT_COLUMNS[dataset]
    rows = []
    for index in range(count):
        raw = dict.fromkeys(names)
        raw.update(vote_id=f"s119-2025-{index}", chamber="senate")
        if dataset == "roll_call_votes":
            raw.update(congress="00119", session="01", roll_number=str(index), vote_day="2025-01-03",
                       yea="0007", nay="02", member_vote_count="0010",
                       documents_json='[ {"congress":119,"number":"0001","type":"bill"},'
                                      ' {"congress":119,"number":"0001","type":"bill"} ]')
        else:
            raw.update(member_key="A000001", term_index="0002", term_match="matched")
        rows.append(raw)
    source = root / "original.parquet"
    pq.write_table(pa.Table.from_pylist(rows, schema=pa.schema([(name, pa.string()) for name in names])), source)
    subject, receipts = write_congress_dataset(source, root / "native", dataset=dataset,
                                               generation_id="selected", bulk=True)
    selected = pq.read_table(receipts).to_pylist()
    # A valid unsuccessful selected attempt must remain inspectable and admitted.
    refused = failure_receipt(policy(dataset), ReceiptContext("selected", "retained-refusal", "fixture",
                              selected[0]["witnesses"], {"reason":"conversion_refused"}), outcome="refused",
                              raw_fields={"entry_kind":"row", "source_fields":dict.fromkeys(names)})
    selected.append(refused)
    sibling = {**copy.deepcopy(selected[0]), "dataset":"member_votes", "generation_id":"other",
               "receipt_id":"invalid-sibling"}
    mixed = selected[:1] + [sibling] + selected[1:]
    pq.write_table(pa.Table.from_pylist(mixed, schema=RECEIPT_SCHEMA), receipts)
    return {"dataset":dataset, "generationId":"selected", "subjects":[member(subject)],
            "receipts":member(receipts), "destination":str(root / "restored")}, rows, selected


class VoteCoverageReceiptScopeTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def test_scope_keeps_all_selected_outcomes_order_and_exact_original_values(self):
        for dataset in ("roll_call_votes", "member_vote_terms"):
            with self.subTest(dataset=dataset):
                root = self.root / dataset
                root.mkdir()
                request, raw, selected = fixture(root, dataset)
                original = reader.votes_batch_receipts.restore_processing_input
                def restore(subjects, receipts, destination, **kwargs):
                    self.assertEqual(pq.read_table(receipts).to_pylist(), selected)
                    self.assertTrue(kwargs["bulk"])
                    self.assertEqual(kwargs["generation_id"], "selected")
                    return original(subjects, receipts, destination, **kwargs)
                with patch.object(reader.votes_batch_receipts, "restore_processing_input", side_effect=restore) as maintained, \
                        patch.object(reader.MAINTAINED, "restore", side_effect=AssertionError("No full-family Python scope")), \
                        patch.object(reader.congress_bulk, "restore_input", wraps=reader.congress_bulk.restore_input) as batch, \
                        redirect_stderr(io.StringIO()) as diagnostics:
                    # Only roll-call votes are newly routed in production; the
                    # reusable helper also proves the unchanged term boundary.
                    result = reader.restore(request) if dataset == "roll_call_votes" else reader.restore_votes(request, reader.description(dataset))
                self.assertEqual(maintained.call_count, 1)
                self.assertEqual(batch.call_count, int(dataset == "member_vote_terms"))
                self.assertEqual(result["selection"], {key:request[key] for key in ("subjects", "receipts")})
                self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(),
                                 [{name:row[name] for name, _ in reader.reviewed_schema(dataset)} for row in raw])
                events = [json.loads(line.removeprefix("coverage-restore ")) for line in diagnostics.getvalue().splitlines()]
                self.assertTrue(any(event["stage"] == "selected-receipts" and event["rows"] == len(selected) for event in events))
                dispatch = next(event for event in events if event["stage"] == "selected-reader")
                self.assertEqual(dispatch["reproduction"], "exact-row" if dataset == "roll_call_votes" else "batch-if-retained-schema-eligible")

    def test_mismatch_refusals_never_publish_facts(self):
        for change in ("generation", "hash", "size", "schema", "late-selected-digest", "late-selected-version", "late-refused-digest"):
            with self.subTest(change=change):
                root = self.root / change
                root.mkdir()
                request, _, _ = fixture(root)
                path = Path(request["receipts"]["path"])
                if change == "generation":
                    request["generationId"] = "different"
                elif change == "hash":
                    request["receipts"]["sha256"] = "sha256:" + "0" * 64
                elif change == "size":
                    request["receipts"]["byteSize"] += 1
                elif change == "schema":
                    pq.write_table(pq.read_table(path).drop(["diagnostic_json"]), path)
                    request["receipts"] = member(path)
                else:
                    receipts = pq.read_table(path).to_pylist()
                    row = next(row for row in reversed(receipts) if row["outcome"] == ("refused" if change == "late-refused-digest" else "accepted"))
                    if change == "late-selected-version":
                        row["subject_version"] = "sha256:" + "0" * 64
                        row["receipt_id"] = _digest({key:value for key, value in row.items() if key != "receipt_id"})
                    else:
                        row["receipt_id"] = "sha256:" + "0" * 64
                    pq.write_table(pa.Table.from_pylist(receipts, schema=RECEIPT_SCHEMA), path)
                    request["receipts"] = member(path)
                with redirect_stderr(io.StringIO()), self.assertRaises((ValueError, TypeError)):
                    reader.restore(request)
                self.assertFalse((Path(request["destination"]) / "coverage-facts.parquet").exists())
                self.assertFalse((Path(request["destination"]) / "provisional-coverage-facts.parquet").exists())

    def test_empty_selected_subject_keeps_reviewed_schema(self):
        request, _, _ = fixture(self.root, count=0)
        with redirect_stderr(io.StringIO()):
            result = reader.restore(request)
        self.assertEqual(result["rows"], 0)
        self.assertEqual(pq.read_schema(result["urls"][0]), reader.arrow_schema("roll_call_votes"))

    def test_duplicate_context_nonaccepted_generation_and_conflicting_footers_refuse(self):
        for change in ("duplicate-accepted", "duplicate-receipt", "observed-generation", "refused-generation", "conflicting-footer", "no-selected-context"):
            with self.subTest(change=change):
                root = self.root / change
                root.mkdir()
                request, _, _ = fixture(root)
                path = Path(request["receipts"]["path"])
                rows = pq.read_table(path).to_pylist()
                if change == "no-selected-context":
                    rows = [row for row in rows if row["dataset"] != "roll_call_votes"]
                elif change.startswith("duplicate"):
                    row = copy.deepcopy(next(row for row in rows if row["outcome"] == "accepted"))
                    if change == "duplicate-accepted":
                        row["attempt_id"] += "-duplicate"
                        row["receipt_id"] = _digest({key:value for key, value in row.items() if key != "receipt_id"})
                    rows.append(row)
                elif change == "conflicting-footer":
                    row = copy.deepcopy(next(row for row in rows if row["dataset"] == "roll_call_votes" and
                        decode_exact_json(row["processing_json"]).get("entry_kind") == "table_metadata"))
                    fields = decode_exact_json(row["processing_json"])
                    fields["source_schema"] = pa.schema([("vote_id", pa.int64())]).serialize().to_pybytes()
                    row["processing_json"] = exact_json(fields)
                    row["attempt_id"] += "-conflicting"
                    row["receipt_id"] = _digest({key:value for key, value in row.items() if key != "receipt_id"})
                    rows.append(row)
                else:
                    row = next(row for row in rows if row["dataset"] == "roll_call_votes" and row["outcome"] ==
                               ("observed" if change.startswith("observed") else "refused"))
                    row["generation_id"] = "other-nonempty"
                    row["receipt_id"] = _digest({key:value for key, value in row.items() if key != "receipt_id"})
                pq.write_table(pa.Table.from_pylist(rows, schema=RECEIPT_SCHEMA), path)
                request["receipts"] = member(path)
                with redirect_stderr(io.StringIO()), self.assertRaises((ValueError, TypeError)):
                    reader.restore(request)
                self.assertFalse((Path(request["destination"]) / "coverage-facts.parquet").exists())

    def test_rejected_term_observations_remain_admitted_and_refuse_wrong_native_row_count(self):
        request, raw, _ = fixture(self.root, "member_vote_terms")
        rejected = dict(raw[0], term_index=None, term_match="not_matched")
        source = self.root / "rejected-original.parquet"
        pq.write_table(pa.Table.from_pylist(raw + [rejected], schema=pq.read_schema(self.root / "original.parquet")), source)
        subject, receipts = write_congress_dataset(source, self.root / "with-rejected", dataset="member_vote_terms", generation_id="selected", bulk=True)
        request.update(subjects=[member(subject)], receipts=member(receipts))
        self.assertTrue(any(row["outcome"] == "rejected" for row in pq.read_table(receipts).to_pylist()))
        with redirect_stderr(io.StringIO()), self.assertRaisesRegex(ValueError, "selected subject schema or rows"):
            reader.restore_votes(request, reader.description("member_vote_terms"))
        self.assertFalse((Path(request["destination"]) / "coverage-facts.parquet").exists())

    def test_diagnostic_forwarding_accepts_timeout_bytes_and_excludes_other_stderr(self):
        with redirect_stderr(io.StringIO()) as captured:
            adapter.forward_restore_diagnostics(b'unrelated\ncoverage-restore {"stage":"selected-receipts"}\n')
        self.assertEqual(captured.getvalue(), 'coverage-restore {"stage":"selected-receipts"}\n')

    def test_bridge_preserves_diagnostics_on_success_failure_and_timeout(self):
        line = 'coverage-restore {"stage":"batch-to-row-fallback","reason":"exact refusal"}\n'
        env = {"SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE":reader.__file__}
        completed = subprocess.CompletedProcess([], 0, '{"ok":true}\n', line)
        failures = (subprocess.CalledProcessError(1, [], stderr=line),
                    subprocess.TimeoutExpired([], 300, stderr=line.encode()))
        with patch.dict(adapter.os.environ, env), redirect_stderr(io.StringIO()) as output:
            with patch.object(adapter.subprocess, "run", return_value=completed):
                self.assertEqual(adapter.bridge(request={"dataset":"roll_call_votes"}), {"ok":True})
            for failure in failures:
                with patch.object(adapter.subprocess, "run", side_effect=failure), self.assertRaises(type(failure)):
                    adapter.bridge(request={"dataset":"roll_call_votes"})
        self.assertEqual(output.getvalue(), line * 3)

    def test_only_measured_native_readers_take_heavy_lock_and_keep_diagnostics(self):
        spec = importlib.util.spec_from_file_location("coverage_scope_driver", Path(reader.__file__).with_name("build-coverage-maps.py"))
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        line = 'coverage-restore {"stage":"selected-reader"}\n'
        result = subprocess.CompletedProcess([], 0, '{}\n', line)
        for dataset, native, locked in (("documents", True, True), ("federal_register", True, True),
                ("fr_docket_links", True, True), ("comment_periods", True, True), ("rule_targets", True, True),
                ("proceedings", True, False), ("roll_call_votes", True, False), ("comment_periods", False, False),
                ("comments", False, False), ("fec_receipts", False, False)):
            with self.subTest(dataset=dataset, native=native), patch.object(driver, "cached", return_value=False), \
                    patch.object(driver.subprocess, "run", return_value=result) as run, patch.object(driver, "HEAVY_NATIVE_SCAN_LOCK") as lock, \
                    redirect_stderr(io.StringIO()) as diagnostics:
                self.assertEqual(driver.timed_scan((dataset, {}, {"_additionalNativeProcessing":native}, None)), (dataset, {}))
                self.assertEqual(lock.__enter__.call_count, int(locked))
                self.assertEqual(run.call_args.kwargs["timeout"], 3600 if dataset in ("comments", "fec_receipts") else 900)
                self.assertEqual(diagnostics.getvalue(), line)


if __name__ == "__main__":
    unittest.main()
