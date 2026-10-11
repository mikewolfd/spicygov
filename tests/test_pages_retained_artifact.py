"""Tiny inert control fixtures only; no live/native/dist sources or network."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('pages', ROOT / 'scripts/pages-retained-artifact.py')
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)

class Controls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name).resolve()
        self.members = {'index.html': {'bytes': 2, 'sha256': hashlib.sha256(b'ok').hexdigest()}}
    def tearDown(self):
        self.temp.cleanup()
    def tar(self, kind='regular', extra=False):
        path = self.path / 'artifact.tar'
        with tarfile.open(path, 'w') as archive:
            item = tarfile.TarInfo('index.html')
            item.size = 2
            if kind == 'link':
                item.type = tarfile.SYMTYPE
                item.linkname = '/secret'
                archive.addfile(item)
            else:
                archive.addfile(item, io.BytesIO(b'ok' if kind == 'regular' else b'no'))
            if extra:
                item = tarfile.TarInfo('private.txt')
                item.size = 1
                archive.addfile(item, io.BytesIO(b'x'))
        return path
    def test_exact_tar(self):
        pages.verify_tar(self.tar(), self.members)
    def test_link_refused(self):
        with self.assertRaises(ValueError):
            pages.verify_tar(self.tar('link'), self.members)
    def test_extra_refused(self):
        with self.assertRaises(ValueError):
            pages.verify_tar(self.tar(extra=True), self.members)
    def test_wrong_bytes_refused(self):
        with self.assertRaises(ValueError):
            pages.verify_tar(self.tar('bad'), self.members)
    def test_missing_refused(self):
        with self.assertRaises(ValueError):
            pages.verify_tar(self.tar(), {**self.members, 'missing': {'bytes': 0, 'sha256': hashlib.sha256(b'').hexdigest()}})
    def test_path_traversal_refused(self):
        for value in ['../secret', '/secret', 'a//b', './a', 'a/../b', 'a\\b']:
            with self.assertRaises(ValueError):
                pages.name(value)
    def test_duplicate_map_refused(self):
        path = self.path / 'map.json'
        raw = json.dumps([dict(path='index.html', **self.members['index.html'])] * 2).encode()
        path.write_bytes(raw)
        with self.assertRaises(ValueError):
            pages.read_map(path, hashlib.sha256(raw).hexdigest())
    def test_private_stat_fields_do_not_escape_logical_map(self):
        path = self.path / 'map.json'
        raw = json.dumps([dict(path='index.html', stat=[1,2,3], **self.members['index.html'])]).encode()
        path.write_bytes(raw)
        logical = pages.read_map(path, hashlib.sha256(raw).hexdigest())
        self.assertEqual(logical, self.members)
        self.assertEqual(set(logical['index.html']), {'bytes', 'sha256'})
    def test_tiny_package_then_full_tar_verification(self):
        root = self.path / 'site'
        root.mkdir()
        (root / 'index.html').write_bytes(b'ok')
        out = self.path / 'out.tar.gz'
        result = pages.package(root, self.members, out)
        self.assertEqual(result['sha256'], hashlib.sha256(out.read_bytes()).hexdigest())
        pages.verify_tar(out, self.members, compressed=True)
    def test_extra_dist_refused_before_container(self):
        root = self.path / 'site'
        root.mkdir()
        (root / 'index.html').write_bytes(b'ok')
        (root / 'secret').write_bytes(b'x')
        out = self.path / 'out.tar.gz'
        with self.assertRaises(ValueError):
            pages.package(root, self.members, out)
        self.assertFalse(out.exists())
    def test_held_binding_refuses_network(self):
        binding = ROOT / '.github/pages-retained-binding.json'
        with patch.object(pages, 'api', side_effect=AssertionError('network called')):
            with self.assertRaises(ValueError):
                pages.deploy(binding, 'forward', self.path / 'receipt.json')
    def test_redirect_refused(self):
        with self.assertRaises(ValueError):
            pages.NoRedirect().redirect_request(None, None, None, None, None, None)
    def test_expansion_limit(self):
        with patch.object(pages, 'MAX_TAR', 1):
            with self.assertRaises(ValueError):
                pages.copy_bounded(io.BytesIO(b'ok'), io.BytesIO())
    def test_nonzero_tar_trailer_refused(self):
        path = self.tar()
        with path.open('ab') as stream:
            stream.write(b'hidden')
        with self.assertRaises(ValueError):
            pages.verify_tar(path, self.members)
    def test_nonzero_gzip_tar_trailer_refused(self):
        import gzip
        raw = self.tar().read_bytes() + b'hidden'
        path = self.path / 'container.gz'
        path.write_bytes(gzip.compress(raw))
        with self.assertRaises(ValueError):
            pages.verify_tar(path, self.members, compressed=True)
    def test_exact_single_html_addition_only(self):
        self.assertTrue(pages.live_body(io.BytesIO(b'okKNOWN'), 'index.html', self.members['index.html'], b'KNOWN'))
        for raw in (b'okUNKNOWN', b'okKNOWNKNOWN', b'noKNOWN'):
            with self.assertRaises(ValueError):
                pages.live_body(io.BytesIO(raw), 'index.html', self.members['index.html'], b'KNOWN')
        with self.assertRaises(ValueError):
            pages.live_body(io.BytesIO(b'okKNOWN'), 'other.json', self.members['index.html'], b'KNOWN')
    def test_artifact_expiry_and_deployment_drift_refused_before_oidc(self):
        binding = json.loads((ROOT / '.github/pages-retained-binding.json').read_text())
        binding.update(upload_authorized=True, deployment_authorized=True, exclusive_writers_confirmed=True, deployment_role='forward', expires_at='2030-01-01T00:00:00+00:00')
        artifact = {'id': 7, 'name': 'github-pages-forward', 'digest': 'sha256:'+'a'*64, 'size_in_bytes': 9, 'expired': False, 'expires_at': '2030-01-01T00:00:00Z', 'workflow_run': {'id': 8, 'head_sha': 'b'*40}}
        binding['roles']['forward']['approved_artifact'] = artifact
        path = self.path / 'binding.json'
        path.write_text(json.dumps(binding))
        with patch.dict('os.environ', GITHUB_RUN_ID='99'), patch.object(pages, 'api', side_effect=[artifact, [{'id':1,'sha':'wrong'}], [{'state':'success','log_url':'https://example.com/other'}]]):
            with self.assertRaisesRegex(ValueError, 'Intervening'):
                pages.deploy(path, 'forward', self.path / 'receipt.json')
        artifact['expires_at'] = '2020-01-01T00:00:00Z'
        path.write_text(json.dumps(binding))
        with patch.object(pages, 'api', return_value=artifact):
            with self.assertRaisesRegex(ValueError, 'expired'):
                pages.deploy(path, 'forward', self.path / 'receipt.json')

if __name__ == '__main__':
    unittest.main()
