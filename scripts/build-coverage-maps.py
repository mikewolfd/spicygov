"""Build a reviewed, receipt-bound coverage map for every Sources table.

Missing definitions, schema drift, failed scans and unreconciled dimensions fail
the build. The previous published inventory is replaced only after every table
passes. Presence measures retained rows; it never proves publisher completeness.
"""
from contextlib import ExitStack
import argparse
import concurrent.futures
import datetime
import importlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile

import duckdb

from coverage_dimensions import binding, definition_digest, scan_dimension, validate_definition
from coverage_inputs import CoverageInputs, inherit_unique
from native_legislative_coverage import processing_context, variant
from publication_census import census_digest, load, schema

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/coverage-maps.v1.json'
CACHE = ROOT / '.cache/coverage-maps'


def measurement_revision(policy=None):
    import hashlib
    from coverage_revision import legacy_revision
    if not policy or not policy.get('_nativeProcessing'):
        revision = legacy_revision(ROOT, __file__)
        if revision: return revision
    paths = [pathlib.Path(__file__), *(ROOT / 'scripts' / name for name in (
        'coverage_dimensions.py', 'coverage_inputs.py', 'publication_census.py',
        'collection_coverage.py', 'congress_coverage.py', 'regulation_coverage.py', 'fec_coverage.py',
        'native_receipt_coverage.py', 'native_legislative_coverage.py', 'coverage_revision.py'))]
    return 'sha256:' + hashlib.sha256(b''.join(path.read_bytes() for path in paths)).hexdigest()


def definitions(folder=None):
    result = {}
    for path in sorted((folder or ROOT / 'content/coverage-definitions').glob('*.json')):
        document = json.loads(path.read_text())
        if document.get('format') != 'spicygov-coverage-definitions' or document.get('version') != 1 or not isinstance(document.get('tables'), dict):
            raise ValueError('Unsupported coverage definitions: ' + str(path))
        for id, definition in document['tables'].items():
            if id in result: raise ValueError('Duplicate coverage definition: ' + id)
            if path.stem not in ('congress', 'regulation', 'fec'): raise ValueError('Unknown coverage scanner: ' + path.stem)
            result[id] = {**definition, '_scanner': path.stem}
    if not result: raise ValueError('No reviewed coverage definitions')
    return result


def validate_plan(tables, policies):
    missing = sorted(set(tables) - set(policies))
    if missing: raise ValueError('Published tables need coverage review: ' + ', '.join(missing))
    # Old reviewed entries may remain as history, but cannot create runtime tables.
    for id, table in tables.items():
        policy = policies[id] = variant(id, table, policies[id])
        if policy.get('family') != table['family']: raise ValueError('Coverage family changed: ' + id)
        if not isinstance(policy.get('classification'), str) or not policy['classification'].strip():
            raise ValueError('Coverage classification is missing: ' + id)
        expected = schema(policy.get('schema'))
        if table.get('columns') and table['kind'] == 'generation' and expected != schema(table['columns']):
            raise ValueError('Published schema needs coverage review: ' + id)
        validate_definition(policy, schema(policy.get('processingSchema', expected)))


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


