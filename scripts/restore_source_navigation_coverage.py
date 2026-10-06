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

import duckdb
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq
from spicy_regs import earlier_receipt_policies, etl_bulk, etl_receipts, regulations_bulk
from spicy_regs.etl_receipts import RECEIPT_SCHEMA, read_attempts, visit_receipt_bundle
from spicy_regs.schemas import regulations_subjects
from spicy_regs.native_types import described_schema
from spicy_regs.pipelines.rollups.subject_receipts import dataset_policy
from spicy_regs.transforms.government_receipts import POLICIES, internal_prior
from spicy_regs.transforms import regulations_receipts, regulations_shape
from restore_additional_coverage import MAINTAINED, verify_artifacts

DATASETS = {"committee_meetings":"congress", "nominations":"congress", "house_communications":"congress", "members":"congress", "member_terms":"congress", "member_party_affiliations":"congress", "fcc_filings":"regulation",
    "committee_reports":"congress", "report_sections":"congress",
    "hearing_transcripts":"congress", "hearing_bill_links":"congress",
    "committees":"congress", "committee_assignments":"congress",
    "laws":"regulation", "law_code_sections":"regulation", "law_sections":"regulation", "table3_records":"regulation",
    "native_legal_references":"regulation", "press_releases":"congress",
    "record_issues":"congress", "senate_expenditures":"congress", "treaties":"congress", "documents":"regulation",
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
                   regulations_subjects, earlier_receipt_policies):
        data = Path(inspect.getfile(module)).read_bytes()
        value.update(len(data).to_bytes(8, "big"))
        value.update(data)
    value.update((Path(inspect.getfile(etl_receipts)).parent / "navigation_policy_history.json").read_bytes())
    value.update(Path(__file__).read_bytes())
    value.update(json.dumps(reviewed_schema(dataset), separators=(",", ":")).encode())
    return "sha256:" + value.hexdigest()


def description(dataset):
    reviewed_schema(dataset)
    policy = POLICIES[dataset] if dataset == "fcc_filings" else dataset_policy(dataset)
    return {"nativeSchema":described_schema(policy.subject_schema), "processingSchema":reviewed_schema(dataset),
            "policy":policy.descriptor(), "policyVersion":policy.policy_version,
            "receiptOnly":policy.receipt_only, "implementationSha256":implementation_identity(dataset)}


def restore_regulation(request, facts):
    """Admit one complete selected dataset and write its reviewed source fields once."""
    dataset = request["dataset"]
    if (set(request) != {"dataset", "generationId", "subjects", "receipts", "destination"}
            or not isinstance(request["generationId"], str) or not request["generationId"]
            or not isinstance(request["subjects"], list) or len(request["subjects"]) != 1):
        raise ValueError("Unsupported selected regulatory coverage request")
    subject = MAINTAINED.checked_member(request["subjects"][0])
    receipts = MAINTAINED.checked_member(request["receipts"])
    with pq.ParquetFile(receipts) as source:
        if not source.schema_arrow.equals(RECEIPT_SCHEMA):
            raise ValueError("Receipt schema differs from the shared schema")
    destination = Path(request["destination"])
    if not destination.is_absolute() or destination.exists():
        raise ValueError("Coverage destination must be a new absolute directory")
    destination.mkdir(parents=True)
    schema = arrow_schema(dataset)
    scoped = destination / "selected-receipts.parquet"
    scanner = ds.dataset(receipts, format="parquet").scanner(
        filter=ds.field("dataset") == dataset, batch_size=2000, use_threads=False)
    receipt_rows = 0
    with pq.ParquetWriter(scoped, RECEIPT_SCHEMA) as writer:
        for batch in scanner.to_batches():
            if any(value != request["generationId"] for value in batch.column(
                    batch.schema.get_field_index("generation_id")).to_pylist()):
                raise ValueError("Regulatory receipt context differs from the selected generation")
            writer.write_batch(batch)
            receipt_rows += batch.num_rows
    if not receipt_rows:
        raise ValueError("Selected regulatory generation has no receipt context")
    output = destination / "coverage-facts.parquet"
    selected = regulations_receipts.ReceiptInput(dataset, (subject,), scoped, request["generationId"])
    if dataset in {"documents", "federal_register", "fr_docket_links"}:
        try:
            # This maintained path performs complete admission and exact source
            # reproduction. Its input is already scoped; avoid selecting twice.
            regulations_bulk._materialize_selected(selected, output, source_schema=schema)
        except etl_bulk.NotBulkEligible:
            write_regulatory_facts(selected, output, schema)
    else:
        write_regulatory_facts(selected, output, schema)
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


