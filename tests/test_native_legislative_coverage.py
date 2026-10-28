"""Native coverage keeps physical publication and private input authorities separate."""

from contextlib import redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import additional_native_coverage as adapter
import coverage_scan
import native_legislative_coverage as native


class NativeCoverageTests(unittest.TestCase):
    def test_bill_subjects_native_route_keeps_restored_acquisition_values(self):
        root = Path(__file__).parents[1]
        policy = json.loads((root / "content/coverage-definitions/congress.json").read_text())["tables"]["bill_subjects"]
        physical = [["bill_id", "VARCHAR"], ["policy_area", "VARCHAR"],
                    ["subjects", "VARCHAR[]"], ["subject_count", "BIGINT"]]
        table = {"family": "bill-subjects", "columns": physical}
        with patch.object(native, "native_schema", return_value={
                "nativeSchema": physical, "receiptOnly": False, "implementationSha256": "reviewed-reader"}):
            selected = native.variant("bill_subjects", table, policy)
        self.assertTrue(selected["_nativeProcessing"])
        self.assertEqual(selected["schema"], physical)
        self.assertEqual(selected["processingSchema"], policy["schema"])
        self.assertIn(["carrier", "VARCHAR"], selected["processingSchema"])
        self.assertNotIn("carrier", dict(selected["schema"]))
        self.assertEqual([(d["id"], d["fields"]) for d in selected["dimensions"]],
                         [("bill-subject-availability", ["bill_id", "policy_area", "subjects_json"]),
                          ("subject-acquisition-route", ["carrier"])])
        self.assertEqual(selected["dimensions"][0]["comparisonTable"], "congress_bills")
        self.assertIn("not a reconstruction of historical processing inputs", selected["note"])

    def test_flat_published_schema_uses_the_published_scanner_without_restoration(self):
        policy = {"schema": [["source", "VARCHAR"]]}
        table = {"family": "bill-family", "columns": policy["schema"]}
        with patch.object(
            native, "bridge", side_effect=AssertionError("unneeded bridge")
        ):
            self.assertIs(native.variant("bill_versions", table, policy), policy)
            with native.processing_context(
                "bill_versions", table, policy, object()
            ) as result:
                self.assertIs(result[0], table)

    def test_bridge_runs_only_the_packaged_reader(self):
        removed = {
            "SPICYGOV_NATIVE_COVERAGE_BRIDGE": "/nonexistent",
            "SPICYGOV_LEGACY_COVERAGE_BRIDGE": "/nonexistent",
        }
        done = type("Done", (), {"stdout": "{}\n", "stderr": ""})()
        with (
            patch.dict("os.environ", {**removed, "SPICYGOV_COVERAGE_PYTHON": "/x/python"}),
            patch.object(native.subprocess, "run", return_value=done) as run,
        ):
            native.bridge(["--schema", "bill_versions"])
            self.assertEqual(
                run.call_args.args[0],
                ["/x/python", "-m", "spicy_regs.coverage_reader", "--schema", "bill_versions"],
            )
        with (
            patch.dict("os.environ", removed),
            patch.object(native.subprocess, "run", return_value=done) as run,
        ):
            os.environ.pop("SPICYGOV_COVERAGE_PYTHON", None)
            native.bridge(["--schema", "bill_versions"])
            self.assertEqual(run.call_args.args[0][:3], [sys.executable, "-m", "spicy_regs.coverage_reader"])

    def test_bridge_has_a_finite_allowance_and_shows_diagnostics_on_success_and_failure(self):
        line = "2026-10-17 | WARNING | regulatory restore route=row dataset=documents reason=x\n"
        done = subprocess.CompletedProcess([], 0, "{}\n", "unrelated\n" + line)
        cause = "ValueError: Native coverage subjects differ from the selected generation"
        stderr = line + "earlier reader output\n" * 200 + cause + "\n"
        failure = subprocess.CalledProcessError(1, [], stderr=stderr)
        timeout = subprocess.TimeoutExpired([], 900, stderr=line)
        with redirect_stderr(io.StringIO()) as shown:
            with patch.object(native.subprocess, "run", return_value=done) as run:
                native.bridge(["--schema", "bill_versions"])
                self.assertEqual(run.call_args.kwargs["timeout"], 900)
            with patch.object(native.subprocess, "run", side_effect=failure):
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    native.bridge(["--schema", "bill_versions"])
            with patch.object(native.subprocess, "run", side_effect=timeout):
                with self.assertRaises(subprocess.TimeoutExpired) as timed_out:
                    native.bridge(["--schema", "bill_versions"])
        self.assertEqual(shown.getvalue(), line * 3)
        self.assertIs(caught.exception, failure)
        self.assertEqual(failure.stderr, stderr)
        notes = getattr(failure, "__notes__", [])
        self.assertEqual(len(notes), 1)
        self.assertLessEqual(len(notes[0]), 1250)
        self.assertTrue(notes[0].endswith(stderr[-1200:]))
        # The outer coverage scan reports only the final 1,500 traceback characters.
        self.assertIn(cause, "".join(traceback.format_exception(failure))[-1500:])
        self.assertIs(timed_out.exception, timeout)
        self.assertFalse(getattr(timeout, "__notes__", []))

    def test_each_dataset_is_described_once_then_served_from_the_build_cache(self):
        calls = []

        def bridge(args=(), request=None):
            calls.append(args[1])
            return {"nativeSchema": [["a", "VARCHAR"]], "receiptOnly": False,
                    "implementationSha256": "bridge"}

        policy = {"_nativeProcessing": True, "schema": [["a", "VARCHAR"]],
                  "restorationImplementationSha256": "bridge"}
        with patch.dict(native.SCHEMAS, clear=True), patch.object(native, "bridge", side_effect=bridge):
            native.describe_all({"bill_versions", "bill_actions"})
            native.describe_all({"bill_versions", "bill_actions"})
            native.native_schema("bill_versions")
            self.assertEqual(sorted(calls), ["bill_actions", "bill_versions"])
            # The end-of-build race check never trusts the cache.
            native.validate_native_implementations({"bill_versions": policy, "other": {}})
            self.assertEqual(sorted(calls), ["bill_actions", "bill_versions", "bill_versions"])
            native.native_schema("bill_sections")
            self.assertEqual(calls[-1], "bill_sections")
        with patch.dict(native.SCHEMAS, clear=True), patch.object(
                native, "bridge", side_effect=AssertionError("seeded datasets need no reader")):
            native.seed({"bill_versions": {"seeded": True}})
            self.assertEqual(native.native_schema("bill_versions"), {"seeded": True})

    def test_only_exact_reviewed_native_schema_has_a_processing_variant(self):
        policy = {"schema": [["source", "VARCHAR"]]}
        table = {"family": "bill-family", "columns": [["printing_id", "VARCHAR"]]}
        with patch.object(
            native,
            "native_schema",
            return_value={
                "nativeSchema": table["columns"],
                "receiptOnly": False,
                "implementationSha256": "bridge",
            },
        ):
            result = native.variant("bill_versions", table, policy)
            self.assertEqual(result["schema"], table["columns"])
            self.assertEqual(result["processingSchema"], policy["schema"])
        for bad in (
            {
                "nativeSchema": [["unknown", "VARCHAR"]],
                "receiptOnly": False,
                "implementationSha256": "bridge",
            },
            {"nativeSchema": table["columns"], "receiptOnly": True},
        ):
            with patch.object(native, "native_schema", return_value=bad):
                with self.assertRaises(ValueError):
                    native.variant("bill_versions", table, policy)
        # Neither the flat reviewed schema nor the reviewed native subject: refused.
        unknown = {**table, "columns": [["x", "VARCHAR"]]}
        with patch.object(
            native,
            "native_schema",
            return_value={
                "nativeSchema": table["columns"],
                "receiptOnly": False,
                "implementationSha256": "bridge",
            },
        ):
            with self.assertRaisesRegex(ValueError, "not the reviewed native subject"):
                native.variant("bill_versions", unknown, policy)

    def test_explicit_public_schema_counts_published_fields_without_restoration(self):
        columns = [["congress", "BIGINT"], ["version_date", "VARCHAR"]]
        policy = {"schema": [["congress", "VARCHAR"], ["version_date", "VARCHAR"]],
                  "publishedSchema": columns, "dimensions": [
                      {"id": "congress", "kind": "category", "fields": ["congress"],
                       "label": "Congress", "meaning": "Published Congress values."}]}
        table = {"family": "bill-family", "columns": columns}
        with patch.object(native, "native_schema", side_effect=AssertionError("Public fields need no receipt reader")):
            actual = native.variant("bill_sections", table, policy)
            self.assertEqual(actual["schema"], columns)
            self.assertNotIn("_nativeProcessing", actual)
            self.assertNotIn("processingSchema", actual)
            self.assertIs(native.variant("bill_sections", {**table, "columns": policy["schema"]}, policy), policy)
            with self.assertRaisesRegex(ValueError, "schema needs coverage review"):
                native.variant("bill_sections", {**table, "columns": [["congress", "DOUBLE"]]}, policy)

    def test_unrelated_schema_change_does_not_enable_restoration(self):
        policy = {"schema": [["old", "VARCHAR"]]}
        table = {"family": "other", "columns": [["new", "VARCHAR"]]}
        with patch.object(
            native, "native_schema", side_effect=AssertionError("unrelated bridge")
        ):
            self.assertIs(native.variant("bill_versions", table, policy), policy)

    def test_native_context_never_changes_physical_members_or_binding_schema(self):
        table = {
            "columns": [["printing_id", "VARCHAR"]],
            "members": [{"url": "actual.parquet", "sha256": "physical"}],
        }
        policy = {
            "_nativeProcessing": True,
            "schema": table["columns"],
            "processingSchema": [["source", "VARCHAR"]],
            "restorationImplementationSha256": "bridge",
        }
        facts = {
            "implementationSha256": "bridge",
            "nativeSchema": table["columns"],
            "processingSchema": policy["processingSchema"],
        }

        class Inputs:
            def producing(self, *args):
                return object()

        with patch.object(
            native.ProcessingInputs,
            "restore",
            return_value={"urls": ["private.parquet"], "_coverageProcessing": facts},
        ):
            with native.processing_context(
                "bill_versions", table, policy, Inputs()
            ) as (measured, _):
                self.assertEqual(measured["members"], table["members"])
                self.assertEqual(measured["columns"], table["columns"])
                self.assertEqual(measured["_coverageUrls"], ["private.parquet"])

    def test_changed_private_schema_refuses_measurement(self):
        table = {"columns": [["printing_id", "VARCHAR"]], "members": []}
        policy = {
            "_nativeProcessing": True,
            "processingSchema": [["source", "VARCHAR"]],
        }

        class Inputs:
            def producing(self, *args):
                return object()

        result = {
            "urls": [],
            "_coverageProcessing": {
                "nativeSchema": table["columns"],
                "processingSchema": [["source", "BIGINT"]],
            },
        }
        with patch.object(native.ProcessingInputs, "restore", return_value=result):
            with self.assertRaises(ValueError):
                with native.processing_context(
                    "bill_versions", table, policy, Inputs()
                ):
                    pass

    def test_changed_staged_bytes_refuse_before_backend(self):
        with tempfile.TemporaryDirectory() as folder:
            inputs = native.ProcessingInputs(
                object(), folder, lambda key, path: path.write_bytes(b"changed")
            )
            with self.assertRaisesRegex(ValueError, "bytes differ"):
                inputs._member(
                    "generation",
                    {
                        "objectKey": "table.parquet",
                        "sha256": "sha256:" + "a" * 64,
                        "byteSize": 7,
                    },
                )

    def test_shared_member_cache_downloads_once_and_refuses_changed_bytes(self):
        import hashlib

        data = b"exact native file"
        calls = []
        member = {
            "objectKey": "etl_receipts.parquet",
            "sha256": "sha256:" + hashlib.sha256(data).hexdigest(),
            "byteSize": len(data),
        }
        with (
            tempfile.TemporaryDirectory() as folder,
            patch.dict("os.environ", {"SPICYGOV_NATIVE_COVERAGE_CACHE": folder}),
        ):

            def download(key, path):
                calls.append(key)
                path.write_bytes(data)

            first = native.ProcessingInputs(object(), folder, download)._member(
                "generation-one", member
            )
            second = native.ProcessingInputs(object(), folder, download)._member(
                "same-content-generation", member
            )
            self.assertEqual(first, second)
            self.assertEqual(len(calls), 1)
            Path(first["path"]).write_bytes(b"changed")
            with self.assertRaises(ValueError):
                native.ProcessingInputs(object(), folder, download)._member(
                    "generation-one", member
                )

    def test_boolean_size_is_not_a_member_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                native.ProcessingInputs(object(), folder)._member(
                    "generation", {"byteSize": True}
                )

    def test_end_of_build_checks_fresh_backend_identity_without_cached_schema(self):
        policy = {
            "_nativeProcessing": True,
            "schema": [["printing_id", "VARCHAR"]],
            "restorationImplementationSha256": "qualified",
        }
        current = {
            "nativeSchema": policy["schema"],
            "receiptOnly": False,
            "implementationSha256": "qualified",
        }
        with patch.object(native, "bridge", return_value=current) as reader:
            native.validate_native_implementations(
                {"bill_versions": policy, "comments": {}}
            )
            reader.assert_called_once_with(["--schema", "bill_versions"])
        for changed in (
            {**current, "implementationSha256": "changed"},
            {**current, "nativeSchema": [["other", "VARCHAR"]]},
            {**current, "receiptOnly": True},
        ):
            with patch.object(native, "bridge", return_value=changed):
                with self.assertRaisesRegex(ValueError, "reader changed"):
                    native.validate_native_implementations({"bill_versions": policy})


class WarmCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "coverage_driver",
            Path(__file__).parents[1] / "scripts/build-coverage-maps.py",
        )
        cls.driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.driver)

    def test_complete_mixed_native_and_published_inventory_uses_each_tables_revision(self):
        source_schema = [["source", "VARCHAR"]]
        physical_schema = [["printing_id", "VARCHAR"]]
        dimension = {
            "id": "source",
            "kind": "category",
            "fields": ["source"],
            "label": "Source",
            "meaning": "Recorded source.",
        }
        reviewed = {
            id: {
                "family": "bill-family",
                "classification": "categorical",
                "schema": source_schema,
                "_scanner": "regulation",
                "dimensions": [dimension],
            }
            for id in ("published", "bill_versions")
        }
        tables = {
            id: {
                "family": "bill-family",
                "kind": "generation",
                "columns": columns,
                "rows": 1,
            }
            for id, columns in (
                ("published", source_schema),
                ("bill_versions", physical_schema),
            )
        }
        native_policy = {
            **reviewed["bill_versions"],
            "schema": physical_schema,
            "processingSchema": source_schema,
            "_nativeProcessing": True,
            "restorationImplementationSha256": "qualified",
        }
        revisions = {}

        def scan(item):
            id, _, policy, _ = item
            revisions[id] = self.driver.measurement_revision(policy)
            return id, {"measurementRevision": revisions[id], "dimensions": [dimension]}

        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "maps.json"
            with (
                patch.object(
                    sys, "argv", ["build-coverage-maps", "--output", str(output)]
                ),
                patch.object(self.driver.duckdb, "connect"),
                patch.object(self.driver, "load", return_value=({}, tables)),
                patch.object(
                    self.driver, "definitions", side_effect=lambda: dict(reviewed)
                ),
                patch.object(
                    self.driver,
                    "variant",
                    side_effect=lambda id, table, policy: (
                        native_policy if id == "bill_versions" else policy
                    ),
                ),
                patch.object(self.driver, "timed_scan", side_effect=scan),
                patch.object(self.driver.native, "describe_all") as describe_native,
                patch.object(self.driver.additional, "describe_all") as describe_additional,
                patch.object(
                    self.driver, "validate_native_implementations"
                ) as final_reader,
                patch.object(self.driver, "census_digest", return_value="exact-census"),
                patch.object(self.driver.subprocess, "run") as checker,
                patch.object(self.driver, "CACHE", Path(folder) / "cache"),
            ):
                self.driver.main()
                self.assertTrue(output.exists())
                # Each published native dataset is described once, before the plan needs it.
                describe_native.assert_called_once_with({"bill_versions"})
                describe_additional.assert_called_once_with(set())
                self.assertNotEqual(revisions["published"], revisions["bill_versions"])
                checker.assert_called_once()
                self.assertEqual(
                    final_reader.call_args.args[0]["bill_versions"], native_policy
                )
                self.assertEqual(reviewed["bill_versions"]["schema"], source_schema)
                saved = json.loads(output.read_text())["tables"]
                self.assertEqual(
                    {id: result["measurementRevision"] for id, result in saved.items()},
                    revisions,
                )

                previous = output.read_text()
                with patch.object(
                    self.driver,
                    "timed_scan",
                    side_effect=lambda item: (
                        item[0],
                        {
                            "measurementRevision": revisions["published"],
                            "dimensions": [dimension],
                        },
                    ),
                ):
                    with self.assertRaisesRegex(ValueError, "implementation changed"):
                        self.driver.main()
                self.assertEqual(output.read_text(), previous)

    def test_flat_published_tables_in_the_measured_map_are_admitted_without_a_reader(self):
        # The 2026-10-05 map measured most native-family tables in the flat published
        # shape. That is the current published format: the plan admits them with no reader.
        root = Path(__file__).parents[1]
        saved = json.loads((root / "public/coverage-maps.v1.json").read_text())["tables"]
        policies = self.driver.definitions()
        flat = {
            id: {"family": saved[id]["family"], "kind": "generation", "columns": policies[id]["schema"]}
            for id in sorted((native.DATASETS | set(adapter.FAMILIES)) & set(saved))
            if [list(c) for c in saved[id]["schema"]] == [list(c) for c in policies[id]["schema"]]
        }
        self.assertTrue({"bill_versions", "documents", "members"} <= set(flat))
        chosen = {id: dict(policies[id]) for id in flat}
        unneeded = AssertionError("a flat published table needs no reader")
        with (
            patch.object(native, "bridge", side_effect=unneeded),
            patch.object(native, "native_schema", side_effect=unneeded),
            patch.object(adapter, "bridge", side_effect=unneeded),
            patch.object(adapter, "native_schema", side_effect=unneeded),
        ):
            self.driver.validate_plan(flat, chosen)
        self.assertFalse(
            [id for id, policy in chosen.items()
             if policy.get("_nativeProcessing") or policy.get("_additionalNativeProcessing")]
        )

    def test_checkpoint_binding_and_historical_map_is_evidence_only(self):
        root = Path(__file__).parents[1]
        saved = json.loads((root / "public/coverage-maps.v1.json").read_text())[
            "tables"
        ]["comments"]
        table = {
            "family": saved["family"],
            "artifactDigest": saved.get("artifactDigest"),
            "columns": saved["schema"],
            "publishedAt": saved.get("publishedAt"),
            "checksum": saved.get("publicationSha256"),
            "rows": saved["rows"],
            "members": [
                {"url": url, "rows": rows, "byteSize": size}
                for url, rows, size in json.loads(saved["fingerprint"])
            ],
            "coverageInputs": [
                dict(zip(("id", "url", "rows", "byteSize", "sha256", "etag"), values))
                for values in json.loads(saved["inputsFingerprint"])
            ],
        }
        policy = self.driver.definitions()["comments"]
        current = self.driver.measurement_revision(policy)
        # The checked-in map predates the single reader route: retained as evidence, never reused.
        self.assertNotEqual(current, saved["measurementRevision"])
        with patch.object(coverage_scan, "header_matches") as check:
            self.assertFalse(self.driver.cached(table, policy, saved))
            check.assert_not_called()
            # The checked-in entry also predates the current comments schema and definition.
            rebound = {**saved, "measurementRevision": current, "schema": policy["schema"],
                       "definitionDigest": self.driver.definition_digest(policy)}
            self.assertTrue(self.driver.cached(table, policy, rebound))
            self.assertEqual(check.call_count, 2)
            changed = {
                **table,
                "members": [
                    {
                        **table["members"][0],
                        "byteSize": table["members"][0]["byteSize"] + 1,
                    }
                ],
            }
            self.assertFalse(self.driver.cached(changed, policy, rebound))

    def test_native_revision_binds_the_reader_identity(self):
        policy = self.driver.definitions()["comments"]
        native_policy = {
            "_scanner": "regulation",
            "_nativeProcessing": True,
            "restorationImplementationSha256": "sha256:" + "a" * 64,
        }
        first = self.driver.measurement_revision(native_policy)
        self.assertNotEqual(first, self.driver.measurement_revision(policy))
        self.assertNotEqual(
            first,
            self.driver.measurement_revision(
                {**native_policy, "restorationImplementationSha256": "sha256:" + "b" * 64}
            ),
        )
        with self.assertRaises(KeyError):
            self.driver.measurement_revision({"_scanner": "regulation", "_nativeProcessing": True})


if __name__ == "__main__":
    unittest.main()
