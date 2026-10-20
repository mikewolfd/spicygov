"""A table's measurement revision hashes the code that measures it, and only that code.

Editing orchestration, release assembly or time allowances must keep every
checkpoint; editing one scanner must re-measure only that scanner's tables. The
scanner module sets are checked against what the modules actually import, so a
new import cannot silently escape a revision.
"""
import ast
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import coverage_scan
import additional_native_coverage  # noqa: E402 - repository-local script import

SHARED = {'coverage_scan.py', 'coverage_dimensions.py', 'coverage_inputs.py', 'collection_coverage.py',
          'publication_census.py'}
SCANNER = {'congress': {'congress_coverage.py'},
           'regulation': {'regulation_coverage.py', 'native_receipt_coverage.py', 'gao_receipt_policy.py'},
           'fec': {'fec_coverage.py'}}
NATIVE = {'native_legislative_coverage.py'}
ADDITIONAL = {'additional_native_coverage.py', 'restore_additional_coverage.py', 'restore_source_navigation_coverage.py'}
PARENTS = {'court_coverage_parents.py'}
# Read by hashed modules, but tuning one changes how long a step may run, never what it measures.
UNHASHED = {'coverage_allowances.py'}
MODES = ('flat', 'native', 'additional', 'witnessed')
IDENTITY = 'sha256:' + 'a' * 64


def policy(mode, scanner, identity=IDENTITY):
    result = {'_scanner': scanner, **({'_nativeProcessing': True, 'restorationImplementationSha256': identity} if mode == 'native' else {}),
              **({'_additionalNativeProcessing': True, 'restorationImplementationSha256': identity} if mode in ('additional', 'witnessed') else {})}
    if mode == 'witnessed':
        result.update(family='court-opinion-pdf-extractions',
                      _additionalNativeDataset='court_opinion_pdf_extractions',
                      dimensions=[{'kind': 'inherited', 'parent': {
                          'mode': 'recorded-parent', 'table': 'court_opinions',
                          'keys': [['opinion_id', 'opinion_id'], ['cluster_id', 'cluster_id']]}}])
    return result


def hashed(mode, scanner):
    return (SHARED | SCANNER[scanner] | (NATIVE if mode != 'flat' else set())
            | (ADDITIONAL if mode in ('additional', 'witnessed') else set())
            | (PARENTS if mode == 'witnessed' else set()))


def local_imports(name, *, inside_functions, root=SCRIPTS):
    local = {path.name for path in root.glob('*.py')}
    found = set()

    def walk(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Import):
                found.update(alias.name.split('.')[0] + '.py' for alias in child.names)
            elif isinstance(child, ast.ImportFrom) and not child.level:
                found.add(child.module.split('.')[0] + '.py')
            elif inside_functions or not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                walk(child)
    walk(ast.parse((root / name).read_text()))
    return found & local


def closure(entries, *, witnessed=False, root=SCRIPTS):
    """Local modules reachable from entries. coverage_scan's own function-level imports are the
    native and additional gates, so a route names its gate module as an entry instead."""
    seen, pending = set(), list(entries)
    while pending:
        name = pending.pop()
        if name not in seen:
            seen.add(name)
            imports = local_imports(name, inside_functions=name != 'coverage_scan.py', root=root)
            # Only this exact lazy edge is route-specific; the structural test
            # below pins its guarded location. All helper imports are followed.
            if name == 'additional_native_coverage.py' and not witnessed:
                imports -= PARENTS
            pending.extend(imports)
    return seen


class ScannerIdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.folder.cleanup)
        cls.copy = Path(cls.folder.name)
        for path in SCRIPTS.glob('*.py'): shutil.copy(path, cls.copy / path.name)

    def revisions(self, identity=IDENTITY):
        with patch.object(coverage_scan, 'SCRIPTS', self.copy):
            return {(mode, scanner): coverage_scan.measurement_revision(policy(mode, scanner, identity))
                    for mode in MODES for scanner in SCANNER}

    def dependents(self, name):
        """The revisions that change when scripts/<name> changes."""
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
        expected = {name: {(mode, scanner) for mode in MODES for scanner in SCANNER if name in hashed(mode, scanner)}
                    for name in everything}
        self.assertEqual({name: self.dependents(name) for name in sorted(everything)}, dict(sorted(expected.items())))
        # Orchestration, release assembly and time allowances keep every checkpoint.
        for name in ('build-coverage-maps.py', 'coverage_release.py', 'coverage_allowances.py'):
            with self.subTest(name=name): self.assertEqual(self.dependents(name), set())

    def test_one_scanner_edit_changes_only_that_scanners_revisions(self):
        self.assertEqual({scanner for _, scanner in self.dependents('congress_coverage.py')}, {'congress'})
        self.assertEqual({scanner for _, scanner in self.dependents('gao_receipt_policy.py')}, {'regulation'})
        self.assertEqual({scanner for _, scanner in self.dependents('fec_coverage.py')}, {'fec'})
        self.assertEqual(len(self.dependents('congress_coverage.py')), len(MODES))
        # Shared code re-measures everything.
        self.assertEqual(len(self.dependents('coverage_scan.py')), len(MODES) * len(SCANNER))

    def test_witnessed_parent_helper_changes_only_its_declared_routes(self):
        definitions = json.loads((SCRIPTS.parent / 'content/coverage-definitions/regulation.json').read_text())['tables']
        expected = {'court_docket_groups', 'court_opinion_pdf_extractions'}
        policies = {dataset: {**definition, '_scanner': 'regulation',
                              '_additionalNativeProcessing': True,
                              '_additionalNativeDataset': dataset,
                              'restorationImplementationSha256': IDENTITY}
                    for dataset, definition in definitions.items()}
        self.assertEqual({dataset for dataset, value in policies.items()
                          if additional_native_coverage.uses_witnessed_parent(value)}, expected)
        path = self.copy / 'court_coverage_parents.py'
        original = path.read_bytes()
        with patch.object(coverage_scan, 'SCRIPTS', self.copy):
            before = {dataset: coverage_scan.measurement_revision(value) for dataset, value in policies.items()}
            try:
                path.write_bytes(original + b'\n# parent proof changed\n')
                after = {dataset: coverage_scan.measurement_revision(value) for dataset, value in policies.items()}
            finally:
                path.write_bytes(original)
        self.assertEqual({dataset for dataset in before if before[dataset] != after[dataset]}, expected)
        value = policy('witnessed', 'regulation')
        for field, replacement in (('_additionalNativeDataset', 'court_opinions'),
                                   ('family', 'court-opinions'), ('dimensions', [])):
            with self.subTest(field=field):
                self.assertFalse(additional_native_coverage.uses_witnessed_parent({**value, field: replacement}))
        for changes in ({'mode': 'same-generation'}, {'table': 'court_dockets'},
                        {'keys': [['opinion_id', 'opinion_id']]}):
            with self.subTest(relation=changes):
                altered = copy.deepcopy(value)
                altered['dimensions'][0]['parent'].update(changes)
                self.assertFalse(additional_native_coverage.uses_witnessed_parent(altered))

    def test_parent_lazy_import_is_guarded_and_its_helper_imports_cannot_escape(self):
        tree = ast.parse((SCRIPTS / 'additional_native_coverage.py').read_text())
        parent = next(method for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'AdditionalInputs'
                      for method in node.body if isinstance(method, ast.FunctionDef) and method.name == 'parent')
        lazy = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                and node.module == 'court_coverage_parents']
        self.assertEqual(len(lazy), 1)
        index = parent.body.index(lazy[0])
        guard = parent.body[index - 1]
        self.assertIsInstance(guard, ast.If)
        self.assertEqual(ast.unparse(guard.test), 'not witnessed_parent_relation(child_id, relation)')
        self.assertIsInstance(guard.body[0], ast.Raise)
        path = self.copy / 'court_coverage_parents.py'
        original = path.read_bytes()
        new_helper = self.copy / 'unregistered_parent_helper.py'
        try:
            new_helper.write_text('VALUE = 1\n')
            path.write_bytes(original + b'\nimport unregistered_parent_helper\n')
            actual = closure({'court_coverage_parents.py'}, witnessed=True, root=self.copy) - UNHASHED
            self.assertIn('unregistered_parent_helper.py', actual)
            with self.assertRaises(AssertionError):
                self.assertLessEqual(actual, hashed('witnessed', 'regulation'))
        finally:
            path.write_bytes(original)
            new_helper.unlink()

    def test_native_revisions_bind_the_reader_identity_and_flat_ones_do_not_carry_one(self):
        first, second = self.revisions(), self.revisions('sha256:' + 'b' * 64)
        for (mode, scanner), revision in first.items():
            with self.subTest(mode=mode, scanner=scanner):
                self.assertRegex(revision, r'^sha256:[0-9a-f]{64}$')
                self.assertEqual(revision != second[(mode, scanner)], mode != 'flat')
        self.assertEqual(len(set(first.values())), len(first))
        with self.assertRaises(KeyError): coverage_scan.measurement_revision({'_scanner': 'fec', '_nativeProcessing': True})

    def test_every_module_a_scan_can_import_is_in_its_revision(self):
        # The lists above are a claim about imports; check them against the source.
        gates = local_imports('coverage_scan.py', inside_functions=True) - local_imports('coverage_scan.py', inside_functions=False)
        self.assertEqual(gates, {'native_legislative_coverage.py', 'additional_native_coverage.py'})
        for mode in MODES:
            for scanner in SCANNER:
                with self.subTest(mode=mode, scanner=scanner):
                    entries = {'coverage_scan.py', scanner + '_coverage.py'} | (
                        {'native_legislative_coverage.py'} if mode != 'flat' else set()) | (
                        {'additional_native_coverage.py'} if mode in ('additional', 'witnessed') else set())
                    self.assertLessEqual(closure(entries, witnessed=mode == 'witnessed') - UNHASHED, hashed(mode, scanner))


if __name__ == '__main__': unittest.main()
