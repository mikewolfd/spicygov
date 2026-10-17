"""Measure one published table, and name the code that measurement depends on.

A measurement revision hashes exactly this module, the shared helpers and the
one scanner a table's definition names, so editing orchestration
(build-coverage-maps.py), release assembly or time allowances keeps checkpoints
while an edit to one scanner re-measures only that scanner's tables. Native
tables add the reader bridge; those modules are imported only when a table is
measured natively, and tests/test_coverage_scan_identity.py keeps the lists
below equal to what each scanner actually imports.
"""
from contextlib import ExitStack
import datetime
import hashlib
import importlib
import pathlib
import re
import subprocess

import duckdb

from coverage_dimensions import binding, definition_digest, scan_dimension, validate_definition
from coverage_inputs import CoverageInputs, inherit_unique
from publication_census import schema

SCRIPTS = pathlib.Path(__file__).resolve().parent
SHARED = ('coverage_scan.py', 'coverage_dimensions.py', 'coverage_inputs.py', 'collection_coverage.py',
          'publication_census.py')
SCANNER = {'congress': ('congress_coverage.py',),
           'regulation': ('regulation_coverage.py', 'native_receipt_coverage.py', 'gao_receipt_policy.py'),
           'fec': ('fec_coverage.py',)}
# Imported lazily by tables measured through the packaged reader and the
# spicygov restoration adapters.
NATIVE = ('native_legislative_coverage.py',)
ADDITIONAL = ('additional_native_coverage.py', 'restore_additional_coverage.py',
              'restore_source_navigation_coverage.py')


def file_digest(identity, names):
    value = hashlib.sha256(identity.encode())
    for name in names:
        data = (SCRIPTS / name).read_bytes()
        value.update(len(data).to_bytes(8, 'big'))
        value.update(data)
    return 'sha256:' + value.hexdigest()


def measurement_revision(policy):
    scanner = SCANNER[policy['_scanner']]
    if policy.get('_additionalNativeProcessing'):
        return file_digest(policy['restorationImplementationSha256'], SHARED + scanner + NATIVE + ADDITIONAL)
    if policy.get('_nativeProcessing'):
        return file_digest(policy['restorationImplementationSha256'], SHARED + scanner + NATIVE)
    return file_digest('', SHARED + scanner)


