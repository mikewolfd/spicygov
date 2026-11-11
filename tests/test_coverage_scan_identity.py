"""A table's measurement revision hashes the code that measures it, and only that code.

Editing orchestration, release assembly or time allowances must keep every
checkpoint; editing one scanner must re-measure only that scanner's tables. The
scanner module sets are checked against what the modules actually import, so a
new import cannot silently escape a revision.
"""
import ast
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import coverage_scan

SHARED = {'coverage_scan.py', 'coverage_dimensions.py', 'coverage_inputs.py', 'collection_coverage.py',
          'publication_census.py'}
SCANNER = {'congress': {'congress_coverage.py'}, 'regulation': {'regulation_coverage.py'}, 'fec': {'fec_coverage.py'}}
# Read by hashed modules, but tuning one changes how long a step may run, never what it measures.
UNHASHED = {'coverage_allowances.py'}


def local_imports(name):
    local = {path.name for path in SCRIPTS.glob('*.py')}
    found = set()
    for node in ast.walk(ast.parse((SCRIPTS / name).read_text())):
        if isinstance(node, ast.Import):
            found.update(alias.name.split('.')[0] + '.py' for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level:
            found.add(node.module.split('.')[0] + '.py')
    return found & local


def closure(entries):
    seen, pending = set(), list(entries)
    while pending:
        name = pending.pop()
        if name not in seen:
            seen.add(name)
            pending.extend(local_imports(name))
    return seen


class ScannerIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.folder.cleanup)
        cls.copy = Path(cls.folder.name)
        for path in SCRIPTS.glob('*.py'): shutil.copy(path, cls.copy / path.name)

    def revisions(self):
        with patch.object(coverage_scan, 'SCRIPTS', self.copy):
            return {scanner: coverage_scan.measurement_revision({'_scanner': scanner}) for scanner in SCANNER}

    def dependents(self, name):
        """The scanners whose revisions change when scripts/<name> changes."""
        before, path = self.revisions(), self.copy / name
        original = path.read_bytes()
        try:
            path.write_bytes(original + b'\n# edited\n')
            after = self.revisions()
        finally:
            path.write_bytes(original)
        return {key for key in before if before[key] != after[key]}

    def test_each_revision_depends_on_exactly_the_code_that_measures_the_table(self):
        everything = {path.name for path in SCRIPTS.glob('*.py')}
        expected = {name: {scanner for scanner in SCANNER if name in SHARED | SCANNER[scanner]} for name in everything}
        self.assertEqual({name: self.dependents(name) for name in sorted(everything)}, dict(sorted(expected.items())))
        # Orchestration, release assembly and time allowances keep every checkpoint.
        for name in ('build-coverage-maps.py', 'coverage_release.py', 'coverage_allowances.py'):
            with self.subTest(name=name): self.assertEqual(self.dependents(name), set())

    def test_revisions_are_distinct_digests(self):
        revisions = self.revisions()
        self.assertTrue(all(value.startswith('sha256:') and len(value) == 71 for value in revisions.values()))
        self.assertEqual(len(set(revisions.values())), len(SCANNER))

    def test_every_module_a_scan_can_import_is_in_its_revision(self):
        # The lists above are a claim about imports; check them against the source.
        for scanner in SCANNER:
            with self.subTest(scanner=scanner):
                entries = {'coverage_scan.py', scanner + '_coverage.py'}
                self.assertLessEqual(closure(entries) - UNHASHED, SHARED | SCANNER[scanner])


if __name__ == '__main__': unittest.main()
