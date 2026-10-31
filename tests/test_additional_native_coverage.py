"""Small maintained-writer fixtures for the additional Sources coverage reader."""
import copy
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import additional_native_coverage as adapter
import native_legislative_coverage as native
import restore_additional_coverage as reader
from coverage_dimensions import scan_dimension
from regulation_coverage import scan_special
from spicy_regs.court_receipts import local_receipt_selection, write_court_rows
from spicy_regs.congress_receipts import write_congress_dataset
from spicy_regs.etl_receipts import combine_receipts


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
        # One interpreter runs every bridge; the removed per-reader variables are ignored.
        env = {'SPICYGOV_COVERAGE_PYTHON': sys.executable,
               'SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE': '/nonexistent'}
        navigation = ('documents', 'document_attributes', 'federal_register', 'fr_docket_links', 'nominations', 'roll_call_votes', 'comment_periods', 'rule_targets')
        additional = ('court_opinions', 'court_dockets', 'amendments')
        for dataset in navigation + additional:
            script = 'restore_source_navigation_coverage.py' if dataset in navigation else 'restore_additional_coverage.py'
            for args in ([], ['--schema', dataset]):
                with self.subTest(dataset=dataset, args=args), patch.dict(os.environ, env), patch.object(
                        native.subprocess, 'run', return_value=type('Result', (), {'stdout':'{}', 'stderr':''})()) as run:
                    self.assertEqual(adapter.bridge(args, {'dataset':dataset} if not args else None), {})
                    self.assertEqual(run.call_args.args[0][0], sys.executable)
                    self.assertEqual(Path(run.call_args.args[0][1]).name, script)
                    expected = {'documents': 900, 'document_attributes': 900, 'comment_periods': 900, 'federal_register': 900, 'fr_docket_links': 900, 'court_opinions': 1800}
                    self.assertEqual(run.call_args.kwargs['timeout'], expected.get(dataset, 300) if not args else 300)
        self.assertEqual(adapter.allowances.scan_seconds('document_attributes', True), 1500)
        self.assertEqual(adapter.allowances.scan_seconds('document_attributes', False), 900)
        self.assertEqual(adapter.allowances.scan_seconds('comment_periods', True), 1500)
        self.assertEqual(adapter.allowances.scan_seconds('comment_periods', False), 900)

    def test_group_receipt_fields_restore_with_exact_witness(self):
        raw, request = fixture(self.root)
        result = reader.restore(request)
        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [raw])
        self.assertNotIn("edition", dict(result["nativeSchema"]))
        self.assertIn("edition", dict(result["processingSchema"]))
        self.assertEqual(result["acceptedWitnessGroups"][0]["rows"], 1)
        self.assertEqual(result["generationId"], "selected")

    def test_bulk_court_coverage_restores_editions_origins_and_exact_literals(self):
        cases = {
            "court_citation_map": {"citing_opinion_id": "10", "cited_opinion_id": "20",
                                   "depth": "003", "dump_date": "2026-09-30"},
            "court_citations": {"citation_id": "1", "cluster_id": "42", "reporter": "U.S.",
                                "date_created": "2026-09-01 00:00:00+00", "dump_date": "2026-09-30"},
            "court_parentheticals": {"parenthetical_id": "1", "described_opinion_id": "10",
                                     "describing_opinion_id": "20", "score": "0.5000",
                                     "dump_date": "2026-09-30"},
            "court_opinion_clusters": {"cluster_id": "42", "cl_docket_id": "40",
                                       "date_filed": "2026-09-30", "date_filed_is_approximate": "f",
                                       "court_is_federal": "t", "citation_count": "003",
                                       "source": "publisher literal", "ingest_source": "search"},
            "court_opinions": {"opinion_id": "10", "cluster_id": "42", "page_count": "003",
                               "author_str": 'José "Exact"\\literal', "per_curiam": "f",
                               "dump_date": "2026-09-30"},
        }
        policies = json.loads((Path(__file__).resolve().parents[1] /
                               "content/coverage-definitions/regulation.json").read_text())["tables"]
        prepared = {}
        for dataset, values in cases.items():
            raw = dict.fromkeys(reader.LEGACY_COLUMNS[dataset])
            raw.update(values)
            prepared[dataset] = fixture(self.root / dataset, dataset, raw)
        citation_datasets = {"court_citation_map", "court_citations", "court_parentheticals"}
        citation_receipts = combine_receipts(
            [Path(request["receipts"]["path"]) for dataset, (_, request) in prepared.items()
             if dataset in citation_datasets], self.root / "combined-citations.parquet")
        for dataset in cases:
            with self.subTest(dataset=dataset):
                raw, request = prepared[dataset]
                if dataset in citation_datasets:
                    request["receipts"] = member(citation_receipts)
                policy = policies[dataset]
                native = plain(reader.description(dataset))["nativeSchema"]
                selected = {"kind": "generation", "family": policy["family"], "columns": native}
                effective = adapter.variant(dataset, selected, policy)
                self.assertTrue(effective["_additionalNativeProcessing"])
                self.assertEqual(effective["processingSchema"], policy["schema"])
                # These coverage axes use restored source fields; only the
                # separate inherited-parent route needs witness enumeration.
                with (patch.object(reader, "read_attempts", side_effect=AssertionError("unused witness scan")),
                      patch.object(reader, "select_receipts", side_effect=AssertionError("unused receipt copy"))):
                    result = reader.restore(request)
                self.assertEqual(result["rows"], 1)
                self.assertEqual(result["acceptedWitnessGroups"], [])
                self.assertEqual(result["selection"], {key: request[key] for key in ("subjects", "receipts")})
                self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [raw])
                table = {"members": [{"url": result["urls"][0]}], "rows": 1,
                         "publishedAt": "2026-10-19T00:00:00Z"}
                measured = {}
                with duckdb.connect() as conn:
                    conn.execute("SET TimeZone='UTC'")
                    for dim in policy["dimensions"]:
                        value = (scan_special(conn, dataset, table, dim, None) if dim.get("special") else
                                 scan_dimension(conn, result["urls"], 1, dim))
                        self.assertEqual(value["placedRows"] + value["unplacedRows"], 1)
                        measured[dim["id"]] = value
                if dataset == "court_opinion_clusters":
                    self.assertEqual(measured["decision-filing-dates"]["buckets"], {"2026-09": 1})
                    self.assertEqual(measured["retained-origins"]["buckets"], {'["search"]': 1})
                else:
                    self.assertEqual(measured["courtlistener-bulk-editions"]["buckets"], {'["2026-09-30"]': 1})
                altered = copy.deepcopy(request)
                altered["destination"] += "-bad"
                altered["receipts"]["sha256"] = "sha256:" + "0" * 64
                with self.assertRaisesRegex(ValueError, "SHA-256 changed"):
                    reader.restore(altered)
                self.assertFalse(Path(altered["destination"]).exists())

    def test_bulk_only_change_invalidates_description_and_restoration_identity(self):
        raw, request = fixture(self.root)
        described_before = reader.description(request["dataset"])
        restored_before = reader.restore(request)
        maintained_before = reader.MAINTAINED.implementation_identity()
        read_bytes = Path.read_bytes
        bulk = reader.PACKAGE / "etl_bulk.py"

        def changed_bytes(path):
            data = read_bytes(path)
            return data + b"\n# bulk dependency changed\n" if path == bulk else data

        changed_request = {**request, "destination": str(self.root / "restored-again")}
        with patch.object(Path, "read_bytes", changed_bytes):
            described_after = reader.description(request["dataset"])
            restored_after = reader.restore(changed_request)
            self.assertNotEqual(reader.MAINTAINED.implementation_identity(), maintained_before)
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
        with patch.object(reader.MAINTAINED, "admission_identity", return_value="sha256:" + "a" * 64):
            after = reader.description("court_docket_groups")
        self.assertNotEqual(before.pop("implementationSha256"), after.pop("implementationSha256"))
        self.assertEqual(before, after)

    def test_native_bridge_runs_the_packaged_reader_end_to_end(self):
        from spicy_regs.legislative_documents import field_registry
        from spicy_regs.legislative_receipts import write_legislative_outputs
        fields = field_registry()["bill_versions"]["fields"]
        raw = {field["name"]: None for field in fields}
        raw.update(bill_id="hr1-119", version_code="is", source="GovInfo original label",
                   version_date="2025-01-03")
        source = self.root / "bill_versions.parquet"
        pq.write_table(pa.Table.from_pylist([raw], schema=pa.schema(
            [(field["name"], pa.string()) for field in fields])), source)
        generated = self.root / "native"
        manifest = write_legislative_outputs([source], generated, generation_id="selected-bill")
        request = {"dataset": "bill_versions", "generationId": "selected-bill",
                   "subjects": [member(generated / name) for name in manifest["subjects"]["bill_versions"]],
                   "receipts": member(generated / "etl_receipts.parquet"),
                   "destination": str(self.root / "direct")}
        direct = plain(reader.MAINTAINED.restore(request))
        with patch.dict(os.environ, {"SPICYGOV_COVERAGE_PYTHON": sys.executable}):
            described = native.bridge(["--schema", "bill_versions"])
            request["destination"] = str(self.root / "selected")
            selected = native.bridge(request=request)
        identity = reader.MAINTAINED.implementation_identity("bill_versions")
        self.assertEqual(described["implementationSha256"], identity)
        self.assertEqual(selected["implementationSha256"], identity)
        for result in (direct, selected):
            self.assertEqual(pq.read_table(result.pop("urls")[0]).to_pylist(), [raw])
            for processing_member in result["processingMembers"]:
                processing_member.pop("path")
        self.assertEqual(direct, selected)

    def test_court_receipts_refuse_earlier_policy_and_missing_field(self):
        _, request = fixture(self.root)
        path = Path(request["receipts"]["path"])
        original = pq.read_table(path)
        cases = {
            "policy": (original.set_column(original.schema.get_field_index("policy_version"), "policy_version",
                                           pa.array(["court-docket-groups/0"] * original.num_rows, type=pa.string())),
                       "Unsupported coverage receipt policy"),
            "field": (original.drop_columns(["policy_version"]), "Unsupported coverage receipt format"),
        }
        for name, (table, message) in cases.items():
            with self.subTest(name=name):
                pq.write_table(table, path)
                altered = {**request, "receipts": member(path), "destination": str(self.root / ("refused-" + name))}
                with self.assertRaisesRegex(ValueError, message):
                    reader.restore(altered)
                self.assertFalse(Path(altered["destination"]).exists())

    def test_court_restore_hashes_and_scans_receipts_once(self):
        _, request = fixture(self.root)
        with (patch.object(reader.MAINTAINED, "checked_member", wraps=reader.MAINTAINED.checked_member) as hashed,
              patch.object(reader.MAINTAINED, "current_receipts", wraps=reader.MAINTAINED.current_receipts) as scanned):
            reader.restore(request)
        self.assertEqual([c.args[0]["path"] for c in hashed.call_args_list].count(request["receipts"]["path"]), 1)
        self.assertEqual(scanned.call_count, 1)

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

    def test_empty_generation_hash_size_and_subject_are_refused(self):
        _, request = fixture(self.root)
        for change in ("generation", "hash", "size", "subject"):
            with self.subTest(change=change):
                altered = copy.deepcopy(request)
                altered["destination"] += "-" + change
                if change == "generation":
                    altered["generationId"] = ""
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
            # A table still published in the flat reviewed shape is measured directly: no reader.
            self.assertIs(adapter.variant("court_docket_groups", {**table, "columns": policy["schema"]}, policy), policy)
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




class CourtFamilyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        values = {
            "court_citation_map": {"citing_opinion_id": "10", "cited_opinion_id": "20", "depth": "003"},
            "court_citations": {"citation_id": "1", "cluster_id": "42", "reporter": "U.S."},
            "court_parentheticals": {"parenthetical_id": "1", "described_opinion_id": "10",
                                     "describing_opinion_id": "20", "score": "0.5000"},
        }
        self.raw, self.requests = {}, []
        for dataset, extra in values.items():
            raw = {**dict.fromkeys(reader.LEGACY_COLUMNS[dataset]), **extra, "dump_date": "2026-09-30"}
            self.raw[dataset], request = fixture(self.root / dataset, dataset, raw)
            self.requests.append(request)
        self.receipt = combine_receipts([Path(r["receipts"]["path"]) for r in self.requests],
                                        self.root / "family-receipts.parquet")
        for request in self.requests:
            request["receipts"] = member(self.receipt)

    def test_court_resources_configure_real_admission_and_preserve_outer_scope(self):
        bulk = reader.etl_bulk
        connect = bulk.duckdb.connect
        self.assertIsNone(bulk._limits.get())
        for grouped in (False, True):
            for explicit in (False, True):
                connections = []

                def observed_connection(*args, **kwargs):
                    connections.append((bulk._limits.get(), kwargs["config"]))
                    return connect(*args, **kwargs)

                requests = [{**r, "destination": r["destination"] + f"-{grouped}-{explicit}"} for r in self.requests]
                scope = bulk.bulk_limits(threads=2, memory_limit="512MB", require_bulk=True) if explicit else nullcontext()
                with self.subTest(grouped=grouped, explicit=explicit), scope:
                    previous = bulk._limits.get()
                    with (patch.object(bulk.duckdb, "connect", side_effect=observed_connection),
                          patch.object(bulk, "_scan", wraps=bulk._scan) as scans):
                        results = reader.restore_court_family(requests) if grouped else [reader.restore(requests[0])]
                    self.assertIs(bulk._limits.get(), previous)
                    self.assertEqual(len(connections), 1)
                    limits, config = connections[0]
                    if explicit:
                        self.assertIs(limits, previous)
                    else:
                        self.assertEqual(limits, bulk.BulkLimits(1, "4GB", False))
                    self.assertEqual(config["threads"], 2 if explicit else 1)
                    self.assertEqual(config["memory_limit"], "512MB" if explicit else "4GB")
                    self.assertEqual(config["max_temp_directory_size"], "32GB")
                    self.assertTrue(scans.call_count)
                    self.assertTrue(all(call.kwargs["bounded_insert"] for call in scans.call_args_list))
                    for request, result in zip(requests, results):
                        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [self.raw[request["dataset"]]])
                self.assertIsNone(bulk._limits.get())

    def test_court_resource_failure_restores_scope_without_weakening_require_bulk(self):
        from spicy_regs import court_restore

        bulk = reader.etl_bulk
        self.assertIsNone(bulk._limits.get())
        for grouped in (False, True):
            for explicit in (False, True):
                requests = [{**r, "destination": r["destination"] + f"-failure-{grouped}-{explicit}"} for r in self.requests]
                scope = bulk.bulk_limits(threads=2, memory_limit="512MB", require_bulk=True) if explicit else nullcontext()
                failure = bulk.NotBulkEligible("forced fallback") if explicit else ValueError("forced restore failure")
                observed = []

                def refused(*args):
                    observed.append(bulk._limits.get())
                    raise failure

                with self.subTest(grouped=grouped, explicit=explicit), scope:
                    previous = bulk._limits.get()
                    with patch.object(court_restore, "materialize", side_effect=refused):
                        with self.assertRaisesRegex(ValueError, "reference fallback disabled" if explicit else "forced restore failure"):
                            if grouped:
                                reader.restore_court_family(requests)
                            else:
                                reader.restore(requests[0])
                    self.assertIs(bulk._limits.get(), previous)
                    self.assertEqual(len(observed), 1)
                    if explicit:
                        self.assertIs(observed[0], previous)
                    else:
                        self.assertEqual(observed[0], bulk.BulkLimits(1, "4GB", False))
                    self.assertFalse(any(list(Path(r["destination"]).glob("*.parquet")) for r in requests))
                    if grouped:
                        self.assertFalse(any(Path(r["destination"]).exists() for r in requests))
                self.assertIsNone(bulk._limits.get())

    def test_carried_tables_from_distinct_producers_keep_ordinary_restoration(self):
        from types import SimpleNamespace

        owners = {dataset: {"family": "court-citations", "artifactDigest": dataset} for dataset in self.raw}
        inputs = SimpleNamespace(producing=lambda dataset, table: owners[dataset])
        held = adapter.AdditionalInputs(inputs, self.root / "adapter")
        with patch.object(adapter, "bridge", side_effect=AssertionError("must not group distinct producers")):
            held.restore_court_family(dict.fromkeys(self.raw, {}))
        self.assertEqual(held.cache, {})
        # The unchanged restore entry cannot use a group result for these owners.
        with patch.object(held, "_request", side_effect=ValueError("ordinary selected request")) as ordinary:
            for dataset, owner in owners.items():
                with self.assertRaisesRegex(ValueError, "ordinary selected request"):
                    held.restore(dataset, owner)
        self.assertEqual(ordinary.call_count, 3)

    def test_complete_family_keeps_one_admission_and_exact_source_values(self):
        from spicy_regs import conversion_reads
        with (patch.object(reader.MAINTAINED, "checked_member", wraps=reader.MAINTAINED.checked_member) as hashed,
              patch.object(conversion_reads.etl_bulk, "_check_receipts",
                           wraps=conversion_reads.etl_bulk._check_receipts) as admitted):
            results = reader.restore_court_family(self.requests)
        self.assertEqual(admitted.call_count, 1)
        self.assertEqual(set(admitted.call_args.args[3]), set(self.raw))
        self.assertEqual([c.args[0]["path"] for c in hashed.call_args_list].count(self.requests[0]["receipts"]["path"]), 1)
        for request, result in zip(self.requests, results):
            expected = reader.restore({**request, "destination": request["destination"] + "-standalone"})
            self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [self.raw[request["dataset"]]])
            self.assertEqual(pq.read_table(result["urls"][0]), pq.read_table(expected["urls"][0]))
            self.assertEqual(result["selection"], expected["selection"])
            self.assertEqual(result["policy"], expected["policy"])
            self.assertEqual(result["acceptedWitnessGroups"], [])

    def test_row_fallback_preserves_bulk_requirement_and_visible_warning(self):
        from spicy_regs import court_restore
        from loguru import logger

        for required in ("true", "invalid", "false"):
            with (self.subTest(required=required),
                  patch.dict(os.environ, SPICY_REGS_REQUIRE_BULK=required),
                  patch.object(court_restore, "materialize",
                               side_effect=reader.court_receipts.etl_bulk.NotBulkEligible("fixture")),
                  patch.object(logger, "warning") as warning):
                if required != "false":
                    with self.assertRaisesRegex(ValueError, "reference fallback disabled"):
                        reader.restore_court_family(self.requests)
                    self.assertFalse(any(Path(r["destination"]).exists() for r in self.requests))
                    warning.assert_not_called()
                else:
                    results = reader.restore_court_family(self.requests)
                    self.assertEqual(warning.call_count, len(self.requests))
                    for request, result, call in zip(self.requests, results, warning.call_args_list):
                        dataset = request["dataset"]
                        self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), [self.raw[dataset]])
                        self.assertEqual(call.args[1:4], ("court restore", dataset, " rows=1"))

    def test_invalid_family_selection_refuses_before_creating_outputs(self):
        for change in ("missing", "duplicate", "generation", "receipt", "subject", "destination"):
            with self.subTest(change=change):
                requests = copy.deepcopy(self.requests)
                if change == "missing":
                    requests.pop()
                elif change == "duplicate":
                    requests[-1] = requests[0]
                elif change == "generation":
                    requests[-1]["generationId"] = "other"
                elif change == "receipt":
                    for request in requests:
                        request["receipts"]["sha256"] = "sha256:" + "0" * 64
                elif change == "subject":
                    requests[-1]["subjects"][0]["sha256"] = "sha256:" + "0" * 64
                else:
                    requests[-1]["destination"] = requests[0]["destination"]
                with self.assertRaises(ValueError):
                    reader.restore_court_family(requests)
                self.assertFalse(any(Path(r["destination"]).exists() for r in self.requests))

    def test_full_family_refuses_missing_duplicate_and_unsupported_receipt(self):
        original = pq.read_table(self.receipt)
        for change in ("missing", "duplicate", "policy", "generation"):
            with self.subTest(change=change):
                rows = original.to_pylist()
                if change == "missing":
                    rows.pop()
                elif change == "duplicate":
                    rows.append(rows[-1])
                else:
                    rows[-1]["policy_version" if change == "policy" else "generation_id"] = "unknown" if change == "policy" else ""
                pq.write_table(pa.Table.from_pylist(rows, schema=original.schema), self.receipt)
                requests = [{**r, "receipts": member(self.receipt)} for r in self.requests]
                with self.assertRaises(ValueError):
                    reader.restore_court_family(requests)
                self.assertFalse(any(Path(r["destination"]).exists() for r in self.requests))

    def test_late_mutation_and_failed_table_remove_all_partial_outputs(self):
        from spicy_regs import court_restore
        materialize = court_restore.materialize
        subject = Path(self.requests[-1]["subjects"][0]["path"])
        saved = subject.read_bytes()
        for failure in ("mutation", "table"):
            calls = []

            def change(reader_, dataset, schema, destination):
                calls.append(dataset)
                if failure == "table" and len(calls) == 2:
                    raise ValueError("failed table")
                value = materialize(reader_, dataset, schema, destination)
                if failure == "mutation" and len(calls) == 1:
                    subject.write_bytes(saved + b"changed")
                return value

            with self.subTest(failure=failure), patch.object(court_restore, "materialize", side_effect=change):
                with self.assertRaisesRegex(ValueError, "changed during restoration|failed table"):
                    reader.restore_court_family(self.requests)
            self.assertFalse(any(Path(r["destination"]).exists() for r in self.requests))
            subject.write_bytes(saved)

    def test_actual_bridge_and_coverage_use_one_shared_receipt_stage(self):
        import shutil
        from coverage_inputs import CoverageInputs
        from coverage_scan import validate_counts, validate_members
        from spicy_regs.court_receipts import build_court_generation

        directory = self.root / "generation"
        artifact = build_court_generation(directory, family="court-citations",
                                         files=[Path(r["subjects"][0]["path"]) for r in self.requests])
        root = plain(artifact.root)
        prefix = "generations/court-citations/" + root["artifactDigest"][7:] + "/"

        class LocalInputs(CoverageInputs):
            def fetch(self, key):
                if not key.startswith(prefix):
                    raise AssertionError("unexpected nonlocal input: " + key)
                return (directory / key[len(prefix):]).read_bytes()

        inputs = LocalInputs()
        definitions = json.loads((Path(__file__).resolve().parents[1] /
                                  "content/coverage-definitions/regulation.json").read_text())["tables"]
        items = []
        for dataset in self.raw:
            owner = inputs.table("court-citations", root["artifactDigest"], dataset)
            table = {**owner, "kind": "generation", "columns": plain(reader.description(dataset))["nativeSchema"]}
            policy = adapter.variant(dataset, table, {**definitions[dataset], "_scanner": "regulation"})
            items.append((dataset, table, policy))

        def download(key, destination):
            if not key.startswith(prefix):
                raise AssertionError("unexpected nonlocal download: " + key)
            shutil.copyfile(directory / key[len(prefix):], destination)

        with (patch.dict(os.environ, {"SPICYGOV_NATIVE_COVERAGE_CACHE": str(self.root / "cache"),
                                      "SPICYGOV_COVERAGE_PYTHON": sys.executable}),
              patch.object(native, "verify_file", wraps=native.verify_file) as hashed):
            result = adapter.scan_court_family(items, inputs=inputs, download=download,
                                              validate_members=validate_members, validate_counts=validate_counts)
        receipt_hash = member(directory / "etl_receipts.parquet")["sha256"]
        # Initial acquisition validates once, then staging validates once. No
        # second/third table staging rehash; the bridge owns its separate check.
        self.assertEqual(sum(c.args[0]["sha256"] == receipt_hash for c in hashed.call_args_list), 2)
        self.assertEqual(set(result), set(self.raw))
        for dataset, value in result.items():
            self.assertEqual(value["processingEvidence"]["rows"], 1)
            for dim in value["dimensions"]:
                self.assertEqual(dim["rows"], 1)
                self.assertEqual(dim["placedRows"], 1)
                self.assertEqual(dim["granularity"], "category")
                self.assertEqual(dim["buckets"], {'["2026-09-30"]': 1})
        self.assertFalse(list(Path.cwd().glob("spicygov-court-family-*")))


if __name__ == '__main__':
    unittest.main()
