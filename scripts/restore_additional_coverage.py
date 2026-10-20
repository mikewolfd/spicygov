"""Restore selected amendment and court coverage values using maintained readers."""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import hashlib
import inspect
import json
from pathlib import Path
import shutil
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from spicy_regs import coverage_reader as MAINTAINED
from spicy_regs import court_receipts, etl_bulk
from spicy_regs.court_subjects import LEGACY_COLUMNS
from spicy_regs.etl_receipts import read_attempts, select_receipts
from spicy_regs.native_types import described_schema
from spicy_regs.pipelines.rollups.subject_receipts import dataset_policy

BULK_COURT_DATASETS = frozenset(("court_citation_map", "court_citations",
                               "court_parentheticals", "court_opinion_clusters"))
DATASETS = frozenset(("amendments", "court_dockets", "court_docket_groups",
                      "court_opinion_pdf_extractions", "court_opinions")) | BULK_COURT_DATASETS
PACKAGE = Path(inspect.getfile(court_receipts)).resolve().parent


def implementation_identity():
    files = [Path(__file__), *(PACKAGE / name for name in (
        "court_receipts.py", "court_subjects.py", "etl_receipts.py", "etl_bulk.py",
        "court_bulk.py", "court_restore.py", "conversion_reads.py",
        "native_types.py", "parquet_rows.py", "transforms/parquet_rows.py",
    ))]
    value = hashlib.sha256(MAINTAINED.implementation_identity().encode())
    for path in files:
        data = path.read_bytes()
        value.update(len(data).to_bytes(8, "big"))
        value.update(data)
    return "sha256:" + value.hexdigest()


def policy_for(dataset):
    if dataset not in DATASETS:
        raise ValueError("Unreviewed additional coverage dataset")
    return dataset_policy(dataset) if dataset == "amendments" else court_receipts.POLICIES[dataset]


def processing_schema(dataset):
    if dataset == "amendments":
        from spicy_regs.congress_subjects import INPUT_COLUMNS
        names = INPUT_COLUMNS[dataset]
    else:
        names = LEGACY_COLUMNS[dataset]
    return pa.schema([(name, pa.int64() if name == "group_size" else pa.string()) for name in names])


def description(dataset):
    policy = policy_for(dataset)
    return {
        "nativeSchema": described_schema(policy.subject_schema),
        "processingSchema": described_schema(processing_schema(dataset)),
        "receiptOnly": policy.receipt_only,
        "policyVersion": policy.policy_version,
        "policy": policy.descriptor(),
        "implementationSha256": implementation_identity(),
    }


def court_restoration_limits():
    """Apply coverage defaults without replacing explicit caller budgets or require_bulk."""
    if etl_bulk._limits.get() is not None:
        return nullcontext()
    # The maintained scope also enables bounded inserts. 4GB is not an RSS cap.
    return etl_bulk.bulk_limits(threads=1, memory_limit="4GB")


def restore(request):
    dataset = request.get("dataset") if isinstance(request, dict) else None
    if dataset == "amendments":
        result = MAINTAINED.restore(request)
        result["implementationSha256"] = implementation_identity()
        return result
    policy, (subject,), receipts, destination = MAINTAINED.checked_request(request, policy_for, one_subject=True)
    generation = request["generationId"]
    destination.mkdir(parents=True)
    with court_restoration_limits():
        output = court_receipts.restore_processing_input(
            subject, destination / (dataset + ".parquet"), dataset=dataset,
            schema=processing_schema(dataset), receipt_path=receipts, generation_id=generation,
        )
    # Restoration above performs complete subject/receipt admission. The bulk
    # tables and opinions read their restored edition/origin fields; coverage does not
    # follow inherited parents and needs no additional witness enumeration.
    witnesses = {}
    rows = pq.read_metadata(output).num_rows
    if rows != pq.read_metadata(subject).num_rows:
        raise ValueError("Accepted court receipt count differs from restored subjects")
    if dataset not in BULK_COURT_DATASETS and dataset != "court_opinions":
        selected = select_receipts(receipts, destination / "selected-receipts.parquet", dataset=dataset)
        accepted = 0
        for receipt in read_attempts([selected], policy, generation_id=generation, outcomes=frozenset(("accepted",))):
            accepted += 1
            key = json.dumps(receipt["witnesses"], sort_keys=True, separators=(",", ":"))
            witnesses[key] = witnesses.get(key, 0) + 1
        if accepted != rows:
            raise ValueError("Accepted court receipt count differs from restored subjects")
    return restored_result(request, output, witnesses)


