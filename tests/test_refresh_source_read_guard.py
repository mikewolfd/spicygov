"""The OS, not a mocked source reader, must deny the positive control."""
import importlib.util
from pathlib import Path
import platform
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('source_read_guard',ROOT/'scripts/check-refresh-no-original-reads.py')
guard=importlib.util.module_from_spec(spec);spec.loader.exec_module(guard)


@unittest.skipUnless(platform.system()=='Darwin' and Path('/usr/bin/sandbox-exec').is_file(),
                     'Requires the real macOS kernel sandbox')
class KernelSourceReadGuard(unittest.TestCase):
    def test_guard_blocks_python_and_native_opens_but_allows_control_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();objects=root/'objects';objects.mkdir()
            original, control=objects/'original',root/'control'
            original.write_text('original');control.write_text('control')
            guard.check_canary(guard.policy_for(objects),control,original)
            self.assertEqual(original.read_text(),'original')

    def test_a_missing_deny_rule_cannot_pass_the_positive_control(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();original,control=root/'original',root/'control'
            original.write_text('original');control.write_text('control')
            with self.assertRaisesRegex(ValueError,'read-denial control failed'):
                guard.check_canary('(version 1)(allow default)',control,original)


class BoundedChildLifetime(unittest.TestCase):
    def test_a_different_archive_cannot_receive_the_selected_archives_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();cache=root/'cache';cache.mkdir()
            selected,other=root/'selected',root/'other'
            for path in (selected,other): (path/'objects/sha256').mkdir(parents=True)
            (cache/'current.json').write_text(json.dumps({'generation':'g'}))
            with sqlite3.connect(cache/'index.sqlite') as db:
                db.executescript('CREATE TABLE inputs(path TEXT); CREATE TABLE metadata(key TEXT,value TEXT);')
                db.execute('INSERT INTO inputs VALUES(?)',(str(selected/'snapshot.json'),))
                db.execute('INSERT INTO metadata VALUES(?,?)',('generation',json.dumps('g')))
            self.assertEqual(guard.selected_archive(cache,selected),'g')
            with self.assertRaisesRegex(ValueError,'does not match'):
                guard.selected_archive(cache,other)

    def test_timeout_reaps_the_owned_child(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            guard.run_bounded([sys.executable,'-c','import time; time.sleep(30)'],0.05)


if __name__=='__main__':unittest.main()
