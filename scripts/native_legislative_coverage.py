"""Private processing inputs from exact native generations, via the backend reader.

Physical subjects still own map schema/fingerprints. Restored inputs supply
original source values and processing-only citation states to measurements.
"""

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import uuid4
import coverage_allowances as allowances
from publication_census import BASE

DATASETS = frozenset(
    (
        "bill_versions",
        "bill_sections",
        "bill_publisher_summaries",
        "bill_summaries",
        "bill_subjects",
        "cbo_cost_estimates",
        "diff_summaries",
        "financial_changes",
        "section_classifications",
        "section_diff_items",
        "section_diffs",
        "bill_committee_actions",
        "budget_volumes",
        "house_activity_reports",
        "document_citations",
        "bill_actions",
        "bill_committee_activities",
        "bill_committees",
        "bill_cosponsors",
        "bill_vote_references",
        "cbo_feed_items",
        "congress_bills",
        "public_activity_events",
    )
)
FAMILIES = frozenset(("bill-family", "print-citations", "bill-subjects"))


def verify_file(member):
    path = Path(member["path"])
    if (
        not path.is_absolute()
        or path.is_symlink()
        or not path.is_file()
        or type(member.get("byteSize")) is not int
    ):
        raise ValueError("Invalid native coverage cache file")
    with path.open("rb") as stream:
        actual = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != member["sha256"] or path.stat().st_size != member["byteSize"]:
        raise ValueError("Native coverage bytes differ from the selected generation")
    return actual


def retire_restore_intermediates(request, result):
    """Retire only the reader's known copies after its cache manifest is committed."""
    destination = Path(request["destination"]).resolve()
    selected = destination / "selected" / request["dataset"]
    # SelectedPriors owns this private layout. Keep its selection and diagnostic
    # manifests, native originals and final processing files; never sweep a tree.
    candidates = [
        selected / "scoped.parquet",
        selected / "file-receipts.parquet",
        selected / "legislative" / "etl_receipts.parquet",
        *(selected / "legislative" / f"subject-{i}.parquet"
          for i in range(len(request["subjects"]))),
    ]
    retained = {
        Path(member["path"]).resolve()
        for member in (*request["subjects"], request["receipts"], *result["processingMembers"])
    }
    for path in candidates:
        if (
            not path.resolve().is_relative_to(destination)
            or path.resolve() in retained
            or path.is_symlink()
            or (path.exists() and not path.is_file())
        ):
            raise ValueError("Restoration intermediate is not a disposable private file")
    for path in candidates:
        path.unlink(missing_ok=True)


def forward_restore_diagnostics(stderr):
    """Show the reader's restore progress and any row-route fallback in the build log."""
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    for line in (stderr or "").splitlines():
        if line.startswith("coverage-restore ") or "route=row" in line:
            print(line, file=sys.stderr, flush=True)


