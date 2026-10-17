"""Fetch one immutable public metadata release, preflight, then stage it."""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import os
import signal
import subprocess
import time
import fcntl
import re
from contextlib import ExitStack, contextmanager
from uuid import uuid4
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MANIFEST = Path(__file__).resolve().parents[1] / 'content/source-catalog-release.v1.json'


def release_manifest(path):
    value = json.loads(path.read_bytes())
    if value.get('format') != 'spicygov-source-catalog-release' or value.get('version') != 1:
        raise ValueError('Unsupported catalog release manifest')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', value.get('generation', '')):
        raise ValueError('Invalid catalog generation')
    for key, cap in [('selection', 2097152), ('archive', 201326592)]:
        item = value[key]
        if (type(item.get('bytes')) is not int or not 0 < item['bytes'] <= cap
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', item.get('sha256', ''))):
            raise ValueError('Invalid bounded catalog input')
    for key, cap in [('decodedBytes', 268435456), ('members', 10000), ('memberBytes', 268435456)]:
        if type(value.get(key)) is not int or not 0 < value[key] <= cap:
            raise ValueError('Invalid catalog allocation bound')
    return value


def checked_file(path, item, checker):
    checker.no_links(path)
    if not path.is_file() or path.stat().st_size != item['bytes']:
        raise ValueError('Cached catalog input size differs: ' + str(path))
    with path.open('rb') as stream:
        actual = 'sha256:' + hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != item['sha256']:
        raise ValueError('Cached catalog input hash differs: ' + str(path))


@contextmanager
def exclusive(path, checker):
    checker.no_links(path)
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('Catalog preparation already active: ' + str(path)) from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def acquire(path, item, url, checker, *, local_inputs=None, **kwargs):
    if path.exists() or path.is_symlink():
        checked_file(path, item, checker)
        return 'verified-cache'
    partial = path.with_name(path.name + '.' + uuid4().hex + '.partial')
    if local_inputs is not None:
        source = local_inputs / path.name
        if source.exists() or source.is_symlink():
            checked_file(source, item, checker)
            shutil.copyfile(source, partial)
            checked_file(partial, item, checker)
            partial.replace(path)
            return 'verified-local'
    download(url, partial, item['bytes'], item['sha256'], **kwargs)
    partial.replace(path)
    return 'GET'


def checked_tree(output, members, checker, check=None):
    checker.no_links(output)
    expected = {m['path']: m for m in members}
    actual = set()
    for base, dirs, files in os.walk(output, followlinks=False):
        if check: check()
        for name in dirs + files:
            path = Path(base) / name
            checker.no_links(path)
            if name in files:
                relative = path.relative_to(output).as_posix()
                if relative not in expected:
                    raise ValueError('Unexpected extracted catalog member')
                checked_file(path, expected[relative], checker)
                actual.add(relative)
    if actual != set(expected):
        raise ValueError('Incomplete extracted catalog')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def download(url, output, expected_size, expected_sha, *, opener=None, deadline=None, media_type=None, check=None):
    """One identity GET, no retry/redirect/proxy, exact bytes before acceptance."""
    if opener is None:
        opener = build_opener(ProxyHandler({}), NoRedirect())
    request = Request(url, headers={'Accept-Encoding': 'identity',
                                   'User-Agent': 'SpicyGovPinnedCatalog/1'})
    h = hashlib.sha256()
    total = 0
    with opener.open(request, timeout=30) as response:
        if response.status != 200 or response.url != url:
            raise ValueError('Unexpected download status/locator')
        for name in ['Content-Length', 'Content-Encoding']:
            if len(response.headers.get_all(name, [])) > 1:
                raise ValueError('Repeated framing header')
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            raise ValueError('Transport must preserve stored bytes')
        if media_type and response.headers.get('Content-Type', '').split(';')[0].strip().lower() != media_type:
            raise ValueError('Unexpected content type')
        length = response.headers.get('Content-Length')
        if length is not None and (not length.isdigit() or int(length) != expected_size):
            raise ValueError('Declared download size differs')
        with output.open('xb') as stream:
            while True:
                if check:
                    check()
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError('Download wall limit')
                chunk = response.read(min(65536, expected_size - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > expected_size:
                    raise ValueError('Download exceeds exact size')
                h.update(chunk)
                stream.write(chunk)
    if total != expected_size or 'sha256:' + h.hexdigest() != expected_sha:
        raise ValueError('Download content differs')
    return {'bytes': total, 'sha256': expected_sha}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, default=MANIFEST)
    parser.add_argument('--local-inputs', type=Path)
    args = parser.parse_args()
    release = release_manifest(args.manifest)
    generation = release['generation']
    selection_sha = release['selection']['sha256']
    prefix = 'https://data.spicygov.ai/source-catalog/releases/' + generation[7:] + '/' + selection_sha[7:] + '/'
    spec = importlib.util.spec_from_file_location('catalog_archive', Path(__file__).with_name('source-catalog-archive.py'))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    for path in [args.work_dir, args.output]:
        checker.no_links(path)
        if shutil.disk_usage(path.parent).free < 536870912:
            raise ValueError('Insufficient finite catalog disk budget')
    args.work_dir.mkdir(exist_ok=True)
    locks = ExitStack()
    try:
        locks.enter_context(exclusive(args.work_dir / 'prepare.lock', checker))
        locks.enter_context(exclusive(args.output.with_name(args.output.name + '.prepare.lock'), checker))
    except BaseException:
        locks.close()
        raise
    started = time.monotonic()
    last_check = 0.0
    def check_budget():
        nonlocal last_check
        now = time.monotonic()
        if now - started >= 600:
            raise TimeoutError('Whole preparation wall bound')
        if now - last_check < 0.5:
            return
        for target in [args.work_dir, args.output.parent]:
            if shutil.disk_usage(target).free < 536870912:
                raise ValueError('Free-space stop floor')
        total = count = 0
        for tree in [args.work_dir, args.output, *args.output.parent.glob(args.output.name + ".stage-*")]:
            if not tree.exists():
                continue
            for base, dirs, files in os.walk(tree, followlinks=False):
                for name in dirs + files:
                    count += 1
                    if count > 60000:
                        raise ValueError('Catalog disk inventory bound')
                    path = Path(base) / name
                    if path.is_symlink():
                        raise ValueError('Symlink in fresh catalog output')
                    if name in files:
                        total += path.stat().st_size
        # Include retained failed attempts and one existing completed output.
        # The selected production catalog alone has 4,130 files per copy.
        if total > 1073741824:
            raise ValueError('Catalog retained disk stop cap')
        # Walk time never shortens the spacing between walks, however slow the disk.
        last_check = time.monotonic()
    def expired(*unused):
        raise TimeoutError('Whole catalog preparation exceeded600s')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(600)
    try:
        owned = args.work_dir / selection_sha[7:]
        checker.no_links(owned)
        owned.mkdir(exist_ok=True)
        check_budget()
        selection = owned / 'public-selection.json'
        archive = owned / 'public-catalog.tar.gz'
        sources = [acquire(selection, release['selection'], prefix + selection.name, checker,
                   local_inputs=args.local_inputs, deadline=time.monotonic() + 30,
                   media_type='application/json', check=check_budget)]
        members = checker.selection_members(selection.read_bytes(), generation,
                    expected_members=release['members'], expected_bytes=release['memberBytes'])
        sources.append(acquire(archive, release['archive'], prefix + archive.name, checker,
                 local_inputs=args.local_inputs, deadline=time.monotonic() + 180,
                 media_type='application/gzip', check=check_budget))
        extracted = owned / 'extracted'
        if extracted.exists():
            checked_tree(extracted, members, checker, check_budget)
            result = {'extracted': True, 'reused': True}
        else:
            attempt = owned / ('extract-' + uuid4().hex)
            result = checker.extract_checked(archive, members, attempt,
                        compressed_cap=release['archive']['bytes'], decoded_cap=release['decodedBytes'], check=check_budget)
            checked_tree(attempt, members, checker, check_budget)
            attempt.rename(extracted)
        if args.output.exists():
            checked_tree(args.output, members, checker, check_budget)
        staged = args.output.with_name(args.output.name + '.stage-' + uuid4().hex)
        command = ['node', str(Path(__file__).with_name('stage-source-catalog.mjs')),
                   str(extracted), str(selection), selection_sha, str(staged)]
        proc = subprocess.Popen(command, start_new_session=True)
        try:
            stage_started = time.monotonic()
            while proc.poll() is None:
                check_budget()
                if time.monotonic() - stage_started >= 180:
                    raise TimeoutError('Maintained staging wall bound')
                time.sleep(0.25)
            if proc.returncode:
                raise subprocess.CalledProcessError(proc.returncode, command)
            # Successful root exit does not authorize a lingering helper.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            check_budget()
            checked_tree(staged, members, checker, check_budget)
            if args.output.exists():
                checked_tree(args.output, members, checker, check_budget)
                shutil.rmtree(staged)  # Only this fresh, successful attempt.
            else:
                staged.rename(args.output)
        except BaseException:
            # SIGALRM also reaches this path: kill the owned staging group.
            signal.alarm(0)
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)
            raise
        print(json.dumps({'generation': generation, 'archive_sha256': release['archive']['sha256'],
                          'selection_sha256': selection_sha, 'inputs': sources, 'checked': result,
                          'elapsed_seconds': time.monotonic() - started,
                          'at': dt.datetime.now(dt.timezone.utc).isoformat()}))
    finally:
        signal.alarm(0)
        locks.close()

if __name__ == '__main__':
    main()
