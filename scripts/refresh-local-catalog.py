"""Refresh the local archive catalog and website together, without downloads.

Run with the SpicyRegs source-readers Python environment. Existing catalog CLI
commands own validation and selection; this command sequences them and stops at
the first failure. Keep local catalog readers/writers paused during selection.
"""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import fcntl


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


def input_snapshot(args):
    """Freeze control inputs and the receipt list, without opening raw bodies."""
    from spicy_regs.source_catalog import maintenance
    from spicy_regs.source_catalog.raw_classification import classification_inputs
    from spicy_regs.source_catalog.raw_content import reader_inputs
    raw = args.raw_root.resolve()
    receipts = {}
    for path in sorted((raw/'acquisitions/sha256').glob('*/*')):
        stat = path.stat()
        if path.is_symlink() or not path.is_file():raise ValueError('Invalid acquisition receipt')
        receipts[str(path.relative_to(raw))] = [stat.st_size,stat.st_mtime_ns,stat.st_ctime_ns]
    code = set(Path(maintenance.__file__).parent.glob('*.py')) | set(classification_inputs())
    code.update(reader_inputs('family:federal-register'))
    code.add(Path(maintenance.__file__).parent/'config/registry.v1.json')
    code.add(args.publication_reconciliation.resolve())
    website = Path(__file__).resolve().parents[1]
    code.update(website/'scripts'/name for name in ('refresh-local-catalog.py','verify-register-sources.py',
                'stage-source-catalog.mjs','catalog-inspection.mjs','register-source-periods.mjs'))
    code.update((website/'lib').rglob('*.ts'))
    code.add(website/'package-lock.json')
    return {'baseGeneration':read(args.cache/'current.json')['generation'], 'python':sys.version,
            'node':subprocess.check_output(['node','--version'],text=True).strip(),
            'rawSnapshot':fingerprint(raw/'snapshot.json'), 'receipts':receipts,
            'definitions':{str(p.resolve()):fingerprint(p) for p in sorted(code)},
            'fullRebuild':args.full_rebuild, 'candidate':str(args.candidate.resolve()) if args.candidate else None}


class CompletedSteps:
    """Reuse this run's completed phases; native selection remains authoritative."""
    def __init__(self, run, snapshot):
        self.run = run
        pin = run/'input-snapshot.json'
        if pin.exists():
            if read(pin) != snapshot:raise ValueError('Refresh inputs changed; keep this run and start a new run for the new receipt set')
        else:save(pin,snapshot)
        self.snapshot = hashlib.sha256(pin.read_bytes()).hexdigest()

    def step(self, name, command, *, cwd, artifacts=()):
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
            return read(report)
        print(name,flush=True)
        with report.open('w') as output:
            subprocess.run(command,cwd=cwd,stdout=output,check=True)
        value = read(report)
        saved = {'snapshot':self.snapshot,'command':command,'report':fingerprint(report),
                 'artifacts':output_pins(value)}
        save(completion,saved)
        return value


def read(path):
    return json.loads(path.read_text())


