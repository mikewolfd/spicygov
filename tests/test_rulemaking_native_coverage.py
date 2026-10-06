"""Native rulemaking coverage uses the declared snapshot, never latest inputs."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import additional_native_coverage as adapter  # noqa: E402
import publication_census as census  # noqa: E402
import restore_source_navigation_coverage as reader  # noqa: E402
from coverage_inputs import CoverageInputs  # noqa: E402
from spicy_regs.transforms.regulations_receipts import write_held_dataset  # noqa: E402
from spicy_regs.transforms.regulations_shape import SOURCE_COLUMNS  # noqa: E402

SPEC = importlib.util.spec_from_file_location("rulemaking_coverage_build", ROOT / "scripts/build-coverage-maps.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def bridge(args=(), request=None):
    if args:
        return json.loads(json.dumps(reader.description(args[1])))
    return json.loads(json.dumps(reader.restore(request)))


def fixture(root, dataset="proceedings"):
    schema = pa.schema([(name, pa.int64() if dtype == "BIGINT" else pa.string())
                        for name, dtype in SOURCE_COLUMNS[dataset]])
    values = {"proceeding_id": "p-1", "rin": "0099-AB01", "stage_events_json":
              '[ {"effective_date":"2025-01-06","stage":"proposal"}, {"effective_date":"2025-01-06","stage":"proposal"}, '
              '{"effective_date":null,"stage":"final"} ]', "method":"source method", "run_id":"source-run",
              "asserted_at":"2025-02-01T00:00:00Z"}
    if dataset == "comment_periods":
        values = {"comment_period_id":"window-1", "open_date":"2025-01-06", "close_date":"2025-02-06",
                  "register_close_date":"1800-01-01", "regulations_gov_close_date":"2200-02-01",
                  "source":"both", "run_id":"source-run"}
    raw = dict.fromkeys(schema.names) | values
    source = root / "source.parquet"
    pq.write_table(pa.Table.from_pylist([raw], schema=schema), source)
    subject, receipts = write_held_dataset(dataset, source, root / "native", generation_id="selected-run")
    prefix = "materialized/rulemaking/snapshots/snapshot_fixture"
    def entry(path, visibility):
        return {"remote_key":prefix + "/" + path.name, "visibility":visibility,
                "rows":pq.ParquetFile(path).metadata.num_rows, "bytes":path.stat().st_size,
                "sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    manifest = {"dataset":"rulemaking", "format_version":2, "snapshot_id":"snapshot_fixture",
                "run_id":"selected-run", "asserted_at":"2025-02-01T00:00:00Z",
                "etlReceipts":{"key":"etl_receipts.parquet", "generationId":"selected-run",
                               "policies":[reader.description(dataset)["policy"]]},
                "artifacts":{subject.name:entry(subject, "public"), receipts.name:entry(receipts, "internal")}}
    pointer = {"dataset":"rulemaking", "format_version":2, "snapshot_id":"snapshot_fixture",
               "manifest_key":prefix + "/manifest.json"}
    class Inputs(CoverageInputs):
        def __init__(self):
            super().__init__()
            self.reads = []
        def fetch(self, key):
            self.reads.append(key)
            if key != pointer["manifest_key"]:
                raise AssertionError("Coverage left its selected snapshot")
            return json.dumps(manifest).encode()
    def download(key, destination):
        if not key.startswith(prefix + "/") or Path(key).name not in manifest["artifacts"]:
            raise AssertionError("Coverage left its selected snapshot")
        shutil.copyfile(root / "native" / Path(key).name, destination)
    return manifest, pointer, Inputs(), download, raw


class RulemakingNativeCoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.patch = patch.object(adapter, "bridge", side_effect=bridge)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        adapter.native_schema.cache_clear()
        self.addCleanup(adapter.native_schema.cache_clear)
        self.env = patch.dict("os.environ", {"SPICYGOV_NATIVE_COVERAGE_CACHE":str(self.root / "cache")})
        self.env.start()
        self.addCleanup(self.env.stop)

    def scan(self, dataset):
        manifest, pointer, inputs, download, raw = fixture(self.root, dataset)
        table = census.rulemaking_tables(pointer, manifest)[dataset]
        policies = build.definitions()
        build.validate_plan({dataset:table}, policies)
        measured = adapter.scan_table(dataset, table, policies[dataset], validate_members=build.validate_members,
                                     validate_counts=build.validate_counts, inputs=inputs, download=download)
        self.assertEqual(inputs.reads, [pointer["manifest_key"]])
        self.assertEqual(measured["processingEvidence"]["generationId"], "selected-run")
        self.assertEqual(measured["processingEvidence"]["receipts"]["sha256"],
                         "sha256:" + manifest["artifacts"]["etl_receipts.parquet"]["sha256"])
        self.assertEqual(measured["schema"], json.loads(json.dumps(reader.description(dataset)["nativeSchema"])))
        with patch.object(build, "header_matches", side_effect=AssertionError("Immutable snapshots need no ETag HEAD")):
            self.assertTrue(build.cached(table, policies[dataset], measured))
        return measured, raw

    def test_proceeding_stage_events_keep_repeated_and_undated_source_values(self):
        measured, _ = self.scan("proceedings")
        dimensions = {dim["id"]:dim for dim in measured["dimensions"]}
        self.assertEqual(dimensions["stage-event-months"]["buckets"], {"2025-01":1})
        self.assertEqual(dimensions["stage-event-months"]["placedRows"], 1)
        self.assertEqual(dimensions["retained-snapshot"]["snapshot"]["recordUrl"],
                         census.BASE + "/materialized/rulemaking/snapshots/snapshot_fixture/manifest.json")

    def test_restored_receipt_fields_preserve_source_order_and_original_run(self):
        manifest, pointer, inputs, download, raw = fixture(self.root)
        table = census.rulemaking_tables(pointer, manifest)["proceedings"]
        restored = adapter.AdditionalInputs(inputs, self.root / "private", download).restore_snapshot("proceedings", table)
        actual = pq.read_table(restored["urls"][0]).to_pylist()
        self.assertEqual(actual, [{name:raw[name] for name, _ in reader.reviewed_schema("proceedings")}])
        self.assertEqual(actual[0]["run_id"], "source-run")
        self.assertEqual(len(json.loads(actual[0]["stage_events_json"])), 3)

    def test_comment_windows_keep_questionable_literal_dates_visible(self):
        measured, _ = self.scan("comment_periods")
        dimensions = {dim["id"]:dim for dim in measured["dimensions"]}
        self.assertEqual(dimensions["register-close-date"]["buckets"], {"1800-01":1})
        self.assertEqual(dimensions["regulations-gov-close-date"]["buckets"], {"2200-02":1})
        self.assertEqual(dimensions["register-close-date"]["anomalies"]["sourceLiteralReviewRows"], 1)

    def test_manifest_binding_refuses_changed_receipts_policy_and_subject(self):
        manifest, pointer, inputs, download, _ = fixture(self.root)
        table = census.rulemaking_tables(pointer, manifest)["proceedings"]
        original = copy.deepcopy(manifest)
        for kind in ("subject", "receipt", "policy", "generation", "snapshot"):
            manifest.clear()
            manifest.update(copy.deepcopy(original))
            if kind in ("subject", "receipt"):
                name = "proceedings.parquet" if kind == "subject" else "etl_receipts.parquet"
                manifest["artifacts"][name]["sha256"] = "0" * 64
            elif kind == "policy":
                manifest["etlReceipts"]["policies"][0]["policy_version"] = "unreviewed"
            elif kind == "generation":
                manifest["run_id"] = "other-run"
            else:
                manifest["snapshot_id"] = "snapshot_other"
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "manifest changed"):
                adapter.AdditionalInputs(inputs, self.root / ("private-" + kind), download).restore_snapshot("proceedings", table)

    def test_exact_manifest_still_requires_reviewed_policy_and_matching_generation(self):
        manifest, pointer, inputs, download, _ = fixture(self.root)
        manifest["etlReceipts"]["policies"][0]["policy_version"] = "unreviewed"
        table = census.rulemaking_tables(pointer, manifest)["proceedings"]
        with self.assertRaisesRegex(ValueError, "Unreviewed"):
            adapter.AdditionalInputs(inputs, self.root / "private", download).restore_snapshot("proceedings", table)
        manifest["run_id"] = "other-run"
        with self.assertRaisesRegex(ValueError, "selected rulemaking receipts"):
            census.rulemaking_tables(pointer, manifest)

    def test_physical_receipt_changes_refused_before_restoration(self):
        manifest, pointer, inputs, download, _ = fixture(self.root)
        table = census.rulemaking_tables(pointer, manifest)["proceedings"]
        receipts = self.root / "native/etl_receipts.parquet"
        receipts.write_bytes(receipts.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            adapter.AdditionalInputs(inputs, self.root / "private", download).restore_snapshot("proceedings", table)

    def test_matching_manifest_run_cannot_replace_the_receipts_actual_generation(self):
        manifest, pointer, inputs, download, _ = fixture(self.root)
        manifest["run_id"] = manifest["etlReceipts"]["generationId"] = "different-run"
        table = census.rulemaking_tables(pointer, manifest)["proceedings"]
        with self.assertRaisesRegex(ValueError, "receipt context"):
            adapter.AdditionalInputs(inputs, self.root / "private", download).restore_snapshot("proceedings", table)

    def test_selected_table_and_pointer_cannot_drift_from_snapshot_manifest(self):
        manifest, pointer, inputs, download, _ = fixture(self.root)
        original = census.rulemaking_tables(pointer, manifest)["proceedings"]
        for kind in ("checksum", "rows", "snapshotId", "member-size", "pointer"):
            table = copy.deepcopy(original)
            if kind == "checksum":
                table[kind] = "0" * 64
            elif kind == "rows":
                table[kind] += 1
            elif kind == "snapshotId":
                table[kind] = "snapshot_other"
            elif kind == "member-size":
                table["members"][0]["byteSize"] += 1
            else:
                table["rulemakingSnapshot"]["pointer"]["manifest_key"] = "materialized/rulemaking/latest.json"
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                adapter.AdditionalInputs(inputs, self.root / ("private-" + kind), download).restore_snapshot("proceedings", table)

    def test_receipt_change_invalidates_reuse_and_legacy_path_stays_unchanged(self):
        manifest, pointer, _, _, _ = fixture(self.root)
        original = census.rulemaking_tables(pointer, manifest)["proceedings"]
        changed = copy.deepcopy(manifest)
        changed["artifacts"]["etl_receipts.parquet"]["sha256"] = "0" * 64
        self.assertNotEqual(census.inputs_fingerprint(original),
                            census.inputs_fingerprint(census.rulemaking_tables(pointer, changed)["proceedings"]))
        del manifest["etlReceipts"]
        legacy = census.rulemaking_tables(pointer, manifest)["proceedings"]
        self.assertNotIn("rulemakingSnapshot", legacy)
        self.assertEqual(census.inputs_fingerprint(legacy), "[]")
        policy = build.definitions()["proceedings"]
        self.assertIs(adapter.variant("proceedings", legacy, policy), policy)


if __name__ == "__main__":
    unittest.main()
