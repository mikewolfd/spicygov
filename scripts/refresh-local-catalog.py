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


def read(path):
    return json.loads(path.read_text())


def publications(index):
    with closing(sqlite3.connect(index.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        return sorted((row[0], row[1], row[2]) for row in db.execute(
            "SELECT id,collection_id,json_extract(data,'$.publication.version') FROM tables "
            "WHERE json_extract(data,'$.publication.scope')='current'"))


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
    args = parser.parse_args()
    website = Path(__file__).resolve().parents[1]
    run, raw = args.run.resolve(), args.raw_root.resolve()
    if any(path.resolve().is_relative_to(raw) for path in (run, args.cache, args.public, website)):
        raise ValueError('Catalog work must stay outside the raw archive')
    if args.finish_selected:
        if args.candidate or args.full_rebuild:
            parser.error('--finish-selected cannot build or replace a candidate')
        finish_selected(args, website, run)
        return
    if not args.publication_reconciliation:
        parser.error('--publication-reconciliation is required for a new refresh')
    if shutil.disk_usage(run.parent).free < (args.cache / 'index.sqlite').stat().st_size + 8 * 1024**3:
        raise ValueError('Insufficient working space for a separate catalog and export')
    run.mkdir()
    current = read(args.cache / 'current.json')
    previous_publications = publications(args.cache / 'index.sqlite')
    candidate = args.candidate.resolve() if args.candidate else run / 'index.sqlite'

    def step(name, command):
        print(name, flush=True)
        with (run / (name + '.json')).open('w') as output:
            subprocess.run(command, cwd=website, stdout=output, check=True)
        return read(run / (name + '.json'))

    cli = [sys.executable, '-m', 'spicy_regs.source_catalog']
    if args.candidate is None:
        command = (['build', '--corpus', str(raw)] if args.full_rebuild else
                   ['refresh-metadata', '--index', str(args.cache.resolve() / 'index.sqlite'),
                    '--expected-generation', current['generation'], '--include-acquisitions',
                    '--refresh-content', 'family:federal-register'])
        step('build', cli + command + ['--output', str(candidate),
             '--publication-reconciliation', str(args.publication_reconciliation.resolve())])
    report = read(candidate.with_suffix(candidate.suffix + '.reconciliation.json'))
    if report.get('status') != 'validated':
        raise ValueError('Candidate build has not validated')
    checked = step('validate', cli + ['validate', '--index', str(candidate)])
    if checked['integrity'] != 'ok' or checked['foreignKeys'] or checked['generation'] != report['generation']:
        raise ValueError('Candidate validation differs from its build')
    if publications(candidate) != previous_publications:
        raise ValueError('Refresh changed the selected published table versions')
    verified = step('verify-sources', [sys.executable, 'scripts/verify-register-sources.py',
                    '--index', str(candidate), '--raw-root', str(raw)])
    staged = run / 'public'
    exported = step('export', cli + ['export', '--index', str(candidate), '--output', str(staged)])
    if exported['generation'] != report['generation']:
        raise ValueError('Export generation differs from its build')
    selection = run / 'inspect.json'
    dates = run / 'source-periods.json'
    step('inspect', ['node', 'scripts/stage-source-catalog.mjs', '--inspect', str(staged), '--source-periods', str(dates)])
    observed = read(dates)
    if observed['months'] != verified['months'] or observed.get('latestIndexedDate') != verified['latestIndexedDate']:
        raise ValueError('Exported source dates differ from the verified local files')
    digest = 'sha256:' + hashlib.sha256(selection.read_bytes()).hexdigest()
    site_stage = website / 'public' / ('.catalog-' + report['generation'][7:])
    step('stage', ['node', 'scripts/stage-source-catalog.mjs', str(staged), str(selection), digest, str(site_stage)])
    step('select', cli + ['select', '--candidate', str(candidate),
         '--reconciliation', str(candidate.with_suffix(candidate.suffix + '.reconciliation.json')),
         '--staged-public', str(staged), '--cache', str(args.cache.resolve()),
         '--public', str(args.public.resolve()), '--raw-root', str(raw),
         '--expected-generation', current['generation'], '--allow-inventory-change'])
    finish_selected(args, website, run)


if __name__ == '__main__':
    main()
