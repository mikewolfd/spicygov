import copy
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

import duckdb

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from coverage_dimensions import binding, parsed_values, scan_dimension, validate_definition
from coverage_inputs import CoverageInputs, inherit_unique
import publication_census


def dimension(kind, fields, **options):
    return {'id': kind, 'kind': kind, 'fields': fields, 'label': 'Source periods',
            'meaning': 'Periods explicitly stated by source records.', **options}


class CoverageDimensionTest(unittest.TestCase):
    def setUp(self):
        self.conn = duckdb.connect()
        self.folder = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.conn.close()
        self.folder.cleanup()

    def file(self, name, ddl, values):
        self.conn.execute(f'CREATE TABLE {name} ({ddl})')
        for row in values:
            self.conn.execute(f'INSERT INTO {name} VALUES ({",".join("?" for _ in row)})', row)
        path = str(pathlib.Path(self.folder.name) / (name + '.parquet'))
        self.conn.execute(f'COPY {name} TO ? (FORMAT PARQUET)', [path])
        return path

    def test_multiple_dimensions_keep_cycles_and_dates_independent(self):
        path = self.file('records', 'cycle INTEGER, event_date VARCHAR', [
            (2024, '2023-12-31'), (2024, '2024-01-02'), (2026, None), (2999, '2024-02-31')])
        cycle = scan_dimension(self.conn, [path], 4, dimension('year', ['cycle']))
        dates = scan_dimension(self.conn, [path], 4, dimension('date', ['event_date']))
        self.assertEqual(cycle['buckets'], {'2024': 2, '2026': 1, '2999': 1})
        self.assertEqual(dates['buckets'], {'2023-12': 1, '2024-01': 1})
        self.assertEqual(dates['unplacedRows'], 2)

    def test_approximate_and_partial_dates_cannot_fill_exact_months(self):
        path = self.file('dates', 'event_date VARCHAR, precision VARCHAR, approx BOOLEAN', [
            ('2024-01-02', 'day', False), ('2024-01-01', 'year', False),
            ('2024-03-01', 'day', True), ('2024', 'year', False), ('2024-02-31', 'day', False)])
        result = scan_dimension(self.conn, [path], 5, dimension('date', ['event_date'], precisionField='precision', approximateField='approx'))
        self.assertEqual(result['buckets'], {'2024-01': 1})
        self.assertEqual(result['placedRows'] + result['unplacedRows'], 5)

    def test_cfr_titles_and_editions_remain_joint_source_scope(self):
        path = self.file('cfr', 'edition INTEGER, title VARCHAR', [(2025, '1'), (2025, '2'), (2026, '2')])
        result = scan_dimension(self.conn, [path], 3, dimension('category', ['edition', 'title']))
        self.assertEqual(result['buckets'], {'["2025","1"]': 1, '["2025","2"]': 1, '["2026","2"]': 1})
        self.assertEqual(result['granularity'], 'category')

    def test_monthly_index_reconciles_weighted_comment_count_not_group_count(self):
        path = self.file('idx', 'year INTEGER, month INTEGER, row_count BIGINT', [(2024, 1, 10), (2024, 1, 20), (2024, 2, 5)])
        dim = dimension('date', ['year', 'month'], syntax='year-month')
        validate_definition({'dimensions': [dim]}, [('year','INTEGER'),('month','INTEGER'),('row_count','BIGINT')])
        result = scan_dimension(self.conn, [path], 35, dim, weight='row_count')
        self.assertEqual(result['buckets'], {'2024-01': 30, '2024-02': 5})
        with self.assertRaises(ValueError): scan_dimension(self.conn, [path], 3, dim, weight='row_count')

    def test_lists_deduplicate_row_membership_and_preserve_partial_values(self):
        path = self.file('lists', 'dates_json VARCHAR', [('["2024-01-02","2024-01-10","2024-03-02"]',), ('["2024-02-31","2024-03-03"]',), ('garbage',), ('[]',)])
        result = scan_dimension(self.conn, [path], 4, dimension('list', ['dates_json'], syntax='date'))
        self.assertEqual(result['buckets'], {'2024-01': 1, '2024-03': 2})
        self.assertEqual(result['placedRows'], 2)
        self.assertEqual(result['partialRows'], 1)
        self.assertTrue(result['overlapping'])

    def test_term_spans_keep_gaps_and_open_ends_unresolved(self):
        path = self.file('terms', 'start VARCHAR, finish VARCHAR', [
            ('2024-01-02','2024-02-01'), ('2024-04-02','2024-04-20'), ('2024-05-02',None)])
        result = scan_dimension(self.conn, [path], 3, dimension('interval', ['start', 'finish'], endBoundary='exclusive'))
        self.assertEqual(result['buckets'], {'2024-01': 1, '2024-04': 1})
        self.assertEqual(result['unplacedRows'], 1)
        self.assertTrue(result['overlapping'])
        self.assertIn('source-stated spans', result['notes'][0])

    def test_year_spans_and_exclusive_timestamp_ends_keep_their_precision(self):
        self.assertEqual(parsed_values(dimension('interval', ['start','end'], syntax='year'), ['0001','0002']), (['0001','0002'], False))
        self.assertEqual(parsed_values(dimension('interval', ['start','end'], endBoundary='exclusive'), ['2024-01-31T23:00:00','2024-02-01T12:00:00']), (['2024-01','2024-02'], False))
        self.assertEqual(parsed_values(dimension('interval', ['start','end'], endBoundary='exclusive'), ['2024-01-31T23:00:00','2024-02-01T00:00:00']), (['2024-01'], False))
        self.assertEqual(parsed_values(dimension('interval', ['start','end']), ['2024-01-02garbage','2024-02-02']), ([], True))

    def test_fractional_index_values_and_non_scalar_row_conditions_remain_unplaced(self):
        path = self.file('fractional', 'year VARCHAR, month VARCHAR', [('2024','1.6'),('2024','2'),('2024.2','1')])
        result = scan_dimension(self.conn,[path],3,dimension('date',['year','month'],syntax='year-month'))
        self.assertEqual(result['buckets'],{'2024-02':1}); self.assertEqual(result['unplacedRows'],2)
        path = self.file('guarded', 'start VARCHAR, finish VARCHAR, status VARCHAR', [('2024-01-02','2024-03-02','valid'),('2024-01-02','2024-04-02','unknown')])
        result = scan_dimension(self.conn,[path],2,dimension('interval',['start','finish'],conditions=[{'field':'status','values':['valid']}]))
        self.assertEqual(result['placedRows'],1); self.assertEqual(result['unplacedRows'],1)
        self.assertEqual(result['yearBuckets'],{'2024':1})

    def test_rfc_feed_and_agenda_editions_use_reviewed_syntax(self):
        self.assertEqual(parsed_values(dimension('date', ['date'], syntax='rfc2822'), ['Wed, 30 Sep 2026 12:13:14 +0000']), (['2026-09'], False))
        self.assertEqual(parsed_values(dimension('date', ['date'], syntax='rfc2822'), ['30 Sep 26']), ([], True))
        path = self.file('agenda', 'edition VARCHAR', [('202504',), ('202510',), ('202501',)])
        result = scan_dimension(self.conn, [path], 3, dimension('category', ['edition'], syntax='agenda'))
        self.assertEqual(result['buckets'], {'2025-fall': 1, '2025-spring': 1})
        self.assertEqual(result['granularity'], 'season')

    def test_unknown_generic_options_fail_before_scanning_or_parsing(self):
        columns = [('start','VARCHAR'),('finish','VARCHAR')]
        invalid = [
            dimension('category',['start'],syntax='misspelled-agenda'),
            dimension('date',['start'],syntax='literal'),
            dimension('year',['start'],syntax='date'),
            dimension('snapshot',[],syntax='iso'),
            dimension('list',['start']),
            dimension('list',['start'],syntax='misspelled-date'),
            dimension('interval',['start','finish'],syntax='misspelled-iso'),
            dimension('interval',['start','finish'],endBoundary='misspelled-exclusive'),
            dimension('date',['start'],endBoundary='exclusive'),
            dimension('interval',['start','finish'],syntax='year',endBoundary='exclusive'),
        ]
        for dim in invalid:
            with self.subTest(dim=dim):
                with self.assertRaises(ValueError): validate_definition({'dimensions':[dim]},columns)
                # No table read should occur before a policy option is refused.
                with self.assertRaises(ValueError): scan_dimension(self.conn,['absent.parquet'],1,dim)
                with self.assertRaises(ValueError): parsed_values(dim,['2024-01-31','2024-02-01'])

    def test_inherited_generic_options_are_validated_before_parent_lookup(self):
        parent = {'table':'events','mode':'same-generation','keys':[['key','key']]}
        for nested in (dimension('category',['scope'],syntax='misspelled-agenda'),
                       dimension('list',['dates']),
                       dimension('interval',['start','end'],endBoundary='typo')):
            inherited = dimension('inherited',[],parent=parent,dimension=nested)
            with self.subTest(nested=nested), self.assertRaises(ValueError):
                validate_definition({'dimensions':[inherited]},[('key','VARCHAR')])
        inherited = dimension('inherited',[],parent=parent,
                              dimension=dimension('date',['event_date'],syntax='iso'))
        validate_definition({'dimensions':[inherited]},[('key','VARCHAR')])

    def test_explicit_iso_date_intervals_preserve_distinct_annual_memberships(self):
        path = self.file('aliases','start VARCHAR, finish VARCHAR',[
            ('2024-01-31','2024-02-01'),('2024-02-03','2024-03-04')])
        for syntax in (None,'date','iso'):
            dim = dimension('interval',['start','finish'],syntax=syntax,endBoundary='exclusive')
            validate_definition({'dimensions':[dim]},[('start','VARCHAR'),('finish','VARCHAR')])
            result = scan_dimension(self.conn,[path],2,dim)
            self.assertEqual(result['buckets'],{'2024-01':1,'2024-02':1,'2024-03':1})
            self.assertEqual(result['yearBuckets'],{'2024':2})
        for dim in (dimension('year',['start'],syntax='year'),
                    dimension('category',['start'],syntax='literal'),
                    dimension('list',['start'],syntax='literal')):
            validate_definition({'dimensions':[dim]},[('start','VARCHAR')])

    def test_specialized_readers_own_their_source_options(self):
        for marker in ('method','special'):
            dim = dimension('list',['source_json'],syntax='source-native',
                            endBoundary='source-native',**{marker:'reviewed-source-reader'})
            validate_definition({'dimensions':[dim]},[('source_json','VARCHAR')])

    def test_binding_tracks_publication_boundary_and_paired_measurement_inputs(self):
        definition = {'dimensions':[dimension('date',['posted_date'])]}
        table = {'family':'comments','rows':1,'columns':[['posted_date','VARCHAR']],
                 'members':[{'url':'same','rows':1,'byteSize':10}],
                 'publishedAt':'2024-01-31T00:00:00Z','pairedIdentity':'index-one'}
        # The census owns the paired-input representation; binding must carry
        # its result unchanged, even while that helper is being integrated.
        with mock.patch.object(publication_census,'inputs_fingerprint',
                               side_effect=lambda value: value['pairedIdentity'],create=True) as inputs:
            old = binding(table,definition)
            changed = {**table,'publishedAt':'2024-02-29T00:00:00Z'}
            self.assertNotEqual(old,binding(changed,definition))
            changed = {**table,'pairedIdentity':'index-two'}
            self.assertNotEqual(old,binding(changed,definition))
            self.assertEqual(binding(changed,definition)['inputsFingerprint'],'index-two')
            inputs.assert_called_with(changed)
        receipt = {'format_version':1,'source':{},'files':{
            'comments.parquet':{'rows':1,'bytes':10,'sha256':'a'*64,'etag':'comments-one'},
            'comments_index.parquet':{'rows':1,'bytes':20,'sha256':'b'*64,'etag':'index-one'},
        }}
        paired = publication_census.comments_tables(receipt)
        for file in receipt['files']:
            changed = copy.deepcopy(receipt)
            changed['files'][file].update(sha256='c'*64,etag='changed-export')
            updated = publication_census.comments_tables(changed)
            for id in paired:
                with self.subTest(changed_file=file,measured_table=id):
                    self.assertNotEqual(binding(paired[id],definition),binding(updated[id],definition))

    def test_missing_schema_and_changed_meaning_cannot_reuse_coverage(self):
        definition = {'dimensions': [dimension('date', ['vote_day'])]}
        with self.assertRaises(ValueError): validate_definition(definition, [('vote_date', 'VARCHAR')])
        table = {'family':'votes','rows':1,'columns':[['vote_day','DATE']], 'members':[{'url':'same', 'rows':1,'byteSize':10}], 'artifactDigest':'old'}
        old = binding(table, definition)
        table['artifactDigest'] = 'new'
        self.assertNotEqual(old, binding(table, definition))
        changed = copy.deepcopy(definition); changed['dimensions'][0]['meaning'] = 'A revised source meaning.'
        self.assertNotEqual(binding(table, definition), binding(table, changed))

    def test_inheritance_uses_unique_parent_and_keeps_unmatched_rows(self):
        child = self.file('child', 'key VARCHAR', [('a',), ('a',), ('b',), (None,)])
        parent = self.file('parent', 'key VARCHAR, vote_day VARCHAR', [('a','2024-01-02')])
        descriptor = {'urls':[parent], 'rows':1,'family':'votes','tableId':'votes','artifactDigest':'old','recordUrl':'receipt','members':[]}
        result = inherit_unique(self.conn, [child], 4, descriptor, {'keys':[['key','key']]}, dimension('date',['vote_day']))
        self.assertEqual(result['buckets'], {'2024-01':2})
        self.assertEqual(result['unmatchedRows'], 2)
        self.assertEqual(result['unplacedRows'], 2)
        with self.assertRaisesRegex(ValueError, 'parent row count'):
            inherit_unique(self.conn,[child],4,{**descriptor,'rows':999},{'keys':[['key','key']]},dimension('date',['vote_day']))
        duplicate = self.file('duplicate', 'key VARCHAR, vote_day VARCHAR', [('a','2024-01-02'),('a','2024-02-02')])
        with self.assertRaisesRegex(ValueError, 'not unique'):
            inherit_unique(self.conn, [child], 4, {**descriptor,'urls':[duplicate],'rows':2}, {'keys':[['key','key']]}, dimension('date',['vote_day']))

    def test_recorded_parent_refuses_a_different_member(self):
        inputs = CoverageInputs()
        pin = {'family':'votes','artifactDigest':'sha256:'+'a'*64,'sha256':'sha256:'+'b'*64,'byteSize':10}
        inputs.producing = lambda *_: {'artifact':{'spec':{'parents':{'votes.parquet':pin}}}}
        inputs.table = lambda *_: {'members':[{'sha256':'sha256:'+'c'*64,'byteSize':10}]}
        with self.assertRaisesRegex(ValueError, 'differs'):
            inputs.parent('child', {}, {'table':'votes','mode':'recorded-parent'})

    def test_column_measurement_time_does_not_consume_the_input_lookup_budget(self):
        clock = [0.0]
        def network(_):
            clock[0] += 2
            return b'recorded input'
        with mock.patch('collection_coverage.time.monotonic', side_effect=lambda: clock[0]), \
             mock.patch('collection_coverage.fetch', side_effect=network) as fetch:
            inputs = CoverageInputs()
            clock[0] = 900  # Earlier table columns took longer than the lookup allowance.
            self.assertEqual(inputs.fetch('first'), b'recorded input')
            clock[0] += 900  # More column work between two required parent lookups.
            self.assertEqual(inputs.fetch('second'), b'recorded input')
            self.assertEqual(fetch.call_count, 2)

    def test_input_fetch_time_still_has_a_cumulative_budget(self):
        clock = [0.0]
        def network(_):
            clock[0] += 120
            return b'recorded input'
        with mock.patch('collection_coverage.time.monotonic', side_effect=lambda: clock[0]), \
             mock.patch('collection_coverage.fetch', side_effect=network) as fetch:
            inputs = CoverageInputs()
            self.assertEqual(inputs.fetch('first'), b'recorded input')
            clock[0] += 900
            self.assertEqual(inputs.fetch('second'), b'recorded input')
            with self.assertRaisesRegex(ValueError, 'lookup exceeded'):
                inputs.fetch('third')
            self.assertEqual(fetch.call_count, 2)


if __name__ == '__main__': unittest.main()
