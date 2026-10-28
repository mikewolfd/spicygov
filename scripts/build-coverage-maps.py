"""Build a reviewed, receipt-bound coverage map for every Sources table.

Missing definitions, schema drift, failed scans and unreconciled dimensions fail
the build. A full release requires every table; an explicit refresh preserves
unselected measurements unchanged. Presence never proves publisher completeness.
"""
from contextlib import nullcontext
import argparse
import concurrent.futures
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile
import threading

import duckdb

import coverage_allowances as allowances
from coverage_dimensions import binding, definition_digest, validate_definition
import native_legislative_coverage as native
from native_legislative_coverage import forward_restore_diagnostics, validate_native_implementations, variant
import additional_native_coverage as additional
from coverage_scan import check_mutable, measurement_revision, scan_table, validate_counts
from publication_census import census_digest, load, schema

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'public/coverage-maps.v1.json'
CACHE = ROOT / '.cache/coverage-maps'
HEAVY_NATIVE_SCAN_LOCK = threading.Lock()


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


def validate_plan(tables, policies, available_tables=None):
    available_tables = tables if available_tables is None else available_tables
    missing = sorted(set(tables) - set(policies))
    if missing: raise ValueError('Published tables need coverage review: ' + ', '.join(missing))
    # Old reviewed entries may remain as history, but cannot create runtime tables.
    for id, table in tables.items():
        # Holdings comparisons use the same captured publication census. They
        # describe what we have now, not the inputs of an earlier processing run.
        definition = {**policies[id], 'dimensions': [
            {**dim, **({'comparison': available_tables[dim['comparisonTable']]}
                      if dim.get('comparisonTable') else {})}
            for dim in policies[id]['dimensions']]}
        policy = policies[id] = additional.variant(id, table, variant(id, table, definition))
        if policy.get('family') != table['family']: raise ValueError('Coverage family changed: ' + id)
        if not isinstance(policy.get('classification'), str) or not policy['classification'].strip():
            raise ValueError('Coverage classification is missing: ' + id)
        expected = schema(policy.get('schema'))
        if table.get('columns') and table['kind'] == 'generation' and expected != schema(table['columns']):
            raise ValueError('Published schema needs coverage review: ' + id)
        validate_definition(policy, schema(policy.get('processingSchema', expected)))


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
        check_mutable(table)
    except (ValueError, OSError, subprocess.SubprocessError): return False
    return True


