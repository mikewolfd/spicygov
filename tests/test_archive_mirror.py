import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mirror', Path(__file__).resolve().parents[1]/'scripts/prepare-archive-mirror.py')
mirror = importlib.util.module_from_spec(spec); spec.loader.exec_module(mirror)


class Mirror(unittest.TestCase):
    def fixture(self, root):
        root = root.resolve()
        raw, cache, catalog = (root/name for name in ('raw', 'cache', 'catalog'))
        for path in (raw, cache, catalog): path.mkdir()
        (raw/'snapshot.json').write_text('{"snapshot":1}\n')
        receipt = raw/'acquisitions/sha256/aa'/('a'*64)
        receipt.parent.mkdir(parents=True); receipt.write_text('{}')
        from spicy_regs.source_catalog.selection import raw_selection
        pins = raw_selection(raw)
        generation = 'sha256:'+'b'*64
        body = json.dumps({'generation': generation}).encode()
        (catalog/'manifest.json').write_bytes(body)
        (cache/'current.json').write_text(json.dumps(dict(pins, generation=generation, index='index.sqlite',
            public_manifest_sha256=hashlib.sha256(body).hexdigest())))
        with sqlite3.connect(cache/'index.sqlite') as db:
            db.executescript('CREATE TABLE metadata(key,value); CREATE TABLE inputs(path,sha256,bytes); CREATE TABLE raw_objects(sha256,object,stored_bytes,present);')
            db.execute('INSERT INTO metadata VALUES(?,?)', ('generation', json.dumps(generation)))
            for path in (raw/'snapshot.json', receipt):
                db.execute('INSERT INTO inputs VALUES(?,?,?)', (str(path), mirror.digest(path.read_bytes()), path.stat().st_size))
            db.execute('INSERT INTO raw_objects VALUES(?,?,?,1)', ('sha256:'+'c'*64, 'objects/sha256/cc/'+'c'*64, 27))
        group = dict(both=1, localOnly=0, r2Only=0, sizeMismatch=0, duplicate=0)
        report = dict(format='spicy-archive-inventory-parity', version=1, status='inventory-parity-confirmed',
                      generation='sha256:'+'d'*64, completedAt='2026-10-29T20:16:14Z',
                      rawInventory=pins, objects=group, receipts=group, controls=group,
                      namespaceCheck={'status':'confirmed'})
        inventory = root/'parity.json'; inventory.write_text(json.dumps(report))
        return inventory, cache, catalog, raw

    def test_adopts_only_matching_raw_inventory_without_reading_originals(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.fixture(Path(folder)); calls = []
            def head(key, size):
                calls.append(key); return dict(key=key, bytes=size, status=200)
            value = mirror.prepare(*args, head=head)
            self.assertEqual(len(calls), 3)
            self.assertEqual(value['inventory']['generation'], 'sha256:'+'d'*64)
            self.assertEqual(value['catalog']['generation'], 'sha256:'+'b'*64)
            self.assertEqual(value['inventory']['evidenceSha256'], mirror.digest(args[0].read_bytes()))
            self.assertEqual(value['inventory']['recordedAt'], '2026-10-29T20:16:14Z')
            # No original source file was created: only its selected inventory row exists.
            self.assertFalse((args[3]/calls[0]).exists())

    def test_mismatch_fails_before_network_and_midcheck_changes_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            args = self.fixture(Path(folder)); inventory = args[0]
            original = inventory.read_text(); bad = json.loads(original)
            bad['rawInventory']['raw_snapshot_sha256'] = 'e'*64; inventory.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, 'another raw snapshot'):
                mirror.prepare(*args, head=lambda *_: self.fail('No HEAD on mismatched inventory'))
            inventory.write_text(original)
            def mutate(key, size):
                (args[2]/'manifest.json').write_text('{"changed":true}')
                return dict(key=key, bytes=size, status=200)
            with self.assertRaisesRegex(ValueError, 'changed during preparation'):
                mirror.prepare(*args, head=mutate)

    def test_public_sample_uses_head_and_refuses_size_or_delivery_mismatch(self):
        status, url = '200', mirror.ARCHIVE_BASE+'snapshot.json'
        def head(command, **_):
            self.assertIn('-fsSI',command)
            self.assertNotIn('-L',command)
            return f'HTTP/2 {status}\nContent-Length: 12\n\n\n{status}\n{url}'
        with patch.object(mirror.subprocess, 'check_output', side_effect=head):
            self.assertEqual(mirror.public_head('snapshot.json',12)['status'],200)
            with self.assertRaisesRegex(ValueError,'size differs'): mirror.public_head('snapshot.json',13)
            status = '403'
            with self.assertRaisesRegex(ValueError,'not publicly available'): mirror.public_head('snapshot.json',12)
            status = '200'; url = 'https://other.example/snapshot.json'
            with self.assertRaisesRegex(ValueError,'not publicly available'): mirror.public_head('snapshot.json',12)


if __name__ == '__main__': unittest.main()
