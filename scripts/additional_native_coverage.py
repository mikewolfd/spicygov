"""Coverage for selected native amendments and courts; preserve exact source parents."""
from __future__ import annotations

import datetime
from functools import lru_cache
import hashlib
import importlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile

import duckdb

from coverage_dimensions import binding, definition_digest, scan_dimension, validate_definition
from coverage_inputs import CoverageInputs, inherit_unique
from native_legislative_coverage import ProcessingInputs, verify_file
from publication_census import BASE, inputs_fingerprint, rulemaking_tables

RULEMAKING_DATASETS = frozenset(("proceedings", "rule_targets", "comment_periods",
    "regulatory_agenda_items", "agenda_item_proceedings", "rulemaking_lifecycles",
    "lifecycle_events", "agency_lifecycle_stats"))

FAMILIES = {"amendments": "amendments", "court_dockets": "courtlistener",
            "court_docket_groups": "court-docket-groups",
            "court_opinion_pdf_extractions": "court-opinion-pdf-extractions",
            "court_opinions": "court-opinions"}
SOURCE_NAVIGATION_FAMILIES = {"committee_meetings":"committee-meetings", "nominations":"nominations", "house_communications":"house-communications", "members":"members", "member_terms":"members", "member_party_affiliations":"members", "fcc_filings":"fcc-filings",
    "committee_reports":"committee-reports", "report_sections":"committee-reports",
    "hearing_transcripts":"committee-reports", "hearing_bill_links":"committee-reports",
    "committees":"committee-rosters", "committee_assignments":"committee-rosters",
    "laws":"laws", "law_code_sections":"laws", "law_sections":"laws", "table3_records":"laws",
    "native_legal_references":"native-legal-references", "press_releases":"press-releases",
    "record_issues":"record-issues", "senate_expenditures":"senate-expenditures", "treaties":"treaties", "documents":"documents",
    "roll_call_votes":"roll-call-votes", "member_vote_terms":"member-vote-terms",
    "cfr_sections":"cfr-sections", "unified_agenda":"unified-agenda",
    "federal_register":"federal-register", "fr_docket_links":"fr-docket-links"}
FAMILIES.update(SOURCE_NAVIGATION_FAMILIES)
ROOT = Path(__file__).resolve().parents[1]


def bridge(args=(), request=None):
    dataset = args[1] if len(args) == 2 and args[0] == "--schema" else request.get("dataset") if isinstance(request, dict) else None
    source_navigation = dataset in SOURCE_NAVIGATION_FAMILIES or dataset in RULEMAKING_DATASETS or bool(args == ["--verify-artifacts"] and isinstance(request, list) and request and all(a.get("spec", {}).get("family") in SOURCE_NAVIGATION_FAMILIES.values() for a in request))
    prefix = "SPICYGOV_SOURCE_NAVIGATION" if source_navigation else "SPICYGOV_ADDITIONAL"
    script = os.environ.get(prefix + "_COVERAGE_BRIDGE")
    if not script or not Path(script).is_absolute() or not Path(script).is_file():
        raise ValueError("Additional native coverage requires the pinned restoration bridge")
    python = os.environ.get(prefix + "_COVERAGE_PYTHON", sys.executable)
    # The complete documents restore passed locally but exceeded five minutes
    # on the hosted runner. Keep the larger finite allowance scoped to it.
    timeout = 600 if dataset == "documents" and not args else 300
    result = subprocess.run([python, script, *args],
                            input=None if request is None else json.dumps(request),
                            text=True, capture_output=True, check=True, timeout=timeout)
    return json.loads(result.stdout.splitlines()[-1])


@lru_cache(maxsize=len(FAMILIES) + len(RULEMAKING_DATASETS))
def native_schema(dataset):
    return bridge(["--schema", dataset])


