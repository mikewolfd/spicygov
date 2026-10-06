"""Routing binds legacy bulk validation and preserves the external citation reader."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROUTER = Path(__file__).resolve().parents[1] / "scripts/select_native_coverage_reader.py"


class SelectedReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = dict(os.environ)
        self.identity = "sha256:" + "a" * 64
        self.scripts = {}
        for name in ("LEGACY", "PRINT_CITATION"):
            script = self.root / name / "scripts/restore_coverage_processing.py"
            script.parent.mkdir(parents=True)
            script.write_text("import sys,json\nprint(json.dumps({'reader':" + repr(name)
                              + ", 'implementationSha256':" + repr(self.identity)
                              + ", 'args':sys.argv[1:], 'input':None if sys.argv[1:] else sys.stdin.read()}))\n")
            self.scripts[name] = script
            self.env["SPICYGOV_" + name + "_COVERAGE_BRIDGE"] = str(script)
            self.env["SPICYGOV_" + name + "_COVERAGE_PYTHON"] = sys.executable
        self.bulk = self.root / "LEGACY/src/spicy_regs/etl_bulk.py"
        self.bulk.parent.mkdir(parents=True)
        self.bulk.write_text("# selected bulk validator\n")

    def run_reader(self, args=(), request=None, check=True):
        return subprocess.run([sys.executable, str(ROUTER), *args], env=self.env,
                              input=request, text=True, capture_output=True, check=check)

    def test_only_document_citations_uses_the_corrected_reader(self):
        for dataset, expected in (("document_citations", "PRINT_CITATION"), ("bill_versions", "LEGACY"), ("document_citation_reads", "LEGACY")):
            described = json.loads(self.run_reader(["--schema", dataset]).stdout)
            identity = described.pop("implementationSha256")
            self.assertEqual(described, {"reader":expected, "args":["--schema",dataset], "input":None})
            self.assertEqual(identity == self.identity, expected == "PRINT_CITATION")
            request = json.dumps({"dataset":dataset, "generationId":"exact-generation", "subjects":[{"path":"literal retained member"}]}, indent=2)
            restored = json.loads(self.run_reader(request=request).stdout)
            self.assertEqual(restored.pop("implementationSha256"), identity)
            self.assertEqual(restored, {"reader":expected, "args":[], "input":request})

    def test_bulk_only_change_invalidates_description_and_restoration(self):
        request = json.dumps({"dataset":"bill_versions", "generationId":"exact-generation"})
        before = json.loads(self.run_reader(["--schema", "bill_versions"]).stdout)
        restored_before = json.loads(self.run_reader(request=request).stdout)
        citation_before = self.run_reader(["--schema", "document_citations"]).stdout
        self.bulk.write_text("# changed bulk validator only\n")
        after = json.loads(self.run_reader(["--schema", "bill_versions"]).stdout)
        restored_after = json.loads(self.run_reader(request=request).stdout)
        self.assertEqual(self.run_reader(["--schema", "document_citations"]).stdout, citation_before)
        before_identity = before.pop("implementationSha256")
        after_identity = after.pop("implementationSha256")
        self.assertNotEqual(before_identity, after_identity)
        self.assertEqual(restored_before.pop("implementationSha256"), before_identity)
        self.assertEqual(restored_after.pop("implementationSha256"), after_identity)
        self.assertEqual(before, after)
        self.assertEqual(restored_before, restored_after)

    def test_exact_maintained_identity_is_still_a_dependency(self):
        before = json.loads(self.run_reader(["--schema", "bill_versions"]).stdout)
        script = self.scripts["LEGACY"]
        script.write_text(script.read_text().replace(self.identity, "sha256:" + "b" * 64))
        after = json.loads(self.run_reader(["--schema", "bill_versions"]).stdout)
        self.assertNotEqual(before.pop("implementationSha256"), after.pop("implementationSha256"))
        self.assertEqual(before, after)

    def test_missing_bulk_dependency_and_invalid_json_are_refused(self):
        self.bulk.unlink()
        missing = self.run_reader(["--schema", "bill_versions"], check=False)
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("requires its selected etl_bulk.py", missing.stderr)
        self.scripts["LEGACY"].write_text("print('not JSON')\n")
        invalid = self.run_reader(["--schema", "bill_versions"], check=False)
        self.assertNotEqual(invalid.returncode, 0)
        self.assertEqual(invalid.stdout, "")

    def test_delegated_failure_preserves_stdout_stderr_and_exit_status(self):
        self.scripts["LEGACY"].write_text("import sys\nprint('reader output')\nprint('reader refusal', file=sys.stderr)\nsys.exit(7)\n")
        for args in (["--verify-artifacts"], ["--schema", "bill_versions"]):
            with self.subTest(args=args):
                result = self.run_reader(args, check=False)
                self.assertEqual(result.returncode, 7)
                self.assertEqual(result.stdout, "reader output\n")
                self.assertEqual(result.stderr, "reader refusal\n")

    def test_unrelated_command_preserves_external_output_without_an_identity(self):
        self.scripts["LEGACY"].write_text("print('[{\"artifactDigest\": \"exact-pin\"}]')\n")
        result = self.run_reader(["--verify-artifacts"])
        self.assertEqual(result.stdout, '[{"artifactDigest": "exact-pin"}]\n')


if __name__ == "__main__":
    unittest.main()
