"""Reviewed public fields are measured from the published files alone."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import duckdb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
import coverage_scan

spec = importlib.util.spec_from_file_location('published_period_build', ROOT/'scripts/build-coverage-maps.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)

SAMPLES = {
    'law_code_sections': dict(congress='119', session='1', prepared_date='January 23, 2026'),
    'table3_records': dict(congress='119', release_point='119-73', act_date='2025-01-29'),
    'budget_volumes': dict(fiscal_year='2027', date_issued='2026-09-04'),
    'treaties': dict(congress_received='119', congress_considered='119',
                     transmitted_date='2026-09-14T00:00:00Z', in_force_date='2027-01-01'),
}


class PublishedPeriods(unittest.TestCase):
    def test_scorecard_geo_extension_keeps_exact_public_schema_and_recorded_parent_keys(self):
        policy = builder.definitions()['scorecard_member_links']
        columns = policy.get('publishedSchema', policy['schema'])
        self.assertLessEqual({'normalized_state', 'state_status', 'normalized_district',
                              'district_status', 'correction_evidence_json'}, set(dict(columns)))
        self.assertTrue(all(dict(columns)[field] == 'VARCHAR'
                            for field in ('scorecard_id', 'publisher_member_key')))
        self.assertTrue(all(d['kind'] == 'inherited' and d['parent']['mode'] == 'recorded-parent'
                            for d in policy['dimensions']))
        table = dict(kind='generation', family=policy['family'], columns=columns)
        selected = {'scorecard_member_links': policy}
        builder.validate_plan({'scorecard_member_links': table}, selected)
        self.assertEqual(selected['scorecard_member_links']['schema'], columns)
        self.assertNotIn('_nativeProcessing', selected['scorecard_member_links'])
        for changed in (columns + [['unreviewed', 'VARCHAR']],
                        [['scorecard_id', 'INTEGER']] + columns[1:]):
            with self.assertRaisesRegex(ValueError, 'schema needs coverage review'):
                builder.validate_plan({'scorecard_member_links': {**table, 'columns': changed}},
                                      {'scorecard_member_links': policy})

    def test_all_four_measure_unchanged_public_fields_without_readers_or_receipts(self):
        for name, sample in SAMPLES.items():
            with self.subTest(table=name), tempfile.TemporaryDirectory() as folder:
                policy = builder.definitions()[name]
                columns = policy.get('publishedSchema', policy['schema'])
                # Names, types, and reviewed meanings stay unchanged.
                for dimension in policy['dimensions']:
                    for field in dimension['fields']:
                        self.assertEqual(dict(columns)[field], dict(policy['schema'])[field])
                path = Path(folder)/f'{name}.parquet'
                con = duckdb.connect()
                con.execute('CREATE TABLE fixture ('+','.join('"'+field+'" '+kind for field,kind in columns)+')')
                fields = ','.join('"'+field+'"' for field in sample)
                placeholders = ','.join('?' for _ in sample)
                con.execute(f'INSERT INTO fixture ({fields}) VALUES ({placeholders})', list(sample.values()))
                con.execute('INSERT INTO fixture DEFAULT VALUES')
                con.execute('COPY fixture TO ? (FORMAT PARQUET)', [str(path)])
                con.close()
                digest = 'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()
                table = dict(kind='generation', family=policy['family'], rows=2, columns=columns,
                             artifactDigest='sha256:'+'a'*64, publishedAt='2026-10-29T20:00:00Z',
                             members=[dict(key=name+'.parquet', sha256=digest, rows=2,
                                           byteSize=path.stat().st_size, url=str(path))])
                selected = {name:policy}
                builder.validate_plan({name:table},selected)
                self.assertNotIn('_nativeProcessing',selected[name])
                self.assertNotIn('_additionalNativeProcessing',selected[name])
                with patch.object(coverage_scan, '_connect', side_effect=duckdb.connect):
                    result = coverage_scan.scan_table(name,table,selected[name])
                self.assertEqual(result['rows'],2)
                self.assertNotIn('processingEvidence',result)
                self.assertEqual(result['fingerprint'],builder.binding(table,selected[name])['fingerprint'])
                for dimension in result['dimensions']:
                    self.assertEqual((dimension['placedRows'],dimension['unplacedRows']),(1,1))
                expected_month = {'table3_records':'2025-01','budget_volumes':'2026-09','treaties':'2026-09'}.get(name)
                if expected_month:
                    self.assertTrue(any(d['buckets'].get(expected_month)==1 for d in result['dimensions']))



DEFERRED_SAMPLES = {
    'bill_actions': dict(bill_id='hr1-119', action_date='2026-10-03'),
    'bill_committee_activities': dict(bill_id='hr1-119', activity_date='2026-10-03'),
    'bill_committees': dict(bill_id='hr1-119', chamber='House'),
    'bill_publisher_summaries': dict(bill_id='hr1-119', action_date='2026-10-03'),
    'bill_vote_references': dict(congress='119', chamber='House', session='1', date='2026-10-03'),
    'cbo_feed_items': dict(congress=119, pub_date='2026-10-03'),
    'roll_call_votes': dict(congress='119', chamber='House', session='1', vote_day='2026-10-03'),
    'section_diffs': dict(bill_id='hr1-119', from_version_date='2026-09-03', to_version_date='2026-10-03'),
}


class DeferredPublishedPeriods(unittest.TestCase):
    def test_public_values_and_exact_parent_keys_supply_all_reviewed_dimensions(self):
        from types import SimpleNamespace
        for name, sample in DEFERRED_SAMPLES.items():
            with self.subTest(table=name), tempfile.TemporaryDirectory() as folder:
                policy = builder.definitions()[name]
                columns = policy.get('publishedSchema', policy['schema'])
                path, parent_path = Path(folder)/'child.parquet', Path(folder)/'parent.parquet'
                with duckdb.connect() as con:
                    con.execute('CREATE TABLE fixture ('+','.join('"'+field+'" '+kind for field,kind in columns)+')')
                    con.execute('INSERT INTO fixture ('+','.join('"'+field+'"' for field in sample)+') VALUES ('+
                                ','.join('?' for _ in sample)+')', list(sample.values()))
                    con.execute('INSERT INTO fixture DEFAULT VALUES')
                    con.execute('COPY fixture TO ? (FORMAT PARQUET)', [str(path)])
                    con.execute("COPY (SELECT 'hr1-119' AS bill_id,'119' AS congress) TO ? (FORMAT PARQUET)", [str(parent_path)])
                digest = 'sha256:'+hashlib.sha256(path.read_bytes()).hexdigest()
                table = dict(kind='generation', family=policy['family'], rows=2, columns=columns,
                             artifactDigest='sha256:'+'a'*64, publishedAt='2026-10-31T00:00:00Z',
                             members=[dict(key=name+'.parquet', sha256=digest, rows=2,
                                           byteSize=path.stat().st_size, url=str(path))])
                parent = dict(family=policy['family'], artifactDigest=table['artifactDigest'],
                              tableId='congress_bills', recordUrl='https://example.test/exact/artifact.json',
                              members=[], rows=1, urls=[str(parent_path)])
                def selected_parent(child_id, child, relation):
                    self.assertEqual((child_id, relation['mode'], relation['table'], relation['keys']),
                                     (name, 'same-generation', 'congress_bills', [['bill_id','bill_id']]))
                    self.assertEqual(child['artifactDigest'], parent['artifactDigest'])
                    return parent
                with (patch.object(coverage_scan, 'CoverageInputs', return_value=SimpleNamespace(parent=selected_parent)),
                      patch.object(coverage_scan, '_connect', side_effect=duckdb.connect)):
                    selected = {name:policy}
                    builder.validate_plan({name:table}, selected)
                    result = coverage_scan.scan_table(name, table, selected[name])
                self.assertNotIn('processingEvidence', result)
                for definition, dimension in zip(policy['dimensions'], result['dimensions']):
                    self.assertEqual((dimension['placedRows'], dimension['unplacedRows']), (1,1))
                    if definition['kind'] == 'inherited':
                        self.assertEqual(dimension['buckets'], {'["119"]':1})
                        self.assertEqual((dimension['matchedRows'], dimension['unmatchedRows']), (1,1))
                        self.assertEqual(dimension['parent']['artifactDigest'], table['artifactDigest'])
                    elif definition['kind'] == 'date':
                        expected = '2026-09' if definition['fields'] == ['from_version_date'] else '2026-10'
                        self.assertEqual(dimension['buckets'], {expected:1})
                changed = {**table, 'columns': columns + [['unreviewed','VARCHAR']]}
                with self.assertRaisesRegex(ValueError, 'schema needs coverage review'):
                    builder.validate_plan({name:changed}, {name:policy})


class PublishedOnlyRoute(unittest.TestCase):
    def test_policy_is_the_published_schema_or_its_reviewed_alias_and_nothing_else(self):
        policy = {'schema': [['old', 'VARCHAR']], 'dimensions': []}
        self.assertIs(builder.published_policy('t', {'columns': policy['schema']}, policy), policy)
        # Rulemaking snapshots carry no census schema; the scan checks every member footer.
        self.assertIs(builder.published_policy('t', {'columns': None}, policy), policy)
        aliased = {**policy, 'publishedSchema': [['new', 'BIGINT']]}
        self.assertEqual(builder.published_policy('t', {'columns': [['new', 'BIGINT']]}, aliased)['schema'], [['new', 'BIGINT']])
        for changed, chosen in (([['new', 'VARCHAR']], policy), ([['new', 'VARCHAR']], aliased)):
            with self.assertRaisesRegex(ValueError, 'Published schema needs coverage review'):
                builder.published_policy('t', {'columns': changed}, chosen)

    def test_every_reviewed_definition_validates_against_its_own_schema(self):
        # A re-pointed schema must still carry every field its unchanged rules read.
        from coverage_dimensions import validate_definition
        for id, policy in builder.definitions().items():
            with self.subTest(table=id):
                validate_definition(policy, policy.get('publishedSchema', policy['schema']))

    def test_receipt_based_dimensions_refuse_instead_of_reading_receipts(self):
        import regulation_coverage
        policy = builder.definitions()['usaspending_recipients']
        dim = next(d for d in policy['dimensions'] if d.get('special') == 'government-receipt-observation-dates')
        with self.assertRaisesRegex(ValueError, 'Receipt-based coverage dimension retired'):
            regulation_coverage.scan_special(None, 'usaspending_recipients', {}, dim, None)
        with self.assertRaisesRegex(ValueError, 'Receipt-based coverage dimension retired'):
            regulation_coverage.scan_special(
                None, 'gao_reports', {}, {'id': 'retained-origins', 'special': 'government-receipt-origins'}, None
            )

    def test_gao_origins_and_new_published_definitions_measure_public_columns(self):
        import duckdb, pathlib, tempfile
        import coverage_scan
        defs = builder.definitions()
        expected_new = {
            'committee_directory_entries', 'committee_report_cbo_letters',
            'house_disbursements', 'house_disbursements_summary',
            'lobbying_affiliated_organizations', 'lobbying_clients',
            'lobbying_conviction_disclosures', 'lobbying_foreign_entities',
            'lobbying_registrants', 'treasury_statement_classification_cells',
        }
        self.assertTrue(expected_new <= set(defs))
        for table_id in ('gao_reports', 'gao_decisions'):
            policy = defs[table_id]
            dim = next(d for d in policy['dimensions'] if d['id'] == 'retained-origins')
            self.assertEqual(dim['fields'], ['source'])
            self.assertNotIn('special', dim)
            with tempfile.TemporaryDirectory() as folder:
                path = pathlib.Path(folder) / f'{table_id}.parquet'
                cols = ', '.join(f'"{name}" {dtype}' for name, dtype in policy['schema'])
                with duckdb.connect() as conn:
                    conn.execute(f'CREATE TABLE t ({cols})')
                    conn.execute("INSERT INTO t (source) VALUES ('search'), ('search'), ('archive'), (NULL)")
                    conn.execute('COPY t TO ? (FORMAT PARQUET)', [str(path)])
                raw = path.read_bytes()
                table = {
                    'family': 'gao-reports',
                    'kind': 'generation',
                    'columns': policy['schema'],
                    'rows': 4,
                    'publishedAt': '2026-11-11T00:00:00Z',
                    'members': [{'key': path.name, 'url': str(path), 'rows': 4, 'byteSize': len(raw)}],
                    '_coverageAsOfMonth': '2026-11',
                }
                result = coverage_scan.scan_table(table_id, table, policy)
                origins = next(d for d in result['dimensions'] if d['id'] == 'retained-origins')
                self.assertEqual(origins['buckets'], {'["archive"]': 1, '["search"]': 2})
                self.assertEqual((origins['placedRows'], origins['unplacedRows']), (3, 1))


if __name__ == '__main__':
    unittest.main()
