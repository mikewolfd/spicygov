"""Inherited native coverage keeps receipt-restored parent keys and scope."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import additional_native_coverage as adapter
import restore_source_navigation_coverage as reader
from coverage_inputs import CoverageInputs
from spicy_regs.legislative_documents import field_registry
from spicy_regs.legislative_receipts import admit_bundle, write_legislative_outputs

SPEC = importlib.util.spec_from_file_location("small_native_build", ROOT / "scripts/build-coverage-maps.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


def fixture(root, family, rows):
    source = root / "source"
    source.mkdir()
    outputs = []
    for dataset, values in rows.items():
        schema = pa.schema([(field["name"], pa.string()) for field in field_registry()[dataset]["fields"]])
        path = source / (dataset + ".parquet")
        pq.write_table(pa.Table.from_pylist([dict.fromkeys(schema.names) | row for row in values], schema=schema), path)
        outputs.append(path)
    write_legislative_outputs(outputs, root / "bundle", generation_id="selected")
    artifact = admit_bundle(root / "bundle", root / "generation", family=family)
    prefix = "generations/" + family + "/" + artifact.root["artifactDigest"][7:]

    class Inputs(CoverageInputs):
        def fetch(self, key):
            if not key.startswith(prefix + "/"):
                raise ValueError("Coverage lookup left the exact selected generation")
            return (root / "generation" / key[len(prefix) + 1:]).read_bytes()

    inputs = Inputs()

    def download(key, destination):
        destination.write_bytes(inputs.fetch(key))

    return inputs, download, artifact.root


def bridge(args=(), request=None):
    if args == ["--verify-artifacts"]:
        return reader.verify_artifacts(request)
    if args:
        return json.loads(json.dumps(reader.description(args[1])))
    return json.loads(json.dumps(reader.restore(request)))


class SmallNativeCoverageTests(unittest.TestCase):
    def scan(self, root, family, child, rows):
        inputs, download, artifact = fixture(root, family, rows)
        owner = inputs.table(family, artifact["artifactDigest"], child)
        description = json.loads(json.dumps(reader.description(child)))
        table = {**owner, "kind":"generation", "columns":description["nativeSchema"],
                 "members":[{**member, "url":url} for member, url in zip(owner["members"], owner["urls"])]}
        with patch.object(adapter, "bridge", side_effect=bridge):
            adapter.native_schema.cache_clear()
            self.addCleanup(adapter.native_schema.cache_clear)
            policy = adapter.variant(child, table, build.definitions()[child])
            return adapter.scan_table(child, table, policy, validate_members=build.validate_members,
                                      validate_counts=build.validate_counts, inputs=inputs, download=download)

    def test_law_sections_keep_same_generation_receipt_hash_key(self):
        digest = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as directory:
            result = self.scan(Path(directory), "laws", "law_sections", {
                "laws":[{"law_id":"119-public-1", "congress":"119", "law_type":"public", "number":"1",
                         "approved_date":"2025-01-06", "uslm_sha256":digest}],
                "law_sections":[{"law_id":"119-public-1", "seq":"1", "source_sha256":digest},
                                {"law_id":"119-public-1", "seq":"2", "source_sha256":"sha256:" + "b" * 64}],
            })
        self.assertNotIn("uslm_sha256", dict(reader.description("laws")["nativeSchema"]))
        dimensions = {dimension["id"]:dimension for dimension in result["dimensions"]}
        for dimension in (dimensions["law-approval-dates"], dimensions["law-congresses"]):
            self.assertEqual((dimension["matchedRows"], dimension["unmatchedRows"]), (1, 1))
            self.assertEqual((dimension["placedRows"], dimension["unplacedRows"]), (1, 1))
            self.assertEqual(dimension["parent"]["artifactDigest"], result["artifactDigest"])
        self.assertEqual(dimensions["law-approval-dates"]["buckets"], {"2025-01":1})
        self.assertEqual(dimensions["law-congresses"]["buckets"], {'["119"]':1})
        self.assertEqual(dimensions["retained-rows"]["snapshot"]["artifactDigest"], result["artifactDigest"])

    def test_report_sections_keep_distinct_parts_in_same_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.scan(Path(directory), "committee-reports", "report_sections", {
                "committee_reports":[{"package_id":"CRPT-119hrpt1", "part_id":"part-1", "congress":"119", "date_issued":"2025-01-06"},
                                     {"package_id":"CRPT-119hrpt1", "part_id":"part-2", "congress":"118", "date_issued":"2024-12-06"}],
                "report_sections":[{"package_id":"CRPT-119hrpt1", "part_id":"part-1", "seq":"1"},
                                   {"package_id":"CRPT-119hrpt1", "part_id":"part-2", "seq":"1"}],
            })
        self.assertEqual(result["dimensions"][0]["buckets"], {'["118"]':1, '["119"]':1})
        self.assertEqual(result["dimensions"][1]["buckets"], {"2024-12":1, "2025-01":1})
        for dimension in result["dimensions"]:
            self.assertEqual((dimension["matchedRows"], dimension["unmatchedRows"]), (2, 0))
            self.assertEqual(dimension["parent"]["artifactDigest"], result["artifactDigest"])


if __name__ == "__main__":
    unittest.main()
