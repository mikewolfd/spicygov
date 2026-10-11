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

class Response(io.BytesIO):
    def __init__(self, status=200, headers=None, body=b'ok'):
        super().__init__(body)
        self.status = status
        self.headers = {'Content-Length': '2'} if headers is None else headers


class Compatibility(unittest.TestCase):
    def attempt(self, status=200, headers=None, body=b'ok'):
        sha = hashlib.sha256(b'ok').hexdigest()
        item = {
            'filename': 'members.json',
            'bytes': 2,
            'sha256': sha,
            'url': pages.BASE + sha + '/members.json',
        }

        def build(*handlers):
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], pages.NoRedirect)

            class Opener:
                def open(opener, request, timeout):
                    self.assertEqual(request.get_header('User-agent'), 'SpicyGov-RetainedArtifact/1.0')
                    self.assertEqual(request.get_header('Accept-encoding'), 'identity')
                    self.assertEqual(request.full_url, item['url'])
                    self.assertEqual(timeout, 30)
                    return Response(status, headers, body)

            return Opener()

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(pages.urllib.request, 'build_opener', side_effect=build):
                pages.download(item, Path(directory) / 'members.json')

    def test_compatible_headers_preserve_verified_fetch(self):
        self.attempt()

    def test_non200_refused(self):
        with self.assertRaisesRegex(ValueError, 'framing'):
            self.attempt(status=403)

    def test_encoding_refused(self):
        with self.assertRaisesRegex(ValueError, 'framing'):
            self.attempt(headers={'Content-Length': '2', 'Content-Encoding': 'gzip'})

    def test_length_refused(self):
        with self.assertRaisesRegex(ValueError, 'framing'):
            self.attempt(headers={'Content-Length': '3'})

    def test_hash_refused(self):
        with self.assertRaises(ValueError):
            self.attempt(body=b'no')


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
        path = self.path / 'held.json'
        path.write_text(json.dumps({'upload_authorized': False, 'expires_at': '2030-01-01T00:00:00+00:00'}))
        with patch.object(pages, 'api', side_effect=AssertionError('network called')):
            with self.assertRaises(ValueError):
                pages.preflight(path, 'forward', 7, 'a'*64, self.path, self.path / 'map', self.path / 'receipt')
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
    def same_run_fixture(self):
        directory = self.path / 'download'
        directory.mkdir()
        self.tar().rename(directory / 'artifact.tar')
        map_path = self.path / 'members.json'
        raw = json.dumps(self.members).encode()
        map_path.write_bytes(raw)
        expected = {'generic_id': 1, 'sha': 'failed-control', 'state': 'failure',
                    'pages_id': 'prior-success-id', 'pages_status': 'succeed'}
        binding = {'upload_authorized': True, 'deployment_authorized': True,
                   'exclusive_writers_confirmed': True, 'deployment_role': 'forward',
                   'expires_at': '2030-01-01T00:00:00+00:00', 'expected_current': expected,
                   'roles': {'forward': {'map': {'sha256': pages.sha(raw)}}}}
        path = self.path / 'binding.json'
        path.write_text(json.dumps(binding))
        artifact = {'id': 7, 'name': 'github-pages-forward', 'digest': 'sha256:'+'a'*64,
                    'size_in_bytes': 9, 'expired': False, 'expires_at': '2030-01-01T00:00:00Z',
                    'workflow_run': {'id': 99, 'head_sha': 'this-control'}}
        return path, directory, map_path, artifact

    def run_preflight(self, fixture, responses):
        path, directory, map_path, _ = fixture
        with patch.dict('os.environ', GITHUB_RUN_ID='99', GITHUB_SHA='this-control'):
            with patch.object(pages, 'api', side_effect=responses) as api:
                pages.preflight(path, 'forward', 7, 'a'*64, directory, map_path, self.path / 'receipt.json')
                return api.call_args_list

    def test_same_run_full_tar_and_distinct_failed_generic_prior_pages(self):
        fixture = self.same_run_fixture()
        calls = self.run_preflight(fixture, [fixture[3],
            [{'id': 2, 'sha': 'this-control'}, {'id': 1, 'sha': 'failed-control'}],
            [{'state': 'in_progress', 'log_url': 'https://github.com/mikewolfd/spicygov/actions/runs/99/job/1'}],
            [{'state': 'failure', 'log_url': 'https://github.com/mikewolfd/spicygov/actions/runs/98/job/2'}],
            {'status': 'succeed'}])
        receipt = json.loads((self.path / 'receipt.json').read_text())
        self.assertEqual(receipt['artifact']['id'], 7)
        self.assertEqual(receipt['verified_members'], 1)
        self.assertEqual(receipt['expected_current']['state'], 'failure')
        self.assertEqual(receipt['state'], 'same-run-artifact-and-current-state-verified')
        self.assertTrue(all(call.args[0] == 'GET' for call in calls))
        self.assertEqual(calls[-1].args[1], 'pages/deployments/prior-success-id')

    def test_old_run_or_wrong_head_digest_role_expiry_refused(self):
        fixture = self.same_run_fixture()
        for key, bad in [('workflow_run', {'id': 98, 'head_sha': 'this-control'}),
                         ('workflow_run', {'id': 99, 'head_sha': 'other'}),
                         ('digest', 'sha256:'+'b'*64), ('name', 'github-pages-prior'),
                         ('expired', True), ('expired', 0),
                         ('expires_at', '2020-01-01T00:00:00Z')]:
            artifact = {**fixture[3], key: bad}
            with self.subTest(key=key, bad=bad), self.assertRaises(ValueError):
                self.run_preflight(fixture, [artifact])
            self.assertFalse((self.path / 'receipt.json').exists())

    def test_wrong_downloaded_tar_bytes_refused_before_writer_query(self):
        fixture = self.same_run_fixture()
        raw = (fixture[1] / 'artifact.tar').read_bytes().replace(b'ok', b'no')
        (fixture[1] / 'artifact.tar').write_bytes(raw)
        with self.assertRaises(ValueError):
            self.run_preflight(fixture, [fixture[3]])
        self.assertFalse((self.path / 'receipt.json').exists())

    def test_unexpected_downloaded_file_refused(self):
        fixture = self.same_run_fixture()
        (fixture[1] / 'extra').write_bytes(b'x')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            self.run_preflight(fixture, [fixture[3]])

    def test_intervening_generic_refuses_despite_same_pages_success(self):
        fixture = self.same_run_fixture()
        with self.assertRaisesRegex(ValueError, 'Intervening'):
            self.run_preflight(fixture, [fixture[3], [{'id': 3, 'sha': 'new'}],
                [{'state': 'failure', 'log_url': 'https://example.com/unknown'}]])
        self.assertFalse((self.path / 'receipt.json').exists())

    def test_prior_role_requires_its_own_authority(self):
        fixture = self.same_run_fixture()
        with patch.object(pages, 'api', side_effect=AssertionError('network called')):
            with self.assertRaisesRegex(ValueError, 'Deployment held'):
                pages.preflight(fixture[0], 'prior', 7, 'a'*64, fixture[1], fixture[2], self.path / 'receipt.json')

    def test_explicit_prior_role_same_run_admission(self):
        fixture = self.same_run_fixture()
        binding = json.loads(fixture[0].read_text())
        binding['deployment_role'] = 'prior'
        binding['roles']['prior'] = binding['roles'].pop('forward')
        fixture[0].write_text(json.dumps(binding))
        artifact = {**fixture[3], 'name': 'github-pages-prior'}
        with patch.dict('os.environ', GITHUB_RUN_ID='99', GITHUB_SHA='this-control'):
            with patch.object(pages, 'api', side_effect=[artifact,
                    [{'id': 1, 'sha': 'failed-control'}],
                    [{'state': 'failure', 'log_url': 'https://example.com/foreign'}],
                    {'status': 'succeed'}]):
                pages.preflight(fixture[0], 'prior', 7, 'a'*64, fixture[1], fixture[2], self.path / 'receipt.json')
        self.assertEqual(json.loads((self.path / 'receipt.json').read_text())['role'], 'prior')

    def test_fetch_prior_role_refused_before_any_download_or_directory(self):
        fixture = self.same_run_fixture()
        with patch('sys.argv', ['pages', 'fetch', '--binding', str(fixture[0]),
                '--role', 'prior', '--require-deployment-role', '--output', str(self.path / 'must-not-exist')]):
            with patch.object(pages, 'download', side_effect=AssertionError('download called')):
                with self.assertRaisesRegex(ValueError, 'Deployment held'):
                    pages.main()
        pages.signal.alarm(0)
        self.assertFalse((self.path / 'must-not-exist').exists())

    def test_strict_old_and_current_fragment_pins(self):
        path = self.path / 'fragment'
        path.write_bytes(b'x'*367)
        for pin in pages.HTML_FRAGMENT_SHAS:
            with patch.object(pages, 'sha', return_value=pin):
                self.assertEqual(pages.read_fragment(path), b'x'*367)
        with self.assertRaisesRegex(ValueError, 'identity'):
            pages.read_fragment(path)
        path.write_bytes(b'x'*368)
        with self.assertRaisesRegex(ValueError, 'size'):
            pages.read_fragment(path)

if __name__ == '__main__':
    unittest.main()
