"""Refresh the local archive catalog and website together.

Run with the SpicyRegs source-readers Python environment. Existing catalog CLI
commands own validation and selection; this command sequences them and stops at
the first failure. Keep local catalog readers/writers paused during selection.
"""
import argparse
from contextlib import closing
import hashlib
import importlib
import importlib.metadata
import inspect
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import fcntl
from datetime import datetime, timezone
from time import monotonic


def save(path, value):
    temporary = path.with_name(path.name+'.tmp')
    with temporary.open('w') as stream:
        json.dump(value,stream,sort_keys=True)
        stream.write('\n');stream.flush();os.fsync(stream.fileno())
    os.replace(temporary,path)


def fingerprint(path):
    """Content pins for exports; native generation plus custody for owned SQLite."""
    if path.is_symlink():raise ValueError('Refresh output symlink refused')
    path = path.resolve()
    if path.is_dir():
        members = {}
        for child in sorted(path.rglob('*')):
            if child.is_symlink():raise ValueError('Refresh output symlink refused')
            if child.is_file():members[str(child.relative_to(path))] = fingerprint(child)
        return {'kind':'directory','members':members}
    stat = path.stat()
    if path.is_symlink() or not path.is_file():
        raise ValueError('Refresh output must be a regular file')
    if path.suffix == '.sqlite':
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True)) as db:
            generation = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
        return {'kind':'native-index', 'generation':generation,
                'custody':[stat.st_dev,stat.st_ino,stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns]}
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream,'sha256').hexdigest()
    return {'kind':'file', 'sha256':digest, 'bytes':stat.st_size}


def input_snapshot(args, *, receipt_keys=None):
    """Freeze control inputs and the receipt list, without opening raw bodies."""
    from spicy_regs.source_catalog import maintenance
    from spicy_regs.source_catalog.raw_classification import classification_inputs
    from spicy_regs.source_catalog.raw_content import reader_inputs
    raw = args.raw_root.resolve()
    receipts = {}
    paths = ((raw/name for name in receipt_keys) if receipt_keys is not None
             else (raw/'acquisitions/sha256').glob('*/*'))
    for path in sorted(paths):
        stat = path.stat()
        if path.is_symlink() or not path.is_file():raise ValueError('Invalid acquisition receipt')
        receipts[str(path.relative_to(raw))] = [stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns]
    code = set(Path(maintenance.__file__).parent.glob('*.py')) | set(classification_inputs())
    code.update(reader_inputs('family:federal-register'))
    code.add(Path(maintenance.__file__).parent/'config/registry.v1.json')
    code.add(args.publication_reconciliation.resolve())
    for name in ('coverage_selection','refresh_object_list','reuse_source_verification','receipt_snapshot','completion_admission',
                 'attempt_source_verification','attempt_source_index'):
        if getattr(args,name,None) is not None:code.add(getattr(args,name).resolve())
    website = Path(__file__).resolve().parents[1]
    code.update(website/'scripts'/name for name in ('refresh-local-catalog.py','verify-register-sources.py'))
    catalog_only = getattr(args,'catalog_only',False)
    if not catalog_only:
        code.update(website/'scripts'/name for name in
                    ('stage-source-catalog.mjs','catalog-inspection.mjs','register-source-periods.mjs'))
        code.update((website/'lib').rglob('*.ts'))
        code.add(website/'package-lock.json')
    return {'baseGeneration':read(args.cache/'current.json')['generation'], 'python':sys.version,
            'node':None if catalog_only else subprocess.check_output(['node','--version'],text=True).strip(),
            'catalogOnly':catalog_only,
            'rawSnapshot':fingerprint(raw/'snapshot.json'), 'receipts':receipts,
            'definitions':{str(p.resolve()):fingerprint(p) for p in sorted(code)},
            'fullRebuild':args.full_rebuild, 'candidate':str(args.candidate.resolve()) if args.candidate else None}


def record_phase(run, name, started, *, status, counters=None):
    path = run/'phase-costs.json'
    records = read(path) if path.exists() else []
    records.append({'phase':name, 'finishedAt':datetime.now(timezone.utc).isoformat(),
                    'elapsedSeconds':monotonic()-started, 'status':status,
                    'work':counters or {},
                    'unmeasured':['physicalIOBytes','peakRSS','allocatedScratchBytes']})
    save(path, records)


