"""Compare the selected local archive index to R2 keys/sizes; never read bodies."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


def compare(expected, observed, report):
    remaining, seen = dict(expected), set()
    counts = dict(both=0, localOnly=0, r2Only=0, sizeMismatch=0, duplicate=0)
    for key, size in observed:
        if key in seen:
            kind = 'duplicate'
        elif key not in remaining:
            kind = 'r2Only'
        elif remaining[key] != size:
            kind = 'sizeMismatch'
        else:
            kind = 'both'
        seen.add(key)
        wanted = remaining.pop(key, None)
        counts[kind] += 1
        if kind != 'both':
            report(dict(kind=kind, key=key, expectedBytes=wanted, r2Bytes=size))
    for key, size in remaining.items():
        counts['localOnly'] += 1
        report(dict(kind='localOnly', key=key, expectedBytes=size))
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('index', 'raw-root', 'env', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(exist_ok=False)
    from dotenv import dotenv_values
    import boto3
    from botocore.config import Config
    settings = dotenv_values(args.env)
    client = boto3.client('s3', endpoint_url=settings['R2_ENDPOINT'],
        aws_access_key_id=settings['R2_ACCESS_KEY_ID'], aws_secret_access_key=settings['R2_SECRET_ACCESS_KEY'],
        region_name='auto', config=Config(max_pool_connections=8, retries={'mode':'standard','max_attempts':5}))
    prefix = 'spicyregs/raw/'
    index = args.index.resolve()
    before = index.stat()
    identity = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    def connect():
        return sqlite3.connect(index.as_uri() + '?mode=ro', uri=True)
    with connect() as db:
        generation = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
        pins = {str(Path(path).relative_to(args.raw_root.resolve())): size for path, size in
                db.execute('SELECT path,bytes FROM inputs WHERE path LIKE ?', (str(args.raw_root.resolve())+'/%',))}
    def listed(relative, delimiter=None):
        options = dict(Bucket=settings['R2_BUCKET_NAME'], Prefix=prefix+relative)
        if delimiter:
            options['Delimiter'] = delimiter
        yield from client.get_paginator('list_objects_v2').paginate(**options)
    def objects(relative):
        for page in listed(relative):
            for item in page.get('Contents', []):
                yield item['Key'][len(prefix):], item['Size']
    def partition(part):
        with connect() as db:
            lower = 'sha256:' + part
            expected = dict(db.execute('SELECT object,stored_bytes FROM raw_objects WHERE present=1 AND sha256>=? AND sha256<?', (lower, lower+'g')))
        with (args.output / (part+'.jsonl')).open('w') as out:
            return compare(expected, objects('objects/sha256/'+part+'/'), lambda row: out.write(json.dumps(row)+'\n'))
    started = datetime.now(timezone.utc).isoformat()
    results = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(partition, f'{i:02x}'): f'{i:02x}' for i in range(256)}
        for future in as_completed(futures):
            row = dict(prefix=futures[future], **future.result());results.append(row)
            with (args.output/'prefixes.jsonl').open('a') as out:out.write(json.dumps(row)+'\n')
            if len(results) % 32 == 0:print(json.dumps(dict(prefixesComplete=len(results))), flush=True)
    with (args.output/'receipts.jsonl').open('w') as out:
        receipts = compare({key:size for key,size in pins.items() if key.startswith('acquisitions/')},
                           objects('acquisitions/'), lambda row: out.write(json.dumps(row)+'\n'))
    root_items = [(item['Key'][len(prefix):],item['Size']) for page in listed('', '/') for item in page.get('Contents', [])]
    with (args.output/'controls.jsonl').open('w') as out:
        controls = compare({key:size for key,size in pins.items() if not key.startswith('acquisitions/')},
                           root_items, lambda row: out.write(json.dumps(row)+'\n'))
    namespace = []
    for relative, allowed in (('', {'objects/', 'acquisitions/'}),
                              ('objects/', {'objects/sha256/'}),
                              ('objects/sha256/', {f'objects/sha256/{i:02x}/' for i in range(256)})):
        for page in listed(relative, '/'):
            namespace.extend(item['Prefix'][len(prefix):] for item in page.get('CommonPrefixes', [])
                             if item['Prefix'][len(prefix):] not in allowed)
            if relative:
                namespace.extend(item['Key'][len(prefix):] for item in page.get('Contents', []))
    if identity(index.stat()) != identity(before):raise ValueError('Selected local index changed during inventory comparison')
    report = dict(format='spicy-archive-inventory-parity', version=1, generation=generation,
        startedAt=started, completedAt=datetime.now(timezone.utc).isoformat(),
        objects={key:sum(row[key] for row in results) for key in ('both','localOnly','r2Only','sizeMismatch','duplicate')},
        receipts=receipts, controls=controls, unexpectedNamespaceKeys=sorted(namespace),
        scope='Selected indexed local originals and input pins versus R2 keys and stored sizes. Listings span the recorded interval; no object bodies or hashes were reread and no keys were modified.')
    (args.output/'summary.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':main()
