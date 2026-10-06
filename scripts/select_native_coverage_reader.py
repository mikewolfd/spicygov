"""Select the maintained reader qualified for this exact dataset.

Keep the established legislative reader for every other dataset. The court-key
mapping correction applies only to document_citations and returns its own
implementation identity, so only that table's checkpoint changes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    args = sys.argv[1:]
    payload = None if args else sys.stdin.read()
    dataset = args[1] if len(args) == 2 and args[0] == "--schema" else json.loads(payload)["dataset"] if payload is not None else None
    prefix = "SPICYGOV_PRINT_CITATION" if dataset == "document_citations" else "SPICYGOV_LEGACY"
    script = Path(os.environ[prefix + "_COVERAGE_BRIDGE"])
    python = Path(os.environ[prefix + "_COVERAGE_PYTHON"])
    if not script.is_absolute() or not script.is_file() or not python.is_absolute() or not python.is_file():
        raise ValueError("Coverage readers require existing absolute paths")
    result = subprocess.run([str(python), str(script), *args], input=payload, text=True)
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