def variant(dataset, table, policy):
    if table.get("kind") == "rulemaking" and table.get("rulemakingSnapshot"):
        if dataset not in RULEMAKING_DATASETS or table.get("family") != "rulemaking":
            raise ValueError("Unreviewed native rulemaking snapshot dataset")
        description = native_schema(dataset)
        if (description.get("receiptOnly") is not False
                or description["processingSchema"] != policy["schema"]
                or table.get("columns") not in (None, description["nativeSchema"])):
            raise ValueError("Native rulemaking snapshot schema needs coverage review")
        return {**policy, "schema": description["nativeSchema"],
                "processingSchema": description["processingSchema"],
                "_additionalNativeProcessing": True,
                "restorationImplementationSha256": description["implementationSha256"]}
    if dataset not in FAMILIES or table.get("columns") == policy["schema"]:
        return policy
    if table["family"] != FAMILIES[dataset] or table.get("kind") != "generation":
        raise ValueError("Additional native coverage family changed")
    description = native_schema(dataset)
    if (description.get("receiptOnly") is not False
            or description["nativeSchema"] != table.get("columns")
            or description["processingSchema"] != policy["schema"]):
        raise ValueError("Published additional native schema needs coverage review")
    return {**policy, "schema": description["nativeSchema"],
            "processingSchema": description["processingSchema"],
            "_additionalNativeProcessing": True,
            "restorationImplementationSha256": description["implementationSha256"]}


def validate_native_implementations(policies):
    for dataset, policy in policies.items():
        if not policy.get("_additionalNativeProcessing"):
            continue
        description = bridge(["--schema", dataset])
        if (description.get("implementationSha256") != policy["restorationImplementationSha256"]
                or description.get("nativeSchema") != policy["schema"]
                or description.get("processingSchema") != policy["processingSchema"]
                or description.get("receiptOnly") is not False):
            raise ValueError("Additional native coverage reader changed during the build")


def measurement_revision(policy):
    names = ("additional_native_coverage.py", "restore_additional_coverage.py",
             "build-coverage-maps.py", "coverage_dimensions.py", "coverage_inputs.py",
             "publication_census.py", "collection_coverage.py", "congress_coverage.py",
             "regulation_coverage.py", "native_receipt_coverage.py", "native_legislative_coverage.py", "restore_source_navigation_coverage.py")
    value = hashlib.sha256(policy["restorationImplementationSha256"].encode())
    for name in names:
        data = (ROOT / "scripts" / name).read_bytes()
        value.update(len(data).to_bytes(8, "big"))
        value.update(data)
    return "sha256:" + value.hexdigest()