def preflight(website, run, catalog_only=False):
    """Import every required runtime owner before cloning or reading receipt bodies."""
    started = monotonic()
    modules = ('spicy_regs.source_catalog.__main__', 'spicy_regs.source_catalog.maintenance',
               'spicy_regs.source_catalog.publication', 'spicy_regs.source_catalog.exporter',
               'spicy_regs.source_catalog.file_inventory', 'spicy_regs.source_catalog.selection',
               'spicy_regs.source_catalog.export_completion',
               'spicy_docs.storage.raw_archive', 'spicy_regs.sources.publication')
    try:
        origins = {}
        for name in modules:
            module = importlib.import_module(name)
            origins[name] = {'path':str(Path(module.__file__).resolve()),
                             'sha256':fingerprint(Path(module.__file__))['sha256']}
        maintenance = importlib.import_module('spicy_regs.source_catalog.maintenance')
        if (not callable(getattr(maintenance,'freeze_receipts',None))
                or 'receipt_snapshot' not in inspect.signature(maintenance.refresh_metadata).parameters):
            raise ValueError('Installed catalog producer lacks frozen-receipt refresh support')
        provider = importlib.import_module('spicy_docs.storage.raw_archive')
        if 'receipt_keys' not in inspect.signature(provider.iter_acquisition_receipts).parameters:
            raise ValueError('Installed receipt provider cannot select keys before payload reads')
        required = ('verify-register-sources.py',) if catalog_only else (
            'stage-source-catalog.mjs','catalog-inspection.mjs','register-source-periods.mjs',
            'verify-register-sources.py','build-ui.mjs')
        for name in required:
            if not (website/'scripts'/name).is_file():
                raise ValueError('Required catalog runtime path is unavailable: '+name)
        runtime = {'python':sys.version, 'executable':sys.executable,
                   'node':None if catalog_only else subprocess.check_output(['node','--version'],text=True).strip(),
                   'modules':origins, 'dependencies':{name:importlib.metadata.version(name)
                       for name in ('spicy-docs','pyarrow','duckdb')}}
        if not catalog_only and int(runtime['node'].removeprefix('v').split('.')[0]) < 22:
            raise ValueError('Catalog staging requires Node.js 22 or newer')
        save(run/'runtime.json',runtime)
    except BaseException:
        record_phase(run,'preflight',started,status='failed')
        raise
    record_phase(run,'preflight',started,status='passed')
    return runtime


class CompletedSteps:
    """Reuse this run's completed phases; native selection remains authoritative."""
    def __init__(self, run, snapshot):
        self.run = run
        pin = run/'input-snapshot.json'
        if pin.exists():
            if read(pin) != snapshot:raise ValueError('Refresh inputs changed; keep this run and start a new run for the new receipt set')
        else:save(pin,snapshot)
        self.snapshot = hashlib.sha256(pin.read_bytes()).hexdigest()

    def check_inputs(self, snapshot, *, boundary):
        """Refuse changes since capture, including receipts consumed by a native reader."""
        pin = self.run/'input-snapshot.json'
        if fingerprint(pin)['sha256'] != self.snapshot or read(pin) != snapshot:
            raise ValueError('Refresh inputs changed before '+boundary+
                             '; keep completed outputs and start a new run for the new input set')

    def step(self, name, command, *, cwd, artifacts=()):
        started = monotonic()
        report, completion = self.run/(name+'.json'), self.run/(name+'.done.json')
        def output_pins(value):
            paths = artifacts(value) if callable(artifacts) else artifacts
            return {str(p):fingerprint(p) for p in paths}
        if completion.exists():
            saved = read(completion)
            value = read(report)
            expected = {'snapshot':self.snapshot,'command':command,
                        'report':fingerprint(report),'artifacts':output_pins(value)}
            if saved != expected:raise ValueError('Completed refresh phase changed: '+name)
            print(name+' (reused)',flush=True)
            record_phase(self.run,name,started,status='reused')
            return read(report)
        print(name,flush=True)
        try:
            with report.open('w') as output, (self.run/(name+'.stderr.log')).open('a') as diagnostic:
                subprocess.run(command,cwd=cwd,stdout=output,stderr=diagnostic,check=True)
            value = read(report)
        except BaseException:
            record_phase(self.run,name,started,status='failed')
            raise
        saved = {'snapshot':self.snapshot,'command':command,'report':fingerprint(report),
                 'artifacts':output_pins(value)}
        save(completion,saved)
        record_phase(self.run,name,started,status='completed',
                     counters=value.get('work') or value.get('inputRefresh') or {})
        return value


