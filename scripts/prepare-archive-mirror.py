"""Bind an existing key/size parity report to the selected catalog; HEAD three keys.

No source bodies are opened or downloaded. Native selection helpers own the raw
snapshot and receipt-set identity. The original report remains unchanged.
"""
import argparse
from datetime import UTC, datetime
from email import message_from_string
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess

ARCHIVE_BASE = 'https://data.spicygov.ai/spicyregs/raw/'


def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def require(ok, message):
    if not ok:
        raise ValueError(message)


def custody(path):
    require(not path.is_symlink() and path.is_file(), 'Mirror input must be a regular file')
    stat = path.stat()
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def public_head(key, size):
    url = ARCHIVE_BASE + key
    raw = subprocess.check_output(['curl', '-fsSI', '--max-time', '20', '--proto', '=https',
                                   '-H', 'Accept-Encoding: identity', '-w', '\n%{http_code}\n%{url_effective}', url], text=True)
    headers, status, effective = raw.rsplit('\n', 2)
    require(status == '200' and effective == url, 'Archive sample is not publicly available')
    headers = message_from_string(headers.split('\n', 1)[1])
    require(headers.get('Content-Length') == str(size), 'Public archive sample size differs')
    return {'key': key, 'bytes': size, 'status': 200}


def prepare(inventory, cache, catalog, raw_root, *, head=public_head):
    from spicy_regs.source_catalog.selection import index_inventory, metadata, raw_selection

    cache, catalog, raw_root = cache.resolve(), catalog.resolve(), raw_root.resolve()
    current_path, index = cache/'current.json', cache/'index.sqlite'
    manifest_path = catalog/'manifest.json'
    paths = [inventory, current_path, index, manifest_path, raw_root/'snapshot.json']
    before = {path: custody(path) for path in paths}
    report_bytes, current_bytes, manifest_bytes = inventory.read_bytes(), current_path.read_bytes(), manifest_path.read_bytes()
    report, current, manifest = map(json.loads, [report_bytes, current_bytes, manifest_bytes])
    require(report.get('format') == 'spicy-archive-inventory-parity' and report.get('version') == 1
            and report.get('status') == 'inventory-parity-confirmed', 'No completed archive inventory proof')
    require(report.get('namespaceCheck', {}).get('status') == 'confirmed', 'Archive namespace was not checked')
    for name in ('objects', 'receipts', 'controls'):
        group = report[name]
        require(type(group.get('both')) is int and group['both'] > 0
                and all(group.get(key) == 0 for key in ('localOnly', 'r2Only', 'sizeMismatch', 'duplicate')),
                'Archive inventory has unresolved differences')
    require(current.get('index') == 'index.sqlite' and current.get('generation') == manifest.get('generation')
            == metadata(index).get('generation'), 'Selected catalog generations differ')
    require(digest(manifest_bytes) == 'sha256:' + current['public_manifest_sha256'], 'Selected manifest bytes differ')
    pins = raw_selection(raw_root)
    require(pins == report.get('rawInventory') and all(current.get(key) == value for key, value in pins.items()),
            'Archive inventory proof belongs to another raw snapshot or receipt set')
    with sqlite3.connect(index.as_uri()+'?mode=ro', uri=True) as db:
        require(index_inventory(db, raw_root)[0] == pins, 'Selected index raw inventory differs')
        controls, receipts = [], []
        prefix = str(raw_root) + '/'
        for path, _, size in db.execute('SELECT path,sha256,bytes FROM inputs WHERE path LIKE ?', (prefix+'%',)):
            key = str(Path(path).relative_to(raw_root))
            if '/' not in key:
                controls.append({'key': key, 'bytes': size})
            elif key.startswith('acquisitions/sha256/'):
                receipts.append((key, size))
        require(len(controls) == report['controls']['both'] and len(receipts) == report['receipts']['both'],
                'Archive inventory counts differ from selected inputs')
        original = db.execute('SELECT object,stored_bytes FROM raw_objects WHERE present=1 ORDER BY sha256 LIMIT 1').fetchone()
    require(original is not None and receipts, 'Archive sample inputs unavailable')
    controls.sort(key=lambda item: item['key'])
    samples = [original, sorted(receipts)[0], ('snapshot.json', (raw_root/'snapshot.json').stat().st_size)]
    checks = [head(key, size) for key, size in samples]
    require(raw_selection(raw_root) == pins and all(custody(path) == value for path, value in before.items()),
            'Archive mirror inputs changed during preparation')
    stamp = datetime.now(UTC).isoformat()
    return {'format': 'spicygov-archive-mirror', 'version': 1, 'preparedAt': stamp, 'archiveBase': ARCHIVE_BASE,
            'catalog': {'generation': current['generation'], 'manifestSha256': digest(manifest_bytes)},
            'inventory': {'generation': report['generation'], 'recordedAt': report['completedAt'],
                          'evidenceSha256': digest(report_bytes),
                          'rawSnapshotSha256': 'sha256:' + pins['raw_snapshot_sha256'],
                          'acquisitionReceiptSetSha256': 'sha256:' + pins['raw_acquisition_receipt_set_sha256'],
                          'objects': report['objects']['both'], 'receipts': report['receipts']['both'], 'controls': controls},
            'publicChecks': {'checkedAt': stamp, 'scope': 'sample', 'files': checks}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('inventory', 'cache', 'catalog', 'raw-root', 'output'):
        parser.add_argument('--'+name, type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.resolve().is_relative_to(args.raw_root.resolve())
            and not args.output.resolve().is_relative_to(args.catalog.resolve()), 'Mirror evidence must stay outside archive/catalog')
    value = prepare(args.inventory, args.cache, args.catalog, args.raw_root)
    temporary = args.output.with_name(args.output.name+'.tmp')
    with temporary.open('x') as stream:
        json.dump(value, stream, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, args.output)
    print(json.dumps({'generation': value['catalog']['generation'], 'inventory': value['inventory']['recordedAt'],
                      'publicHeadChecks': len(value['publicChecks']['files']), 'sourceBodiesOpened': 0}))


if __name__ == '__main__':
    main()
