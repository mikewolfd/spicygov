"""Read coverage facts from newly promoted source fields and selected receipts.

The reviewed coverage schema stays unchanged: Congress values come from exact
retained processing inputs; FCC date/text facts come from the validated native
subject. Extra navigation fields remain in the public subject and receipts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import shutil

import duckdb
import pyarrow.parquet as pq
from spicy_regs.native_types import described_schema
from spicy_regs.pipelines.rollups.subject_receipts import dataset_policy
from spicy_regs.transforms.government_receipts import POLICIES, internal_prior
from restore_additional_coverage import MAINTAINED, verify_artifacts

DATASETS = {"committee_meetings":"congress", "nominations":"congress", "house_communications":"congress", "members":"congress", "member_terms":"congress", "member_party_affiliations":"congress", "fcc_filings":"regulation",
    "committee_reports":"congress", "report_sections":"congress",
    "hearing_transcripts":"congress", "hearing_bill_links":"congress",
    "committees":"congress", "committee_assignments":"congress",
    "laws":"regulation", "law_code_sections":"regulation", "law_sections":"regulation", "table3_records":"regulation",
    "native_legal_references":"regulation", "press_releases":"congress",
    "record_issues":"congress", "senate_expenditures":"congress", "treaties":"congress"}
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
    value.update(Path(__file__).read_bytes())
    value.update(json.dumps(reviewed_schema(dataset), separators=(",", ":")).encode())
    return "sha256:" + value.hexdigest()


def description(dataset):
    reviewed_schema(dataset)
    policy = POLICIES[dataset] if dataset == "fcc_filings" else dataset_policy(dataset)
    return {"nativeSchema":described_schema(policy.subject_schema), "processingSchema":reviewed_schema(dataset),
            "policy":policy.descriptor(), "policyVersion":policy.policy_version,
            "receiptOnly":policy.receipt_only, "implementationSha256":implementation_identity(dataset)}


def restore(request):
    dataset = request.get("dataset")
    facts = description(dataset)
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
