"""Select the maintained reader qualified for this exact dataset.

Keep the established legislative reader for every other dataset and bind its
identity to the bulk receipt validator it calls. The court-key mapping correction
applies only to document_citations and retains that reader's own identity.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def implementation_identity(maintained_identity, script):
    if not isinstance(maintained_identity, str) or not maintained_identity.startswith("sha256:"):
        raise ValueError("Maintained coverage reader has no implementation SHA-256")
    bulk = script.resolve().parents[1] / "src/spicy_regs/etl_bulk.py"
    if not bulk.is_file():
        raise ValueError("Maintained coverage reader requires its selected etl_bulk.py")
    value = hashlib.sha256(maintained_identity.encode())
    for path in (Path(__file__), bulk):
        data = path.read_bytes()
        value.update(len(data).to_bytes(8, "big"))
        value.update(data)
    return "sha256:" + value.hexdigest()


def main():
    args = sys.argv[1:]
    payload = None if args else sys.stdin.read()
    dataset = args[1] if len(args) == 2 and args[0] == "--schema" else json.loads(payload)["dataset"] if payload is not None else None
    prefix = "SPICYGOV_PRINT_CITATION" if dataset == "document_citations" else "SPICYGOV_LEGACY"
    script = Path(os.environ[prefix + "_COVERAGE_BRIDGE"])
    python = Path(os.environ[prefix + "_COVERAGE_PYTHON"])
    if not script.is_absolute() or not script.is_file() or not python.is_absolute() or not python.is_file():
        raise ValueError("Coverage readers require existing absolute paths")
    if dataset is None or dataset == "document_citations":
        result = subprocess.run([str(python), str(script), *args], input=payload, text=True)
        sys.exit(result.returncode)
    result = subprocess.run([str(python), str(script), *args], input=payload, text=True,
                            stdout=subprocess.PIPE)
    if result.returncode == 0:
        value = json.loads(result.stdout)
        value["implementationSha256"] = implementation_identity(value.get("implementationSha256"), script)
        print(json.dumps(value))
    else:
        sys.stdout.write(result.stdout)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