def write_regulatory_facts(selected, output, schema):
    """Keep provisional output private until every receipt and subject is admitted."""
    partial = output.with_name("provisional-coverage-facts.parquet")
    pending = []
    seen = 0
    metadata = None
    try:
        with pq.ParquetWriter(partial, schema) as writer:
            def visit(dataset, row):
                nonlocal seen, metadata
                original = regulations_receipts._processor_input(dataset, row)
                current = row.get("input_metadata", {})
                if not isinstance(current, dict):
                    raise ValueError("Regulatory input metadata is not a mapping")
                schema.with_metadata(current)
                if seen and current != metadata:
                    raise ValueError("Regulatory input metadata differs across selected receipts")
                metadata = current
                seen += 1
                pending.append({name: original.get(name) for name in schema.names})
                if len(pending) == 2000:
                    writer.write_table(pa.Table.from_pylist(pending, schema=schema))
                    pending.clear()
            visit_receipt_bundle({selected.dataset:selected.subjects}, [selected.receipts],
                [regulations_receipts.policy(selected.dataset)], generation_id=selected.generation_id, visit=visit)
            if not seen:
                observed = [attempt["processing_fields"]["input_metadata"]
                            for attempt in read_attempts([selected.receipts], regulations_receipts.policy(selected.dataset),
                                generation_id=selected.generation_id, outcomes=frozenset({"observed"}))
                            if attempt["diagnostics"].get("kind") == "input_file_metadata"]
                if observed and any(value != observed[0] for value in observed):
                    raise ValueError("Empty input metadata differs across selected receipts")
                if observed:
                    schema.with_metadata(observed[0])
            if pending:
                writer.write_table(pa.Table.from_pylist(pending, schema=schema))
        partial.replace(output)
    finally:
        partial.unlink(missing_ok=True)


def restore(request):
    dataset = request.get("dataset")
    facts = description(dataset)
    if dataset in regulations_shape.SOURCE_COLUMNS and dataset != "fcc_filings":
        return restore_regulation(request, facts)
    # The maintained reader checks byte identities, generation and subject/receipt agreement.
    if dataset == "fcc_filings":
        if set(request) != {"dataset", "generationId", "subjects", "receipts", "destination"} or not isinstance(request["generationId"], str) or not request["generationId"] or len(request["subjects"]) != 1:
            raise ValueError("Unsupported selected FCC coverage request")
        subject = MAINTAINED.checked_member(request["subjects"][0])
        receipts = MAINTAINED.checked_member(request["receipts"])
        found = False
        with pq.ParquetFile(receipts) as selected_receipts:
            for batch in selected_receipts.iter_batches(columns=["dataset", "generation_id"], batch_size=2000):
                for row in batch.to_pylist():
                    if row["dataset"] == dataset:
                        found = True
                        if row["generation_id"] != request["generationId"]:
                            raise ValueError("FCC receipts differ from the selected generation")
        if not found:
            raise ValueError("Selected FCC generation has no receipt context")
        destination = Path(request["destination"])
        if not destination.is_absolute() or destination.exists():
            raise ValueError("Coverage destination must be a new absolute directory")
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
