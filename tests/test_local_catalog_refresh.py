"""Actual files exercise the local refresh's byte and date verification boundary."""
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('verify_register', ROOT / 'scripts/verify-register-sources.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
refresh_spec = importlib.util.spec_from_file_location('refresh_catalog', ROOT / 'scripts/refresh-local-catalog.py')
refresh = importlib.util.module_from_spec(refresh_spec)
refresh_spec.loader.exec_module(refresh)


class CompletedRefreshPhases(unittest.TestCase):
    def test_completed_native_build_refuses_changed_rows_with_the_same_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);candidate=root/'index.sqlite'
            with sqlite3.connect(candidate) as db:
                db.executescript('CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE payload(value TEXT);')
                db.execute('INSERT INTO metadata VALUES(?,?)',('generation',json.dumps('g')))
                db.execute("INSERT INTO payload VALUES('valid')")
            completed=refresh.CompletedSteps(root,{'definitions':'fixed'})
            def build(*args,stdout,**kwargs):stdout.write('{"status":"validated","generation":"g"}')
            outputs=lambda value: () if value['status']=='unchanged' else (candidate,)
            with patch.object(refresh.subprocess,'run',side_effect=build):
                completed.step('build',['native-build'],cwd=root,artifacts=outputs)
            with sqlite3.connect(candidate) as db:
                db.execute("UPDATE payload SET value='other'")
            with self.assertRaisesRegex(ValueError,'Completed refresh phase changed'):
                refresh.CompletedSteps(root,{'definitions':'fixed'}).step(
                    'build',['native-build'],cwd=root,artifacts=outputs)

    def test_native_completion_reuse_rejects_a_different_candidate_or_report(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate=Path(directory)/'index.sqlite'
            report={'status':'validated','generation':'g','validation':{'foreignKeys':[]}}
            with sqlite3.connect(candidate) as db:
                db.execute('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)')
                db.executemany('INSERT INTO metadata VALUES(?,?)',
                    [('generation',json.dumps('g')),('reconciliation',json.dumps(report))])
            refresh.native_validation(candidate,report,dict(report))
            with self.assertRaisesRegex(ValueError,'native builder validation'):
                refresh.native_validation(candidate,report,{**report,'generation':'other'})
            with sqlite3.connect(candidate) as db:
                db.execute("UPDATE metadata SET value=? WHERE key='generation'",(json.dumps('other'),))
            with self.assertRaisesRegex(ValueError,'native builder validation'):
                refresh.native_validation(candidate,report,report)

    def test_fresh_process_style_resume_reuses_export_and_rejects_same_size_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);export=root/'public';export.mkdir()
            (export/'member').write_bytes(b'valid')
            def command(*args,stdout,**kwargs):stdout.write('{"generation":"g"}')
            first=refresh.CompletedSteps(root,{'receipts':['immutable-receipt']})
            with patch.object(refresh.subprocess,'run',side_effect=command) as run:
                first.step('export',['export'],cwd=root,artifacts=(export,))
                self.assertEqual(run.call_count,1)
            resumed=refresh.CompletedSteps(root,{'receipts':['immutable-receipt']})
            with patch.object(refresh.subprocess,'run',side_effect=AssertionError('Repeated export')):
                self.assertEqual(resumed.step('export',['export'],cwd=root,artifacts=(export,))['generation'],'g')
            (export/'member').write_bytes(b'other')
            with self.assertRaisesRegex(ValueError,'Completed refresh phase changed'):
                resumed.step('export',['export'],cwd=root,artifacts=(export,))
            with self.assertRaisesRegex(ValueError,'inputs changed'):
                refresh.CompletedSteps(root,{'receipts':['immutable-receipt','later-receipt']})