def restored_result(request, output, witnesses):
    dataset = request["dataset"]
    return {
        "format": "spicygov-private-coverage-input", "version": 1,
        "dataset": dataset, "generationId": request["generationId"],
        **description(dataset),
        "selection": {"subjects": request["subjects"], "receipts": request["receipts"]},
        "rows": pq.read_metadata(output).num_rows, "urls": [str(output)],
        "processingMembers": [{"path": str(output), "sha256": MAINTAINED.file_hash(output),
                               "byteSize": output.stat().st_size}],
        "acceptedWitnessGroups": [{"rows": count, "witnesses": json.loads(key)}
                                  for key, count in sorted(witnesses.items())],
    }


def restore_court_family(requests):
    """Keep one complete citation-family admission alive for its three restores."""
    from spicy_regs import court_restore
    from spicy_regs.conversion_reads import _open_family_reader
    from spicy_regs.etl_receipts import selected_subject_policy
    from spicy_regs.local_data import file_signature
    from spicy_regs.transforms.parquet_rows import write_rows

    datasets = BULK_COURT_DATASETS - {"court_opinion_clusters"}
    if (not isinstance(requests, list) or len(requests) != len(datasets)
            or any(not isinstance(r, dict) or set(r) != MAINTAINED.REQUEST_FIELDS for r in requests)
            or {r["dataset"] for r in requests} != datasets):
        raise ValueError("Expected the complete court citation family")
    first = requests[0]
    generation = first["generationId"]
    if not isinstance(generation, str) or not generation:
        raise ValueError("Missing coverage receipt generation")
    subjects, destinations, policies = {}, [], []
    for request in requests:
        if request["generationId"] != generation or request["receipts"] != first["receipts"]:
            raise ValueError("Court coverage family has mixed receipt selections")
        destination = Path(request["destination"])
        if not destination.is_absolute() or destination.exists():
            raise ValueError("Coverage destination must be a new absolute directory")
        if any(destination == old or destination in old.parents or old in destination.parents for old in destinations):
            raise ValueError("Court coverage destinations overlap")
        destinations.append(destination)
        if not isinstance(request["subjects"], list) or len(request["subjects"]) != 1:
            raise ValueError("Court coverage subjects must be explicit")
        subject = MAINTAINED.checked_member(request["subjects"][0])
        dataset = request["dataset"]
        subjects[dataset] = [subject]
        policies.append(selected_subject_policy(policy_for(dataset), [subject]))
    receipts = MAINTAINED.checked_member(first["receipts"])
    paths = [receipts, *(paths[0] for paths in subjects.values())]
    before = [file_signature(path) for path in paths]

    def guard():
        if [file_signature(path) for path in paths] != before:
            raise ValueError("Selected court input changed during restoration")

    # Complete admission owns policy/generation checks for every receipt and
    # every subject. No single-dataset pre-scan or saved validation flag is used.
    created = []
    try:
        with (court_restoration_limits(),
              _open_family_reader(subjects, [receipts], policies, generation_id=generation, guard=guard) as reader):
            results = []
            for request, destination in zip(requests, destinations):
                destination.mkdir(parents=True)
                created.append(destination)
                dataset = request["dataset"]
                output = destination / (dataset + ".parquet")
                schema = processing_schema(dataset)
                try:
                    court_restore.materialize(reader, dataset, schema, output)
                except court_receipts.etl_bulk.NotBulkEligible as error:
                    court_receipts.etl_bulk.log_row_fallback(
                        "court restore", error, dataset=dataset,
                        rows=pq.read_metadata(subjects[dataset][0]).num_rows)
                    write_rows(court_receipts.processing_rows(
                        reader.read_subjects(dataset), dataset=dataset, schema=schema), output, schema)
                if pq.read_metadata(output).num_rows != pq.read_metadata(subjects[dataset][0]).num_rows:
                    raise ValueError("Accepted court receipt count differs from restored subjects")
                results.append(restored_result(request, output, {}))
        return results
    except BaseException:
        for destination in created:
            shutil.rmtree(destination, ignore_errors=True)
        raise


def verify_artifacts(roots):
    from rulespec_artifacts import expected_artifact_digest, expected_logical_id
    if not isinstance(roots, list) or not 1 <= len(roots) <= 3:
        raise ValueError("Expected one to three selected artifact roots")
    pins = []
    for root in roots:
        if (expected_artifact_digest(root) != root.get("artifactDigest")
                or expected_logical_id(root) != root.get("logicalId")):
            raise ValueError("Coverage artifact differs from its content or logical digest")
        pins.append({k: root[k] for k in ("artifactDigest", "logicalId")})
    return pins


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--schema", choices=sorted(DATASETS))
    parser.add_argument("--verify-artifacts", action="store_true")
    parser.add_argument("--court-family", action="store_true")
    args = parser.parse_args()
    if args.court_family:
        result = restore_court_family(json.load(sys.stdin))
    elif args.verify_artifacts:
        result = verify_artifacts(json.load(sys.stdin))
    else:
        result = description(args.schema) if args.schema else restore(json.load(sys.stdin))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
