"""Verify locally held Federal Register bytes and date observations offline."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import json

from spicy_regs.source_catalog.raw_archive import contained_file
from spicy_regs.source_catalog.raw_content import extract_metadata
from spicy_regs.source_catalog.storage import connect


def verify(index, raw):
    with connect(index, readonly=True) as db:
        generation = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
        rows = db.execute("""SELECT DISTINCT o.sha256,o.bytes,r.object,r.encoding,r.stored_bytes,r.stored_sha256
            FROM files f JOIN objects o ON o.sha256=f.sha256 JOIN raw_objects r ON r.sha256=f.sha256
            WHERE f.collection_id='family:federal-register' AND f.status='held'""").fetchall()

    def check(row):
        sha, size, reference, encoding, stored_size, stored_sha = row
        path = contained_file(raw, reference)
        with path.open('rb') as stream:
            if path.stat().st_size != stored_size or hashlib.file_digest(stream, 'sha256').hexdigest() != stored_sha.removeprefix('sha256:'):
                raise ValueError('Stored bytes differ: ' + sha)
        digest, count, body = hashlib.sha256(), 0, bytearray()
        with gzip.open(path, 'rb') if encoding == 'gzip' else path.open('rb') as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                count += len(chunk)
                if count > size:
                    raise ValueError('Original size differs: ' + sha)
                if size <= 4 * 1024**2:
                    body.extend(chunk)
        if count != size or 'sha256:' + digest.hexdigest() != sha:
            raise ValueError('Original bytes differ: ' + sha)
        content = extract_metadata('family:federal-register', bytes(body)) if size <= 4 * 1024**2 else {'outcome': 'not-read'}
        return sha, content['outcome'], [p['label'] for p in content.get('periods', []) if p['kind'] == 'publication-date']

    counts, dates, identities = Counter(), set(), hashlib.sha256()
    with ThreadPoolExecutor(max_workers=4) as pool:
        for sha, outcome, observed in pool.map(check, sorted(rows, key=lambda row: row[0])):
            identities.update((sha + '\n').encode())
            counts[outcome] += 1
            dates.update(observed)
    dates = sorted(date for date in dates if date >= '1994-01-01')
    if not rows:
        raise ValueError('No locally held Federal Register sources to verify')
    return {'generation': generation, 'checkedAt': datetime.now(timezone.utc).isoformat(),
            'verifiedObjects': len(rows), 'objectSetSha256': 'sha256:' + identities.hexdigest(),
            'dateOutcomes': dict(counts), 'months': sorted({date[:7] for date in dates}),
            'latestIndexedDate': dates[-1] if dates else None}


if __name__ == '__main__':
    from pathlib import Path
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--raw-root', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.index, args.raw_root)))
