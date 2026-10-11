"""T01 retained Pages bytes: package, verify, fetch, live-check and explicitly authorized deploy."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import tarfile
import time
import urllib.request
import zipfile

MAX_CONTAINER = 64 * 1024 * 1024
MAX_MAP = 2 * 1024 * 1024
MAX_TAR = 192 * 1024 * 1024
BASE = 'https://data.spicygov.ai/pages-retained/t01/'
HTML_FRAGMENT_SHA = 'f639ffee489b6bf2685ce5675ec83fd22e071ed2de5915bd84e437481c9c3bf6'
HTML_MEMBERS = {'index.html', 'sources/index.html', 'mcp/index.html'}

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def digest(value):
    value = value.removeprefix('sha256:')
    if not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('Missing exact digest')
    return value

def name(value):
    p = PurePosixPath(value)
    if not value or p.is_absolute() or any(x in ('', '.', '..') for x in value.split('/')) or '\\' in value or p.as_posix() != value:
        raise ValueError('Unsafe member name')
    return value

def regular(path):
    if any(x.is_symlink() for x in (path, *path.parents)):
        raise ValueError('Symlink input')
    s = path.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise ValueError('Regular single-link input required')
    return s

def identity(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink

def read_map(path, expected):
    s = regular(path)
    if s.st_size > MAX_MAP:
        raise ValueError('Map cap')
    raw = path.read_bytes()
    if identity(regular(path)) != identity(s) or sha(raw) != digest(expected):
        raise ValueError('Map identity')
    obj = json.loads(raw)
    rows = obj if isinstance(obj, list) else [dict(path=k, **v) for k, v in obj.items()]
    result = {}
    for row in rows:
        key = name(row['path'])
        if key in result or type(row['bytes']) is not int or row['bytes'] < 0:
            raise ValueError('Duplicate or invalid member')
        result[key] = {'bytes': row['bytes'], 'sha256': digest(row['sha256'])}
    if not result or len(result) > 5000 or sum(x['bytes'] for x in result.values()) > MAX_TAR:
        raise ValueError('Map workload cap')
    return result

def check_stream(stream, size, expected, sink=None):
    h = hashlib.sha256()
    remaining = size
    while remaining:
        block = stream.read(min(65536, remaining))
        if not block:
            raise ValueError('Truncated body')
        h.update(block)
        remaining -= len(block)
        if sink is not None:
            sink.write(block)
    if stream.read(1) or h.hexdigest() != digest(expected):
        raise ValueError('Body identity')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirect refused')

def download(item, target):
    cap = MAX_MAP if item['filename'] == 'members.json' else MAX_CONTAINER
    if type(item['bytes']) is not int or not 0 < item['bytes'] <= cap:
        raise ValueError('Transfer cap')
    expected_url = BASE + digest(item['sha256']) + '/' + item['filename']
    if item['filename'] not in ('artifact.tar.gz', 'prior.zip', 'members.json') or item['url'] != expected_url:
        raise ValueError('Destination binding')
    request = urllib.request.Request(item['url'], headers={'Accept-Encoding': 'identity'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response, target.open('xb') as output:
        if response.status != 200 or response.headers.get('Content-Encoding') is not None or response.headers.get('Content-Length') != str(item['bytes']):
            raise ValueError('Transfer framing')
        check_stream(response, item['bytes'], item['sha256'], output)

class BoundedReader:
    def __init__(self, stream):
        self.stream, self.total = stream, 0
    def read(self, size):
        if size < 0 or size > MAX_MAP:
            raise ValueError('Tar parser read cap')
        raw = self.stream.read(size)
        self.total += len(raw)
        if self.total > MAX_TAR:
            raise ValueError('Tar expansion cap')
        return raw

def verify_tar(path, members, compressed=False):
    if regular(path).st_size > MAX_TAR:
        raise ValueError('Tar cap')
    seen = set()
    import gzip
    source = gzip.open if compressed else open
    with source(path, 'rb') as raw, tarfile.open(fileobj=BoundedReader(raw), mode='r|') as archive:
        for entry in archive:
            key = entry.name.removeprefix('./').rstrip('/')
            if entry.isdir():
                if key and key != '.':
                    name(key)
                    if not any(x.startswith(key + '/') for x in members):
                        raise ValueError('Unexpected directory')
                continue
            key = name(key)
            if not entry.isfile() or key in seen or key not in members or entry.size != members[key]['bytes']:
                raise ValueError('Unexpected, linked or duplicate tar member')
            seen.add(key)
            with archive.extractfile(entry) as stream:
                check_stream(stream, entry.size, members[key]['sha256'])
        # tarfile stops at its first end marker. Consume its buffered remainder
        # and the complete underlying stream, allowing only zero tar padding.
        # This also forces gzip EOF/CRC checks on compressed containers.
        while tail := archive.fileobj.read(65536):
            if tail.strip(b'\x00'):
                raise ValueError('Nonzero trailing tar bytes')
    if seen != set(members):
        raise ValueError('Incomplete tar members')

def package(root, members, output):
    if any(x.is_symlink() for x in (root, *root.parents)) or not root.is_dir():
        raise ValueError('Unsafe root')
    actual = set()
    for parent, dirs, files in os.walk(root, followlinks=False):
        for child in dirs:
            if (Path(parent) / child).is_symlink():
                raise ValueError('Directory symlink')
        for child in files:
            path = Path(parent) / child
            regular(path)
            actual.add(path.relative_to(root).as_posix())
    if actual != set(members):
        raise ValueError('Dist member set differs')
    before = {key: identity(regular(root / key)) for key in members}
    # Necessary transfer container; no extracted dist copy or source build.
    with output.open('xb') as raw, tarfile.open(fileobj=raw, mode='w|gz') as archive:
        for key in sorted(members):
            path = root / key
            with path.open('rb') as stream:
                if identity(os.fstat(stream.fileno())) != before[key]:
                    raise ValueError('Opened member drift')
                check_stream(stream, members[key]['bytes'], members[key]['sha256'])
                stream.seek(0)
                entry = tarfile.TarInfo(key)
                entry.size = members[key]['bytes']
                entry.mode = 0o644
                archive.addfile(entry, stream)
                if identity(os.fstat(stream.fileno())) != before[key] or identity(regular(path)) != before[key]:
                    raise ValueError('Member drift')
        if raw.tell() > MAX_CONTAINER:
            raise ValueError('Compressed container exceeds maintained transfer bound')
    if regular(output).st_size > MAX_CONTAINER:
        raise ValueError('Compressed container cap')
    verify_tar(output, members, compressed=True)
    return {'bytes': output.stat().st_size, 'sha256': sha(output.read_bytes())}

def unpack(container, kind, target):
    # Only the necessary Pages tar is materialized, never the dist tree.
    with target.open('xb') as output:
        if kind == 'prior.zip':
            with zipfile.ZipFile(container) as archive:
                if archive.namelist() != ['artifact.tar']:
                    raise ValueError('Unexpected ZIP inventory')
                item = archive.getinfo('artifact.tar')
                if item.file_size > MAX_TAR:
                    raise ValueError('ZIP expansion cap')
                with archive.open(item) as stream:
                    copy_bounded(stream, output)
        else:
            import gzip
            with gzip.open(container, 'rb') as stream:
                copy_bounded(stream, output)

def copy_bounded(stream, output):
    total = 0
    while block := stream.read(65536):
        total += len(block)
        if total > MAX_TAR:
            raise ValueError('Expansion cap')
        output.write(block)

def binding(path, role, action):
    if regular(path).st_size > 32768:
        raise ValueError('Binding cap')
    obj = json.loads(path.read_text())
    now = dt.datetime.now(dt.timezone.utc)
    if obj['upload_authorized'] is not True or now >= dt.datetime.fromisoformat(obj['expires_at']):
        raise ValueError('Held or expired binding')
    if action == 'deploy' and (obj['deployment_authorized'] is not True or obj['exclusive_writers_confirmed'] is not True or obj['deployment_role'] != role):
        raise ValueError('Deployment held')
    return obj['roles'][role]

def api(method, path, body=None):
    token = os.environ['GH_TOKEN']
    raw = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request('https://api.github.com/repos/mikewolfd/spicygov/' + path,
        data=raw, method=method, headers={'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
        'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response:
        raw = response.read(262145)
        if len(raw) > 262144:
            raise ValueError('API response cap')
        return json.loads(raw)

def deploy(path, role, output):
    obj = json.loads(path.read_text())
    item = binding(path, role, 'deploy')
    approved = item['approved_artifact']
    if not approved or approved['expired'] is not False:
        raise ValueError('Actual uploaded artifact admission missing')
    artifact = api('GET', 'actions/artifacts/' + str(approved['id']))
    for key in ('id', 'name', 'digest', 'size_in_bytes', 'expired', 'expires_at'):
        if artifact[key] != approved[key]:
            raise ValueError('Provider artifact identity differs')
    for key in ('id', 'head_sha'):
        if artifact['workflow_run'][key] != approved['workflow_run'][key]:
            raise ValueError('Artifact run identity differs')
    expires = dt.datetime.fromisoformat(artifact['expires_at'].replace('Z', '+00:00'))
    if expires.tzinfo is None or dt.datetime.now(dt.timezone.utc) >= expires:
        raise ValueError('Artifact already expired')
    # Own environment job creates a generic record before this step. Identify
    # it by this run's log URL; unknown records cause refusal, never exclusion
    # merely because they share a SHA or appear queued.
    run_url = 'https://github.com/mikewolfd/spicygov/actions/runs/' + os.environ['GITHUB_RUN_ID']
    deployments = api('GET', 'deployments?environment=github-pages&per_page=5')
    foreign = None
    for record in deployments:
        statuses = api('GET', 'deployments/' + str(record['id']) + '/statuses?per_page=5')
        if not statuses:
            raise ValueError('Unidentified generic deployment')
        log = statuses[0].get('log_url', '')
        if log == run_url or log.startswith(run_url + '/'):
            continue
        foreign = record
        break
    expected = obj['expected_current']
    if foreign is None or foreign['id'] != expected['generic_id'] or foreign['sha'] != expected['sha']:
        raise ValueError('Intervening or unidentified Pages writer')
    if statuses[0]['state'] != expected['state']:
        raise ValueError('Prior status differs')
    pages_status = api('GET', 'pages/deployments/' + expected['pages_id'])
    if pages_status['status'] != expected['pages_status']:
        raise ValueError('Prior Pages-specific status differs')
    # Exact input artifact may come from an earlier admitted run. The REST API
    # selects its repository artifact ID; deploy-pages' current-run discovery
    # is deliberately not used. Provider acceptance is a future runtime gate.
    token_url = os.environ['ACTIONS_ID_TOKEN_REQUEST_URL']
    from urllib.parse import urlsplit
    host = urlsplit(token_url)
    if host.scheme != 'https' or not host.hostname or not host.hostname.endswith('.actions.githubusercontent.com'):
        raise ValueError('OIDC service origin')
    request = urllib.request.Request(token_url, headers={'Authorization': 'Bearer ' + os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=30) as response:
        raw = response.read(32769)
        if len(raw) > 32768:
            raise ValueError('OIDC response cap')
        token = json.loads(raw)['value']
    binding(path, role, 'deploy')  # Recheck authority expiry before the POST.
    if dt.datetime.now(dt.timezone.utc) >= expires:
        raise ValueError('Artifact expired before submission')
    # Write a pre-submit receipt so indeterminate POST failures stay visible.
    receipt = {'state': 'submit-started', 'artifact': approved, 'prior': expected,
               'workflow_sha': os.environ['GITHUB_SHA'], 'run': os.environ['GITHUB_RUN_ID'], 'role': role}
    output.write_text(json.dumps(receipt) + '\n')
    result = api('POST', 'pages/deployments', {'artifact_id': approved['id'],
        'pages_build_version': os.environ['GITHUB_SHA'], 'oidc_token': token})
    receipt.update(state='submitted', pages_response=result)
    output.write_text(json.dumps(receipt) + '\n')
    deployment_id = str(result['id'])
    for unused in range(110):
        result = api('GET', 'pages/deployments/' + deployment_id)
        receipt.update(state='provider-status-observed', pages_status=result)
        output.write_text(json.dumps(receipt) + '\n')
        if result['status'] == 'succeed':
            return
        if result['status'] in ('deployment_failed', 'deployment_content_failed', 'deployment_cancelled', 'deployment_lost'):
            raise ValueError('Pages deployment failed; no automatic restore')
        time.sleep(5)
    raise TimeoutError('Pages status deadline; no retry or automatic restore')

def live_body(response, key, expected, fragment):
    if key not in HTML_MEMBERS or fragment is None:
        check_stream(response, expected['bytes'], expected['sha256'])
        return False
    raw = response.read(expected['bytes'] + 368)
    if len(raw) > expected['bytes'] + 367:
        raise ValueError('HTML expansion exceeds exact hosting addition')
    if len(raw) == expected['bytes'] and sha(raw) == expected['sha256']:
        return False
    if raw.count(fragment) != 1:
        raise ValueError('Unknown or repeated hosting fragment')
    normalized = raw.replace(fragment, b'', 1)
    if len(normalized) != expected['bytes'] or sha(normalized) != expected['sha256']:
        raise ValueError('Normalized HTML differs')
    return True

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['package', 'fetch', 'live', 'deploy'])
    parser.add_argument('--map', type=Path)
    parser.add_argument('--map-sha')
    parser.add_argument('--root', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--binding', type=Path)
    parser.add_argument('--role', choices=['prior', 'forward'])
    parser.add_argument('--html-fragment', type=Path)
    parser.add_argument('--public-map-output', type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGALRM, lambda *unused: (_ for _ in ()).throw(TimeoutError('Whole operation deadline')))
    signal.alarm(600)
    if args.command == 'package':
        members = read_map(args.map, args.map_sha)
        result = package(args.root, members, args.output)
        if args.public_map_output is not None:
            # Public transfer needs logical member identity, not local inode,
            # device, timestamps or other private acceptance diagnostics.
            raw = (json.dumps(members, sort_keys=True, separators=(',', ':')) + '\n').encode()
            if len(raw) > MAX_MAP:
                raise ValueError('Public map cap')
            with args.public_map_output.open('xb') as output:
                output.write(raw)
            result['public_map'] = {'bytes': len(raw), 'sha256': sha(raw)}
        print(json.dumps(result, sort_keys=True))
    elif args.command == 'fetch':
        item = binding(args.binding, args.role, 'upload')
        args.output.mkdir(exist_ok=False)
        download(item['map'], args.output / 'members.json')
        members = read_map(args.output / 'members.json', item['map']['sha256'])
        download(item['container'], args.output / item['container']['filename'])
        unpack(args.output / item['container']['filename'], item['container']['filename'], args.output / 'artifact.tar')
        verify_tar(args.output / 'artifact.tar', members)
        print(json.dumps({'verified_members': len(members), 'content_bytes': sum(x['bytes'] for x in members.values())}))
    elif args.command == 'deploy':
        deploy(args.binding, args.role, args.output)
    else:
        # Root performs live readback using the same verified map on a retained
        # runner. A failed read never dispatches an automatic restoration.
        item = binding(args.binding, args.role, 'deploy')
        members = read_map(args.map, item['map']['sha256'])
        fragment = None
        if args.html_fragment is not None:
            if regular(args.html_fragment).st_size != 367:
                raise ValueError('Hosting fragment size')
            fragment = args.html_fragment.read_bytes()
            if sha(fragment) != HTML_FRAGMENT_SHA:
                raise ValueError('Hosting fragment identity')
        normalized = []
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        for key, value in members.items():
            from urllib.parse import quote
            route = key[:-10] if key in HTML_MEMBERS else key
            request = urllib.request.Request('https://spicygov.ai/' + quote(route, safe='/'), headers={'Accept-Encoding': 'identity'})
            with opener.open(request, timeout=30) as response:
                if response.status != 200 or response.headers.get('Content-Encoding') is not None:
                    raise ValueError('Live response framing')
                if live_body(response, key, value, fragment):
                    normalized.append(key)
        with args.output.open('x') as output:
            output.write(json.dumps({'status': 'complete-member-live-byte-match', 'members': len(members), 'exact_hosting_fragment_normalized': normalized}) + '\n')

if __name__ == '__main__':
    main()
