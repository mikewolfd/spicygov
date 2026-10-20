"""Read coverage facts from newly promoted source fields and selected receipts.

The reviewed coverage schema stays unchanged: Congress values come from exact
retained processing inputs; FCC date/text facts come from the validated native
subject. Extra navigation fields remain in the public subject and receipts.
"""
import argparse
import hashlib
import inspect
import json
from pathlib import Path
import sys
import shutil
import os
import resource
import time
from contextlib import contextmanager

import duckdb
import pyarrow.dataset as ds
import pyarrow.parquet as pq
from spicy_regs import congress_bulk, earlier_receipt_policies, etl_bulk, etl_receipts, regulations_bulk, votes_batch_receipts
from spicy_regs import coverage_reader as MAINTAINED
from spicy_regs.etl_receipts import RECEIPT_SCHEMA
from spicy_regs.schemas import regulations_subjects
from spicy_regs.native_types import described_schema
from spicy_regs.pipelines.rollups.subject_receipts import dataset_policy
from spicy_regs.transforms.government_receipts import POLICIES, internal_prior
from spicy_regs.transforms import regulations_receipts, regulations_shape
from restore_additional_coverage import verify_artifacts

DATASETS = {"committee_meetings":"congress", "nominations":"congress", "house_communications":"congress", "members":"congress", "member_terms":"congress", "member_party_affiliations":"congress", "fcc_filings":"regulation",
    "committee_reports":"congress", "report_sections":"congress",
    "hearing_transcripts":"congress", "hearing_bill_links":"congress",
    "committees":"congress", "committee_assignments":"congress",
    "laws":"regulation", "law_code_sections":"regulation", "law_sections":"regulation", "table3_records":"regulation",
    "native_legal_references":"regulation", "press_releases":"congress",
    "record_issues":"congress", "senate_expenditures":"congress", "treaties":"congress", "documents":"regulation",
    "docket_attributes":"regulation", "document_attributes":"regulation",
    "roll_call_votes":"congress", "member_vote_terms":"congress",
    "cfr_sections":"regulation", "unified_agenda":"regulation",
    "federal_register":"regulation", "fr_docket_links":"regulation",
    "proceedings":"regulation", "rule_targets":"regulation",
    "comment_periods":"regulation", "regulatory_agenda_items":"regulation",
    "agenda_item_proceedings":"regulation", "rulemaking_lifecycles":"regulation",
    "lifecycle_events":"regulation", "agency_lifecycle_stats":"regulation"}
ROOT = Path(__file__).resolve().parents[1]


def reviewed_schema(dataset):
    if dataset not in DATASETS:
        raise ValueError("Unreviewed source-navigation coverage dataset")
    return json.loads((ROOT / "content/coverage-definitions" / (DATASETS[dataset] + ".json")).read_text())["tables"][dataset]["schema"]


def arrow_schema(dataset):
    with duckdb.connect() as conn:
        columns = ",".join('"' + name.replace('"', '""') + '" ' + dtype for name, dtype in reviewed_schema(dataset))
        conn.execute("CREATE TABLE coverage (" + columns + ")")
        return conn.execute("SELECT * FROM coverage").to_arrow_table().schema


def implementation_identity(dataset):
    value = hashlib.sha256(MAINTAINED.implementation_identity().encode())
    for module in (etl_bulk, etl_receipts, regulations_bulk, regulations_receipts, regulations_shape,
                   regulations_subjects, earlier_receipt_policies, congress_bulk, votes_batch_receipts):
        data = Path(inspect.getfile(module)).read_bytes()
        value.update(len(data).to_bytes(8, "big"))
        value.update(data)
    value.update((Path(inspect.getfile(etl_receipts)).parent / "navigation_policy_history.json").read_bytes())
    value.update(Path(__file__).read_bytes())
    value.update(json.dumps(reviewed_schema(dataset), separators=(",", ":")).encode())
    return "sha256:" + value.hexdigest()


def policy_for(dataset):
    reviewed_schema(dataset)
    return POLICIES[dataset] if dataset == "fcc_filings" else dataset_policy(dataset)


def description(dataset):
    policy = policy_for(dataset)
    return {"nativeSchema":described_schema(policy.subject_schema), "processingSchema":reviewed_schema(dataset),
            "policy":policy.descriptor(), "policyVersion":policy.policy_version,
            "receiptOnly":policy.receipt_only, "implementationSha256":implementation_identity(dataset)}


def diagnostic(dataset, stage, **values):
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    facts = {"dataset":dataset, "stage":stage, "pid":os.getpid(),
             "peakRssBytes":peak if sys.platform == "darwin" else peak * 1024, **values}
    try:
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        for source, target in (("MemTotal", "hostMemoryBytes"), ("MemAvailable", "availableMemoryBytes")):
            facts[target] = int(memory[source].split()[0]) * 1024
    except (OSError, KeyError, ValueError):
        pass
    print("coverage-restore " + json.dumps(facts, sort_keys=True), file=sys.stderr, flush=True)


@contextmanager
def measured_stage(dataset, stage):
    started = time.monotonic()
    diagnostic(dataset, stage, state="started")
    try:
        yield
    except Exception as error:
        diagnostic(dataset, stage, state="failed", seconds=time.monotonic() - started,
                   errorType=type(error).__name__, reason=str(error))
        raise
    else:
        diagnostic(dataset, stage, state="completed", seconds=time.monotonic() - started)


