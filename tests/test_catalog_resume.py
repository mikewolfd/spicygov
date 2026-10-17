"""Bounded retry probes with constructed bytes; no network or publisher."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fetch', ROOT / 'scripts/fetch-source-catalog.py')
fetch = importlib.util.module_from_spec(spec); spec.loader.exec_module(fetch)
spec = importlib.util.spec_from_file_location('archive', ROOT / 'scripts/source-catalog-archive.py')
archive = importlib.util.module_from_spec(spec); spec.loader.exec_module(archive)
sha = lambda raw: 'sha256:' + hashlib.sha256(raw).hexdigest()


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work, self.output = self.root / 'work', self.root / 'output'
        raw = b'{}'
        self.members = [{'path': 'manifest.json', 'bytes': 2, 'sha256': sha(raw)}]
        selected = json.dumps({'format': 'spicy-public-source-catalog-selection', 'version': 1,
                              'generation': 'sha256:' + 'a'*64, 'files': self.members}).encode()
        stream = io.BytesIO()
        with gzip.GzipFile(filename='', mtime=0, compresslevel=6, fileobj=stream, mode='wb') as zipped:
            zipped.write(archive.canonical_header('manifest.json', 2) + raw + b'\0'*9726)
        self.inputs = {'public-selection.json': selected, 'public-catalog.tar.gz': stream.getvalue()}
        self.manifest = self.root / 'release.json'
        self.manifest.write_text(json.dumps({'format': 'spicygov-source-catalog-release', 'version': 1,
            'generation': 'sha256:'+'a'*64,
            'selection': {'bytes': len(selected), 'sha256': sha(selected)},
            'archive': {'bytes': len(stream.getvalue()), 'sha256': sha(stream.getvalue())},
            'decodedBytes': 10240, 'members': 1, 'memberBytes': 2}))
        self.gets, self.stages = 0, 0

    def download(self, url, output, size, digest, **kwargs):
        self.gets += 1
        raw = self.inputs[url.rsplit('/', 1)[1]]
        self.assertEqual((len(raw), sha(raw)), (size, digest))
        output.write_bytes(raw)

    def stage(self, command, **kwargs):
        self.stages += 1
        destination = Path(command[-1])
        shutil.copytree(command[-4], destination)
        returncode = 7 if self.stages == 1 else 0
        class Process:
            pid = 987654321
            def poll(self): return returncode
            def wait(self, **kwargs): return returncode
        result = Process(); result.returncode = returncode
        return result

    def run_main(self):
        with patch.object(sys, 'argv', ['fetch', '--manifest', str(self.manifest), '--work-dir', str(self.work), '--output', str(self.output)]), \
             patch.object(fetch, 'download', side_effect=self.download), \
             patch.object(fetch.subprocess, 'Popen', side_effect=self.stage):
            fetch.main()

    def test_failed_stage_reuses_inputs_and_extraction_with_zero_additional_get(self):
        with self.assertRaises(subprocess.CalledProcessError): self.run_main()
        self.assertEqual(self.gets, 2); self.assertFalse(self.output.exists())
        self.run_main()
        self.assertEqual(self.gets, 2); self.assertEqual(self.stages, 2)
        self.assertEqual((self.output/'manifest.json').read_bytes(), b'{}')
        self.run_main()  # Still reruns semantic staging rather than trusting prior success.
        self.assertEqual((self.gets, self.stages), (2, 3))

    def test_corrupt_verified_input_refuses_without_get(self):
        with self.assertRaises(subprocess.CalledProcessError): self.run_main()
        next(self.work.glob('*/public-catalog.tar.gz')).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'size differs'): self.run_main()
        self.assertEqual(self.gets, 2)

    def test_selected_member_count_retry_and_existing_output_fit_finite_inventory(self):
        count=fetch.release_manifest(fetch.MANIFEST)['members']
        generation='sha256:'+'a'*64
        self.members=[{'path':'manifest.json' if i==0 else f'generations/{generation[7:]}/{i}.json',
                       'bytes':2,'sha256':sha(b'{}')} for i in range(count)]
        raw=b''.join(archive.canonical_header(m['path'],2)+b'{}'+b'\0'*510 for m in sorted(self.members,key=lambda m:m['path']))
        size=((len(raw)+1024+10239)//10240)*10240;raw+=b'\0'*(size-len(raw))
        stream=io.BytesIO()
        with gzip.GzipFile(filename='',mtime=0,compresslevel=6,fileobj=stream,mode='wb') as zipped:zipped.write(raw)
        selected=json.dumps({'format':'spicy-public-source-catalog-selection','version':1,'generation':generation,'files':self.members}).encode()
        self.inputs={'public-selection.json':selected,'public-catalog.tar.gz':stream.getvalue()}
        manifest=json.loads(self.manifest.read_text())
        manifest.update(selection={'bytes':len(selected),'sha256':sha(selected)},
                        archive={'bytes':len(stream.getvalue()),'sha256':sha(stream.getvalue())},
                        decodedBytes=size,members=count,memberBytes=2*count)
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaises(subprocess.CalledProcessError):self.run_main()
        self.run_main();self.run_main()
        self.assertEqual((self.gets,self.stages),(2,3))

    def test_partial_extraction_is_retained_and_new_attempt_succeeds(self):
        self.work.mkdir()
        owned = self.work / sha(self.inputs['public-selection.json'])[7:]; owned.mkdir()
        partial = owned / 'extract-interrupted'; partial.mkdir(); (partial/'manifest.json').write_bytes(b'{')
        with self.assertRaises(subprocess.CalledProcessError): self.run_main()
        self.run_main()
        self.assertEqual((partial/'manifest.json').read_bytes(), b'{')
        self.assertEqual(self.gets, 2)

    def test_completed_extraction_corruption_refuses(self):
        with self.assertRaises(subprocess.CalledProcessError): self.run_main()
        next(self.work.glob('*/extracted/manifest.json')).write_bytes(b'xx')
        with self.assertRaisesRegex(ValueError, 'hash differs'): self.run_main()

    def test_changed_selection_gets_a_separate_verified_cache(self):
        with self.assertRaises(subprocess.CalledProcessError):self.run_main()
        old=sha(self.inputs['public-selection.json'])[7:]
        selected=self.inputs['public-selection.json']+b' '
        self.inputs['public-selection.json']=selected
        manifest=json.loads(self.manifest.read_text())
        manifest['selection']={'bytes':len(selected),'sha256':sha(selected)}
        self.manifest.write_text(json.dumps(manifest));self.run_main()
        self.assertTrue((self.work/old/'extracted').is_dir())
        self.assertTrue((self.work/sha(selected)[7:]/'extracted').is_dir())
        self.assertEqual(self.gets,4)

    def test_lock_and_symlink_refuse(self):
        self.work.mkdir()
        with fetch.exclusive(self.work/'prepare.lock', archive):
            with self.assertRaisesRegex(ValueError, 'already active'): self.run_main()
        self.output.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'Symlink'): self.run_main()

    def test_local_inputs_need_no_get_and_changed_selection_is_separate(self):
        local = self.root/'local'; local.mkdir()
        for name, raw in self.inputs.items(): (local/name).write_bytes(raw)
        target = self.root/'copied'
        item = {'bytes': len(self.inputs['public-selection.json']), 'sha256': sha(self.inputs['public-selection.json'])}
        with patch.object(fetch, 'download', side_effect=AssertionError('GET forbidden')):
            self.assertEqual(fetch.acquire(target.with_name('public-selection.json'), item, 'unused', archive, local_inputs=local), 'verified-local')
        # Selection digests determine disjoint cache roots, never a mutable latest.
        first = sha(self.inputs['public-selection.json'])
        self.assertNotEqual(first, sha(self.inputs['public-selection.json'] + b' '))


if __name__ == '__main__': unittest.main()
