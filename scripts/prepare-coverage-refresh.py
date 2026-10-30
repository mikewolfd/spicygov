"""Prepare changed coverage with the existing scanners, without selecting a catalog.

The run retains one publication snapshot, per-table checkpoints and explicit
failures. Only successfully checked tables enter the ordinary refresh release;
other measurements remain byte-for-byte associated with their earlier release.
"""
import argparse
import copy
import datetime
import fcntl
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time

from coverage_release import capture_load, complete, implementation_files, read_base, sha
from coverage_inputs import CoverageInputs
from publication_census import census_digest, load, path as publication_path

ROOT = Path(__file__).resolve().parents[1]
HELD_UNCHANGED = ('comments', 'comments_index', 'court_opinions', 'court_citation_map',
                  'court_citations', 'court_parentheticals', 'court_opinion_clusters',
                  'court_docket_groups', 'court_opinion_pdf_extractions',
                  'fec_receipts', 'fec_source_records', 'fec_intercommittee_transactions',
                  'uscode_edition_sections', 'comment_attributes', 'document_attributes', 'documents')
spec = importlib.util.spec_from_file_location('coverage_builder', ROOT / 'scripts/build-coverage-maps.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class HeldMeasurement(Exception):
    """Retain an earlier result when this unchanged table needs new admission."""


def validate_summary_fields(measured):
    """Apply the consumer's optional exact-day/month consistency guard."""
    for dimension in measured.get('dimensions', []):
        if 'latestDate' not in dimension:
            continue
        latest = dimension['latestDate']
        try:
            canonical = isinstance(latest, str) and datetime.date.fromisoformat(latest).isoformat() == latest
        except ValueError:
            canonical = False
        buckets = dimension.get('buckets', {})
        if (not canonical or dimension.get('granularity') != 'month' or not buckets
                or latest[:7] != max(buckets)):
            raise ValueError('Latest-date summary differs from its retained month buckets: ' + dimension['id'])


def eligible_month_summary(measured, table, policy):
    """Leave the exact day unknown after the reviewed future-activity filter.

    flag_future owns the retained month counts and explicit excluded literals.
    It does not recompute the optional maximum day after removing future months.
    This only removes that optional day; it never edits the measured facts.
    Callers must first admit the normal bindings, revision, policy and counts.
    """
    result, omissions = measured, []
    for index, (definition, dimension) in enumerate(zip(policy['dimensions'], measured.get('dimensions', []))):
        latest = dimension.get('latestDate')
        buckets = dimension.get('buckets', {})
        if not isinstance(latest, str) or not buckets or latest[:7] == max(buckets):
            continue
        try:
            canonical = datetime.date.fromisoformat(latest).isoformat() == latest
        except ValueError:
            canonical = False
        if not canonical or policy.get('_scanner') != 'regulation' or definition.get('special') != 'literal-date-anomalies':
            continue
        from regulation_coverage import activity_boundary
        boundary = activity_boundary(table)
        anomalies = dimension.get('anomalies', {})
        future = anomalies.get('futureActivityBuckets', {}) if isinstance(anomalies, dict) else {}
        def valid_month(value):
            try:
                return isinstance(value, str) and datetime.date.fromisoformat(value + '-01').strftime('%Y-%m') == value
            except ValueError:
                return False
        if (definition.get('kind') != 'date' or dimension.get('kind') != 'date'
                or dimension.get('granularity') != 'month' or dimension.get('overlapping') is not False
                or dimension.get('activityBoundary') != boundary
                or anomalies.get('boundaryMonth') != boundary['month']
                or not isinstance(future, dict) or not future
                or any(not valid_month(month) or month <= boundary['month'] or type(count) is not int or count <= 0
                       for month, count in future.items())
                or type(anomalies.get('futureActivityRows')) is not int
                or anomalies['futureActivityRows'] != sum(future.values())
                or anomalies['futureActivityRows'] > dimension['unplacedRows']
                or any(month > boundary['month'] for month in buckets)
                or latest[:7] != max(future)):
            continue
        if result is measured:
            result = copy.deepcopy(measured)
        del result['dimensions'][index]['latestDate']
        omissions.append({'dimension': dimension['id'], 'omittedLatestDate': latest,
                          'latestEligibleMonth': max(buckets), 'activityBoundary': boundary,
                          'reasonCode': 'exact-day-outside-filtered-activity-months'})
    validate_summary_fields(result)
    return result, omissions


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, sort_keys=True, indent=2) + '\n')
    temporary.replace(path)


