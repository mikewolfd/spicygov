"""Completion output owned by the coverage builder; no packaging CLI."""
import hashlib
import json
from pathlib import Path
import subprocess
from uuid import uuid4

from publication_census import load, path as publication_path


def sha(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def read_base(path, expected):
    path = Path(path)
    if path.stat().st_size > 32 * 1024**2:
        raise ValueError('Retained coverage exceeds release bound')
    raw = path.read_bytes()
    if len(raw) > 32 * 1024**2 or sha(raw) != expected:
        raise ValueError('Retained coverage differs from its reviewed SHA-256')
    document = json.loads(raw)
    if (document.get('format') != 'spicygov-coverage-maps' or document.get('version') != 1
            or document.get('partial') is not False or not isinstance(document.get('tables'), dict)):
        raise ValueError('Refresh requires a retained coverage map')
    return raw


def capture_load():
    captured = {}

    def fetch(key):
        publication_path(key)
        raw = subprocess.check_output(['curl', '-fsS', '--retry', '2', '--max-time', '60',
                                       'https://data.spicygov.ai/' + key])
        if len(raw) > 16 * 2**20:
            raise ValueError('Publication metadata exceeds release bound')
        captured[key] = raw
        return json.loads(raw)

    _, tables = load(fetch)
    return tables, captured


def implementation_files(root):
    # Release admission is conservative; scanner/definition edits require refresh.
    return sorted({*root.glob('scripts/*coverage*.py'), root / 'scripts/publication_census.py',
                   root / 'scripts/gao_receipt_policy.py',
                   *root.glob('content/coverage-definitions/*.json')})


def complete(root, output, map_bytes, captured, policies, revisions, *, base_bytes=None):
    """Called after builder final checks, never for an unselected partial scan.

    The returned manifest digest is selected outside this producer, in the
    reviewed UI release selection. A producer boolean grants no authority.
    """
    root, output = Path(root), Path(output)
    document = json.loads(map_bytes)
    measured = set(policies)
    if document.get('partial') is not False or not measured or measured != set(revisions):
        raise ValueError('Only a complete coverage build can create a release')
    if base_bytes is None:
        if set(document['tables']) != measured:
            raise ValueError('Only a complete coverage build can create a release')
    else:
        base = json.loads(base_bytes)['tables']
        if (set(document['tables']) != set(base) | measured
                or any(document['tables'][id] != value for id, value in base.items() if id not in measured)):
            raise ValueError('Refresh must preserve every unselected measurement')
    if output.exists():
        raise ValueError('Coverage releases are immutable; choose a new output')
    attempt = output.with_name(output.name + '.partial-' + uuid4().hex)
    attempt.mkdir(parents=True)
    members = {}

    def save(key, raw):
        target = attempt / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        members[key] = {'bytes': len(raw), 'sha256': sha(raw)}

    save('coverage-maps.v1.json', map_bytes)
    if base_bytes is not None:
        save('base-coverage-maps.v1.json', base_bytes)
    for key, raw in captured.items():
        publication_path(key)
        save('publications/' + key, raw)
    save('effective-policies.json', (json.dumps(policies, sort_keys=True, separators=(',', ':')) + '\n').encode())
    manifest = {'format': 'spicygov-coverage-refresh-release' if base_bytes is not None else 'spicygov-completed-coverage-release', 'version': 1,
                'generatedAt': document['generatedAt'], 'censusDigest': document['censusDigest'],
                'owner': 'scripts/build-coverage-maps.py:' + ('refresh-completion' if base_bytes is not None else 'full-completion'),
                'measurementRevisions': revisions, 'members': members,
                'implementation': {p.relative_to(root).as_posix(): sha(p.read_bytes())
                                   for p in implementation_files(root)}}
    raw = (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()
    (attempt / 'manifest.json').write_bytes(raw)
    # The independent consumer parses the actual Sources selection offline.
    subprocess.run(['node', str(root / 'scripts/consume-coverage-release.mjs'),
                    '--release', str(attempt), '--sha256', sha(raw)], check=True, cwd=root)
    attempt.rename(output)
    return {'directory': str(output), 'manifestSha256': sha(raw)}
