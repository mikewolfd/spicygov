import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import duckdb

spec = importlib.util.spec_from_file_location('collections', pathlib.Path(__file__).resolve().parents[1] / 'scripts/collection_coverage.py')
collections = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collections)
SHA = 'sha256:' + 'a' * 64
OLD = 'sha256:' + 'b' * 64
PARENT = 'sha256:' + 'c' * 64
FILE = 'sha256:' + 'd' * 64


class CollectionCoverageTest(unittest.TestCase):
    def test_carried_table_uses_its_original_parent(self):
        member = {'role': 'table', 'objectKey': 'example.parquet', 'sha256': FILE, 'recordCount': 2, 'byteSize': 10}
        parent_member = {**member, 'objectKey': 'fec_collections.parquet'}
        pin = {'family': 'fec-observations', 'artifactDigest': PARENT, 'sha256': FILE, 'byteSize': 10}
        owner = {'spec': {'parents': {'fec_collections.parquet': pin}, 'readSnapshot': {'families': {'fec-observations': {'artifactDigest': PARENT, 'tables': {'fec_collections.parquet': {'sha256': FILE, 'byteSize': 10, 'rows': 2}}}}}}}
        current = {'spec': {'carriedForward': {'example.parquet': OLD}, 'parents': {'fec_collections.parquet': {**pin, 'artifactDigest': SHA}}}}
        inputs = collections.Inputs()
        responses = [('current', current, [member]), ('original', owner, [member]), ('retained-parent', {}, [parent_member])]
        expected = [{'key': 'example.parquet', 'sha256': FILE, 'rows': 2, 'byteSize': 10}]
        with patch.object(inputs, 'artifact', side_effect=responses) as fetch:
            result = inputs.collections('fec-query', SHA, 'example', expected)
            self.assertEqual(result['generation'], PARENT)
            self.assertEqual(result['owner'], collections.BASE + '/original/artifact.json')
            self.assertEqual(fetch.call_args_list[1].args, ('fec-query', OLD))
        with patch.object(inputs, 'artifact', return_value=responses[0]):
            with self.assertRaisesRegex(ValueError, 'differ'):
                inputs.collections('fec-query', SHA, 'example', [{**expected[0], 'sha256': SHA}])

    def test_missing_collections_and_cycles_remain_explicit(self):
        result = collections.summarize([('a', '2026', 2), ('missing', None, 3)], [('a', 'fec_receipts', 'no-record-rejections')], 5)
        self.assertEqual((result['matchedRows'], result['unmatchedRows']), (2, 3))
        self.assertEqual(result['cycleRows'], {'2026': 2})
        self.assertEqual(result['unscopedRows'], 3)
        self.assertEqual(result['outcomes'], {'no-record-rejections': 1})
        with self.assertRaisesRegex(ValueError, 'unique'):
            collections.summarize([('a', '2026', 2)], [('a', 'x', 'empty'), ('a', 'x', 'refused')], 2)

    def test_explicit_generation_mismatch_cannot_join_by_id(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder)
            con = duckdb.connect()
            con.execute('INSTALL httpfs')
            con.execute('CREATE TABLE records(collection_id VARCHAR, source_cycle INTEGER, source_generation_pin VARCHAR)')
            con.execute('INSERT INTO records VALUES (?,?,?),(?,?,?)', ['a',2026,PARENT,'a',2026,OLD])
            con.execute("CREATE TABLE collections AS SELECT 'a' collection_id, 'fec_receipts' source_family, 'no-record-rejections' record_outcome")
            con.execute("ALTER TABLE records ADD COLUMN outcome_status VARCHAR DEFAULT 'refused_native_observation_not_qualified_empty_success'")
            con.execute("ALTER TABLE records ADD COLUMN profile_refusal VARCHAR DEFAULT 'retained observation timestamp missing'")
            con.execute("ALTER TABLE records ADD COLUMN query_completeness VARCHAR DEFAULT 'not-asserted'")
            con.execute('COPY records TO ? (FORMAT PARQUET)', [str(path / 'records.parquet')])
            con.execute('COPY collections TO ? (FORMAT PARQUET)', [str(path / 'collections.parquet')])
            con.close()
            result = collections.scan({'rows': 2, 'hasCycle': True, 'hasGenerationPin': True, 'queryResults': True, 'urls': [str(path / 'records.parquet')], 'input': {'url': str(path / 'collections.parquet'), 'generation': PARENT, 'rows': 1}})
            self.assertEqual(result['matchedRows'], 1)
            self.assertEqual(result['unmatchedRows'], 1)
            self.assertEqual(result['collections'], 1)
            self.assertEqual(result['queryResults'][0]['records'], 2)
            self.assertEqual(result['queryResults'][0]['status'], 'refused_native_observation_not_qualified_empty_success')
            self.assertEqual(result['queryResults'][0]['completeness'], 'not-asserted')


if __name__ == '__main__':
    unittest.main()