class AdditionalInputs:
    def __init__(self, inputs, directory, download=None):
        self.inputs, self.directory = inputs, Path(directory)
        self.staging = ProcessingInputs(inputs, directory, download)
        self.cache = {}
        self.parent_cache = {}
        self.snapshot_cache = {}

    def __getattr__(self, name):
        return getattr(self.inputs, name)

    def restore_snapshot(self, dataset, table):
        """Restore one subject from its selected rulemaking snapshot and receipts."""
        selected = table.get("rulemakingSnapshot", {})
        if not isinstance(selected, dict) or not isinstance(selected.get("pointer"), dict):
            raise ValueError("Missing selected native rulemaking snapshot")
        pointer = selected.get("pointer", {})
        key = pointer.get("manifest_key")
        # Validate the exact path before fetching; no mutable latest lookup.
        expected = "materialized/rulemaking/snapshots/" + str(table.get("snapshotId"))
        if (dataset not in RULEMAKING_DATASETS or table.get("kind") != "rulemaking"
                or not re.fullmatch(r"snapshot_[a-zA-Z0-9]+", str(table.get("snapshotId")))
                or table.get("family") != "rulemaking" or key != expected + "/manifest.json"
                or table.get("recordUrl") != BASE + "/" + key):
            raise ValueError("Missing exact native rulemaking snapshot binding")
        identity = (key, selected.get("manifestDefinitionDigest"))
        if identity not in self.snapshot_cache:
            manifest = json.loads(self.inputs.fetch(key))
            if definition_digest(manifest) != selected.get("manifestDefinitionDigest"):
                raise ValueError("Selected rulemaking manifest changed")
            self.snapshot_cache[identity] = manifest, rulemaking_tables(pointer, manifest)
        manifest, tables = self.snapshot_cache[identity]
        declared = tables.get(dataset, {})
        if (any(table.get(field) != declared.get(field) for field in (
                "family", "kind", "rows", "checksum", "recordUrl", "snapshotId", "members", "publishedAt", "rulemakingSnapshot"))
                or inputs_fingerprint(table) != inputs_fingerprint(declared)):
            raise ValueError("Native rulemaking subject differs from selected manifest")
        description = native_schema(dataset)
        receipts = manifest["etlReceipts"]
        if [p for p in receipts["policies"] if p.get("dataset") == dataset] != [description["policy"]]:
            raise ValueError("Unreviewed native rulemaking restoration policy")
        cached = (*identity, dataset)
        if cached in self.cache:
            return self.cache[cached]
        def member(name):
            entry = manifest["artifacts"][name]
            return {"objectKey": name, "sha256": "sha256:" + entry["sha256"].removeprefix("sha256:"),
                    "byteSize": entry["bytes"], "recordCount": entry["rows"]}
        subject, receipt = member(dataset + ".parquet"), member(receipts["key"])
        request = {"dataset": dataset, "generationId": receipts["generationId"],
                   "subjects": [self.staging._member(expected, subject)],
                   "receipts": self.staging._member(expected, receipt),
                   "destination": str(self.directory / dataset)}
        # These are whole immutable files: COUNT(*) uses their Parquet footers.
        with duckdb.connect() as conn:
            conn.execute("SET memory_limit='128MB'")
            conn.execute("SET threads=2")
            for selected_member, declared_member in ((request["subjects"][0], subject), (request["receipts"], receipt)):
                if conn.execute("SELECT count(*) FROM read_parquet(?)", [selected_member["path"]]).fetchone()[0] != declared_member["recordCount"]:
                    raise ValueError("Native rulemaking file row count differs from manifest")
        result = bridge(request=request)
        if (result.get("selection") != {k: request[k] for k in ("subjects", "receipts")}
                or result.get("dataset") != dataset or result.get("generationId") != receipts["generationId"]
                or result.get("rows") != table["rows"]
                or any(result.get(k) != description[k] for k in (
                    "nativeSchema", "processingSchema", "policy", "implementationSha256", "receiptOnly"))
                or not result.get("processingMembers")
                or result.get("urls") != [m["path"] for m in result["processingMembers"]]):
            raise ValueError("Restoration differs from selected native rulemaking snapshot")
        for restored_member in result["processingMembers"]:
            if not Path(restored_member["path"]).resolve().is_relative_to(Path(request["destination"]).resolve()):
                raise ValueError("Restored coverage member escaped its private destination")
            verify_file(restored_member)
        restored = {**table, "urls": result["urls"], "_coverageProcessing": result}
        self.cache[cached] = restored
        return restored

    def restore(self, dataset, owner):
        identity = (owner["family"], owner["artifactDigest"], dataset)
        if identity in self.cache:
            return self.cache[identity]
        key, artifact, members = self.inputs.artifact(owner["family"], owner["artifactDigest"])
        if artifact != owner["artifact"]:
            raise ValueError("Additional native artifact differs from selected owner")
        bridge(["--verify-artifacts"], request=[artifact])
        spec = artifact.get("spec", {}).get("etlReceipts", {})
        policies = [p for p in spec.get("policies", []) if p.get("dataset") == dataset]
        description = native_schema(dataset)
        if policies != [description["policy"]]:
            raise ValueError("Unreviewed additional native restoration policy")
        subjects = [m for m in members if m.get("role") == "table"
                    and m["objectKey"] == dataset + ".parquet"]
        receipts = [m for m in members if m.get("role") == "table" and m["objectKey"] == spec.get("key")]
        actual = [{"key": m["objectKey"], "sha256": m["sha256"], "rows": m["recordCount"],
                   "byteSize": m["byteSize"]} for m in subjects]
        if (len(subjects) != 1 or actual != owner["members"] or len(receipts) != 1
                or not isinstance(spec.get("generationId"), str)
                or spec.get("rows") != receipts[0].get("recordCount")):
            raise ValueError("Additional native selection differs from published subjects or receipts")
        request = {"dataset": dataset, "generationId": spec["generationId"],
                   "subjects": [self.staging._member(key, m) for m in subjects],
                   "receipts": self.staging._member(key, receipts[0]),
                   "destination": str(self.directory / dataset)}
        result = bridge(request=request)
        if (result.get("selection") != {k: request[k] for k in ("subjects", "receipts")}
                or result.get("dataset") != dataset or result.get("generationId") != spec["generationId"]
                or result.get("rows") != owner["rows"]
                or any(result.get(k) != description[k] for k in (
                    "nativeSchema", "processingSchema", "policy", "implementationSha256", "receiptOnly"))
                or not result.get("processingMembers")
                or result.get("urls") != [m["path"] for m in result["processingMembers"]]):
            raise ValueError("Restoration result differs from selected additional native inputs")
        for member in result["processingMembers"]:
            if not Path(member["path"]).resolve().is_relative_to(Path(request["destination"]).resolve()):
                raise ValueError("Restored coverage member escaped its private destination")
            verify_file(member)
        value = {**owner, "urls": result["urls"], "_coverageProcessing": result}
        self.cache[identity] = value
        return value

    def parent(self, child_id, child, relation):
        if relation["mode"] == "same-generation":
            return self.restore(relation["table"], self.inputs.parent(child_id, child, relation))
        owner = self.inputs.producing(child_id, child)
        if owner["artifact"]["spec"].get("parents", {}).get(relation["table"] + ".parquet"):
            return self.inputs.parent(child_id, child, relation)
        prior_relationships = {
            "court_docket_groups": ("court_dockets", [["cl_docket_id", "cl_docket_id"]]),
            "court_opinion_pdf_extractions": (
                "court_opinions", [["opinion_id", "opinion_id"], ["cluster_id", "cluster_id"]]),
        }
        expected_relation = prior_relationships.get(child_id)
        if (expected_relation is None or relation["mode"] != "recorded-parent"
                or relation["table"] != expected_relation[0]
                or relation.get("keys") != expected_relation[1]):
            raise ValueError("Producing release does not pin this additional coverage parent")
        identity = (owner["family"], owner["artifactDigest"])
        if identity in self.parent_cache:
            return self.parent_cache[identity]
        restored = self.restore(child_id, owner)
        snapshot = owner["artifact"]["spec"].get("readSnapshot", {}).get("families", {}).get(owner["family"])
        if not isinstance(snapshot, dict) or snapshot.get("artifactDigest") == owner["artifactDigest"]:
            raise ValueError("Native group has no exact prior group snapshot")
        descriptor = snapshot.get("tables", {}).get(child_id + ".parquet")
        if not isinstance(descriptor, dict) or descriptor.get("members"):
            raise ValueError("Native group source descriptor is absent or unsupported")
        prior = self.inputs.table(owner["family"], snapshot["artifactDigest"], child_id)
        expected = [{"key": child_id + ".parquet", "sha256": descriptor.get("sha256"),
                     "rows": descriptor.get("rows"), "byteSize": descriptor.get("byteSize")}]
        key, artifact, members = self.inputs.artifact(prior["family"], prior["artifactDigest"])
        if (prior["members"] != expected or snapshot.get("prefix") != key
                or prior["rows"] != owner["rows"]
                or descriptor.get("columns") != restored["_coverageProcessing"]["processingSchema"]):
            raise ValueError("Prior group bytes/schema differ from recorded source snapshot")
        source_key = key + "/" + child_id + ".parquet"
        groups = restored["_coverageProcessing"].get("acceptedWitnessGroups", [])
        if (not groups or any(not isinstance(g.get("rows"), int) or isinstance(g["rows"], bool) or g["rows"] <= 0 for g in groups)
                or sum(g["rows"] for g in groups) != owner["rows"]
                or any(not any(w.get("source_id") == source_key and w.get("sha256") == descriptor["sha256"]
                               for w in g["witnesses"]) for g in groups)):
            raise ValueError("Accepted group receipts do not all witness the exact prior group member")
        source = next(m for m in members if m["objectKey"] == child_id + ".parquet")
        local = self.staging._member(key, source)
        with duckdb.connect() as conn:
            conn.execute("SET memory_limit='256MB'")
            conn.execute("SET threads=2")
            conn.read_parquet(restored["urls"]).create_view("restored_groups")
            conn.read_parquet(local["path"]).create_view("prior_groups")
            actual_schema = [list(row[:2]) for row in conn.execute("DESCRIBE prior_groups").fetchall()]
            if actual_schema != descriptor["columns"]:
                raise ValueError("Prior group physical schema differs from its descriptor")
            changed = conn.execute("SELECT count(*) FROM ((SELECT * FROM restored_groups EXCEPT ALL SELECT * FROM prior_groups) UNION ALL (SELECT * FROM prior_groups EXCEPT ALL SELECT * FROM restored_groups))").fetchone()[0]
            if changed:
                raise ValueError("Restored group rows differ from the witnessed prior input")
        parent = self.inputs.parent(child_id, prior, relation)
        _, parent_artifact, _ = self.inputs.artifact(parent["family"], parent["artifactDigest"])
        bridge(["--verify-artifacts"], request=[artifact, parent_artifact])
        chain = {"qualification": "Every restored group row equals its witnessed prior input; that release declares this parent.",
                 "sourceTable": {k: prior[k] for k in ("family", "artifactDigest", "tableId", "recordUrl", "members", "rows")},
                 "witnessSourceId": source_key, "matchedSourceRows": owner["rows"]}
        parent = {**parent, "_additionalParentEvidence": chain}
        self.parent_cache[identity] = parent
        return parent


