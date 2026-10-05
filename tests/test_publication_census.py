import copy
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from publication_census import census, census_digest, inputs_fingerprint, load

DIGEST = 'sha256:' + 'a' * 64
PREFIX = 'generations/test/' + 'a' * 64
RULE_PREFIX = 'materialized/rulemaking/snapshots/snapshot_abc'


def documents():
    core = {'format': 'spicy-regs-publication', 'version': 2, 'families': {'test': {
        'artifactDigest': DIGEST, 'prefix': PREFIX, 'tables': {'records.parquet': {
            'rows': 2, 'byteSize': 20, 'sha256': DIGEST, 'columns': [['day', 'DATE']],
        }}}}}
    pointer = {'format_version': 2, 'dataset': 'rulemaking', 'snapshot_id': 'snapshot_abc',
               'manifest_key': RULE_PREFIX + '/manifest.json'}
    manifest = {'format_version': 2, 'dataset': 'rulemaking', 'snapshot_id': 'snapshot_abc', 'artifacts': {
        'records.parquet': {'rows': 9, 'bytes': 99, 'sha256': 'b' * 64,
                            'remote_key': RULE_PREFIX + '/records.parquet', 'visibility': 'public'},
        'derived.parquet': {'rows': 3, 'bytes': 30, 'sha256': 'b' * 64,
                            'remote_key': RULE_PREFIX + '/derived.parquet', 'visibility': 'public'},
        'private.parquet': {'visibility': 'private'},
    }}
    comments = {'format_version': 1, 'source': {}, 'files': {
        'comments.parquet': {'rows': 100, 'bytes': 1000, 'sha256': 'c' * 64, 'etag': 'comments'},
        'comments_index.parquet': {'rows': 3, 'bytes': 100, 'sha256': 'd' * 64, 'etag': 'index'},
        'comments_agency.parquet': {'rows': 100, 'bytes': 1000},
    }}
    return core, pointer, manifest, comments


class PublicationCensusTest(unittest.TestCase):
    def test_main_publication_wins_and_comments_partitions_are_not_counted_twice(self):
        result = census(*documents())
        self.assertEqual(set(result), {'records', 'derived', 'comments', 'comments_index'})
        self.assertEqual(result['records']['family'], 'test')
        self.assertEqual(result['records']['rows'], 2)
        self.assertEqual(result['comments']['dateIndexETag'], 'index')

    def test_unavailable_publication_cannot_silently_drop_its_tables(self):
        core, pointer, manifest, comments = documents()
        files = {'publication.v2.json': core, 'materialized/rulemaking/latest.json': pointer,
                 pointer['manifest_key']: manifest, 'comments-publication.json': comments}
        for key in files:
            def fetcher(path):
                if path == key:
                    raise OSError('unavailable')
                return files[path]
            with self.subTest(publication=key), self.assertRaises(OSError):
                load(fetcher)

    def test_invalid_members_and_mismatched_receipts_fail_before_scanning(self):
        for defect in ('rows', 'bytes', 'duplicate', 'escape', 'snapshot', 'schema'):
            docs = documents()
            table = docs[0]['families']['test']['tables']['records.parquet']
            member = {'key': 'records/part-0.parquet', 'rows': 2, 'byteSize': 20, 'sha256': DIGEST}
            table['members'] = [member]
            if defect == 'rows': member['rows'] = 1
            if defect == 'bytes': member['byteSize'] = 19
            if defect == 'duplicate': table['members'].append(copy.deepcopy(member))
            if defect == 'escape': member['key'] = 'records/../other.parquet'
            if defect == 'snapshot': docs[2]['snapshot_id'] = 'snapshot_other'
            if defect == 'schema': table['columns'].append(['day', 'VARCHAR'])
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                census(*docs)

    def test_census_binding_tracks_schema_parent_generation_and_mutable_export_checksum(self):
        base = census(*documents())
        for table_id, field, value in (
                ('records', 'columns', [['day', 'TIMESTAMP']]),
                ('records', 'artifactDigest', 'sha256:' + 'e' * 64),
                ('records', 'publishedAt', '2026-10-05T12:00:00Z'),
                ('comments', 'checksum', 'f' * 64)):
            changed = copy.deepcopy(base)
            changed[table_id][field] = value
            self.assertNotEqual(census_digest(base), census_digest(changed))

    def test_either_mutable_export_changes_both_paired_input_bindings(self):
        base = census(*documents())
        for key, other in [('comments.parquet', 'comments_index'), ('comments_index.parquet', 'comments')]:
            docs = documents()
            docs[3]['files'][key]['sha256'] = 'e' * 64
            docs[3]['files'][key]['etag'] = 'changed'
            changed = census(*docs)
            self.assertEqual(base[other]['checksum'], changed[other]['checksum'])
            self.assertNotEqual(inputs_fingerprint(base[other]), inputs_fingerprint(changed[other]))
            self.assertNotEqual(census_digest(base), census_digest(changed))


if __name__ == '__main__': unittest.main()
