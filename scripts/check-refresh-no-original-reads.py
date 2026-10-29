"""Run an unchanged refresh with macOS denying original-data access to its process tree.

This is a kernel-enforced denial experiment, not a file-open event trace. A
positive control must fail to read a private canary before the refresh runs.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import signal
import sqlite3
import subprocess
import sys
import tempfile


CANARY = '''from pathlib import Path
import os, sys
assert Path(sys.argv[1]).read_text() == 'control'
for kind in ('python', 'native-open'):
    try:
        if kind == 'python':
            Path(sys.argv[2]).read_bytes()
        else:
            descriptor = os.open(sys.argv[2], os.O_RDONLY)
            os.close(descriptor)
    except PermissionError:
        continue
    raise SystemExit('The guard allowed the canary original: '+kind)
print('canary-denied')
'''


def policy_for(*directories):
    paths = []
    for directory in directories:
        name = str(directory.resolve())
        if any(ord(char) < 32 for char in name):
            raise ValueError('Control characters refused in sandbox paths')
        paths.append('(subpath '+json.dumps(name,ensure_ascii=False)+')')
    return '(version 1)(allow default)(deny file-read-data '+' '.join(paths)+')'


def check_canary(policy, control, original):
    result = subprocess.run(['/usr/bin/sandbox-exec','-p',policy,sys.executable,'-c',CANARY,
                             str(control),str(original)],capture_output=True,text=True,timeout=10)
    if result.returncode or result.stdout.strip() != 'canary-denied':
        raise ValueError('Kernel read-denial control failed: '+result.stderr[-1200:])


def run_bounded(command, timeout):
    process = subprocess.Popen(command,start_new_session=True)
    try:
        return process.wait(timeout=timeout)
    except BaseException:
        os.killpg(process.pid,signal.SIGTERM)
        try:process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL)
            process.wait()
        raise


def selected_archive(cache, raw):
    """Bind the denied directory to the archive used by the native selected index."""
    with sqlite3.connect((cache/'index.sqlite').as_uri()+'?mode=ro',uri=True) as db:
        roots = {Path(row[0]).parent.resolve() for row in db.execute(
            "SELECT path FROM inputs WHERE path LIKE '%/snapshot.json'")
            if (Path(row[0]).parent/'objects/sha256').is_dir()}
        generation = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
    if roots != {raw} or json.loads((cache/'current.json').read_text())['generation'] != generation:
        raise ValueError('The guarded directory does not match the selected archive and generation')
    return generation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('raw-root','cache','run','report'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--timeout',type=float,default=120)
    args, options = parser.parse_known_args()
    raw, cache, run, report = (path.resolve() for path in (args.raw_root,args.cache,args.run,args.report))
    if platform.system() != 'Darwin' or not Path('/usr/bin/sandbox-exec').is_file():
        parser.error('This kernel-denial check requires macOS sandbox-exec; no weaker fallback is used')
    if args.timeout <= 0 or args.timeout > 600:
        parser.error('--timeout must be greater than zero and no more than 600 seconds')
    if run.exists() or report.exists() or report.is_relative_to(run):
        parser.error('Use a fresh run directory and a new report outside that run')
    if run.is_relative_to(raw) or report.is_relative_to(raw):
        parser.error('Run and proof output must stay outside the raw archive')
    if any(option.split('=')[0] in {'--resume','--finish-selected','--candidate','--full-rebuild'} for option in options):
        parser.error('The no-original-read proof requires a fresh normal unchanged refresh')
    objects = raw/'objects/sha256'
    if not objects.is_dir():parser.error('The canonical raw object directory is missing')
    generation = selected_archive(cache,raw)
    report.parent.mkdir(parents=True,exist_ok=True)
    proof = {'format':'spicygov-guarded-unchanged-refresh','version':1,
             'startedAt':datetime.now(timezone.utc).isoformat(),
             'guardedOriginalDirectory':str(objects),'run':str(run),
             'baselineGeneration':generation,
             'mechanism':'macOS sandbox-exec file-read-data denial, inherited by descendants',
             'scope':'Proves no successful original-data access under the guarded directory. Does not count attempted file opens.'}
    try:
        with tempfile.TemporaryDirectory(prefix='catalog-read-guard-') as directory:
            canary = Path(directory).resolve()
            blocked = canary/'objects';blocked.mkdir()
            original, control = blocked/'original',canary/'control'
            original.write_text('private canary');control.write_text('control')
            policy = policy_for(objects,blocked)
            check_canary(policy,control,original)
            proof['canaryReadDenied'] = True
            command = ['/usr/bin/sandbox-exec','-p',policy,sys.executable,
                       str(Path(__file__).with_name('refresh-local-catalog.py')),
                       '--raw-root',str(raw),'--cache',str(cache),'--run',str(run),*options]
            result = run_bounded(command,args.timeout)
            if result:raise ValueError('Guarded refresh failed with exit status '+str(result))
        completion = json.loads((run/'complete.json').read_text())
        if (completion.get('status') != 'unchanged' or completion.get('generation') != generation
                or selected_archive(cache,raw) != generation):
            raise ValueError('The guarded command did not complete through the unchanged path')
        if (run/'index.sqlite').exists() or (run/'export.json').exists():
            raise ValueError('The unchanged proof produced a candidate or export')
        proof.update(status='passed',generation=completion['generation'])
    except Exception as error:
        proof.update(status='failed',error=type(error).__name__,reason=str(error))
        raise
    finally:
        proof['completedAt'] = datetime.now(timezone.utc).isoformat()
        with report.open('x') as stream:json.dump(proof,stream,indent=2);stream.write('\n')
    print(json.dumps(proof))


if __name__ == '__main__':main()