def selected_base(selection_path):
    selection = json.loads(selection_path.read_bytes())
    if selection.get('format') != 'spicygov-coverage-release-selection' or selection.get('version') != 1:
        raise ValueError('Unsupported base coverage selection')
    directory = Path(selection['directory'])
    manifest_raw = (directory / 'manifest.json').read_bytes()
    if sha(manifest_raw) != selection['manifestSha256']:
        raise ValueError('Base coverage manifest changed')
    manifest = json.loads(manifest_raw)
    member = manifest['members']['coverage-maps.v1.json']
    base = read_base(directory / 'coverage-maps.v1.json', member['sha256'])
    if len(base) != member['bytes']:
        raise ValueError('Base coverage size changed')
    return base


def publication_matches(table, previous):
    """Compare publication identity without borrowing current scanner semantics."""
    actual = builder.binding(table, {'dimensions': []})
    keys = ('family', 'fingerprint', 'rows', 'artifactDigest', 'publishedAt',
            'publicationSha256', 'inputsFingerprint')
    return bool(previous) and all(previous.get(key) == actual.get(key) for key in keys)


def publication_snapshot(run):
    pin = run / 'publication-snapshot.json'
    if pin.exists():
        members = json.loads(pin.read_bytes())
        captured = {}
        for key, member in members.items():
            publication_path(key)
            raw = (run / 'publications' / key).read_bytes()
            if len(raw) != member['bytes'] or sha(raw) != member['sha256']:
                raise ValueError('Captured publication changed: ' + key)
            captured[key] = raw
        _, tables = load(lambda key: json.loads(captured[key]))
        return tables, captured
    tables, captured = capture_load()
    for key, raw in captured.items():
        target = run / 'publications' / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
    save(pin, {key: {'bytes': len(raw), 'sha256': sha(raw)} for key, raw in captured.items()})
    return tables, captured


def restoration_inputs(id, table, policy, policies, tables):
    """Bound known subject/receipt/parent bodies before invoking a native reader."""
    inputs, required = CoverageInputs(), {}

    def retain(owner, receipts=False):
        for member in owner['members']:
            required[(owner['recordUrl'], member['key'])] = member
        if receipts:
            receipt_spec = owner['artifact']['spec'].get('etlReceipts', {})
            _, _, members = inputs.artifact(owner['family'], owner['artifactDigest'])
            receipt = [m for m in members if m.get('role') == 'table' and m['objectKey'] == receipt_spec.get('key')]
            if len(receipt) != 1:
                raise ValueError('Exact selected processing receipt is unavailable')
            member = receipt[0]
            required[(owner['recordUrl'], member['objectKey'])] = {
                'key': member['objectKey'], 'byteSize': member['byteSize'], 'sha256': member['sha256']}

    native = policy.get('_nativeProcessing') or policy.get('_additionalNativeProcessing')
    receipt_special = any(d.get('special', '').startswith('government-receipt-') for d in policy['dimensions'])
    if native or receipt_special:
        if table.get('kind') == 'rulemaking' and table.get('rulemakingSnapshot'):
            selected = table['rulemakingSnapshot']
            for member in [*selected['subjects'], selected['receipts']]:
                required[(table['recordUrl'], member['key'])] = member
        elif table.get('kind') == 'generation':
            retain(inputs.producing(id, table), receipts=True)
        else:
            raise ValueError('Native snapshot restoration needs a separately reviewed input budget')
    for dimension in policy['dimensions']:
        if dimension['kind'] != 'inherited':
            continue
        relation = dimension['parent']
        # Match the child adapter's route. A current census schema says nothing
        # about an exact recorded historical parent. The maintained reader owns
        # schema admission when it actually restores that pinned input.
        restore_parent = bool(policy.get('_nativeProcessing') or (
            policy.get('_additionalNativeProcessing') and relation['mode'] == 'same-generation'))
        if policy.get('_nativeProcessing') and relation['mode'] == 'same-generation':
            owner = inputs.producing(id, table)
            descriptors = owner['artifact']['spec'].get('etlReceipts', {}).get('policies', [])
            if any(p.get('dataset') == relation['table'] and p.get('receipt_only') for p in descriptors):
                # ProcessingInputs.parent restores receipt-only parents from the
                # already-budgeted owner receipt; no public parent file exists.
                continue
        parent = inputs.parent(id, table, dimension['parent'])
        parent_id = parent['tableId']
        descriptor = parent['artifact']['spec'].get('etlReceipts', {}).get('policies', [])
        has_receipts = any(p.get('dataset') == parent_id for p in descriptor)
        if policy.get('_nativeProcessing') and parent_id not in builder.native.DATASETS:
            restore_parent = False
        retain(parent, receipts=restore_parent and has_receipts)
    return list(required.values())