def validate_counts(dimension, rows):
    if not isinstance(dimension, dict) or dimension.get('status') != 'measured':
        raise ValueError('A required coverage dimension was not measured')
    integers = ('rows', 'placedRows', 'unplacedRows')
    if any(type(dimension.get(k)) is not int or dimension[k] < 0 for k in integers):
        raise ValueError('Coverage counts must be nonnegative integers')
    if dimension['rows'] != rows or dimension['placedRows'] + dimension['unplacedRows'] != rows:
        raise ValueError('Coverage placed/unplaced counts do not reconcile')
    buckets = dimension.get('buckets')
    if (not isinstance(buckets, dict) or any(not isinstance(k, str) or not k
            or type(n) is not int or n <= 0 for k, n in buckets.items())):
        raise ValueError('Invalid coverage buckets')
    grain = dimension.get('granularity')
    if grain not in ('month', 'year', 'season', 'category', 'snapshot'):
        raise ValueError('Invalid coverage granularity')
    pattern = {'month': r'[0-9]{4}-(0[1-9]|1[0-2])', 'year': r'[0-9]{4}', 'season': r'[0-9]{4}-(spring|fall)'}.get(grain)
    if pattern and any(not re.fullmatch(pattern, key) or key[:4] == '0000' for key in buckets):
        raise ValueError('Coverage has an invalid period key')
    if grain == 'snapshot' and buckets: raise ValueError('Snapshot cannot claim historical buckets')
    if 'activityBoundary' in dimension:
        boundary = dimension['activityBoundary']
        if (not isinstance(boundary, dict) or boundary.get('basis') not in ('publication-month', 'measurement-month')
                or not isinstance(boundary.get('month'), str)
                or not re.fullmatch(r'[0-9]{4}-(0[1-9]|1[0-2])', boundary['month'])
                or boundary['month'].startswith('0000')):
            raise ValueError('Invalid activity boundary')
    if 'snapshot' in dimension:
        snapshot = dimension['snapshot']
        if not isinstance(snapshot, dict): raise ValueError('Invalid snapshot facts')
        if 'asOf' in snapshot:
            stamp = snapshot['asOf']
            if not isinstance(stamp, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])', stamp):
                raise ValueError('Snapshot calculation time must include its timezone')
            try: datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00'))
            except ValueError as error: raise ValueError('Invalid snapshot calculation time') from error
        if 'facts' in snapshot and (not isinstance(snapshot['facts'], list) or any(
                not isinstance(fact, dict) or any(not isinstance(fact.get(key), str) or not fact[key].strip()
                                                for key in ('label', 'value')) for fact in snapshot['facts'])):
            raise ValueError('Invalid snapshot facts')
    if 'overlapping' in dimension and type(dimension['overlapping']) is not bool:
        raise ValueError('Coverage overlap must be a boolean')
    for key in ('partialRows', 'matchedRows', 'unmatchedRows'):
        if key in dimension and (type(dimension[key]) is not int or not 0 <= dimension[key] <= rows):
            raise ValueError('Invalid auxiliary coverage count')
    if 'matchedRows' in dimension and 'unmatchedRows' in dimension and dimension['matchedRows'] + dimension['unmatchedRows'] != rows:
        raise ValueError('Inherited matched/unmatched counts do not reconcile')
    if 'partialRows' in dimension and dimension['partialRows'] > dimension['placedRows']:
        raise ValueError('Partial coverage exceeds placed rows')
    if 'yearBuckets' in dimension and (not isinstance(dimension['yearBuckets'], dict)
            or any(not re.fullmatch(r'[0-9]{4}', key) or key == '0000'
                   or type(n) is not int or not 0 < n <= rows for key, n in dimension['yearBuckets'].items())):
        raise ValueError('Invalid deduplicated year counts')
    if 'notes' in dimension and (not isinstance(dimension['notes'], list)
            or any(not isinstance(note, str) for note in dimension['notes'])):
        raise ValueError('Coverage notes must be a list of text')
    if grain != 'snapshot':
        total = sum(buckets.values())
        if dimension.get('overlapping'):
            if total < dimension['placedRows'] or any(n > rows for n in buckets.values()):
                raise ValueError('Overlapping coverage counts are inconsistent')
        elif total != dimension['placedRows']:
            raise ValueError('Coverage bucket counts do not reconcile')


def header_matches(url, expected_etag, expected_bytes=None):
    headers = subprocess.check_output(['curl', '-fsSI', '--retry', '2', '--max-time', '30', url]).decode()
    values = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip()
              for line in headers.splitlines() if ':' in line}
    if values.get('etag') != expected_etag:
        raise ValueError('Mutable export differs from its publication ETag')
    if expected_bytes is not None and values.get('content-length') != str(expected_bytes):
        raise ValueError('Mutable export size differs from its publication receipt')


def check_mutable(table):
    """Refuse a mutable export that no longer matches the publication that described it."""
    if table.get('coverageInputs'):
        for entry in table['coverageInputs']:
            header_matches(entry['url'], entry['etag'], entry['byteSize'])
    else:
        first = table['members'][0]
        if table.get('etag'): header_matches(first['url'], table['etag'], first['byteSize'])
        if table.get('dateIndex'): header_matches(table['dateIndex'], table['dateIndexETag'])


def validate_members(conn, id, table, expected_schema):
    # DESCRIBE on a file list describes only the first member. Check each footer
    # independently so a later schema/count change cannot hide behind it.
    for member in table['members']:
        actual = [[row[0], row[1]] for row in conn.execute(
            'DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)', [member['url']]).fetchall()]
        if actual != expected_schema:
            raise ValueError('Retained member schema differs from its coverage review: ' + id)
        rows = conn.execute('SELECT count(*) FROM read_parquet(?, hive_partitioning=false)', [member['url']]).fetchone()[0]
        if rows != member['rows']:
            raise ValueError('Retained member row count differs from its publication: ' + id)


def _connect():
    conn = duckdb.connect()
    try:
        # Render stored instants in UTC, regardless of the host's timezone.
        conn.execute("SET TimeZone='UTC'")
        conn.execute('LOAD httpfs')
        conn.execute("SET memory_limit='512MB'")
        conn.execute('SET threads=2')
        conn.execute('SET http_timeout=30')
    except BaseException:
        conn.close()
        raise
    return conn