def scan_table(dataset, table, policy, *, validate_members, validate_counts,
               inputs=None, download=None):
    revision = measurement_revision(policy)
    with tempfile.TemporaryDirectory(prefix="spicygov-additional-coverage-") as directory, duckdb.connect() as conn:
        conn.execute("SET TimeZone='UTC'")
        conn.execute("SET memory_limit='512MB'")
        conn.execute("SET threads=2")
        adapter = AdditionalInputs(inputs or CoverageInputs(), directory, download)
        if table.get("kind") == "rulemaking" and table.get("rulemakingSnapshot"):
            restored = adapter.restore_snapshot(dataset, table)
        else:
            owner = adapter.inputs.producing(dataset, table)
            restored = adapter.restore(dataset, owner)
        facts = restored["_coverageProcessing"]
        if (facts["nativeSchema"] != policy["schema"]
                or facts["processingSchema"] != policy["processingSchema"]
                or facts["implementationSha256"] != policy["restorationImplementationSha256"]):
            raise ValueError("Additional native processing schema or reader changed")
        physical = {**table, "columns": policy["schema"], "members": [
            {**m, "url": selected["path"]} for m, selected in zip(table["members"], facts["selection"]["subjects"])]}
        validate_members(conn, dataset, physical, policy["schema"])
        validate_definition(policy, policy["processingSchema"])
        private = {**table, "_coverageProcessing": facts, "_coverageUrls": restored["urls"],
                   "members": [{**m, "url": url} for m, url in zip(table["members"], restored["urls"])]}
        dimensions = []
        for dim in policy["dimensions"]:
            if dim.get("special") or dim.get("method"):
                helper = importlib.import_module(policy["_scanner"] + "_coverage")
                measured = helper.scan_special(conn, dataset, private, dim, adapter)
                if measured is None:
                    raise ValueError("Unsupported additional native coverage dimension")
            elif dim["kind"] == "inherited":
                parent = adapter.parent(dataset, table, dim["parent"])
                # Restoration already checks the exact same-generation subjects
                # and receipts. Keep its original processing-only join fields.
                if not parent.get("_coverageProcessing"):
                    key, _, members = adapter.inputs.artifact(parent["family"], parent["artifactDigest"])
                    selected = [m for m in members if m["objectKey"] in {p["key"] for p in parent["members"]}]
                    parent = {**parent, "urls": [adapter.staging._member(key, m)["path"] for m in selected]}
                measured = inherit_unique(conn, restored["urls"], table["rows"], parent, dim["parent"], dim["dimension"])
                if parent.get("_additionalParentEvidence"):
                    measured["evidence"] = parent["_additionalParentEvidence"]
            else:
                measured = scan_dimension(conn, restored["urls"], table["rows"], dim, snapshot={
                    "publishedAt": table.get("publishedAt"), "artifactDigest": table.get("artifactDigest"),
                    "recordUrl": table.get("recordUrl"), "publicationSha256": table.get("checksum")})
            validate_counts(measured, table["rows"])
            measured.update(id=dim["id"], label=dim["label"], meaning=dim["meaning"],
                            definitionDigest=definition_digest(dim))
            dimensions.append(measured)
        validate_native_implementations({dataset: policy})
        if measurement_revision(policy) != revision:
            raise ValueError("Additional coverage implementation changed during the scan")
        return {**binding({**table, "columns": policy["schema"]}, policy), "status": "measured", "classification": policy["classification"],
                "note": policy.get("note", ""), "measurementRevision": revision,
                "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "dimensions": dimensions,
                "processingEvidence": {
                    "dataset": dataset, "generationId": facts["generationId"], "rows": facts["rows"],
                    "policy": facts["policy"], "implementationSha256": facts["implementationSha256"],
                    "subjects": [{k: v for k, v in m.items() if k != "path"} for m in facts["selection"]["subjects"]],
                    "receipts": {k: v for k, v in facts["selection"]["receipts"].items() if k != "path"},
                    "qualification": "Source values restored through the maintained reader for the exact selected receipts."}}