class FixedInputSelectionBoundary(unittest.TestCase):
    """A native-accepted late receipt must not escape the wrapper's fixed capture."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.website, self.raw, self.cache, self.public, self.run = [
            self.root/name for name in ('site', 'raw', 'cache', 'public', 'run')]
        for path in (self.website/'scripts', self.website/'lib', self.raw/'acquisitions/sha256', self.cache, self.public):
            path.mkdir(parents=True)
        for name in ('refresh-local-catalog.py', 'verify-register-sources.py', 'stage-source-catalog.mjs',
                     'catalog-inspection.mjs', 'register-source-periods.mjs'):
            (self.website/'scripts'/name).write_text('fixed implementation')
        (self.website/'lib/source-catalog.ts').write_text('fixed schema')
        (self.website/'package-lock.json').write_text('{}')
        (self.raw/'snapshot.json').write_text('{}')
        self.publication = self.root/'publication.json'
        self.publication.write_text('{}')
        self.old, self.new = 'sha256:'+'a'*64, 'sha256:'+'b'*64
        self.write(self.cache/'current.json', {'generation': self.old})
        self.index(self.cache/'index.sqlite', self.old)
        for path in (self.public, self.website/'public/source-catalog', self.website/'dist/source-catalog'):
            path.mkdir(parents=True, exist_ok=True)
            self.write(path/'manifest.json', {'generation': self.old})
        self.calls = []
        self.late_at = None
        self.interrupt_inspection = False
        self.arguments = ['refresh-local-catalog.py', '--raw-root', str(self.raw), '--cache', str(self.cache),
            '--public', str(self.public), '--run', str(self.run), '--publication-reconciliation', str(self.publication)]

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def index(self, path, generation, report=None):
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);'
                             'CREATE TABLE tables(id TEXT,collection_id TEXT,data TEXT);')
            db.execute('INSERT INTO metadata VALUES(?,?)', ('generation', json.dumps(generation)))
            if report is not None:
                db.execute('INSERT INTO metadata VALUES(?,?)', ('reconciliation', json.dumps(report)))

    def add_receipt(self):
        body = b'{"receipt":"late addition"}'
        sha = hashlib.sha256(body).hexdigest()
        path = self.raw/'acquisitions/sha256'/sha[:2]/sha
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(body)

    def command(self, command, *, stdout, **kwargs):
        action = command[3] if command[:3] == [refresh.sys.executable, '-m', 'spicy_regs.source_catalog'] else (
            'verify-sources' if command[1] == 'scripts/verify-register-sources.py' else
            'inspect' if '--inspect' in command else 'stage')
        self.calls.append(action)
        periods = {'generation': self.new, 'months': ['2026-09'], 'latestIndexedDate': '2026-09-30'}
        if action == 'refresh-metadata':
            if self.late_at == 'unchanged':
                value = {'status': 'unchanged', 'generation': self.old}
                self.add_receipt()
            else:
                if self.late_at == 'build': self.add_receipt()
                value = {'status': 'validated', 'generation': self.new,
                         'rawInventory': {'raw_acquisition_receipts': int(self.late_at == 'build')}}
                self.index(self.run/'index.sqlite', self.new, value)
                self.write(self.run/'index.sqlite.reconciliation.json', value)
        elif action == 'verify-sources': value = {**periods, 'verifiedObjects': 1}
        elif action == 'export':
            target = self.run/'public'; target.mkdir()
            value = {'generation': self.new}; self.write(target/'manifest.json', value)
        elif action == 'inspect':
            if self.interrupt_inspection:
                self.interrupt_inspection = False
                raise RuntimeError('interruption after completed export')
            self.write(self.run/'source-periods.json', periods)
            value = {'generation': self.new, 'files': []}
        elif action == 'stage':
            target = Path(command[-1]); target.mkdir(parents=True)
            self.write(target/'manifest.json', {'generation': self.new})
            if self.late_at == 'stage': self.add_receipt()
            if self.late_at == 'publication': self.publication.write_text('{"changed":true}')
            value = {'generation': self.new}
        elif action == 'select': value = {'status': 'selected', 'generation': self.new}
        else: raise AssertionError('Unexpected fixture command: '+str(command))
        stdout.write(json.dumps(value))

    def execute(self, resume=False):
        with (patch.object(refresh.sys, 'argv', self.arguments+(['--resume'] if resume else [])),
              patch.object(refresh, '__file__', str(self.website/'scripts/refresh-local-catalog.py')),
              patch.object(refresh.shutil, 'disk_usage', return_value=SimpleNamespace(free=1024**4)),
              patch.object(refresh.subprocess, 'check_output', return_value='v22.13.0\n'),
              patch.object(refresh.subprocess, 'run', side_effect=self.command),
              patch.object(refresh, 'finish_selected') as finish):
            refresh.main()
            return finish.call_count

    def test_late_receipts_or_changed_selected_inputs_stop_before_selection_and_keep_outputs(self):
        for boundary in ('build', 'stage', 'publication'):
            with self.subTest(boundary=boundary):
                if self.run.exists(): shutil.rmtree(self.run)
                for path in self.raw.glob('acquisitions/sha256/*/*'): path.unlink()
                for path in (self.website/'public').glob('.catalog-*'): shutil.rmtree(path)
                self.publication.write_text('{}')
                self.calls.clear(); self.late_at = boundary
                with self.assertRaisesRegex(ValueError, 'inputs changed before selection'):
                    self.execute()
                self.assertNotIn('select', self.calls)
                self.assertEqual(json.loads((self.cache/'current.json').read_text())['generation'], self.old)
                for name in ('build', 'verify-sources', 'export', 'inspect', 'stage'):
                    self.assertTrue((self.run/(name+'.done.json')).is_file())
                self.assertTrue((self.run/'index.sqlite').is_file())
                completed = (self.run/'export.done.json').read_bytes()
                self.calls.clear()
                with self.assertRaisesRegex(ValueError, 'Refresh inputs changed'):
                    self.execute(resume=True)
                self.assertEqual(self.calls, [])
                self.assertEqual((self.run/'export.done.json').read_bytes(), completed)

    def test_unchanged_result_is_refused_if_a_receipt_arrives_before_completion(self):
        self.late_at = 'unchanged'
        with self.assertRaisesRegex(ValueError, 'inputs changed before unchanged completion'):
            self.execute()
        self.assertFalse((self.run/'complete.json').exists())
        self.assertFalse((self.run/'index.sqlite').exists())

    def test_failed_run_releases_its_run_lock(self):
        self.late_at = 'stage'
        locks = []
        original = Path.open
        def opened(path, *args, **kwargs):
            stream = original(path, *args, **kwargs)
            if path.resolve() == (self.run/'run.lock').resolve(): locks.append(stream)
            return stream
        with patch.object(Path, 'open', opened):
            with self.assertRaisesRegex(ValueError, 'inputs changed before selection'):
                self.execute()
        self.assertEqual(len(locks), 1)
        self.assertTrue(locks[0].closed)

    def test_stable_interrupted_run_reuses_completed_build_audit_and_export(self):
        self.interrupt_inspection = True
        with self.assertRaisesRegex(RuntimeError, 'interruption after completed export'):
            self.execute()
        before = {name: (self.run/(name+'.done.json')).read_bytes()
                  for name in ('build', 'verify-sources', 'export')}
        self.calls.clear()
        self.assertEqual(self.execute(resume=True), 1)
        self.assertEqual(self.calls, ['inspect', 'stage', 'select'])
        for name, raw in before.items():
            self.assertEqual((self.run/(name+'.done.json')).read_bytes(), raw)

    def test_cohort_and_prior_audit_are_forwarded_and_pinned_for_resume(self):
        cohort,proof = self.root/'affected.txt',self.root/'audit.json'
        cohort.write_text('sha256:'+'c'*64+'\n');proof.write_text('{}')
        self.arguments += ['--refresh-object-list',str(cohort),'--reuse-source-verification',str(proof)]
        commands=[]
        original=self.command
        def observed(command,**kwargs):
            commands.append(command)
            return original(command,**kwargs)
        self.command=observed
        self.assertEqual(self.execute(),1)
        build=next(c for c in commands if 'refresh-metadata' in c)
        audit=next(c for c in commands if 'scripts/verify-register-sources.py' in c)
        self.assertEqual(build[build.index('--refresh-object-list')+1],str(cohort.resolve()))
        self.assertEqual(audit[audit.index('--reuse-verified')+1],str(proof.resolve()))
        self.assertEqual(audit[audit.index('--objects-from')+1],str(cohort.resolve()))
        self.assertEqual(audit[audit.index('--base-index')+1],str((self.cache/'index.sqlite').resolve()))
        pins=json.loads((self.run/'input-snapshot.json').read_text())['definitions']
        self.assertIn(str(cohort.resolve()),pins);self.assertIn(str(proof.resolve()),pins)
        proof.write_text('{"changed":true}')
        self.calls.clear()
        with self.assertRaisesRegex(ValueError,'Refresh inputs changed'):self.execute(resume=True)
        self.assertEqual(self.calls,[])


class LocalSourceVerification(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.index = self.root / 'index.sqlite'
        self.raw = self.root / 'raw'
        self.raw.mkdir()
        with sqlite3.connect(self.index) as db:
            db.executescript('''CREATE TABLE metadata(key TEXT,value TEXT);
                CREATE TABLE files(collection_id TEXT,status TEXT,sha256 TEXT);
                CREATE TABLE objects(sha256 TEXT,bytes INTEGER);
                CREATE TABLE raw_objects(sha256 TEXT,object TEXT,encoding TEXT,stored_bytes INTEGER,stored_sha256 TEXT);''')
            db.execute('INSERT INTO metadata VALUES(?,?)', ('generation', json.dumps('sha256:' + 'a' * 64)))

    def tearDown(self):
        self.temp.cleanup()

    def source(self, body, *, identity=None, status='held'):
        key = identity or hashlib.sha256(body).hexdigest()
        packed = gzip.compress(body, mtime=0)
        relative = f'objects/sha256/{key[:2]}/{key}.gz'
        path = self.raw / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(packed)
        with sqlite3.connect(self.index) as db:
            db.execute('INSERT INTO files VALUES(?,?,?)', ('family:federal-register', status, 'sha256:' + key))
            db.execute('INSERT INTO objects VALUES(?,?)', ('sha256:' + key, len(body)))
            db.execute('INSERT INTO raw_objects VALUES(?,?,?,?,?)',
                       ('sha256:' + key, relative, 'gzip', len(packed), hashlib.sha256(packed).hexdigest()))
        return path

    def test_readable_dates_and_unknown_formats_remain_distinct(self):
        self.source(b'<html><title>Federal Register, Volume 91 Issue 188 (Wednesday, September 30, 2026)</title></html>')
        self.source(b'Unrecognized source format with a mentioned date: October 2, 2026')
        self.source(b'{"publication_date":"2026-10-02"}', status='missing-bytes')
        report = module.verify(self.index, self.raw)
        self.assertEqual(report['verifiedObjects'], 2)
        self.assertEqual(report['months'], ['2026-09'])
        self.assertEqual(report['latestIndexedDate'], '2026-09-30')
        self.assertEqual(report['dateOutcomes'], {'ok': 1, 'unsupported': 1})

    def test_same_size_corruption_stops_the_refresh(self):
        path = self.source(b'original content')
        body = bytearray(path.read_bytes())
        body[-1] ^= 1
        path.write_bytes(body)
        with self.assertRaisesRegex(ValueError, 'Stored bytes differ'):
            module.verify(self.index, self.raw)

    def test_storage_hash_cannot_substitute_for_the_original_hash(self):
        self.source(b'original content', identity='b' * 64)
        with self.assertRaisesRegex(ValueError, 'Original bytes differ'):
            module.verify(self.index, self.raw)

    def test_symlinks_do_not_establish_local_file_verification(self):
        path = self.source(b'original content')
        moved = self.root / 'outside.gz'
        path.rename(moved)
        path.symlink_to(moved)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            module.verify(self.index, self.raw)


class SelectedRefreshRecovery(unittest.TestCase):
    """Exercise completion/recovery using bounded native-owner control fixtures."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.website, self.run, self.cache, self.public = [self.root / name for name in ('website', 'run', 'cache', 'selected-public')]
        for path in (self.website / 'public/source-catalog', self.run, self.cache, self.public):
            path.mkdir(parents=True)
        self.generation = 'sha256:' + 'a' * 64
        self.manifest = json.dumps({'generation': self.generation}).encode()
        for directory in (self.public, self.website / 'public/source-catalog'):
            (directory / 'manifest.json').write_bytes(self.manifest)
        self.write(self.cache / 'current.json', {'generation': self.generation,
            'public_manifest_sha256': hashlib.sha256(self.manifest).hexdigest()})
        pins = [{'path': 'manifest.json', 'bytes': len(self.manifest),
                 'sha256': 'sha256:' + hashlib.sha256(self.manifest).hexdigest()}]
        self.write(self.cache / 'selection.json', {'generation': self.generation, 'files': pins})
        with sqlite3.connect(self.cache / 'index.sqlite') as db:
            db.execute('CREATE TABLE metadata(key TEXT,value TEXT)')
            db.execute('INSERT INTO metadata VALUES(?,?)', ('generation', json.dumps(self.generation)))
        self.write(self.run / 'inspect.json', {'files': pins})
        self.write(self.run / 'export.json', {'generation': self.generation})
        self.summary = {'generation': self.generation, 'months': ['2026-09'], 'latestIndexedDate': '2026-09-30',
                        'dateCoverage': {'files': 1, 'datedFiles': 1, 'undatedFiles': 0}}
        self.write(self.run / 'verify-sources.json', {**self.summary, 'verifiedObjects': 1})
        self.native_backup = self.cache / 'selection-backup-owned'
        self.native_backup.mkdir()
        self.write(self.native_backup / 'recovery.json', {'generation': self.generation})
        self.write(self.run / 'select.json', {'status': 'selected', 'generation': self.generation,
                                            'backup': str(self.native_backup)})
        (self.run / 'previous-site-catalog').mkdir()
        self.args = SimpleNamespace(cache=self.cache, public=self.public, coverage_selection=None)

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value))

    def build_only(self, command, **kwargs):
        self.assertEqual(command, ['npm', 'run', 'build:ui', '--', '--coverage', 'unavailable'])
        self.write(self.website / 'public/register-source-periods.v1.json', self.summary)
        (self.website / 'dist/source-catalog').mkdir(parents=True, exist_ok=True)
        (self.website / 'dist/source-catalog/manifest.json').write_bytes(self.manifest)
        self.write(self.website / 'dist/register-source-periods.v1.json', self.summary)

    def test_selected_retry_runs_only_the_website_and_retires_its_backup(self):
        with patch.object(refresh.subprocess, 'run', side_effect=self.build_only) as called:
            refresh.finish_selected(self.args, self.website, self.run)
        self.assertEqual(called.call_count, 1)
        self.assertTrue((self.run / 'complete.json').exists())
        self.assertFalse(self.native_backup.exists())

    def test_failed_build_preserves_recovery_then_successful_retry_reuses_selection(self):
        with patch.object(refresh.subprocess, 'run', side_effect=RuntimeError('build stopped')):
            with self.assertRaisesRegex(RuntimeError, 'build stopped'):
                refresh.finish_selected(self.args, self.website, self.run)
        self.assertTrue(self.native_backup.exists())
        self.assertTrue((self.run / 'previous-site-catalog').exists())
        self.assertFalse((self.run / 'complete.json').exists())
        with patch.object(refresh.subprocess, 'run', side_effect=self.build_only):
            refresh.finish_selected(self.args, self.website, self.run)

    def test_lost_acknowledgement_reconciles_native_controls_and_keeps_backups(self):
        (self.run / 'select.json').write_bytes(b'')
        with patch.object(refresh.subprocess, 'run', side_effect=self.build_only):
            refresh.finish_selected(self.args, self.website, self.run)
        self.assertEqual(json.loads((self.run / 'recovered-select.json').read_text())['acknowledgedBy'], 'native-controls')
        self.assertTrue(self.native_backup.exists())

    def test_changed_native_selection_refuses_before_build_or_cleanup(self):
        self.write(self.cache / 'selection.json', {'generation': 'sha256:' + 'b' * 64, 'files': []})
        with patch.object(refresh.subprocess, 'run') as called:
            with self.assertRaisesRegex(ValueError, 'inconsistent'):
                refresh.finish_selected(self.args, self.website, self.run)
        called.assert_not_called()
        self.assertTrue(self.native_backup.exists())

    def test_finish_selected_cli_skips_new_refresh_preflight(self):
        arguments = ['refresh-local-catalog.py', '--finish-selected', '--raw-root', str(self.root / 'raw'),
                     '--cache', str(self.cache), '--public', str(self.public), '--run', str(self.run)]
        with (patch.object(refresh.sys, 'argv', arguments),
              patch.object(refresh, '__file__', str(self.website / 'scripts/refresh-local-catalog.py')),
              patch.object(refresh.subprocess, 'run', side_effect=self.build_only) as called):
            refresh.main()
        self.assertEqual(called.call_count, 1)

    def test_a_different_generations_backup_is_preserved_without_a_completion_marker(self):
        self.write(self.native_backup / 'recovery.json', {'generation': 'sha256:' + 'b' * 64})
        with patch.object(refresh.subprocess, 'run', side_effect=self.build_only):
            with self.assertRaisesRegex(ValueError, 'different generation'):
                refresh.finish_selected(self.args, self.website, self.run)
        self.assertTrue(self.native_backup.exists())
        self.assertFalse((self.run / 'complete.json').exists())


if __name__ == '__main__':
    unittest.main()
