"""Small maintained-writer fixtures for the additional Sources coverage reader."""
import copy
import hashlib
import json
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import additional_native_coverage as adapter
import restore_additional_coverage as reader
from spicy_regs.court_receipts import local_receipt_selection, write_court_rows
from spicy_regs.congress_receipts import write_congress_dataset


def plain(value):
    return json.loads(json.dumps(value))


def member(path):
    return {"path": str(path.resolve()), "byteSize": path.stat().st_size,
            "sha256": "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()}


def fixture(root, dataset="court_docket_groups", raw=None, witness=None):
    raw = raw or {"cl_docket_id": "1", "parent_cl_docket_id": "2", "confidence_tier": "high",
                  "group_size": 2, "edition": "2026-06-30", "rule_version": "2", "match_basis": "same_caption"}
    witness = witness or {"source_id": "retained", "sha256": "sha256:" + "a" * 64,
                          "source_uri": None, "locator": None, "body_version": None}
    subject = write_court_rows(dataset, [raw], root / "native", witnesses=[witness], generation_id="selected")
    receipts, _ = local_receipt_selection(subject)
    return raw, {"dataset": dataset, "generationId": "selected", "subjects": [member(subject)],
                 "receipts": member(receipts), "destination": str(root / "restored")}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_runtime_allowances_are_finite_and_scoped_to_selected_restoration(self):
        env = {'SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE': str(Path(adapter.__file__).resolve()),
               'SPICYGOV_SOURCE_NAVIGATION_COVERAGE_PYTHON': sys.executable,
               'SPICYGOV_ADDITIONAL_COVERAGE_BRIDGE': str(Path(adapter.__file__).resolve()),
               'SPICYGOV_ADDITIONAL_COVERAGE_PYTHON': sys.executable}
        for dataset in ('documents', 'federal_register', 'fr_docket_links', 'nominations', 'roll_call_votes', 'comment_periods', 'rule_targets', 'court_opinions', 'court_dockets', 'amendments'):
            for args in ([], ['--schema', dataset]):
                with self.subTest(dataset=dataset, args=args), patch.dict(os.environ, env), patch.object(
                        adapter.subprocess, 'run', return_value=type('Result', (), {'stdout':'{}', 'stderr':''})()) as run:
                    self.assertEqual(adapter.bridge(args, {'dataset':dataset} if not args else None), {})
                    expected = {'documents': 600, 'federal_register': 600, 'fr_docket_links': 600, 'court_opinions': 1800}
                    self.assertEqual(run.call_args.kwargs['timeout'], expected.get(dataset, 300) if not args else 300)

    def test_group_receipt_fields_restore_with_exact_witness(self):
        raw, request = fixture(self.root)
        result = reader.restore(request)
        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [raw])
        self.assertNotIn("edition", dict(result["nativeSchema"]))
        self.assertIn("edition", dict(result["processingSchema"]))
        self.assertEqual(result["acceptedWitnessGroups"][0]["rows"], 1)
        self.assertEqual(result["generationId"], "selected")

    def test_bulk_only_change_invalidates_description_and_restoration_identity(self):
        raw, request = fixture(self.root)
        described_before = reader.description(request["dataset"])
        restored_before = reader.restore(request)
        maintained_before = reader.MAINTAINED.implementation_identity()
        read_bytes = Path.read_bytes
        bulk = reader.ROOT / "src/spicy_regs/etl_bulk.py"

        def changed_bytes(path):
            data = read_bytes(path)
            return data + b"\n# bulk dependency changed\n" if path == bulk else data

        changed_request = {**request, "destination": str(self.root / "restored-again")}
        with patch.object(Path, "read_bytes", changed_bytes):
            described_after = reader.description(request["dataset"])
            restored_after = reader.restore(changed_request)
            self.assertEqual(reader.MAINTAINED.implementation_identity(), maintained_before)
        before_identity = described_before.pop("implementationSha256")
        after_identity = described_after.pop("implementationSha256")
        self.assertNotEqual(before_identity, after_identity)
        self.assertEqual(restored_before.pop("implementationSha256"), before_identity)
        self.assertEqual(restored_after.pop("implementationSha256"), after_identity)
        self.assertEqual(described_before, described_after)
        for restored in (restored_before, restored_after):
            self.assertEqual(pq.read_table(restored.pop("urls")[0]).to_pylist(), [raw])
            for processing_member in restored["processingMembers"]:
                processing_member.pop("path")
        self.assertEqual(restored_before, restored_after)

    def test_exact_maintained_identity_is_still_a_dependency(self):
        before = reader.description("court_docket_groups")
        with patch.object(reader.MAINTAINED, "implementation_identity", return_value="sha256:" + "a" * 64):
            after = reader.description("court_docket_groups")
        self.assertNotEqual(before.pop("implementationSha256"), after.pop("implementationSha256"))
        self.assertEqual(before, after)

    def test_selected_bill_bridge_preserves_the_maintained_restoration(self):
        from spicy_regs.legislative_documents import field_registry
        from spicy_regs.legislative_receipts import write_legislative_outputs
        fields = field_registry()["bill_versions"]["fields"]
        raw = {field["name"]: None for field in fields}
        raw.update(bill_id="hr1-119", version_code="is", source="GovInfo original label",
                   version_date="2025-01-03")
        source = self.root / "bill_versions.parquet"
        pq.write_table(pa.Table.from_pylist([raw], schema=pa.schema(
            [(field["name"], pa.string()) for field in fields])), source)
        native = self.root / "native"
        manifest = write_legislative_outputs([source], native, generation_id="selected-bill")
        request = {"dataset": "bill_versions", "generationId": "selected-bill",
                   "subjects": [member(native / name) for name in manifest["subjects"]["bill_versions"]],
                   "receipts": member(native / "etl_receipts.parquet"),
                   "destination": str(self.root / "direct")}
        direct = plain(reader.MAINTAINED.restore(request))
        router = Path(reader.__file__).with_name("select_native_coverage_reader.py")
        env = {**os.environ, "SPICYGOV_LEGACY_COVERAGE_BRIDGE": str(reader.ROOT / "scripts/restore_coverage_processing.py"),
               "SPICYGOV_LEGACY_COVERAGE_PYTHON": sys.executable}
        described = json.loads(subprocess.check_output(
            [sys.executable, str(router), "--schema", "bill_versions"], env=env, text=True))
        request["destination"] = str(self.root / "selected")
        selected = json.loads(subprocess.check_output(
            [sys.executable, str(router)], env=env, input=json.dumps(request), text=True))
        self.assertEqual(selected["implementationSha256"], described["implementationSha256"])
        self.assertNotEqual(selected["implementationSha256"], direct["implementationSha256"])
        for result in (direct, selected):
            self.assertEqual(pq.read_table(result.pop("urls")[0]).to_pylist(), [raw])
            result.pop("implementationSha256")
            for processing_member in result["processingMembers"]:
                processing_member.pop("path")
        self.assertEqual(direct, selected)

    def test_court_source_list_spelling_survives(self):
        raw = {"cl_docket_id": "1", "parties_json": '["Agency", null,"","Agency"]',
               "attorneys_json": None, "firms_json": "[]", "absolute_url": "/docket/1/",
               "date_filed": "2026-06-30"}
        _, request = fixture(self.root, "court_dockets", raw)
        result = reader.restore(request)
        actual = pq.read_table(result["urls"][0]).to_pylist()[0]
        self.assertTrue(all(actual[k] == v for k, v in raw.items()))
        self.assertEqual(dict(result["nativeSchema"])["parties"], "VARCHAR[]")

    def test_amendment_source_url_restores_via_maintained_reader(self):
        raw = {name: None for name in reader.processing_schema("amendments").names}
        raw.update(amendment_id="hamdt1-119", congress="119", url="https://example.gov/source")
        source = self.root / "source.parquet"
        pq.write_table(pa.Table.from_pylist([raw], schema=reader.processing_schema("amendments")), source)
        subject, receipts = write_congress_dataset(source, self.root / "native", dataset="amendments", generation_id="selected")
        result = reader.restore({"dataset": "amendments", "generationId": "selected",
                                 "subjects": [member(subject)], "receipts": member(receipts),
                                 "destination": str(self.root / "restored")})
        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [raw])
        self.assertNotIn("url", dict(result["nativeSchema"]))

    def test_wrong_generation_hash_size_and_subject_are_refused(self):
        _, request = fixture(self.root)
        for change in ("generation", "hash", "size", "subject"):
            with self.subTest(change=change):
                altered = copy.deepcopy(request)
                altered["destination"] += "-" + change
                if change == "generation":
                    altered["generationId"] = "unselected"
                elif change == "hash":
                    altered["receipts"]["sha256"] = "sha256:" + "0" * 64
                elif change == "size":
                    altered["subjects"][0]["byteSize"] += 1
                else:
                    path = self.root / "altered.parquet"
                    table = pq.read_table(altered["subjects"][0]["path"])
                    rows = table.to_pylist()
                    rows[0]["cl_docket_id"] = "99"
                    pq.write_table(pa.Table.from_pylist(rows, schema=table.schema), path)
                    altered["subjects"] = [member(path)]
                with self.assertRaises(ValueError):
                    reader.restore(altered)

    def test_reused_destination_is_refused(self):
        _, request = fixture(self.root)
        reader.restore(request)
        with self.assertRaisesRegex(ValueError, "new absolute"):
            reader.restore(request)

    def test_artifact_verification_refuses_changed_parent_and_logical_identity(self):
        from spicy_regs.court_receipts import build_court_generation
        _, request = fixture(self.root)
        artifact = build_court_generation(self.root / "generation", family="court-docket-groups",
                                         files=[Path(request["subjects"][0]["path"])])
        root = plain(artifact.root)
        self.assertEqual(reader.verify_artifacts([root])[0]["artifactDigest"], root["artifactDigest"])
        for change in ("parent", "logical"):
            altered = copy.deepcopy(root)
            if change == "parent":
                altered["spec"]["parents"] = {"court_dockets.parquet": {"artifactDigest": "invented"}}
            else:
                altered["logicalId"] = "urn:invented"
            with self.subTest(change=change), self.assertRaises(ValueError):
                reader.verify_artifacts([altered])

    def test_variant_has_narrow_family_schema_and_processing_boundary(self):
        description = plain(reader.description("court_docket_groups"))
        table = {"kind": "generation", "family": "court-docket-groups", "columns": description["nativeSchema"]}
        policy = {"schema": description["processingSchema"]}
        with patch.object(adapter, "native_schema", return_value=description):
            result = adapter.variant("court_docket_groups", table, policy)
            self.assertTrue(result["_additionalNativeProcessing"])
            self.assertIs(adapter.variant("unrelated", table, policy), policy)
            for changed in ({**table, "family": "other"}, {**table, "columns": [["x", "VARCHAR"]]}):
                with self.assertRaises(ValueError):
                    adapter.variant("court_docket_groups", changed, policy)
            with self.assertRaises(ValueError):
                adapter.variant("court_docket_groups", table, {"schema": [["edition", "VARCHAR"]]})


class ParentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = {"cl_docket_id": "1", "parent_cl_docket_id": "2", "confidence_tier": "high",
                    "group_size": 2, "edition": "2026-06-30", "rule_version": "2", "match_basis": "same_caption"}
        self.source = self.root / "prior.parquet"
        pq.write_table(pa.Table.from_pylist([self.raw], schema=reader.processing_schema("court_docket_groups")), self.source)
        self.pin = member(self.source)
        self.key = "generations/court-docket-groups/" + "a" * 64
        witness = {"source_id": self.key + "/court_docket_groups.parquet", "sha256": self.pin["sha256"],
                   "source_uri": None, "locator": None, "body_version": None}
        _, request = fixture(self.root, witness=witness)
        self.restored = reader.restore(request)
        self.restored = plain(self.restored)
        self.prior = {"family": "court-docket-groups", "artifactDigest": "sha256:" + "a" * 64,
                      "tableId": "court_docket_groups", "recordUrl": "https://example/prior", "rows": 1,
                      "members": [{"key": "court_docket_groups.parquet", "sha256": self.pin["sha256"],
                                   "byteSize": self.pin["byteSize"], "rows": 1}]}
        self.descriptor = {"sha256": self.pin["sha256"], "byteSize": self.pin["byteSize"], "rows": 1,
                           "columns": self.restored["processingSchema"]}
        self.owner = {"family": "court-docket-groups", "artifactDigest": "sha256:" + "b" * 64, "rows": 1,
                      "artifact": {"spec": {"readSnapshot": {"families": {"court-docket-groups": {
                          "artifactDigest": self.prior["artifactDigest"], "prefix": self.key,
                          "tables": {"court_docket_groups.parquet": self.descriptor}}}}}}}
        self.parent_result = {"family": "courtlistener", "artifactDigest": "original-court-parent", "rows": 1}
        test = self

        class Inputs:
            def producing(self, dataset, child):
                return test.owner

            def table(self, family, generation, dataset):
                test.assertEqual(generation, test.prior["artifactDigest"])
                return test.prior

            def artifact(self, family, generation):
                return test.key, {}, [{"objectKey": "court_docket_groups.parquet", "role": "table",
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
        self.relation = {"mode": "recorded-parent", "table": "court_dockets", "keys": [["cl_docket_id", "cl_docket_id"]]}

    def run_parent(self):
        return self.adapter.parent("court_docket_groups", self.owner, self.relation)

    def test_uses_witnessed_prior_parent_not_snapshot_current_dockets(self):
        self.owner["artifact"]["spec"]["readSnapshot"]["families"]["courtlistener"] = {"artifactDigest": "newer-unrelated"}
        result = self.run_parent()
        self.assertEqual(result["artifactDigest"], "original-court-parent")
        self.assertEqual(result["_additionalParentEvidence"]["matchedSourceRows"], 1)
        self.assertEqual(result["_additionalParentEvidence"]["sourceTable"], self.prior)

    def test_changed_snapshot_descriptor_is_refused(self):
        self.descriptor["sha256"] = "sha256:" + "c" * 64
        with self.assertRaisesRegex(ValueError, "recorded source snapshot"):
            self.run_parent()

    def test_missing_or_unrelated_accepted_witness_is_refused(self):
        for value in ([], [{"rows": 1, "witnesses": []}], [{"rows": 2, "witnesses": []}]):
            with self.subTest(value=value):
                self.restored["acceptedWitnessGroups"] = value
                with self.assertRaisesRegex(ValueError, "receipts do not all witness"):
                    self.run_parent()

    def test_changed_restored_row_or_multiplicity_is_refused(self):
        path = Path(self.restored["urls"][0])
        for rows in ([{**self.raw, "edition": "2027"}], [self.raw, self.raw]):
            with self.subTest(rows=len(rows)):
                pq.write_table(pa.Table.from_pylist(rows, schema=reader.processing_schema("court_docket_groups")), path)
                with self.assertRaisesRegex(ValueError, "rows differ"):
                    self.run_parent()

    def test_missing_prior_declared_parent_still_refuses(self):
        self.adapter.inputs.parent = lambda *args: (_ for _ in ()).throw(ValueError("Producing release does not pin this coverage parent"))
        with self.assertRaisesRegex(ValueError, "does not pin"):
            self.run_parent()

    def test_wrong_relationship_is_refused(self):
        self.relation["keys"] = [["parent_cl_docket_id", "cl_docket_id"]]
        with self.assertRaisesRegex(ValueError, "does not pin"):
            self.run_parent()


if __name__ == "__main__":
    unittest.main()