def _scan_legacy_table(id, table, policy):
    revision = measurement_revision()
    conn = duckdb.connect()
    try:
        # Render stored instants in UTC, regardless of the host's timezone.
        conn.execute("SET TimeZone='UTC'")
        conn.execute('LOAD httpfs')
        conn.execute("SET memory_limit='512MB'")
        conn.execute('SET threads=2')
        conn.execute('SET http_timeout=30')
        urls = [m['url'] for m in table['members']]
        def check_mutable():
            if table.get('coverageInputs'):
                for entry in table['coverageInputs']:
                    header_matches(entry['url'], entry['etag'], entry['byteSize'])
            else:
                if table.get('etag'): header_matches(urls[0], table['etag'], table['members'][0]['byteSize'])
                if table.get('dateIndex'): header_matches(table['dateIndex'], table['dateIndexETag'])
        check_mutable()
        actual_schema = schema(policy['schema'])
        validate_members(conn, id, table, actual_schema)
        validate_definition(policy, actual_schema)
        table = {**table, 'columns': actual_schema}
        inputs = CoverageInputs()
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
        check_mutable()
        if measurement_revision() != revision: raise ValueError('Coverage implementation changed during this table scan')
        return {**binding(table, policy), 'status': 'measured', 'classification': policy['classification'],
                'note': policy.get('note', ''), 'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'measurementRevision': revision, 'dimensions': result}
    finally: conn.close()


def _scan_native_table(id, table, policy):
    revision = measurement_revision(policy)
    conn = duckdb.connect()
    contexts = ExitStack()
    try:
        # Render stored instants in UTC, regardless of the host's timezone.
        conn.execute("SET TimeZone='UTC'")
        conn.execute('LOAD httpfs')
        conn.execute("SET memory_limit='512MB'")
        conn.execute('SET threads=2')
        conn.execute('SET http_timeout=30')
        urls = [m['url'] for m in table['members']]
        def check_mutable():
            if table.get('coverageInputs'):
                for entry in table['coverageInputs']:
                    header_matches(entry['url'], entry['etag'], entry['byteSize'])
            else:
                if table.get('etag'): header_matches(urls[0], table['etag'], table['members'][0]['byteSize'])
                if table.get('dateIndex'): header_matches(table['dateIndex'], table['dateIndexETag'])
        check_mutable()
        actual_schema = schema(policy['schema'])
        validate_members(conn, id, table, actual_schema)
        validate_definition(policy, schema(policy.get('processingSchema', actual_schema)))
        table = {**table, 'columns': actual_schema}
        inputs = CoverageInputs()
        physical_table = table
        table, inputs = contexts.enter_context(processing_context(id, table, policy, inputs))
        urls = table.get('_coverageUrls', urls)
        table = {**table, 'members': [{**member, 'url': url} for member, url in zip(table['members'], urls)]}
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
        check_mutable()
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
    return (_scan_native_table if policy.get('_nativeProcessing') else _scan_legacy_table)(id, table, policy)


def cached(table, policy, old):
    if not isinstance(old, dict) or old.get('status') != 'measured': return False
    if old.get('measurementRevision') != measurement_revision(policy): return False
    comparable = {**table, 'columns': policy['schema']}
    if any(old.get(k) != v for k, v in binding(comparable, policy).items()): return False
    dims = old.get('dimensions', [])
    if len(dims) != len(policy['dimensions']): return False
    try:
        for dim, measured in zip(policy['dimensions'], dims):
            if measured.get('id') != dim['id'] or measured.get('definitionDigest') != definition_digest(dim): return False
            validate_counts(measured, table['rows'])
            if dim.get('special') == 'literal-date-anomalies':
                from regulation_coverage import activity_boundary
                if measured.get('activityBoundary') != activity_boundary(table): return False
        if table.get('coverageInputs'):
            for entry in table['coverageInputs']:
                header_matches(entry['url'], entry['etag'], entry['byteSize'])
        else:
            if table.get('etag'): header_matches(table['members'][0]['url'], table['etag'], table['members'][0]['byteSize'])
            if table.get('dateIndex'): header_matches(table['dateIndex'], table['dateIndexETag'])
    except (ValueError, OSError, subprocess.SubprocessError): return False
    return True


def timed_scan(item):
    id, table, policy, old = item
    if cached(table, policy, old): return id, old
    # Full saved-text reads across the comments release exceed the ordinary
    # table budget; keep the larger allowance limited to this measured case.
    timeout_seconds = 3600 if id in ('comments', 'fec_receipts') else 900
    try:
        # DuckDB's default spill directory is relative to the working directory.
        # Keep concurrent readers separate and clean up even after a timeout.
        with tempfile.TemporaryDirectory(prefix='spicygov-coverage-') as workdir:
            process = subprocess.run([sys.executable, __file__, '--scan'],
                input=json.dumps({'id': id, 'table': table, 'policy': policy}), text=True,
                capture_output=True, timeout=timeout_seconds, check=True, cwd=workdir)
        return id, json.loads(process.stdout.splitlines()[-1])
    except subprocess.CalledProcessError as error:
        raise ValueError(id + ': ' + error.stderr[-1500:]) from error
    except subprocess.TimeoutExpired as error:
        raise ValueError(f'{id}: coverage scan exceeded its {timeout_seconds}-second time limit') from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scan', action='store_true')
    parser.add_argument('--only', nargs='+')
    parser.add_argument('--output', type=pathlib.Path, default=OUTPUT)
    args = parser.parse_args()
    if args.scan:
        request = json.load(sys.stdin)
        print(json.dumps(scan_table(request['id'], request['table'], request['policy'])))
        return
    if args.only and args.output.resolve() == OUTPUT.resolve():
        raise ValueError('Partial scans require a separate output file')
    setup = duckdb.connect(); setup.execute('INSTALL httpfs'); setup.close()
    _, tables = load()
    policies = definitions()
    validate_plan(tables, policies)
    previous = json.loads(args.output.read_text()).get('tables', {}) if args.output.exists() else {}
    CACHE.mkdir(parents=True, exist_ok=True)
    for id in tables:
        checkpoint = CACHE / (id + '.json')
        if checkpoint.exists():
            try: previous[id] = json.loads(checkpoint.read_text())
            except (OSError, ValueError): pass
    revision = measurement_revision()
    # A build has one UTC reference month; it is measurement context, not a
    # substitute publication date or part of the source census.
    as_of_month = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')
    selected = {id: {**table, '_coverageAsOfMonth': as_of_month}
                for id, table in tables.items() if not args.only or id in args.only}
    if args.only and set(args.only) != set(selected): raise ValueError('Requested table is not currently published')
    results, failures = {}, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {pool.submit(timed_scan, (id, table, policies[id], previous.get(id))): id for id, table in selected.items()}
        for future in concurrent.futures.as_completed(futures):
            id = futures[future]
            try:
                _, result = future.result()
                results[id] = result
                checkpoint = CACHE / (id + '.json')
                temp = checkpoint.with_suffix('.tmp'); temp.write_text(json.dumps(result)); temp.replace(checkpoint)
                print(f'{id}: {len(result["dimensions"])} dimensions reconciled', flush=True)
            except Exception as error:
                failures.append(str(error)); print(str(error), file=sys.stderr, flush=True)
    if failures: raise ValueError('Coverage build failed; published maps kept unchanged:\n' + '\n'.join(failures))
    if definitions() != policies:
        raise ValueError('Coverage definitions changed during the build; rerun the reviewed policies')
    if measurement_revision() != revision or any(result.get('measurementRevision') != revision for result in results.values()):
        raise ValueError('Coverage implementation changed during the build; rerun the reviewed code')
    if set(results) != set(selected): raise ValueError('Coverage build omitted a published table')
    # Confirm membership/bindings still match after all scans, including mutable receipts.
    _, final_tables = load()
    if census_digest(final_tables) != census_digest(tables): raise ValueError('Publication changed during coverage build; retry against the new release')
    document = {'format': 'spicygov-coverage-maps', 'version': 1, 'partial': bool(args.only),
                'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'censusDigest': census_digest(tables), 'tables': dict(sorted(results.items()))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temp = args.output.with_suffix('.tmp'); temp.write_text(json.dumps(document, separators=(',', ':')) + '\n')
    if not args.only:
        subprocess.run(['node', str(ROOT / 'scripts/check-coverage-maps.mjs'), str(temp)], check=True, cwd=ROOT)
    temp.replace(args.output)
    print(f'All {len(results)} requested coverage maps verified', flush=True)


if __name__ == '__main__': main()
