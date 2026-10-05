import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import json
import duckdb
spec = importlib.util.spec_from_file_location('time_coverage', pathlib.Path(__file__).resolve().parents[1] / 'scripts/build-time-coverage.py')
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)
coverage.previous = {}
class TimeCoverageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        conn = duckdb.connect()
        conn.execute('INSTALL httpfs')
        conn.close()
    def test_invalid_missing_and_year_precision_dates_do_not_fill_months(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'dates.parquet'
            conn = duckdb.connect()
            conn.execute("CREATE TABLE dates(event_date VARCHAR, date_precision VARCHAR)")
            conn.execute("INSERT INTO dates VALUES ('2024-01-02','day'),('2024-02-31','day'),('2024-01-01','year'),(NULL,NULL)")
            conn.execute('COPY dates TO ? (FORMAT PARQUET)', [str(path)])
            conn.close()
            _, result = coverage.measure(('test', {'rows':4,'columns':[('event_date','VARCHAR'),('date_precision','VARCHAR')], 'members':[{'url':str(path),'rows':4,'byteSize':path.stat().st_size}]}))
            self.assertEqual(result['status'], 'measured')
            self.assertEqual(result['buckets'], {'2024-01':1})
            self.assertEqual(result['undatedRows'], 3)
    def test_changed_export_checksum_forces_recount(self):
        table = {'rows':1, 'columns':[('posted_date','VARCHAR')], 'members':[{'url':'https://example.gov/comments.parquet','rows':1,'byteSize':100}], 'checksum':'new'}
        old = {'status':'measured','rows':1,'fingerprint':coverage.fingerprint(table['members']), 'field':'posted_date','granularity':'month','publicationSha256':'old'}
        coverage.previous = {'comments':old}
        new = {**old, 'publicationSha256':'new'}
        with patch.object(coverage.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps(new))) as scan:
            self.assertEqual(coverage.timed_measure(('comments',table))[1]['publicationSha256'], 'new')
            scan.assert_called_once()
        coverage.previous = {}
    def test_operational_dates_are_not_record_coverage(self):
        self.assertEqual(coverage.select_field('test', [('update_date','VARCHAR'),('dump_date','VARCHAR')])[0], None)
if __name__ == '__main__': unittest.main()
