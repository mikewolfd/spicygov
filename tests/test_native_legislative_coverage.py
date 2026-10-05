"""Native coverage keeps physical publication and private input authorities separate."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
import native_legislative_coverage as native


class NativeCoverageTests(unittest.TestCase):
    def test_legacy_schema_does_not_require_backend_or_restore(self):
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


class WarmCoverageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location(
            "coverage_driver",
            Path(__file__).parents[1] / "scripts/build-coverage-maps.py",
        )
        cls.driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.driver)

    def test_real_26_million_comment_checkpoint_remains_bound_without_scanning(self):
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
        self.assertEqual(
            self.driver.measurement_revision(policy), saved["measurementRevision"]
        )
        with patch.object(self.driver, "header_matches") as check:
            self.assertTrue(self.driver.cached(table, policy, saved))
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
            self.assertFalse(self.driver.cached(changed, policy, saved))
        self.assertNotEqual(
            self.driver.measurement_revision({"_nativeProcessing": True}),
            saved["measurementRevision"],
        )

    def test_a_legacy_reader_or_validation_change_invalidates_compatibility(self):
        from coverage_revision import legacy_revision
        import shutil

        root = Path(__file__).parents[1]
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            (target / "content").mkdir()
            (target / "scripts").mkdir()
            shutil.copyfile(
                root / "content/legacy-coverage-compatibility.v1.json",
                target / "content/legacy-coverage-compatibility.v1.json",
            )
            shutil.copyfile(
                root / "scripts/native_legislative_coverage.py",
                target / "scripts/native_legislative_coverage.py",
            )
            proof = json.loads(
                (target / "content/legacy-coverage-compatibility.v1.json").read_text()
            )
            for name in proof["files"]:
                shutil.copyfile(root / "scripts" / name, target / "scripts" / name)
            driver = target / "scripts/build-coverage-maps.py"
            shutil.copyfile(root / "scripts/build-coverage-maps.py", driver)
            self.assertEqual(
                legacy_revision(target, driver), proof["measurementRevision"]
            )
            reader = target / "scripts/regulation_coverage.py"
            reader.write_text(reader.read_text() + "\n# changed reader\n")
            self.assertIsNone(legacy_revision(target, driver))
            shutil.copyfile(root / "scripts/regulation_coverage.py", reader)
            driver.write_text(
                driver.read_text().replace(
                    "def validate_counts(dimension, rows):",
                    "def validate_counts(dimension, rows):\n    changed_validation = True",
                )
            )
            self.assertIsNone(legacy_revision(target, driver))
            shutil.copyfile(root / "scripts/build-coverage-maps.py", driver)
            driver.write_text(driver.read_text() + "\nCHANGED_GLOBAL = True\n")
            self.assertIsNone(legacy_revision(target, driver))


if __name__ == "__main__":
    unittest.main()