def read(path):
    return json.loads(path.read_text())


def native_validation(candidate, report, built):
    """Reuse checks completed by this run's native builder, with exact output agreement."""
    with closing(sqlite3.connect(candidate.resolve().as_uri()+'?mode=ro', uri=True)) as db:
        values = {key:json.loads(value) for key,value in db.execute(
            "SELECT key,value FROM metadata WHERE key IN ('generation','reconciliation')")}
    if (report != built or report.get('status') != 'validated'
            or values.get('generation') != report.get('generation')
            or values.get('reconciliation') != report):
        raise ValueError('Candidate differs from its native builder validation')


def completed_report(run, name):
    """Check retained report ownership without reopening a moved candidate."""
    completion = read(run/(name+'.done.json'))
    report = run/(name+'.json')
    if (completion['report'] != fingerprint(report)
            or completion['snapshot'] != fingerprint(run/'input-snapshot.json')['sha256']):
        raise ValueError('Completed refresh phase changed: '+name)
    return read(report)


def finish_selected(args, website, run):
    """Finish a committed native selection; never repeat its acquisition/audit/export."""
    catalog_only = getattr(args,'catalog_only',False)
    snapshot = run/'input-snapshot.json'
    if snapshot.exists() and read(snapshot).get('catalogOnly',False) != catalog_only:
        raise ValueError('Finish mode differs from the fixed-input run')
    exported = read(run / 'export.json')
    generation = exported['generation']
    # The candidate has moved, but this run's report and fixed-input pins have
    # not. Verify the existing phase completion without reopening that artifact.
    verified = completed_report(run,'verify-sources')
    cache, public = args.cache.resolve(), args.public.resolve()
    current, selection = read(cache / 'current.json'), read(cache / 'selection.json')
    with closing(sqlite3.connect((cache / 'index.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
        indexed = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
    if any(value != generation for value in (current['generation'], selection['generation'],
            indexed, read(public / 'manifest.json')['generation'], verified['generation'])):
        raise ValueError('Native selection is inconsistent; use its recovery.json before finishing the website')
    def pins(value):
        return sorted((item['path'], item['bytes'], item['sha256']) for item in value['files'])
    if pins(selection) != pins(exported if catalog_only else read(run / 'inspect.json')):
        raise ValueError('Selected catalog differs from this run; keep its recovery files')
    manifest_sha = hashlib.sha256((public / 'manifest.json').read_bytes()).hexdigest()
    if manifest_sha != current['public_manifest_sha256']:
        raise ValueError('Selected public manifest differs from its native pin')
    selected = None
    acknowledgement = run / 'select.json'
    if acknowledgement.exists() and acknowledgement.stat().st_size:
        selected = read(acknowledgement)
        if selected.get('generation') != generation or selected.get('status') != 'selected':
            raise ValueError('Selection acknowledgement differs from native controls')
    else:
        # current.json is committed last by the existing selection owner. All
        # its controls and this run's exact member pins agree above.
        selected = {'status': 'selected', 'generation': generation,
                    'backup': None, 'acknowledgedBy': 'native-controls',
                    'note': 'Native backups retained because the acknowledgement was lost.'}
        (run / 'recovered-select.json').write_text(json.dumps(selected, indent=2) + '\n')
    if catalog_only:
        # The native selection already validated the exact admitted export.
        # Check its currently selected bytes before handing off the source proof.
        from spicy_regs.source_catalog.selection import public_members
        members, _ = public_members(public,generation,decode=False)
        if members != selection['files']:
            raise ValueError('Selected public members changed before completion')
        if verified.get('indexAgreement',{}).get('status') != 'matched':
            raise ValueError('Source proof does not establish native index agreement')
        complete_selection(args,run,selected,verified,{
            'generation':generation,
            'scope':'Local catalog completed; Federal Register source proof retained; website not built.'})
        print('Local catalog refreshed.',flush=True)
        return
    site = website / 'public/source-catalog'
    site_stage = website / 'public' / ('.catalog-' + generation[7:])
    backup = run / 'previous-site-catalog'
    if not site.exists() or read(site / 'manifest.json')['generation'] != generation:
        if not site_stage.exists() or hashlib.sha256((site_stage / 'manifest.json').read_bytes()).hexdigest() != manifest_sha:
            raise ValueError('Prepared website catalog is unavailable; keep the native selection and recovery files')
        if site.exists():
            if backup.exists():
                raise ValueError('Website backup already exists; reconcile it before replacement')
            os.rename(site, backup)
        os.rename(site_stage, site)
    command = ['npm', 'run', 'build:ui', '--']
    command += ['--selection', str(args.coverage_selection.resolve())] if args.coverage_selection else ['--coverage', 'unavailable']
    subprocess.run(command, cwd=website, check=True)
    summary = read(website / 'public/register-source-periods.v1.json')
    if summary.get('generation') != generation or summary['months'] != verified['months'] or summary.get('latestIndexedDate') != verified['latestIndexedDate']:
        raise ValueError('Website source dates differ from the verified local files')
    if summary.get('dateCoverage', {}).get('files', verified['verifiedObjects']) != verified['verifiedObjects']:
        raise ValueError('Website source-file count differs from the byte audit')
    if any(read(path)['generation'] != generation for path in
           (cache / 'current.json', public / 'manifest.json', site / 'manifest.json', website / 'dist/source-catalog/manifest.json')):
        raise ValueError('Catalog selection changed during website preparation')
    if read(website / 'dist/register-source-periods.v1.json') != summary:
        raise ValueError('Built and development source summaries differ')
    complete_selection(args,run,selected,verified,{'generation':generation,'sourcePeriods':summary,
        'scope':'Local catalog and website; Federal Register byte audit only; published measurements remain release-specific; no downloads or deployment'})
    shutil.rmtree(backup, ignore_errors=True)
    print('Local catalog and quarter coverage refreshed.', flush=True)


def complete_selection(args, run, selected, verified, result):
    """Hand off source proof before retiring this run's owned recovery backup."""
    cache = args.cache.resolve()
    generation = result['generation']
    from spicy_regs.source_catalog.selection import selection_lock

    with selection_lock(cache):
        if read(cache/'current.json')['generation'] != generation:
            raise ValueError('Catalog selection changed before completion')
        save(cache/'source-verification.json',verified)
        if selected.get('backup'):
            selection_backup = Path(selected['backup']).resolve()
            if selection_backup.parent == cache and selection_backup.name.startswith('selection-backup-'):
                if selection_backup.exists() and read(selection_backup/'recovery.json').get('generation') != generation:
                    raise ValueError('Recovery backup belongs to a different generation; retained')
                shutil.rmtree(selection_backup,ignore_errors=True)
        save(run/'complete.json',result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('raw-root', 'cache', 'public', 'run'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--publication-reconciliation', type=Path)
    parser.add_argument('--candidate', type=Path, help='Use an already validated rebuild')
    parser.add_argument('--full-rebuild', action='store_true', help='Explicitly replay the full archive instead of updating the selected index')
    parser.add_argument('--coverage-selection', type=Path, help='Preserve a completed published-table coverage release')
    parser.add_argument('--prepare-coverage', action='store_true',
                        help='Prepare changed published-table measurements before catalog refresh; permits public/R2 reads')
    parser.add_argument('--finish-selected', action='store_true', help='Finish an already committed native selection')
    parser.add_argument('--catalog-only', action='store_true', help='Finish the local catalog and source proof without website staging or build')
    parser.add_argument('--refresh-object-list', type=Path, help='Replay only these canonical SHA-256 originals')
    parser.add_argument('--reuse-source-verification', type=Path, help='Reuse an earlier matching byte audit outside the affected object list')
    parser.add_argument('--audit-register-sources', action='store_true',
                        help='Explicitly renew the full Federal Register byte audit instead of reusing a selected proof')
    parser.add_argument('--resume', action='store_true', help='Reuse completed phases of the same fixed-input run')
    parser.add_argument('--max-catch-up-attempts', type=int, default=2,
                        help='Maximum additional frozen receipt batches; pending work is retained at the bound')
    parser.add_argument('--catch-up-budget-seconds', type=float, default=300,
                        help='Maximum elapsed time before starting another catch-up batch')
    parser.add_argument('--completion-request',type=Path,
                        help='Consume one opt-in coalesced notification after durable source/publication completion')
    args = parser.parse_args()
    if args.catalog_only and (args.prepare_coverage or args.coverage_selection):
        parser.error('--catalog-only cannot prepare website coverage')
    if args.max_catch_up_attempts < 0 or args.catch_up_budget_seconds < 0:
        parser.error('Catch-up limits must be nonnegative')
    if args.refresh_object_list and (args.full_rebuild or args.candidate):
        parser.error('--refresh-object-list requires an incremental native refresh')
    website = Path(__file__).resolve().parents[1]
    run, raw = args.run.resolve(), args.raw_root.resolve()
    if any(path.resolve().is_relative_to(raw) for path in (run, args.cache, args.public, website)):
        raise ValueError('Catalog work must stay outside the raw archive')
    if args.resume or args.finish_selected:
        if not run.is_dir():raise ValueError('Refresh run does not exist')
    else:run.mkdir()
    with (run/'run.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('Another process owns this refresh run')
        return run_refresh(args,website,run,raw,parser)


def run_refresh(args, website, run, raw, parser):
    if args.finish_selected:
        if args.candidate or args.full_rebuild:
            parser.error('--finish-selected cannot build or replace a candidate')
    else:
        if args.completion_request and not admit_completion(args,run,raw):
            save(run/'complete.json',{'status':'no-pending-request','scope':'No catalogue refresh was started.'})
            return
        preflight(website,run,getattr(args,'catalog_only',False))
    if getattr(args, 'prepare_coverage', False):
        base = args.coverage_selection or website / 'content/coverage-release-selection.v1.json'
        coverage_env = dict(os.environ)
        if coverage_env.get('SPICYGOV_COVERAGE_PYTHONPATH'):
            coverage_env['PYTHONPATH'] = coverage_env['SPICYGOV_COVERAGE_PYTHONPATH']
        subprocess.run([sys.executable, str(website / 'scripts/prepare-coverage-refresh.py'),
                        '--base-selection', str(base.resolve()), '--run', str(run / 'coverage')],
                       cwd=website, env=coverage_env, check=True)
        args.coverage_selection = run / 'coverage/selection.json'
    if args.finish_selected:
        finish_selected(args, website, run)
        acknowledge_completion(run,raw)
        return
    if not args.publication_reconciliation:
        parser.error('--publication-reconciliation is required for a new refresh')
    if args.reuse_source_verification is None and not args.audit_register_sources:
        proof = args.cache/'source-verification.json'
        if not proof.is_file():
            raise ValueError('A prior source proof is required for routine refresh; supply --reuse-source-verification or explicitly renew with --audit-register-sources')
        args.reuse_source_verification = proof
    state_path = run/'catch-up.json'
    current = read(args.cache/'current.json')
    state = read(state_path) if state_path.exists() else {
        'attempt':0, 'baseIndex':str((args.cache/'index.sqlite').resolve()),
        'baseGeneration':current['generation'], 'selectedGeneration':current['generation']}
    if state['attempt']:
        args.candidate = None
        args.full_rebuild = False
    catch_up_started = None
    while True:
        attempt = run if state['attempt'] == 0 else run/'catch-up'/str(state['attempt'])
        attempt.mkdir(parents=True,exist_ok=True)
        if attempt != run and getattr(args,'completion_admission',None):
            save(attempt/'completion-admission.json',read(args.completion_admission))
        if args.resume and (attempt/'export.done.json').exists():
            exported = completed_report(attempt,'export')
            if read(args.cache/'current.json')['generation'] == exported['generation']:
                finish_selected(args,website,attempt)
                acknowledge_completion(run,raw)
                return
        if state.get('sourceVerification'):
            reuse_attempt_verification(args,website,state['sourceVerification'])
        args.receipt_snapshot = freeze_receipts(args,website,attempt,
            Path(state['baseIndex']),state['baseGeneration'],
            current.get('index_sha256') if state['attempt'] == 0 else None)
        first_snapshot = run/'receipt-snapshot.json'
        result = refresh_attempt(args,website,attempt,raw,Path(state['baseIndex']),
                                 state['baseGeneration'],state['selectedGeneration'],first_snapshot)
        if result is None:
            state['status'] = 'complete'
            save(state_path,state)
            if attempt != run:
                save(run/'complete.json',{**read(attempt/'complete.json'),'completedRun':str(attempt)})
            (run/'pending-catch-up.json').unlink(missing_ok=True)
            acknowledge_completion(run,raw)
            return
        save(run/'pending-catch-up.json',{**result,'attempt':state['attempt'],
             'scope':'Completed frozen work retained; no new catalog selection claimed.'})
        state['status'] = 'pending-catch-up'
        save(state_path,state)
        if catch_up_started is None:
            catch_up_started = monotonic()
        if (state['attempt'] >= args.max_catch_up_attempts
                or monotonic()-catch_up_started >= args.catch_up_budget_seconds):
            print('Catalog refresh pending catch-up; completed work retained.',flush=True)
            return 3
        state.update(attempt=state['attempt']+1,
                     baseIndex=result['candidate'],baseGeneration=result['generation'])
        if result.get('sourceVerification'):
            state['sourceVerification'] = result['sourceVerification']
        save(state_path,state)
        # Every changed global generation gets its own v3 export. Earlier
        # completed attempts stay available for recovery and investigation.
        args.candidate = None
        args.full_rebuild = False


def reuse_attempt_verification(args, website, retained):
    """Reuse the accepted phase through its existing report/artifact checks."""
    prior = Path(retained['run'])
    index = Path(retained['index'])
    completion = read(prior/'verify-sources.done.json')
    command = completion['command']
    if Path(command[command.index('--index')+1]).resolve() != index.resolve():
        raise ValueError('Retained source verification names a different candidate')
    CompletedSteps(prior,read(prior/'input-snapshot.json')).step(
        'verify-sources',command,cwd=website,artifacts=(index,))
    args.attempt_source_verification = prior/'verify-sources.json'
    args.attempt_source_index = index


def admit_completion(args, run, raw):
    from spicy_regs.catalog_refresh_request import pending

    admission = run/'completion-admission.json'
    if not admission.exists():
        item = pending(args.completion_request,raw)
        if item is None:return False
        save(admission,{**item,'controlPath':str(args.completion_request.resolve())})
    elif read(admission)['controlPath'] != str(args.completion_request.resolve()):
        raise ValueError('Completion control differs from this retained run')
    requested_publication = read(admission)['request'].get('publicationSha256')
    if requested_publication:
        selected = read(args.publication_reconciliation).get('publication',{}).get('sha256')
        if selected is None or selected.removeprefix('sha256:') != requested_publication.removeprefix('sha256:'):
            raise ValueError('Pinned publication does not match the pending completion request')
    args.completion_admission = admission
    return True


def acknowledge_completion(run, raw):
    admission = run/'completion-admission.json'
    if not admission.exists():return
    from spicy_regs.catalog_refresh_request import acknowledge

    item = read(admission)
    try:
        result = acknowledge(Path(item['controlPath']),item['sha256'],raw)
    except Exception as error:
        result = {'status':'acknowledgment-failed','error':f'{type(error).__name__}: {error}'}
        print('Catalog selected; completion notification remains pending: '+str(error),file=sys.stderr)
    save(run/'completion-acknowledgment.json',result)


def freeze_receipts(args, website, run, index, generation, expected_sha):
    snapshot = run/'receipt-snapshot.json'
    if snapshot.exists():
        if snapshot.is_symlink() or read(snapshot).get('baseGeneration') != generation:
            raise ValueError('Frozen receipt snapshot differs from this attempt')
        return snapshot
    command = [sys.executable,'-m','spicy_regs.source_catalog','freeze-receipts',
               '--index',str(index),'--output',str(snapshot),'--expected-generation',generation]
    if expected_sha:
        command += ['--expected-index-sha256',expected_sha]
    started = monotonic()
    try:
        with (run/'freeze.json').open('w') as output:
            subprocess.run(command,cwd=website,stdout=output,check=True)
        frozen = read(snapshot)
    except BaseException:
        record_phase(run,'freeze-receipts',started,status='failed')
        raise
    record_phase(run,'freeze-receipts',started,status='completed',counters=frozen.get('work'))
    return snapshot


def pending_receipts(completed, args, candidate, generation, *, boundary):
    captured = read(completed.run/'input-snapshot.json')
    completed.check_inputs(captured,boundary=boundary)
    observed = input_snapshot(args)
    old_receipts, new_receipts = captured['receipts'],observed['receipts']
    if ({key:value for key,value in captured.items() if key != 'receipts'} !=
            {key:value for key,value in observed.items() if key != 'receipts'}
            or any(new_receipts.get(key) != value for key,value in old_receipts.items())):
        completed.check_inputs(observed,boundary=boundary)
    additions = sorted(new_receipts.keys()-old_receipts.keys())
    if additions:
        pending = {'status':'pending-catch-up','generation':generation,'candidate':str(candidate),
                   'addedReceiptKeys':additions,'lastCompletedRun':str(completed.run)}
        if (completed.run/'verify-sources.done.json').is_file():
            pending['sourceVerification'] = {'run':str(completed.run),'index':str(candidate)}
        return pending
    return None


def refresh_attempt(args, website, run, raw, base_index, base_generation, selected_generation, first_snapshot):
    if shutil.disk_usage(run.parent).free < (args.cache / 'index.sqlite').stat().st_size + 8 * 1024**3:
        raise ValueError('Insufficient working space for a separate catalog and export')
    frozen = read(args.receipt_snapshot)
    completed = CompletedSteps(run,input_snapshot(args,receipt_keys=frozen['receipts']))
    candidate = args.candidate.resolve() if args.candidate else run / 'index.sqlite'

    def step(name, command, artifacts=()):
        return completed.step(name,command,cwd=website,artifacts=artifacts)

    cli = [sys.executable, '-m', 'spicy_regs.source_catalog']
    if args.candidate is None:
        command = (['build', '--corpus', str(raw)] if args.full_rebuild else
                   ['refresh-metadata', '--index', str(base_index),
                    '--expected-generation', base_generation, '--include-acquisitions',
                    '--receipt-snapshot',str(args.receipt_snapshot),
                    '--receipt-snapshot-sha256','sha256:'+fingerprint(args.receipt_snapshot)['sha256'],
                    '--reuse-unchanged'])
        if args.refresh_object_list:
            command += ['--refresh-content','family:federal-register',
                        '--refresh-object-list', str(args.refresh_object_list.resolve())]
        built = step('build', cli + command + ['--output', str(candidate),
             '--publication-reconciliation', str(args.publication_reconciliation.resolve())],
             lambda value: () if value.get('status') == 'unchanged' else
                 (candidate,candidate.with_suffix(candidate.suffix+'.reconciliation.json')))
        if built.get('status') == 'unchanged':
            generation = built['generation']
            paths = [args.public/'manifest.json']
            if not getattr(args,'catalog_only',False):
                paths += [website/'public/source-catalog/manifest.json',website/'dist/source-catalog/manifest.json']
            if any(read(path)['generation'] != generation for path in paths):
                raise ValueError('Catalog unchanged but website selection differs; finish the selected run')
            pending = pending_receipts(completed,args,base_index,generation,boundary='unchanged completion')
            if pending:return pending
            if getattr(args, 'prepare_coverage', False):
                subprocess.run(['npm', 'run', 'build:ui', '--', '--selection',
                                str(args.coverage_selection.resolve())], cwd=website, check=True)
            (run/'complete.json').write_text(json.dumps({**built,'website':
                'Prepared coverage website built' if getattr(args, 'prepare_coverage', False)
                else 'Existing selected website preserved'},indent=2)+'\n')
            print('Catalog unchanged; prepared coverage website built.' if getattr(args, 'prepare_coverage', False)
                  else 'Catalog unchanged; no source payloads, validation, export or website rebuild.', flush=True)
            return
    report = read(candidate.with_suffix(candidate.suffix + '.reconciliation.json'))
    if report.get('status') != 'validated':
        raise ValueError('Candidate build has not validated')
    if args.candidate is None:
        native_validation(candidate,report,built)
        print('Native builder validation reused.',flush=True)
    else:
        checked = step('validate', cli + ['validate', '--index', str(candidate)],(candidate,))
        if checked['integrity'] != 'ok' or checked['foreignKeys'] or checked['generation'] != report['generation']:
            raise ValueError('Candidate validation differs from its build')
    pending = pending_receipts(completed,args,candidate,report['generation'],boundary='build completion')
    if pending:return pending
    checked = step('publication',cli+['check-publication','--target-only','--index',str(candidate),
                   '--selection',str(args.publication_reconciliation.resolve())],(candidate,))
    if not checked.get('selectionMatches') or not checked.get('targetMatches'):
        raise ValueError('Candidate differs from the pinned target publication')
    audit = [sys.executable, 'scripts/verify-register-sources.py',
             '--index', str(candidate), '--raw-root', str(raw), '--require-index-agreement']
    proof = getattr(args,'attempt_source_verification',None) or args.reuse_source_verification
    if proof:
        inherited_attempt = getattr(args,'attempt_source_index',None)
        cohort = None if inherited_attempt else args.refresh_object_list
        if cohort is None:
            cohort = run/'affected-register-objects.txt'
            if cohort.is_symlink() or (cohort.exists() and cohort.read_bytes()):
                raise ValueError('Generated empty source-verification cohort changed')
            if not cohort.exists():cohort.write_text('')
        audit += ['--reuse-verified', str(proof.resolve()),
                  '--base-index', str((inherited_attempt or args.cache/'index.sqlite').resolve()),
                  '--objects-from', str(cohort.resolve())]
    verified = step('verify-sources', audit,(candidate,))
    staged = run / 'public'
    exported = step('export', cli + ['export', '--index', str(candidate), '--output', str(staged),
                    '--completion-cache',str(args.cache.resolve())],(staged,))
    if exported['generation'] != report['generation']:
        raise ValueError('Export generation differs from its build')
    if not getattr(args,'catalog_only',False):
        selection = run / 'inspect.json'
        dates = run / 'source-periods.json'
        step('inspect', ['node', 'scripts/stage-source-catalog.mjs', '--inspect', str(staged), '--source-periods', str(dates)],(staged,selection,dates))
        observed = read(dates)
        if observed['months'] != verified['months'] or observed.get('latestIndexedDate') != verified['latestIndexedDate']:
            raise ValueError('Exported source dates differ from the verified local files')
        digest = 'sha256:' + hashlib.sha256(selection.read_bytes()).hexdigest()
        site_stage = website / 'public' / ('.catalog-' + report['generation'][7:])
        step('stage', ['node', 'scripts/stage-source-catalog.mjs', str(staged), str(selection), digest, str(site_stage)],(site_stage,))
    pending = pending_receipts(completed,args,candidate,report['generation'],boundary='selection')
    if pending:return pending
    step('select', cli + ['select', '--candidate', str(candidate),
         '--reconciliation', str(candidate.with_suffix(candidate.suffix + '.reconciliation.json')),
         '--staged-public', str(staged), '--cache', str(args.cache.resolve()),
         '--public', str(args.public.resolve()), '--raw-root', str(raw),
         '--expected-generation', selected_generation, '--allow-inventory-change',
         '--receipt-snapshot',str(first_snapshot),
         '--receipt-snapshot-sha256','sha256:'+fingerprint(first_snapshot)['sha256']])
    finish_selected(args, website, run)


if __name__ == '__main__':
    raise SystemExit(main())