def _measure(conn, id, table, urls, policy, inputs):
    # Use one resolver per table, shared by all its axes.
    result = []
    for dim in policy['dimensions']:
        measured = None
        if dim.get('special') or dim.get('method'):
            helper = importlib.import_module(policy['_scanner'] + '_coverage')
            measured = helper.scan_special(conn, id, table, dim, inputs)
            if measured is None: raise ValueError('Unsupported specialized coverage dimension: ' + dim['id'])
        elif dim['kind'] == 'inherited':
            parent = inputs.parent(id, table, dim['parent'])
            measured = inherit_unique(conn, urls, table['rows'], parent, dim['parent'], dim['dimension'])
        else:
            measured = scan_dimension(conn, urls, table['rows'], dim, snapshot={
                'publishedAt': table.get('publishedAt'), 'artifactDigest': table.get('artifactDigest'),
                'recordUrl': table.get('recordUrl'), 'publicationSha256': table.get('checksum')})
        validate_counts(measured, table['rows'])
        measured.update(id=dim['id'], label=dim['label'], meaning=dim['meaning'],
                        definitionDigest=definition_digest(dim))
        result.append(measured)
    return result


def _scan_published_table(id, table, policy):
    revision = measurement_revision(policy)
    conn = _connect()
    try:
        check_mutable(table)
        actual_schema = schema(policy['schema'])
        validate_members(conn, id, table, actual_schema)
        validate_definition(policy, actual_schema)
        table = {**table, 'columns': actual_schema}
        result = _measure(conn, id, table, [m['url'] for m in table['members']], policy, CoverageInputs())
        check_mutable(table)
        if measurement_revision(policy) != revision: raise ValueError('Coverage implementation changed during this table scan')
        return {**binding(table, policy), 'status': 'measured', 'classification': policy['classification'],
                'note': policy.get('note', ''), 'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'measurementRevision': revision, 'dimensions': result}
    finally: conn.close()


def _scan_native_table(id, table, policy):
    from native_legislative_coverage import processing_context
    revision = measurement_revision(policy)
    conn = _connect()
    contexts = ExitStack()
    try:
        check_mutable(table)
        actual_schema = schema(policy['schema'])
        validate_members(conn, id, table, actual_schema)
        validate_definition(policy, schema(policy.get('processingSchema', actual_schema)))
        table = {**table, 'columns': actual_schema}
        physical_table = table
        table, inputs = contexts.enter_context(processing_context(id, table, policy, CoverageInputs()))
        urls = table.get('_coverageUrls', [m['url'] for m in table['members']])
        table = {**table, 'members': [{**member, 'url': url} for member, url in zip(table['members'], urls)]}
        result = _measure(conn, id, table, urls, policy, inputs)
        check_mutable(physical_table)
        if measurement_revision(policy) != revision: raise ValueError('Coverage implementation changed during this table scan')
        return {**binding(physical_table, policy), 'status': 'measured', 'classification': policy['classification'],
                'note': policy.get('note', ''), 'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'measurementRevision': revision, 'dimensions': result,
                **({'processingEvidence': {
                    'dataset': table['_coverageProcessing']['dataset'],
                    'generationId': table['_coverageProcessing']['generationId'],
                    'rows': table['_coverageProcessing']['rows'],
                    'subjects': [{k: v for k, v in member.items() if k != 'path'} for member in table['_coverageProcessing']['selection']['subjects']],
                    'receipts': {k: v for k, v in table['_coverageProcessing']['selection']['receipts'].items() if k != 'path'},
                    'qualification': 'Private source values restored by the maintained selected-prior reader.'
                }} if table.get('_coverageProcessing') else {})}
    finally:
        contexts.close()
        conn.close()


def scan_table(id, table, policy):
    if policy.get('_additionalNativeProcessing'):
        import additional_native_coverage as additional
        return additional.scan_table(id, table, policy, validate_members=validate_members, validate_counts=validate_counts)
    return (_scan_native_table if policy.get('_nativeProcessing') else _scan_published_table)(id, table, policy)