def publications(index):
    with closing(sqlite3.connect(index.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        return sorted((row[0], row[1], row[2]) for row in db.execute(
            "SELECT id,collection_id,json_extract(data,'$.publication.version') FROM tables "
            "WHERE json_extract(data,'$.publication.scope')='current'"))


def native_validation(candidate, report, built):
    """Reuse checks completed by this run's native builder, with exact output agreement."""
    with closing(sqlite3.connect(candidate.resolve().as_uri()+'?mode=ro', uri=True)) as db:
        values = {key:json.loads(value) for key,value in db.execute(
            "SELECT key,value FROM metadata WHERE key IN ('generation','reconciliation')")}
    if (report != built or report.get('status') != 'validated'
            or values.get('generation') != report.get('generation')
            or values.get('reconciliation') != report):
        raise ValueError('Candidate differs from its native builder validation')


def finish_selected(args, website, run):
    """Finish a committed native selection; never repeat its acquisition/audit/export."""
    generation = read(run / 'export.json')['generation']
    verified = read(run / 'verify-sources.json')
    cache, public = args.cache.resolve(), args.public.resolve()
    current, selection = read(cache / 'current.json'), read(cache / 'selection.json')
    with closing(sqlite3.connect((cache / 'index.sqlite').as_uri() + '?mode=ro', uri=True)) as db:
        indexed = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
    if any(value != generation for value in (current['generation'], selection['generation'],
            indexed, read(public / 'manifest.json')['generation'], verified['generation'])):
        raise ValueError('Native selection is inconsistent; use its recovery.json before finishing the website')
    def pins(value):
        return sorted((item['path'], item['bytes'], item['sha256']) for item in value['files'])
    if pins(selection) != pins(read(run / 'inspect.json')):
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
    shutil.rmtree(backup, ignore_errors=True)
    if selected.get('backup'):
        selection_backup = Path(selected['backup']).resolve()
        if selection_backup.parent == cache and selection_backup.name.startswith('selection-backup-'):
            if selection_backup.exists() and read(selection_backup / 'recovery.json').get('generation') != generation:
                raise ValueError('Recovery backup belongs to a different generation; retained')
            shutil.rmtree(selection_backup, ignore_errors=True)
    (run / 'complete.json').write_text(json.dumps({'generation': generation, 'sourcePeriods': summary,
        'scope': 'Local catalog and website; Federal Register byte audit only; published measurements remain release-specific; no downloads or deployment'}, indent=2) + '\n')
    print('Local catalog and quarter coverage refreshed.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('raw-root', 'cache', 'public', 'run'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--publication-reconciliation', type=Path)
    parser.add_argument('--candidate', type=Path, help='Use an already validated rebuild')
    parser.add_argument('--full-rebuild', action='store_true', help='Explicitly replay the full archive instead of updating the selected index')
    parser.add_argument('--coverage-selection', type=Path, help='Preserve a completed published-table coverage release')
    parser.add_argument('--finish-selected', action='store_true', help='Resume only website preparation for an already committed native selection')
    parser.add_argument('--resume', action='store_true', help='Reuse completed phases of the same fixed-input run')
    args = parser.parse_args()
    website = Path(__file__).resolve().parents[1]
    run, raw = args.run.resolve(), args.raw_root.resolve()
    if any(path.resolve().is_relative_to(raw) for path in (run, args.cache, args.public, website)):
        raise ValueError('Catalog work must stay outside the raw archive')
    if args.resume or args.finish_selected:
        if not run.is_dir():raise ValueError('Refresh run does not exist')
    else:run.mkdir()
    lock = (run/'run.lock').open('a')
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise ValueError('Another process owns this refresh run')
    if args.finish_selected:
        if args.candidate or args.full_rebuild:
            parser.error('--finish-selected cannot build or replace a candidate')
        finish_selected(args, website, run)
        return
    if args.resume and (run/'export.json').exists():
        if read(args.cache/'current.json')['generation'] == read(run/'export.json')['generation']:
            finish_selected(args,website,run)
            return
    if not args.publication_reconciliation:
        parser.error('--publication-reconciliation is required for a new refresh')
    if shutil.disk_usage(run.parent).free < (args.cache / 'index.sqlite').stat().st_size + 8 * 1024**3:
        raise ValueError('Insufficient working space for a separate catalog and export')
    completed = CompletedSteps(run,input_snapshot(args))
    current = read(args.cache / 'current.json')
    previous_publications = publications(args.cache / 'index.sqlite')
    candidate = args.candidate.resolve() if args.candidate else run / 'index.sqlite'

    def step(name, command, artifacts=()):
        return completed.step(name,command,cwd=website,artifacts=artifacts)

    cli = [sys.executable, '-m', 'spicy_regs.source_catalog']
    if args.candidate is None:
        command = (['build', '--corpus', str(raw)] if args.full_rebuild else
                   ['refresh-metadata', '--index', str(args.cache.resolve() / 'index.sqlite'),
                    '--expected-generation', current['generation'], '--include-acquisitions',
                    '--refresh-content', 'family:federal-register', '--reuse-unchanged'])
        built = step('build', cli + command + ['--output', str(candidate),
             '--publication-reconciliation', str(args.publication_reconciliation.resolve())],
             lambda value: () if value.get('status') == 'unchanged' else
                 (candidate,candidate.with_suffix(candidate.suffix+'.reconciliation.json')))
        if built.get('status') == 'unchanged':
            generation = built['generation']
            if any(read(path)['generation'] != generation for path in (args.public/'manifest.json',
                    website/'public/source-catalog/manifest.json',website/'dist/source-catalog/manifest.json')):
                raise ValueError('Catalog unchanged but website selection differs; finish the selected run')
            (run/'complete.json').write_text(json.dumps({**built,'website':'Existing selected website preserved'},indent=2)+'\n')
            print('Catalog unchanged; no source payloads, validation, export or website rebuild.',flush=True)
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
    if publications(candidate) != previous_publications:
        raise ValueError('Refresh changed the selected published table versions')
    verified = step('verify-sources', [sys.executable, 'scripts/verify-register-sources.py',
                    '--index', str(candidate), '--raw-root', str(raw)],(candidate,))
    staged = run / 'public'
    exported = step('export', cli + ['export', '--index', str(candidate), '--output', str(staged)],(staged,))
    if exported['generation'] != report['generation']:
        raise ValueError('Export generation differs from its build')
    selection = run / 'inspect.json'
    dates = run / 'source-periods.json'
    step('inspect', ['node', 'scripts/stage-source-catalog.mjs', '--inspect', str(staged), '--source-periods', str(dates)],(staged,selection,dates))
    observed = read(dates)
    if observed['months'] != verified['months'] or observed.get('latestIndexedDate') != verified['latestIndexedDate']:
        raise ValueError('Exported source dates differ from the verified local files')
    digest = 'sha256:' + hashlib.sha256(selection.read_bytes()).hexdigest()
    site_stage = website / 'public' / ('.catalog-' + report['generation'][7:])
    step('stage', ['node', 'scripts/stage-source-catalog.mjs', str(staged), str(selection), digest, str(site_stage)],(site_stage,))
    step('select', cli + ['select', '--candidate', str(candidate),
         '--reconciliation', str(candidate.with_suffix(candidate.suffix + '.reconciliation.json')),
         '--staged-public', str(staged), '--cache', str(args.cache.resolve()),
         '--public', str(args.public.resolve()), '--raw-root', str(raw),
         '--expected-generation', current['generation'], '--allow-inventory-change'])
    finish_selected(args, website, run)


if __name__ == '__main__':
    main()
