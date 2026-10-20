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
from coverage_inputs import CoverageInputs
from coverage_scan import validate_counts, validate_members
from congress_coverage import _member_service
import duckdb
from spicy_regs.congress_receipts import write_congress_dataset
from spicy_regs.congress_subjects import INPUT_COLUMNS
from spicy_regs.etl_receipts import ReceiptContext, write_dataset
from spicy_regs.transforms.government_receipts import POLICIES
from spicy_regs.transforms.government_source_shapes import map_subject


def member(path):
    return {"path":str(path.resolve()), "byteSize":path.stat().st_size, "sha256":"sha256:"+hashlib.sha256(path.read_bytes()).hexdigest()}


class SourceCoverageTests(unittest.TestCase):
    def test_bridge_selects_a_script_by_dataset_under_the_one_backend_interpreter(self):
        # The removed per-reader variables are ignored: one interpreter, two spicygov adapters.
        env = {"SPICYGOV_COVERAGE_PYTHON": sys.executable, "SPICYGOV_SOURCE_NAVIGATION_COVERAGE_BRIDGE": "/nonexistent"}
        navigation, additional = "restore_source_navigation_coverage.py", "restore_additional_coverage.py"
        with patch.dict("os.environ", env), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([],0,stdout="{}")) as run:
            def selected(*args, **kwargs):
                adapter.bridge(*args, **kwargs)
                self.assertEqual(run.call_args.args[0][0], sys.executable)
                return Path(run.call_args.args[0][1]).name
            for name in reader.DATASETS:
                self.assertEqual(selected(["--schema",name]), navigation, name)
                self.assertEqual(selected(request={"dataset":name}), navigation, name)
            self.assertEqual(selected(["--verify-artifacts"],request=[{"spec":{"family":"fcc-filings"}}]), navigation)
            for name in ("amendments", "court_dockets", "court_opinions"):
                self.assertEqual(selected(["--schema",name]), additional, name)
            self.assertEqual(selected(["--verify-artifacts"],request=[{"spec":{"family":"amendments"}}]), additional)

    def test_members_service_uses_restored_terms_from_the_same_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            members = root / "members.parquet"
            terms = root / "member_terms.parquet"
            pq.write_table(pa.Table.from_pylist([{"bioguide_id":"A000001"}]), members)
            pq.write_table(pa.Table.from_pylist([
                {"bioguide_id":"A000001", "term_index":0, "term_start":"2000-01-01", "term_end":"2000-02-01"},
                {"bioguide_id":"A000001", "term_index":1, "term_start":"2001-01-01", "term_end":"2001-02-01"},
            ]), terms)
            child = {"family":"members", "artifactDigest":"selected-generation", "tableId":"members", "rows":1,
                     "urls":[str(members)], "members":[{"url":str(members)}], "artifact":{"spec":{"etlReceipts":{"policies":[]}}}}
            parent = {"family":"members", "artifactDigest":"selected-generation", "tableId":"member_terms", "rows":2,
                      "urls":[str(terms)], "recordUrl":"selected-parent", "members":[]}
            class Inputs(CoverageInputs):
                def producing(self, table_id, table):
                    return child
                def table(self, family, generation, table_id, expected=None):
                    if (family, generation, table_id) != ("members", "selected-generation", "member_terms"):
                        raise ValueError("Parent lookup left the selected generation")
                    return parent
            selected = adapter.AdditionalInputs(Inputs(), root / "private")
            dim = json.loads((Path(reader.ROOT) / "content/coverage-definitions/congress.json").read_text())["tables"]["members"]["dimensions"][1]
            # Keep the real same-generation resolver and service scanner. Receipt
            # restoration is checked separately by the native fixtures above.
            with patch.object(selected, "restore", side_effect=lambda dataset, owner: owner) as restore, duckdb.connect() as conn:
                measured = _member_service(conn, child, dim, selected)
            restore.assert_called_once_with("member_terms", parent)
            self.assertEqual(measured["parent"]["artifactDigest"], "selected-generation")
            self.assertEqual(measured["placedRows"], 1)
            self.assertIn("2000-01", measured["buckets"])
            self.assertIn("2001-01", measured["buckets"])
            self.assertNotIn("2000-06", measured["buckets"])

    def test_new_subjects_preserve_old_coverage_facts_and_exact_generation(self):
        for dataset in ("committee_meetings", "nominations", "house_communications", "members", "member_terms", "member_party_affiliations", "fcc_filings"):
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
                    elif dataset == "member_terms":
                        raw.update(bioguide_id="A000001", term_index="0", term_type="rep", term_start="2000-01-01", term_end="2001-01-01")
                    elif dataset == "member_party_affiliations":
                        raw.update(bioguide_id="A000001", input_sha256="sha256:"+"0"*64, term_index="0", affiliation_index="0", party="D", term_party="D", affiliation_start="2000-01-01", affiliation_end="2001-01-01", start_status="stated", end_status="stated")
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
                carried = copy.deepcopy(request)
                carried["generationId"] = "next-selection"
                carried["destination"] += "-carried"
                restored = reader.restore(carried)
                self.assertEqual(pq.read_table(restored["urls"][0]).to_pylist(),
                                 pq.read_table(facts["urls"][0]).to_pylist())
                wrong = copy.deepcopy(request)
                wrong["generationId"] = ""
                wrong["destination"] += "-wrong"
                with self.assertRaises(ValueError):
                    reader.restore(wrong)
                changed = copy.deepcopy(request)
                changed["destination"] += "-changed"
                changed["subjects"][0]["sha256"] = "sha256:" + "0" * 64
                with self.assertRaises(ValueError):
                    reader.restore(changed)


class MemberVoteCoverageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.dataset = "member_vote_terms"
        self.definition = json.loads((reader.ROOT / "content/coverage-definitions/congress.json").read_text())["tables"][self.dataset]

    def row(self, key, day="2025-01-03", status="half_open", index="00"):
        row = dict.fromkeys(INPUT_COLUMNS[self.dataset])
        row.update(vote_id="119-house-1-1", member_key=key, chamber="house",
                   vote_day=day, term_match=status, term_index=index)
        return row

    def request(self, rows, name="fixture"):
        root = self.root / name
        root.mkdir()
        source = root / "source.parquet"
        pq.write_table(pa.Table.from_pylist(rows, schema=reader.arrow_schema(self.dataset)), source)
        subject, receipts = write_congress_dataset(source, root / "native", dataset=self.dataset, generation_id="selected")
        return {"dataset": self.dataset, "generationId": "selected", "subjects": [member(subject)],
                "receipts": member(receipts), "destination": str(root / "restored")}

    def scan(self, result, *, dataset="member_vote_terms", special=None):
        # Match the private bridge's JSON boundary (schema pairs become lists).
        result = json.loads(json.dumps(result))
        rows = result["rows"]
        native = result["selection"]["subjects"][0]
        table = {"family": "member-vote-terms", "kind": "generation", "rows": rows,
                 "artifactDigest": "sha256:" + "a" * 64, "columns": result["nativeSchema"],
                 "members": [{"url": native["path"], "rows": rows, "sha256": native["sha256"], "byteSize": native["byteSize"]}]}
        definition = copy.deepcopy(self.definition)
        if special is not None:
            definition["dimensions"][-1]["special"] = special
        policy = {**definition, "_scanner": "congress", "_additionalNativeProcessing": True,
                  "_additionalNativeDataset": dataset,
                  "schema": result["nativeSchema"], "processingSchema": result["processingSchema"],
                  "restorationImplementationSha256": result["implementationSha256"]}
        class Inputs:
            def producing(self, dataset, selected):
                return selected
        # Admission is real in restore(); this local seam supplies that retained
        # result without publishing a synthetic generation or repeating admission.
        with patch.object(adapter.AdditionalInputs, "restore", return_value={**table, "urls": result["urls"], "_coverageProcessing": result}), \
             patch.object(adapter, "describe", side_effect=lambda dataset: json.loads(json.dumps(reader.description(dataset)))):
            return adapter.scan_table(dataset, table, policy, validate_members=validate_members,
                                      validate_counts=validate_counts, inputs=Inputs())

    def test_member_vote_populations_keep_exact_literals_order_and_visible_groups(self):
        native = self.row("native")
        both_null = self.row("both-null", day=None, status=None, index=None)
        unmatched = self.row("unmatched", status="unmatched", index=None)
        unresolved = self.row("unresolved", day=None, status="unresolved_member", index=None)
        empty = self.row("empty", day="", status="", index=None)
        cases = {
            "mixed": ([unmatched, native, unresolved, both_null, self.row("unmatched-2", status="unmatched", index=None), empty],
                      [native, both_null], [("2025-01-03", "unmatched", 2), (None, "unresolved_member", 1), ("", "", 1)]),
            "native-only": ([native, both_null], [native, both_null], []),
            "all-unresolved": ([unmatched, unresolved, empty], [], [("2025-01-03", "unmatched", 1), (None, "unresolved_member", 1), ("", "", 1)]),
        }
        for name, (rows, expected, groups) in cases.items():
            with self.subTest(name=name):
                request = self.request(rows, name)
                with patch.object(reader, "MEMBER_VOTE_BATCH_ROWS", 2), \
                     patch.object(reader.MAINTAINED, "restore", wraps=reader.MAINTAINED.restore) as admission:
                    result = reader.restore(request)
                admission.assert_called_once_with(request)
                self.assertEqual(pq.read_table(result["urls"][0]).to_pylist(), expected)
                self.assertEqual(result["selection"], {k: request[k] for k in ("subjects", "receipts")})
                self.assertEqual(result["sourceObservations"], {
                    "totalRows": len(rows), "nativeRows": len(expected), "receiptOnlyRows": len(rows) - len(expected),
                    "groups": [{"voteDay": day, "termMatch": status, "rows": count} for day, status, count in groups]})
                self.assertEqual(result["rows"], pq.read_metadata(request["subjects"][0]["path"]).num_rows)
                self.assertEqual(result["processingMembers"], [member(Path(result["urls"][0]))])
                measured = self.scan(result)
                snapshot = measured["dimensions"][-1]
                self.assertEqual(snapshot["rows"], len(expected))
                self.assertEqual(snapshot["snapshot"]["facts"], [
                    {"label": "Restored source observations", "value": str(len(rows))},
                    {"label": "Published assignments", "value": str(len(expected))},
                    {"label": "Receipt-only observations", "value": str(len(rows) - len(expected))},
                    *[{"label": f"Receipt-only vote day {json.dumps(day)}; term match {json.dumps(status)}", "value": str(count)}
                      for day, status, count in groups]])
                self.assertEqual(snapshot["evidence"]["generationId"], "selected")
                self.assertEqual(snapshot["evidence"]["receipts"]["sha256"], request["receipts"]["sha256"])
                self.assertEqual(snapshot["evidence"]["implementationSha256"], result["implementationSha256"])
                self.assertEqual(measured["dimensions"][0]["buckets"], {"2025-01": 1} if expected else {})
                self.assertEqual(measured["dimensions"][1]["unplacedRows"], 1 if expected else 0)

    def test_member_vote_selected_input_refusals_remain(self):
        request = self.request([self.row("native"), self.row("unmatched", index=None)])
        for name in ("generation", "subject-hash", "receipt-hash", "receipt-size"):
            with self.subTest(name=name):
                bad = copy.deepcopy(request)
                bad["destination"] += "-" + name
                if name == "generation":
                    bad["generationId"] = ""
                elif name == "subject-hash":
                    bad["subjects"][0]["sha256"] = "sha256:" + "0" * 64
                elif name == "receipt-hash":
                    bad["receipts"]["sha256"] = "sha256:" + "0" * 64
                else:
                    bad["receipts"]["byteSize"] += 1
                with self.assertRaises(ValueError):
                    reader.restore(bad)
                self.assertFalse((Path(bad["destination"]) / "coverage-facts.parquet").exists())

    def test_member_vote_partition_refuses_count_drift_and_removes_provisional_output(self):
        request = self.request([self.row("native"), self.row("unmatched", index=None)])
        restored = reader.MAINTAINED.restore(request)
        facts = reader.description(self.dataset)
        for name in ("restored-total", "native-footer"):
            with self.subTest(name=name):
                bad = copy.deepcopy(restored)
                if name == "restored-total":
                    bad["rows"] += 1
                else:
                    # A truncated private stream still reconciles internally but
                    # must not replace a selected nonempty native subject.
                    source = self.root / "truncated.parquet"
                    pq.write_table(pa.Table.from_pylist([self.row("unmatched", index=None)], schema=reader.arrow_schema(self.dataset)), source)
                    bad.update(rows=1, urls=[str(source)])
                with self.assertRaises(ValueError):
                    reader.restore_member_vote_assignments(request, facts, bad)
                self.assertFalse((Path(request["destination"]) / "coverage-facts.parquet").exists())
                self.assertFalse((Path(request["destination"]) / "provisional-coverage-facts.parquet").exists())

    def test_member_vote_snapshot_refuses_missing_malformed_or_unreconciled_summary(self):
        result = reader.restore(self.request([self.row("native"), self.row("unmatched", index=None)]))
        for name in ("missing", "total", "native", "boolean", "group-boolean", "groups-total", "duplicate", "raw-type"):
            with self.subTest(name=name):
                bad = copy.deepcopy(result)
                summary = bad["sourceObservations"]
                if name == "missing":
                    del bad["sourceObservations"]
                elif name == "total":
                    summary["totalRows"] += 1
                elif name == "native":
                    summary.update(nativeRows=0, totalRows=1)
                elif name == "boolean":
                    summary["nativeRows"] = True
                elif name == "group-boolean":
                    summary["groups"][0]["rows"] = True
                elif name == "groups-total":
                    summary["groups"][0]["rows"] += 1
                elif name == "duplicate":
                    summary["groups"].append(copy.deepcopy(summary["groups"][0]))
                else:
                    summary["groups"][0]["voteDay"] = 20250103
                with duckdb.connect() as conn, self.assertRaises(ValueError):
                    adapter.member_vote_source_observations(conn, {"urls": bad["urls"], "_coverageProcessing": bad},
                                                           {"rows": result["rows"]}, self.definition["dimensions"][-1])
        for dataset, special in (("members", None), ("member_vote_terms", "unknown-observations")):
            with self.subTest(dataset=dataset, special=special), self.assertRaisesRegex(ValueError, "Unsupported"):
                self.scan(result, dataset=dataset, special=special)
        for option in ({"kind": "category"}, {"fields": ["vote_day"]}, {"method": "new-method"}):
            with self.subTest(option=option), duckdb.connect() as conn, self.assertRaisesRegex(ValueError, "Unsupported"):
                adapter.member_vote_source_observations(conn, {"urls": result["urls"], "_coverageProcessing": result},
                                                       {"rows": result["rows"]}, {**self.definition["dimensions"][-1], **option})


if __name__ == "__main__":
    unittest.main()