def selected_inputs(request):
    """Check original byte identities before retaining all selected receipt outcomes."""
    dataset = request.get("dataset") if isinstance(request, dict) else None
    with measured_stage(dataset, "original-member-checks"):
        _, (subject,), receipts, destination = MAINTAINED.checked_request(request, policy_for, one_subject=True)
    destination.mkdir(parents=True)
    scoped = destination / "selected-receipts.parquet"
    scanner = ds.dataset(receipts, format="parquet").scanner(
        filter=ds.field("dataset") == dataset, batch_size=2000, use_threads=False)
    receipt_rows = 0
    with measured_stage(dataset, "selected-receipt-scoping"), pq.ParquetWriter(scoped, RECEIPT_SCHEMA) as writer:
        for batch in scanner.to_batches():
            writer.write_batch(batch)
            receipt_rows += batch.num_rows
    diagnostic(dataset, "selected-receipts", rows=receipt_rows,
               generationId=request["generationId"], originalSha256=request["receipts"]["sha256"])
    return subject, scoped, destination


def restored_facts(request, facts, subject, output):
    dataset = request["dataset"]
    with pq.ParquetFile(output) as source, pq.ParquetFile(subject) as native:
        rows = source.metadata.num_rows
        if [list(column) for column in described_schema(source.schema_arrow)] != facts["processingSchema"] or rows != native.metadata.num_rows:
            output.unlink()
            raise ValueError("Coverage facts differ from the selected subject schema or rows")
    return {"format":"spicygov-private-coverage-input", "version":1, "dataset":dataset,
            "generationId":request["generationId"], "selection":{k:request[k] for k in ("subjects", "receipts")},
            **facts, "rows":rows, "urls":[str(output)],
            "processingMembers":[{"path":str(output), "sha256":MAINTAINED.file_hash(output),
                                  "byteSize":output.stat().st_size}]}


def restore_votes(request, facts):
    """Use the maintained vote authority on a checked dataset-only receipt file."""
    dataset = request["dataset"]
    subject, scoped, destination = selected_inputs(request)
    source = destination / "retained-processing.parquet"
    diagnostic(dataset, "selected-reader", reader="votes_batch_receipts.restore_processing_input",
               reproduction="batch-if-retained-schema-eligible" if congress_bulk.eligible(dataset) else "exact-row",
               reason=None if congress_bulk.eligible(dataset) else "Congress native fields require exact row restoration")
    with measured_stage(dataset, "maintained-admission-and-reproduction"):
        votes_batch_receipts.restore_processing_input((subject,), scoped, source, dataset=dataset,
                                                     generation_id=request["generationId"], bulk=True)
    output = destination / "coverage-facts.parquet"
    partial = destination / "provisional-coverage-facts.parquet"
    schema = arrow_schema(dataset)
    try:
        with measured_stage(dataset, "reviewed-field-writing"), pq.ParquetWriter(partial, schema) as writer, pq.ParquetFile(source) as reader:
            for batch in reader.iter_batches(columns=schema.names, batch_size=2000):
                writer.write_batch(batch.cast(schema, safe=True))
        # Check private output before publishing its final name.
        result = restored_facts(request, facts, subject, partial)
        partial.replace(output)
        result["urls"] = [str(output)]
        result["processingMembers"][0]["path"] = str(output)
        return result
    finally:
        partial.unlink(missing_ok=True)


def restore(request):
    dataset = request.get("dataset") if isinstance(request, dict) else None
    facts = description(dataset)
    if dataset == "roll_call_votes":
        return restore_votes(request, facts)
    # checked_request admits byte identities, current receipts and generation once per route.
    if dataset == "fcc_filings":
        _, (subject,), receipts, destination = MAINTAINED.checked_request(request, policy_for, one_subject=True)
        destination.mkdir()
        copied = destination / "fcc_filings.parquet"
        shutil.copyfile(subject, copied)
        MAINTAINED.checked_member({**request["subjects"][0], "path":str(copied)})
        internal_prior(dataset, copied, receipt_path=receipts, generation_id=request["generationId"])
        restored = {"format":"spicygov-private-coverage-input", "version":1, "dataset":dataset,
                    "generationId":request["generationId"], "selection":{k:request[k] for k in ("subjects", "receipts")},
                    **facts, "rows":pq.ParquetFile(copied).metadata.num_rows, "urls":[str(copied)]}
    else:
        restored = MAINTAINED.restore(request)
    expected = facts["nativeSchema"]
    if restored["nativeSchema"] != expected or restored["policy"] != facts["policy"]:
        raise ValueError("Source-navigation coverage differs from the reviewed policy")
    if len(restored["urls"]) != 1 or len(request["subjects"]) != 1:
        raise ValueError("Source-navigation coverage requires one selected subject member")
    source = restored["urls"][0]
    schema = arrow_schema(dataset)
    output = Path(request["destination"]) / "coverage-facts.parquet"
    rows = 0
    with pq.ParquetWriter(output, schema) as writer, pq.ParquetFile(source) as reader:
        for batch in reader.iter_batches(columns=schema.names, batch_size=2000):
            selected = batch.cast(schema, safe=True)
            writer.write_batch(selected)
            rows += selected.num_rows
    if rows != restored["rows"]:
        raise ValueError("Coverage facts differ from selected subject row count")
    return {**restored, **facts, "rows":rows, "urls":[str(output)],
            "processingMembers":[{"path":str(output), "sha256":MAINTAINED.file_hash(output), "byteSize":output.stat().st_size}]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema")
    parser.add_argument("--verify-artifacts", action="store_true")
    args = parser.parse_args()
    result = description(args.schema) if args.schema else verify_artifacts(json.load(sys.stdin)) if args.verify_artifacts else restore(json.load(sys.stdin))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
