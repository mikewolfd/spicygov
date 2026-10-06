"""Restore selected amendment and court coverage values using maintained readers."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import inspect
import json
from pathlib import Path
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from spicy_regs import court_receipts
from spicy_regs.court_subjects import LEGACY_COLUMNS
from spicy_regs.etl_receipts import read_attempts, select_receipts
from spicy_regs.native_types import described_schema
from spicy_regs.pipelines.rollups.subject_receipts import dataset_policy

DATASETS = frozenset(("amendments", "court_dockets", "court_docket_groups",
                      "court_opinion_pdf_extractions", "court_opinions"))
ROOT = Path(inspect.getfile(court_receipts)).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "maintained_coverage_bridge", ROOT / "scripts/restore_coverage_processing.py"
)
assert SPEC is not None and SPEC.loader is not None
MAINTAINED = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MAINTAINED)


def implementation_identity():
    files = [Path(__file__), *(ROOT / "src/spicy_regs" / name for name in (
        "court_receipts.py", "court_subjects.py", "etl_receipts.py", "etl_bulk.py",
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


def restore(request):
    if not isinstance(request, dict) or set(request) != {
        "dataset", "generationId", "subjects", "receipts", "destination"
    }:
        raise ValueError("Unsupported additional coverage restoration request")
    dataset = request["dataset"]
    policy = policy_for(dataset)
    if dataset == "amendments":
        result = MAINTAINED.restore(request)
        result["implementationSha256"] = implementation_identity()
        return result
    if not isinstance(request["subjects"], list) or len(request["subjects"]) != 1:
        raise ValueError("Court coverage requires one selected subject member")
    subject = MAINTAINED.checked_member(request["subjects"][0])
    receipts = MAINTAINED.checked_member(request["receipts"])
    generation = request["generationId"]
    if not isinstance(generation, str) or not generation:
        raise ValueError("Missing selected court receipt generation")
    for batch in pq.ParquetFile(receipts).iter_batches(columns=["dataset", "generation_id"], batch_size=2000):
        if any(row["dataset"] == dataset and row["generation_id"] != generation for row in batch.to_pylist()):
            raise ValueError("Court receipts differ from the selected generation")
    destination = Path(request["destination"])
    if not destination.is_absolute() or destination.exists():
        raise ValueError("Coverage destination must be a new absolute directory")
    destination.mkdir(parents=True)
    output = court_receipts.restore_processing_input(
        subject, destination / (dataset + ".parquet"), dataset=dataset,
        schema=processing_schema(dataset), receipt_path=receipts, generation_id=generation,
    )
    # Restoration above performs complete subject/receipt admission. Read the
    # accepted witnesses through the same maintained receipt decoder afterward.
    selected = select_receipts(receipts, destination / "selected-receipts.parquet", dataset=dataset)
    witnesses = {}
    accepted = 0
    for receipt in read_attempts([selected], policy, generation_id=generation, outcomes=frozenset(("accepted",))):
        accepted += 1
        key = json.dumps(receipt["witnesses"], sort_keys=True, separators=(",", ":"))
        witnesses[key] = witnesses.get(key, 0) + 1
    rows = pq.read_metadata(output).num_rows
    if accepted != rows or rows != pq.read_metadata(subject).num_rows:
        raise ValueError("Accepted court receipt count differs from restored subjects")
    return {
        "format": "spicygov-private-coverage-input", "version": 1,
        "dataset": dataset, "generationId": generation,
        **description(dataset),
        "selection": {"subjects": request["subjects"], "receipts": request["receipts"]},
        "rows": rows, "urls": [str(output)],
        "processingMembers": [{"path": str(output), "sha256": MAINTAINED.file_hash(output),
                               "byteSize": output.stat().st_size}],
        "acceptedWitnessGroups": [{"rows": count, "witnesses": json.loads(key)}
                                  for key, count in sorted(witnesses.items())],
    }


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
    args = parser.parse_args()
    if args.verify_artifacts:
        result = verify_artifacts(json.load(sys.stdin))
    else:
        result = description(args.schema) if args.schema else restore(json.load(sys.stdin))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