def timed_scan(item):
    id, table, policy, old = item
    if cached(table, policy, old): return id, old
    timeout_seconds = allowances.scan_seconds(id, policy.get('_additionalNativeProcessing'))
    # Every native dataset was described once by main(); the child reuses those descriptions.
    request = {'id': id, 'table': table, 'policy': policy,
               'descriptions': {'legislative': native.SCHEMAS, 'additional': additional.SCHEMAS}}
    try:
        # DuckDB's default spill directory is relative to the working directory.
        # Keep concurrent readers separate and clean up even after a timeout.
        # Full selected receipt admission can use several GiB beyond DuckDB's
        # memory limit. Queue the measured large receipt readers before starting their timer;
        # other scans keep the existing parallelism and cached maps return above.
        serial = id in ('court_opinions', 'court_citation_map', 'court_citations', 'court_parentheticals',
                        'court_opinion_clusters', 'documents', 'federal_register', 'fr_docket_links',
                        'comment_periods', 'rule_targets') and policy.get('_additionalNativeProcessing')
        with (HEAVY_NATIVE_SCAN_LOCK if serial else nullcontext()), tempfile.TemporaryDirectory(prefix='spicygov-coverage-') as workdir:
            process = subprocess.run([sys.executable, __file__, '--scan'],
                input=json.dumps(request), text=True,
                capture_output=True, timeout=timeout_seconds, check=True, cwd=workdir)
        forward_restore_diagnostics(process.stderr)
        return id, json.loads(process.stdout.splitlines()[-1])
    except subprocess.CalledProcessError as error:
        forward_restore_diagnostics(error.stderr)
        raise ValueError(id + ': ' + error.stderr[-1500:]) from error
    except subprocess.TimeoutExpired as error:
        forward_restore_diagnostics(error.stderr)
        raise ValueError(f'{id}: coverage scan exceeded its {timeout_seconds}-second time limit') from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--scan', action='store_true')
    parser.add_argument('--only', nargs='+')
    parser.add_argument('--output', type=pathlib.Path, default=OUTPUT)
    parser.add_argument('--release-output', type=pathlib.Path)
    parser.add_argument('--refresh-from', type=pathlib.Path,
                        help='Retained coverage map to preserve outside --only')
    parser.add_argument('--base-sha256', help='Reviewed SHA-256 of --refresh-from')
    args = parser.parse_args()
    base_bytes = None
    if args.refresh_from or args.base_sha256:
        if not (args.refresh_from and args.base_sha256 and args.only and args.release_output) or args.scan:
            raise ValueError('A refresh requires --only, --refresh-from, --base-sha256 and --release-output')
        if args.refresh_from.resolve() == args.output.resolve():
            raise ValueError('A refresh must preserve its retained base file')
        from coverage_release import read_base
        base_bytes = read_base(args.refresh_from, args.base_sha256)
    if args.release_output and (args.scan or (args.only and base_bytes is None)):
        raise ValueError('Completed releases require a full build')
    if args.scan:
        request = json.load(sys.stdin)
        # A scan without descriptions (a direct probe) describes datasets on demand.
        descriptions = request.get('descriptions', {})
        native.seed(descriptions.get('legislative', {}))
        additional.seed(descriptions.get('additional', {}))
        print(json.dumps(scan_table(request['id'], request['table'], request['policy'])))
        return
    if args.only and args.output.resolve() == OUTPUT.resolve():
        raise ValueError('Partial scans require a separate output file')
    setup = duckdb.connect(); setup.execute('INSTALL httpfs'); setup.close()
    captured = None
    if args.release_output:
        from coverage_release import capture_load
        tables, captured = capture_load()
    else:
        _, tables = load()
    reviewed_policies = definitions()
    selected_tables = {id: table for id, table in tables.items() if not args.only or id in args.only}
    if args.only and set(args.only) != set(selected_tables):
        raise ValueError('Requested table is not currently published')
    policies = {id: policy for id, policy in reviewed_policies.items() if id in selected_tables}
    # One reader call per native dataset, in parallel; validate_plan and every scan reuse it.
    native.describe_all(native.DATASETS & selected_tables.keys())
    additional.describe_all((additional.FAMILIES.keys() | additional.RULEMAKING_DATASETS) & selected_tables.keys())
    validate_plan(selected_tables, policies, tables)
    previous = json.loads(args.output.read_text()).get('tables', {}) if args.output.exists() else {}
    CACHE.mkdir(parents=True, exist_ok=True)
    for id in selected_tables:
        checkpoint = CACHE / (id + '.json')
        if checkpoint.exists():
            try: previous[id] = json.loads(checkpoint.read_text())
            except (OSError, ValueError): pass
    # A build has one UTC reference month; it is measurement context, not a
    # substitute publication date or part of the source census.
    as_of_month = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')
    selected = {id: {**table, '_coverageAsOfMonth': as_of_month}
                for id, table in selected_tables.items()}
    revisions = {id: measurement_revision(policies[id]) for id in selected}
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
    if definitions() != reviewed_policies:
        raise ValueError('Coverage definitions changed during the build; rerun the reviewed policies')
    validate_native_implementations({id: policies[id] for id in selected})
    additional.validate_native_implementations({id: policies[id] for id in selected})
    if any(measurement_revision(policies[id]) != revisions[id] or result.get('measurementRevision') != revisions[id] for id, result in results.items()):
        raise ValueError('Coverage implementation changed during the build; rerun the reviewed code')
    if set(results) != set(selected): raise ValueError('Coverage build omitted a published table')
    # Confirm membership/bindings still match after all scans, including mutable receipts.
    if args.release_output:
        final_tables, final_capture = capture_load()
        if final_capture != captured:
            raise ValueError('Selected publication bytes changed during coverage build')
    else:
        _, final_tables = load()
    if census_digest(final_tables) != census_digest(tables): raise ValueError('Publication changed during coverage build; retry against the new release')
    retained = {}
    if base_bytes is not None:
        if read_base(args.refresh_from, args.base_sha256) != base_bytes:
            raise ValueError('Retained coverage changed during refresh')
        retained = json.loads(base_bytes)['tables']
    document = {'format': 'spicygov-coverage-maps', 'version': 1, 'partial': bool(args.only) and base_bytes is None,
                'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'censusDigest': census_digest(tables), 'tables': dict(sorted((retained | results).items()))}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    completed_bytes = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    temp = args.output.with_suffix('.tmp'); temp.write_bytes(completed_bytes)
    if not args.only:
        subprocess.run(['node', str(ROOT / 'scripts/check-coverage-maps.mjs'), str(temp)], check=True, cwd=ROOT)
    temp.replace(args.output)
    if args.release_output:
        from coverage_release import complete
        print(json.dumps(complete(ROOT, args.release_output, completed_bytes,
                                  captured, policies, revisions, base_bytes=base_bytes)), flush=True)
    print(f'All {len(results)} requested coverage maps verified', flush=True)


if __name__ == '__main__': main()
