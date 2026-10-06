"""Routing preserves the selected dataset, request and maintained reader identity."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROUTER = Path(__file__).resolve().parents[1] / "scripts/select_native_coverage_reader.py"


class SelectedReaderTests(unittest.TestCase):
    def test_only_document_citations_uses_the_corrected_reader(self):
        with tempfile.TemporaryDirectory() as folder:
            env = dict(os.environ)
            for name in ("LEGACY", "PRINT_CITATION"):
                script = Path(folder) / (name + ".py")
                script.write_text("import sys,json\nprint(json.dumps({'reader':" + repr(name) + ", 'args':sys.argv[1:], 'input':None if sys.argv[1:] else sys.stdin.read()}))\n")
                env["SPICYGOV_" + name + "_COVERAGE_BRIDGE"] = str(script)
                env["SPICYGOV_" + name + "_COVERAGE_PYTHON"] = sys.executable
            for dataset, expected in (("document_citations", "PRINT_CITATION"), ("bill_versions", "LEGACY"), ("document_citation_reads", "LEGACY")):
                described = subprocess.run([sys.executable, str(ROUTER), "--schema", dataset], env=env, text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(described.stdout), {"reader":expected, "args":["--schema",dataset], "input":None})
                request = json.dumps({"dataset":dataset, "generationId":"exact-generation", "subjects":[{"path":"literal retained member"}]}, indent=2)
                restored = subprocess.run([sys.executable, str(ROUTER)], env=env, input=request, text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(restored.stdout), {"reader":expected, "args":[], "input":request})


if __name__ == "__main__":
    unittest.main()
