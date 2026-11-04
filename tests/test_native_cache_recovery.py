"""Offline cache recovery: only private fixture members and synthetic bridge results."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import native_legislative_coverage as native


def pin(path):
    data = path.read_bytes()
    return {'path': str(path), 'sha256': 'sha256:' + hashlib.sha256(data).hexdigest(), 'byteSize': len(data)}


class CacheRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TEST_TMP_ROOT'))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'SPICYGOV_NATIVE_COVERAGE_CACHE': str(self.root / 'cache')})
        self.env.start(); self.addCleanup(self.env.stop)
        self.policy = {'dataset': 'bill_sections'}
        self.description = {'policy': self.policy, 'implementationSha256': 'reader'}
        self.source = self.root / 'sources'; self.source.mkdir()
        self.members = []
        for name in ('bill_sections.parquet', 'etl_receipts.parquet'):
            path = self.source / name; path.write_bytes(name.encode())
            identity = pin(path)
            self.members.append({'role': 'table', 'objectKey': name, 'sha256': identity['sha256'],
                                 'byteSize': identity['byteSize'], 'recordCount': 1})
        self.artifact = {'spec': {'etlReceipts': {'policies': [self.policy], 'key': 'etl_receipts.parquet',
                                                    'generationId': 'selected', 'rows': 1}}}
        self.owner = {'family': 'bill-family', 'artifactDigest': 'sha256:' + 'a' * 64,
                      'artifact': self.artifact, 'rows': 1}
        class Inputs:
            def artifact(inner, *args): return ('generation', self.artifact, self.members)
        self.inputs = Inputs()
        self.schema = patch.object(native, 'native_schema', return_value=self.description)
        self.schema.start(); self.addCleanup(self.schema.stop)
        self.calls = 0

    def adapter(self):
        def download(key, dest): dest.write_bytes((self.source / key.split('/')[-1]).read_bytes())
        return native.ProcessingInputs(self.inputs, self.root / 'work', download)

    def bridge(self, *, request):
        self.calls += 1
        dest = Path(request['destination']); dest.mkdir(parents=True)
        output = dest / 'processing.parquet'; output.write_bytes(b'private processing')
        return {'dataset': request['dataset'], 'generationId': request['generationId'], 'policy': self.policy,
                'implementationSha256': 'reader', 'selection': {k: request[k] for k in ('subjects', 'receipts')},
                'rows': 1, 'urls': [str(output)], 'processingMembers': [pin(output)]}

    def manifests(self):
        return list((self.root / 'cache' / 'restored').glob('*/manifest.json'))

    def test_invalid_fresh_then_valid_retry(self):
        def bridge(*, request):
            result = self.bridge(request=request)
            if self.calls == 1: result['generationId'] = 'wrong'
            return result
        with patch.object(native, 'bridge', side_effect=bridge):
            with self.assertRaises(ValueError): self.adapter().restore('bill_sections', self.owner)
            self.assertEqual(self.manifests(), [])
            self.assertEqual(self.adapter().restore('bill_sections', self.owner)['rows'], 1)
        self.assertEqual(self.calls, 2)

    def test_existing_poison_preserved_and_replaced(self):
        with patch.object(native, 'bridge', side_effect=self.bridge):
            first = self.adapter().restore('bill_sections', self.owner)
            manifest, = self.manifests(); bad = json.loads(manifest.read_text()); bad['generationId'] = 'bad'
            payload = json.dumps(bad); manifest.write_text(payload)
            result = self.adapter().restore('bill_sections', self.owner)
        self.assertEqual(result['rows'], first['rows']); self.assertEqual(self.calls, 2)
        self.assertEqual(json.loads(manifest.read_text())['generationId'], 'selected')
        preserved = list((manifest.parent / 'rejected').glob('*.json'))
        self.assertEqual([path.read_text() for path in preserved], [payload])

    def test_bad_fresh_member_refused_before_commit(self):
        for change in ('missing', 'urls', 'hash', 'size', 'escape', 'symlink'):
            with self.subTest(change=change):
                self.calls = 0
                def bridge(*, request):
                    result = self.bridge(request=request)
                    if change == 'missing': result['processingMembers'] = []
                    elif change == 'urls': result['urls'] = []
                    elif change == 'hash': result['processingMembers'][0]['sha256'] = 'sha256:' + '0'*64
                    elif change == 'size': result['processingMembers'][0]['byteSize'] += 1
                    else:
                        outside = self.root / ('outside-' + change); outside.write_bytes(b'private')
                        if change == 'escape': path = outside
                        else:
                            path = Path(request['destination']) / 'link'; path.symlink_to(outside)
                        result['processingMembers'] = [pin(path)]; result['urls'] = [str(path)]
                    return result
                with patch.object(native, 'bridge', side_effect=bridge):
                    with self.assertRaises(ValueError): self.adapter().restore('bill_sections', self.owner)
                self.assertEqual(self.manifests(), [])

    def test_each_binding_is_validated_before_commit(self):
        changes = {'selection': {}, 'generationId': 'wrong', 'dataset': 'wrong',
                   'implementationSha256': 'wrong', 'policy': {}, 'rows': True}
        for field, invalid in changes.items():
            with self.subTest(field=field):
                def bridge(*, request):
                    result = self.bridge(request=request); result[field] = invalid
                    return result
                with patch.object(native, 'bridge', side_effect=bridge):
                    with self.assertRaises(ValueError): self.adapter().restore('bill_sections', self.owner)
                self.assertEqual(self.manifests(), [])

    def test_cached_bad_member_rebuilt_and_manifest_preserved(self):
        with patch.object(native, 'bridge', side_effect=self.bridge):
            first = self.adapter().restore('bill_sections', self.owner)
            Path(first['urls'][0]).write_bytes(b'corrupt')
            result = self.adapter().restore('bill_sections', self.owner)
        self.assertEqual(self.calls, 2)
        self.assertNotEqual(first['urls'], result['urls'])
        manifest, = self.manifests()
        self.assertEqual(len(list((manifest.parent / 'rejected').glob('*.json'))), 1)
        self.assertEqual(Path(first['urls'][0]).read_bytes(), b'corrupt')

    def test_symlinked_cache_root_refused(self):
        cache = self.root / 'cache'; cache.mkdir()
        target = self.root / 'elsewhere'; target.mkdir()
        (cache / 'restored').symlink_to(target, target_is_directory=True)
        with patch.object(native, 'bridge', side_effect=AssertionError('unexpected bridge')):
            with self.assertRaisesRegex(ValueError, 'symlink'):
                self.adapter().restore('bill_sections', self.owner)
        self.assertEqual(list(target.iterdir()), [])

    def test_valid_cache_reuse_and_concurrent_callers(self):
        def bridge(*, request):
            time.sleep(.1)
            return self.bridge(request=request)
        with patch.object(native, 'bridge', side_effect=bridge), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.adapter().restore, 'bill_sections', self.owner) for _ in range(2)]
            values = [future.result(timeout=5) for future in futures]
            self.assertEqual(values[0]['urls'], values[1]['urls'])
            self.assertEqual(self.adapter().restore('bill_sections', self.owner)['urls'], values[0]['urls'])
        self.assertEqual(self.calls, 1)

if __name__ == '__main__': unittest.main()