def recover_release(run, inputs, captured):
    """Reconcile an acknowledged or interrupted completion without new scans."""
    directory = run / 'release'
    raw = (directory / 'manifest.json').read_bytes()
    manifest = json.loads(raw)
    if (manifest.get('censusDigest') != inputs['censusDigest']
            or manifest.get('members', {}).get('base-coverage-maps.v1.json', {}).get('sha256') != inputs['baseSha256']
            or any(manifest.get('members', {}).get('publications/' + key) != {'bytes': len(body), 'sha256': sha(body)}
                   for key, body in captured.items())):
        raise ValueError('Completed coverage release differs from this run\'s fixed inputs')
    completion = {'directory': str(directory), 'manifestSha256': sha(raw)}
    subprocess.run(['node', str(ROOT / 'scripts/consume-coverage-release.mjs'),
                    '--release', str(directory), '--sha256', completion['manifestSha256']],
                   cwd=ROOT, check=True)
    selection = {'format': 'spicygov-coverage-release-selection', 'version': 1, **completion}
    path = run / 'selection.json'
    if path.exists() and json.loads(path.read_bytes()) != selection:
        raise ValueError('Completed coverage selection differs from its immutable release')
    save(path, selection)
    return selection


def prepare(args):
    run = args.run.resolve()
    run.mkdir(parents=True, exist_ok=True)
    base_bytes = selected_base(args.base_selection.resolve())
    base = json.loads(base_bytes)['tables']
    tables, captured = publication_snapshot(run)
    held_unchanged = set(getattr(args, 'hold_unchanged', ()))
    inputs = {'baseSha256': sha(base_bytes), 'censusDigest': census_digest(tables),
              'maxRestorationBytes': args.max_restoration_bytes, 'reserveGiB': args.reserve_gib,
              'onlyTables': sorted(getattr(args, 'only', None) or []),
              'heldUnchangedTables': sorted(held_unchanged),
              'implementation': {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in implementation_files(ROOT)}}
    pin = run / 'inputs.json'
    if pin.exists() and json.loads(pin.read_bytes()) != inputs:
        raise ValueError('Coverage run inputs changed; retain checkpoints and use a new run directory')
    save(pin, inputs)
    report_path = run / 'report.json'
    if (run / 'release').exists():
        selection = recover_release(run, inputs, captured)
        report = json.loads(report_path.read_bytes())
        states = json.loads((run / 'release/coverage-maps.v1.json').read_bytes()).get('measurementStates', {})
        report.update(selection=selection,
                      currentTables=len(tables) - len(states), unresolvedTables=len(states),
                      heldTables=sum(state == 'held' for state in states.values()),
                      freeBytesAfter=shutil.disk_usage(run).free)
        save(report_path, report)
        return report
    if (run / 'selection.json').exists():
        raise ValueError('Completed selection has no immutable release')
    policies = builder.definitions()
    results, effective, outcomes = {}, {}, {}
    only = getattr(args, 'only', None)
    if only and set(only) - set(tables):
        raise ValueError('Requested table is not in the fixed publication snapshot')
    selected_tables = {id: table for id, table in tables.items() if not only or id in only}
    month = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m')
    def order(item):
        id, table = item
        policy = policies.get(id, {})
        public = table.get('columns') in (policy.get('schema'), policy.get('publishedSchema'))
        changed = not publication_matches(table, base.get(id))
        priority = 0 if changed and table.get('family') in ('bill-family', 'federal-register') else 1 if changed else 2
        return priority, 0 if public else 1, sum(member['byteSize'] for member in table['members']), id
    for id, original in sorted(selected_tables.items(), key=order):
        started = time.monotonic()
        try:
            if shutil.disk_usage(run).free < args.reserve_gib * 2**30:
                raise ValueError('Free space reached the configured reserve')
            hold_candidate = id in held_unchanged and publication_matches(original, base.get(id))
            table = {**original, '_coverageAsOfMonth': month}
            checkpoint = run / 'checkpoints' / (id + '.json')
            old = json.loads(checkpoint.read_bytes()) if checkpoint.exists() else base.get(id)
            try:
                if id not in policies:
                    raise ValueError('No reviewed coverage definition for this published table')
                selected = {id: dict(policies[id])}
                builder.validate_plan({id: table}, selected, tables)
                policy = selected[id]
                reused = builder.cached(table, policy, old)
                if reused:
                    accepted, omissions = eligible_month_summary(old, table, policy)
            except Exception as error:
                if hold_candidate:
                    raise HeldMeasurement('Publication unchanged; no admissible current cached measurement: ' + str(error)) from error
                raise
            if hold_candidate and not reused:
                raise HeldMeasurement('Publication unchanged; remeasurement intentionally held. Earlier qualified measurement retained.')
            required = [] if reused else restoration_inputs(id, table, policy, policies, tables)
            required_bytes = sum(m['byteSize'] for m in required)
            if args.max_restoration_bytes is not None and required_bytes > args.max_restoration_bytes:
                raise ValueError(f'Exact subject/receipt/parent inputs total {required_bytes} bytes; '
                                 f'exceeds this run\'s {args.max_restoration_bytes}-byte restoration budget')
            native = policy.get('_nativeProcessing') or policy.get('_additionalNativeProcessing')
            if native and any(member['byteSize'] > 16 * 2**30 for member in required):
                raise ValueError('An exact native subject/receipt exceeds the existing reader\'s 16 GiB member staging limit')
            # Existing maintained bulk readers cap their spill at 32 GiB. Input
            # staging and restored outputs need additional room; this is a
            # conservative admission check, not a measured scratch prediction.
            working_allowance = required_bytes * 2 + (32 * 2**30 if native else 0)
            if required_bytes and shutil.disk_usage(run).free < args.reserve_gib * 2**30 + working_allowance:
                raise ValueError('Insufficient space above reserve for selected restoration and working files')
            print(f'{id}: ' + ('reuse' if reused else f'measure; planned restoration inputs {required_bytes} bytes'), flush=True)
            original_measurement = old if reused else builder.timed_scan((id, table, policy, old))[1]
            measured, omissions = (accepted, omissions) if reused else eligible_month_summary(original_measurement, table, policy)
            if omissions:
                rejected = run / 'rejected-summaries' / (id + '.json')
                if rejected.exists() and json.loads(rejected.read_bytes()) != original_measurement:
                    raise ValueError('Retained original summary changed')
                save(rejected, original_measurement)
            save(checkpoint, measured)
            results[id], effective[id] = measured, policy
            bindings = builder.binding({**table, 'columns': policy['schema']}, policy)
            changed_fields = [key for key, value in bindings.items() if (old or {}).get(key) != value]
            if (old or {}).get('measurementRevision') != builder.measurement_revision(policy):
                changed_fields.append('measurementRevision')
            outcomes[id] = {'status': 'current', 'action': 'reused' if reused else 'measured',
                            'changedBindings': changed_fields, 'restorationInputBytes': required_bytes,
                            **({'summaryOmissions': omissions} if omissions else {}),
                            'elapsedSeconds': time.monotonic() - started}
        except HeldMeasurement as error:
            outcomes[id] = {'status': 'held', 'reason': str(error), 'earlierMeasurementRetained': id in base,
                            'elapsedSeconds': time.monotonic() - started}
            print(f'{id}: held; {error}', flush=True)
        except Exception as error:
            outcomes[id] = {'status': 'unresolved', 'reason': str(error),
                            'earlierMeasurementRetained': id in base, 'elapsedSeconds': time.monotonic() - started}
            print(f'{id}: unresolved: {error}', flush=True)
        save(report_path, {'censusDigest': inputs['censusDigest'], 'tables': outcomes,
                           'scope': 'Fixed published snapshot; unchanged raw originals are not read.'})
    if not results:
        raise ValueError('No current coverage measurements were admitted; reasons retained in report.json')
    # Recheck frozen metadata and all selected implementations before release assembly.
    _, final_capture = publication_snapshot(run)
    if captured != final_capture or inputs['implementation'] != {
            str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in implementation_files(ROOT)}:
        raise ValueError('Coverage preparation inputs changed during measurement')
    builder.validate_native_implementations(effective)
    builder.additional.validate_native_implementations(effective)
    revisions = {id: builder.measurement_revision(policy) for id, policy in effective.items()}
    if any(results[id]['measurementRevision'] != revisions[id] for id in results):
        raise ValueError('Coverage measurement revision changed')
    states = {id: state for id, state in json.loads(base_bytes).get('measurementStates', {}).items()
              if id not in selected_tables}
    states.update({id: 'held' if value['status'] == 'held' else 'unavailable'
                   for id, value in outcomes.items() if value['status'] != 'current'})
    document = {'format': 'spicygov-coverage-maps', 'version': 1, 'partial': False,
                'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'censusDigest': inputs['censusDigest'], 'tables': dict(sorted((base | results).items())),
                # Public codes carry no internal exceptions, paths or tracebacks.
                'measurementStates': states}
    map_bytes = (json.dumps(document, separators=(',', ':')) + '\n').encode()
    completion = complete(ROOT, run / 'release', map_bytes, captured, effective, revisions, base_bytes=base_bytes)
    selection = {'format': 'spicygov-coverage-release-selection', 'version': 1, **completion}
    save(run / 'selection.json', selection)
    report = {'censusDigest': inputs['censusDigest'], 'tables': outcomes, 'selection': selection,
              'currentTables': len(tables) - len(states), 'unresolvedTables': len(states),
              'selectedTables': len(selected_tables), 'selectedCurrentTables': len(results),
              'heldTables': sum(state == 'held' for state in states.values()),
              'freeBytesAfter': shutil.disk_usage(run).free,
              'scope': 'Fixed published snapshot. Unresolved tables retain earlier measurements and their original release labels.'}
    save(report_path, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-selection', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--only', nargs='+', help='Refresh only these tables; preserve other records and states from the base')
    parser.add_argument('--reserve-gib', type=int, default=25)
    parser.add_argument('--hold-unchanged', nargs='*', default=list(HELD_UNCHANGED),
                        help='Retain these unchanged-publication measurements as earlier checks; changed publications still run')
    parser.add_argument('--max-restoration-bytes', type=int,
                        help='Optional per-table input budget; existing native staging and free-space guards always apply')
    args = parser.parse_args()
    if args.reserve_gib < 25 or (args.max_restoration_bytes is not None and args.max_restoration_bytes < 0):
        parser.error('Keep at least 25 GiB free and a nonnegative restoration budget')
    args.run.mkdir(parents=True, exist_ok=True)
    with (args.run / 'prepare.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        report = prepare(args)
    print(json.dumps({key: value for key, value in report.items() if key != 'tables'}), flush=True)


if __name__ == '__main__':
    main()
