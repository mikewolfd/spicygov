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
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

GENERATION = 'sha256:46443510ff63b1c989400cc9e632f730b521b93d847ff5573d6d083e72121cda'
SELECTION_SHA = 'sha256:3b18dde7218277fb4c192bb8de1d5ba1a4dce527c488799c3d05aeba7061f0af'
ARCHIVE_SHA = 'sha256:94cdca21d4ee95c2c881f3456f7ee03ffb66ec3c6e4a10c56d8fa293f3bd087d'
PREFIX = ('https://data.spicygov.ai/source-catalog/releases/' + GENERATION[7:]
          + '/' + SELECTION_SHA[7:] + '/')
ARCHIVE_BYTES = 50842455
SELECTION_BYTES = 1073646
DECODED_BYTES = 163645440
MEMBERS = 4130
MEMBER_BYTES = 160379449

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
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location('catalog_archive', Path(__file__).with_name('source-catalog-archive.py'))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    for path in [args.work_dir, args.output]:
        checker.no_links(path)
        if path.exists():
            raise ValueError('Work and staging output must be absent')
        if shutil.disk_usage(path.parent).free < 536870912:
            raise ValueError('Insufficient finite catalog disk budget')
    args.work_dir.mkdir(exist_ok=False)
    started = time.monotonic()
    last_check = 0.0
    def check_budget():
        nonlocal last_check
        now = time.monotonic()
        if now - started >= 600:
            raise TimeoutError('Whole preparation wall bound')
        if now - last_check < 0.5:
            return
        last_check = now
        for target in [args.work_dir, args.output.parent]:
            if shutil.disk_usage(target).free < 536870912:
                raise ValueError('Free-space stop floor')
        total = count = 0
        for tree in [args.work_dir, args.output]:
            if not tree.exists():
                continue
            for base, dirs, files in os.walk(tree, followlinks=False):
                for name in dirs + files:
                    count += 1
                    if count > 12000 or time.monotonic() - now > 2:
                        raise ValueError('Catalog disk inventory bound')
                    path = Path(base) / name
                    if path.is_symlink():
                        raise ValueError('Symlink in fresh catalog output')
                    if name in files:
                        total += path.stat().st_size
        if total > 536870912:
            raise ValueError('Catalog retained disk stop cap')
    def expired(*unused):
        raise TimeoutError('Whole catalog preparation exceeded600s')
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(600)
    try:
        selection = args.work_dir / 'public-selection.json'
        archive = args.work_dir / 'public-catalog.tar.gz'
        download(PREFIX + 'public-selection.json', selection, SELECTION_BYTES,
                 SELECTION_SHA, deadline=time.monotonic() + 30, media_type='application/json', check=check_budget)
        members = checker.selection_members(selection.read_bytes(), GENERATION,
                    expected_members=MEMBERS, expected_bytes=MEMBER_BYTES)
        download(PREFIX + 'public-catalog.tar.gz', archive, ARCHIVE_BYTES,
                 ARCHIVE_SHA, deadline=time.monotonic() + 180, media_type='application/gzip', check=check_budget)
        extracted = args.work_dir / 'extracted'
        result = checker.extract_checked(archive, members, extracted,
                    compressed_cap=ARCHIVE_BYTES, decoded_cap=DECODED_BYTES, check=check_budget)
        command = ['node', str(Path(__file__).with_name('stage-source-catalog.mjs')),
                   str(extracted), str(selection), SELECTION_SHA, str(args.output)]
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
        except BaseException:
            # SIGALRM also reaches this path: kill the owned staging group.
            signal.alarm(0)
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=5)
            raise
        print(json.dumps({'generation': GENERATION, 'archive_sha256': ARCHIVE_SHA,
                          'selection_sha256': SELECTION_SHA, 'checked': result,
                          'elapsed_seconds': time.monotonic() - started,
                          'at': dt.datetime.now(dt.timezone.utc).isoformat()}))
    finally:
        signal.alarm(0)

if __name__ == '__main__':
    main()
