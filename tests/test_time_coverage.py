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
    def test_reviewed_date_fields_count_months_without_using_capture_dates(self):
        for table_id, field in [('bill_vote_references', 'date'), ('member_vote_terms', 'vote_day'), ('fec_registration_statements', 'receipt_date')]:
            with self.subTest(table=table_id), tempfile.TemporaryDirectory() as folder:
                path = pathlib.Path(folder) / 'records.parquet'
                conn = duckdb.connect()
                conn.execute(f'CREATE TABLE records("{field}" VARCHAR, observed_at VARCHAR)')
                conn.execute("INSERT INTO records VALUES ('2024-02-03', '2026-10-04'), (NULL, '2026-10-04')")
                conn.execute('COPY records TO ? (FORMAT PARQUET)', [str(path)])
                conn.close()
                _, result = coverage.measure((table_id, {'rows': 2, 'members': [{'url': str(path), 'rows': 2, 'byteSize': path.stat().st_size}]}))
                self.assertEqual(result['buckets'], {'2024-02': 1})
                self.assertEqual(result['undatedRows'], 1)
        self.assertIsNone(coverage.select_field('unreviewed', [('date', 'VARCHAR'), ('vote_day', 'VARCHAR'), ('receipt_date', 'VARCHAR')])[0])

    def test_agenda_editions_are_seasons_not_calendar_months(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'agenda.parquet'
            conn = duckdb.connect()
            conn.execute("CREATE TABLE agenda(agenda_edition VARCHAR)")
            conn.execute("INSERT INTO agenda VALUES ('201104'),('201110'),('201210'),('201201'),('000004'),(NULL)")
            conn.execute('COPY agenda TO ? (FORMAT PARQUET)', [str(path)])
            conn.close()
            _, result = coverage.measure(('unified_agenda', {'rows':6, 'members':[{'url':str(path),'rows':6,'byteSize':path.stat().st_size}]}))
            self.assertEqual(result['granularity'], 'season')
            self.assertEqual(result['buckets'], {'2011-spring':1, '2011-fall':1, '2012-fall':1})
            self.assertEqual(result['undatedRows'], 3)

    def test_collection_results_do_not_become_calendar_coverage(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / 'collections.parquet'
            conn = duckdb.connect()
            conn.execute("CREATE TABLE collections(record_outcome VARCHAR)")
            conn.execute("INSERT INTO collections VALUES ('empty'),('refused'),('inventory_only'),('selection_context'),(NULL)")
            conn.execute('COPY collections TO ? (FORMAT PARQUET)', [str(path)])
            conn.close()
            _, result = coverage.measure(('fec_collections', {'rows':5, 'members':[{'url':str(path),'rows':5,'byteSize':path.stat().st_size}]}))
            self.assertEqual(result['status'], 'unmeasured')
            self.assertNotIn('buckets', result)
            self.assertEqual(result['collectionOutcomes'], {'empty':1,'refused':1,'inventory_only':1,'selection_context':1,'unknown':1})

    def test_operational_dates_are_not_record_coverage(self):
        self.assertEqual(coverage.select_field('test', [('update_date','VARCHAR'),('dump_date','VARCHAR')])[0], None)
if __name__ == '__main__': unittest.main()