def run_bridge(command, request, timeout):
    """Run one reader request; its diagnostics reach the log even when it fails."""
    try:
        result = subprocess.run(
            command,
            input=None if request is None else json.dumps(request),
            text=True,
            capture_output=True,
            check=True,
            timeout=timeout,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        forward_restore_diagnostics(error.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            stderr = error.stderr
            if isinstance(stderr, bytes):
                stderr = stderr.decode("utf-8", errors="replace")
            # Exception notes remain at the end of the outer scan's traceback tail.
            error.add_note("Reader stderr (last 1200 characters):\n" + stderr[-1200:])
        raise
    forward_restore_diagnostics(result.stderr)
    return json.loads(result.stdout.splitlines()[-1])


def bridge(args=(), request=None):
    python = os.environ.get("SPICYGOV_COVERAGE_PYTHON", sys.executable)
    return run_bridge(
        [python, "-m", "spicy_regs.coverage_reader", *args],
        request,
        allowances.LEGISLATIVE_BRIDGE,
    )


# Each dataset is described once per build (describe_all) and handed to every
# scan process (seed); an uncached dataset is described on first use.
SCHEMAS = {}


def describe(dataset):
    return bridge(["--schema", dataset])


def describe_each(function, datasets):
    """One request per dataset, run in parallel: {dataset: description}."""
    datasets = sorted(set(datasets))
    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(zip(datasets, pool.map(function, datasets)))


def describe_all(datasets):
    SCHEMAS.update(describe_each(describe, set(datasets) - SCHEMAS.keys()))


def seed(descriptions):
    SCHEMAS.update(descriptions)


def native_schema(dataset):
    if dataset not in SCHEMAS:
        SCHEMAS[dataset] = describe(dataset)
    return SCHEMAS[dataset]


def validate_native_implementations(policies):
    # Describe again, uncached and in parallel: this is the race check against a
    # reader that changed while the build ran.
    current = describe_each(
        describe, (d for d, policy in policies.items() if policy.get("_nativeProcessing"))
    )
    for dataset, description in current.items():
        if (
            description.get("implementationSha256")
            != policies[dataset].get("restorationImplementationSha256")
            or description.get("nativeSchema") != policies[dataset]["schema"]
            or description.get("receiptOnly") is not False
        ):
            raise ValueError(
                "Native coverage reader changed during the build: " + dataset
            )


def variant(dataset, table, policy):
    # A table still published in the flat reviewed shape is measured directly by
    # the published-table scanner: no reader, receipts or restoration.
    if table.get("columns") == policy["schema"]:
        return policy
    if dataset not in DATASETS or table["family"] not in FAMILIES:
        return policy
    description = native_schema(dataset)
    if description["receiptOnly"] or description["nativeSchema"] != table.get(
        "columns"
    ):
        raise ValueError(
            "Published schema is not the reviewed native subject: " + dataset
        )
    return {
        **policy,
        "schema": description["nativeSchema"],
        "processingSchema": policy["schema"],
        "_nativeProcessing": True,
        "restorationImplementationSha256": description["implementationSha256"],
    }


class ProcessingInputs:
    def __init__(self, inputs, directory, download=None):
        self.inputs, self.directory = inputs, Path(directory)
        self.cache = {}
        self.download = download or self._download
        self.shared = Path(
            os.environ.get(
                "SPICYGOV_NATIVE_COVERAGE_CACHE",
                Path(__file__).resolve().parents[1] / ".cache/native-coverage",
            )
        ).resolve()
        self.shared.mkdir(parents=True, exist_ok=True)

    def __getattr__(self, name):
        return getattr(self.inputs, name)

    def _download(self, key, path):
        subprocess.run(
            [
                "curl",
                "-fsS",
                "--retry",
                "2",
                "--max-time",
                "300",
                BASE + "/" + key,
                "-o",
                str(path),
            ],
            check=True,
        )

    def _member(self, key, member):
        if (
            type(member.get("byteSize")) is not int
            or not 0 <= member["byteSize"] <= 16 * 2**30
        ):
            raise ValueError("Native coverage member exceeds the bounded staging limit")
        if not isinstance(member.get("sha256"), str) or not re.fullmatch(
            r"sha256:[0-9a-f]{64}", member["sha256"]
        ):
            raise ValueError("Invalid native coverage SHA-256 pin")
        name = member["objectKey"]
        if (
            not isinstance(name, str)
            or Path(name).is_absolute()
            or ".." in Path(name).parts
        ):
            raise ValueError("Invalid native coverage member path")
        path = self.shared / "members" / member["sha256"][7:] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.with_suffix(path.suffix + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not path.exists():
                partial = path.with_name(path.name + "." + uuid4().hex + ".partial")
                try:
                    self.download(key + "/" + name, partial)
                    checked = {
                        "path": str(partial),
                        "sha256": member["sha256"],
                        "byteSize": member["byteSize"],
                    }
                    verify_file(checked)
                    partial.replace(path)
                finally:
                    partial.unlink(missing_ok=True)
            actual = verify_file(
                {
                    "path": str(path),
                    "sha256": member["sha256"],
                    "byteSize": member["byteSize"],
                }
            )
        return {
            "path": str(path.resolve()),
            "sha256": actual,
            "byteSize": member["byteSize"],
        }

    def restore(self, dataset, owner):
        identity = (owner["family"], owner["artifactDigest"], dataset)
        if identity in self.cache:
            return self.cache[identity]
        key, artifact, members = self.inputs.artifact(
            owner["family"], owner["artifactDigest"]
        )
        if owner.get("artifact") != artifact:
            raise ValueError("Native producing artifact differs from selected owner")
        spec = artifact.get("spec", {}).get("etlReceipts", {})
        policies = [p for p in spec.get("policies", []) if p.get("dataset") == dataset]
        if not policies or dataset not in DATASETS:
            return owner
        if len(policies) != 1 or policies[0] != native_schema(dataset)["policy"]:
            raise ValueError("Unreviewed native coverage restoration policy")
        subjects = [
            m
            for m in members
            if m.get("role") == "table"
            and (
                m["objectKey"] == dataset + ".parquet"
                or m["objectKey"].startswith(dataset + "/")
            )
        ]
        receipts = [
            m
            for m in members
            if m.get("role") == "table" and m["objectKey"] == spec.get("key")
        ]
        if (
            len(receipts) != 1
            or not isinstance(spec.get("generationId"), str)
            or spec.get("rows") != receipts[0].get("recordCount")
        ):
            raise ValueError("Native coverage has no exact selected receipt member")
        actual = [
            {
                "key": m["objectKey"],
                "sha256": m["sha256"],
                "rows": m["recordCount"],
                "byteSize": m["byteSize"],
            }
            for m in subjects
        ]
        if owner.get("members") is not None and actual != owner["members"]:
            raise ValueError(
                "Native coverage subjects differ from selected publication"
            )
        request = {
            "dataset": dataset,
            "generationId": spec["generationId"],
            "subjects": [self._member(key, m) for m in subjects],
            "receipts": self._member(key, receipts[0]),
            "destination": "",
        }
        cache_key = (
            "sha256:"
            + hashlib.sha256(
                json.dumps(
                    {
                        "family": owner["family"],
                        "artifactDigest": owner["artifactDigest"],
                        "dataset": dataset,
                        "implementation": native_schema(dataset)[
                            "implementationSha256"
                        ],
                        "subjects": request["subjects"],
                        "receipts": request["receipts"],
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            ).hexdigest()
        )
        folder = self.shared / "restored" / cache_key[7:]
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / "restore.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            saved = folder / "manifest.json"
            fresh = not saved.exists()
            if not fresh:
                result = json.loads(saved.read_text())
            else:
                request["destination"] = str(folder / uuid4().hex)
                result = bridge(request=request)
            if not result.get("processingMembers") or result.get("urls") != [
                member["path"] for member in result["processingMembers"]
            ]:
                raise ValueError(
                    "Cached restoration has no exact processing file identities"
                )
            if not fresh:
                for member in result["processingMembers"]:
                    verify_file(member)
            if (
                result.get("selection")
                != {"subjects": request["subjects"], "receipts": request["receipts"]}
                or result.get("generationId") != request["generationId"]
                or result.get("dataset") != dataset
                or result.get("implementationSha256")
                != native_schema(dataset)["implementationSha256"]
                or result.get("policy") != policies[0]
            ):
                raise ValueError("Restoration result differs from selected coverage inputs")
            if owner.get("rows") is not None and result["rows"] != owner["rows"]:
                raise ValueError("Restored source rows differ from native subject count")
            if fresh:
                temporary = folder / (uuid4().hex + ".json")
                temporary.write_text(json.dumps(result))
                temporary.replace(saved)
                retire_restore_intermediates(request, result)
        value = {
            **owner,
            "urls": result["urls"],
            "rows": result["rows"],
            "_coverageProcessing": result,
        }
        self.cache[identity] = value
        return value

    def table(self, family, generation, dataset, expected=None):
        return self.restore(
            dataset, self.inputs.table(family, generation, dataset, expected)
        )

    def parent(self, child_id, child, relation):
        owner = self.inputs.producing(child_id, child)
        if relation["mode"] == "same-generation":
            spec = owner["artifact"].get("spec", {}).get("etlReceipts", {})
            descriptors = [
                p
                for p in spec.get("policies", [])
                if p.get("dataset") == relation["table"]
            ]
            if descriptors and descriptors[0].get("receipt_only"):
                return self.restore(
                    relation["table"],
                    {
                        **owner,
                        "tableId": relation["table"],
                        "members": [],
                        "rows": None,
                    },
                )
        return self.restore(
            relation["table"], self.inputs.parent(child_id, child, relation)
        )


@contextmanager
def processing_context(dataset, table, policy, inputs, download=None):
    if not policy.get("_nativeProcessing"):
        yield table, inputs
        return
    with tempfile.TemporaryDirectory(prefix="spicygov-native-coverage-") as directory:
        adapted = ProcessingInputs(inputs, directory, download)
        owner = inputs.producing(dataset, table)
        restored = adapted.restore(dataset, owner)
        facts = restored.get("_coverageProcessing")
        if (
            not facts
            or facts.get("implementationSha256")
            != policy.get("restorationImplementationSha256")
            or facts["nativeSchema"] != table["columns"]
            or facts["processingSchema"] != policy["processingSchema"]
        ):
            raise ValueError(
                "Qualified processing schema differs from the reviewed native variant"
            )
        yield (
            {**table, "_coverageUrls": restored["urls"], "_coverageProcessing": facts},
            adapted,
        )
