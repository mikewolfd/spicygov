"""Follow published table inputs before counting their retained FEC collections."""
import concurrent.futures
import hashlib
import json
import re
import subprocess
import sys
import time

import duckdb

BASE = 'https://data.spicygov.ai'
POLICY = 1


def fetch(key):
    if not re.fullmatch(r'[a-zA-Z0-9_./=-]+', key) or any(p in ('', '.', '..') for p in key.split('/')):
        raise ValueError('Invalid evidence path')
    return subprocess.check_output(['curl', '-fsSL', '--max-time', '30', BASE + '/' + key])


def identity(members):
    return sorted((m['key'], m['sha256'], m['rows'], m['byteSize']) for m in members)


class Inputs:
    def __init__(self):
        self.cache = {}
        self.deadline = time.monotonic() + 240

    def fetch(self, key):
        if time.monotonic() >= self.deadline:
            raise ValueError('Input lookup exceeded the scan budget')
        return fetch(key)

    def artifact(self, family, digest):
        if not re.fullmatch(r'[a-z0-9-]+', family) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise ValueError('Invalid generation identity')
        key = f'generations/{family}/{digest[7:]}'
        if key not in self.cache:
            raw = json.loads(self.fetch(key + '/artifact.json'))
            if raw.get('artifactDigest') != digest or raw.get('spec', {}).get('family') != family:
                raise ValueError('Generation differs from its recorded identity')
            members = []
            for descriptor in raw['memberManifests']:
                data = self.fetch(key + '/' + descriptor['objectKey'])
                if 'sha256:' + hashlib.sha256(data).hexdigest() != descriptor['sha256']:
                    raise ValueError('Member manifest differs from its receipt')
                members.extend(json.loads(data)['members'])
            self.cache[key] = raw, members
        return key, *self.cache[key]

    def collections(self, family, digest, table_id, expected_members):
        visited = set()
        for _ in range(32):
            if digest in visited:
                raise ValueError('Repeated carried-forward generation')
            visited.add(digest)
            key, raw, members = self.artifact(family, digest)
            selected = [m for m in members if m.get('role') == 'table' and
                        (m['objectKey'] == table_id + '.parquet' or m['objectKey'].startswith(table_id + '/'))]
            actual = [{'key': m['objectKey'], 'sha256': m['sha256'], 'rows': m['recordCount'], 'byteSize': m['byteSize']} for m in selected]
            if identity(actual) != identity(expected_members):
                raise ValueError('Retained table files differ from this publication')
            carried = raw['spec'].get('carriedForward', {}).get(table_id + '.parquet')
            if carried:
                digest = carried
                continue
            pin = raw['spec']['parents']['fec_collections.parquet']
            snapshot = raw['spec']['readSnapshot']['families'][pin['family']]
            table = snapshot['tables']['fec_collections.parquet']
            if snapshot['artifactDigest'] != pin['artifactDigest'] or table['sha256'] != pin['sha256'] or table['byteSize'] != pin['byteSize']:
                raise ValueError('Collection input differs from the saved snapshot')
            parent_key, _, parent_members = self.artifact(pin['family'], pin['artifactDigest'])
            entry = next(m for m in parent_members if m['objectKey'] == 'fec_collections.parquet' and m.get('role') == 'table')
            if (entry['sha256'], entry['byteSize'], entry['recordCount']) != (pin['sha256'], pin['byteSize'], table['rows']):
                raise ValueError('Collection file differs from its member manifest')
            return {'url': BASE + '/' + parent_key + '/fec_collections.parquet', 'sha256': pin['sha256'],
                    'generation': pin['artifactDigest'], 'rows': table['rows'], 'owner': BASE + '/' + key + '/artifact.json'}
        raise ValueError('Retained input history exceeded the scan limit')


def summarize(groups, collections, expected_rows):
    if sum(n for _, _, n in groups) != expected_rows:
        raise ValueError('Data row count differs from publication')
    ids = [c[0] for c in collections]
    if len(ids) != len(set(ids)) or None in ids:
        raise ValueError('Collection identities are not unique')
    lookup = {c[0]: c[1:] for c in collections}
    used, missing, families, cycles = set(), set(), {}, {}
    matched_rows = unscoped_rows = 0
    for collection_id, cycle, rows in groups:
        if cycle is not None and re.fullmatch(r'[0-9]{4}', cycle) and cycle != '0000':
            cycles[cycle] = cycles.get(cycle, 0) + rows
        else:
            unscoped_rows += rows
        if collection_id not in lookup:
            missing.add(collection_id)
            continue
        used.add(collection_id)
        matched_rows += rows
        source, outcome = lookup[collection_id]
        source = source or 'unknown'
        family = families.setdefault(source, {'rows': 0, 'ids': set()})
        family['rows'] += rows
        family['ids'].add(collection_id)
    outcomes = {}
    for collection_id in used:
        outcome = lookup[collection_id][1] or 'unknown'
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    return {'matchedRows': matched_rows, 'unmatchedRows': expected_rows - matched_rows,
            'collections': len(used), 'unmatchedCollections': len(missing), 'outcomes': outcomes,
            'cycleRows': dict(sorted(cycles.items())), 'unscopedRows': unscoped_rows,
            'sources': {k: {'rows': v['rows'], 'collections': len(v['ids'])} for k, v in sorted(families.items())}}


def scan(request):
    con = duckdb.connect()
    try:
        con.execute('LOAD httpfs')
        con.execute("SET memory_limit='384MB'")
        con.execute('SET threads=2')
        con.execute('SET http_timeout=30')
        cycle = 'cast(source_cycle AS VARCHAR)' if request['hasCycle'] else 'NULL::VARCHAR'
        collection_id = 'collection_id'
        if request.get('hasGenerationPin'):
            collection_id = "CASE WHEN source_generation_pin = ? THEN collection_id END"
        args = ([request['input']['generation']] if request.get('hasGenerationPin') else []) + [request['urls']]
        groups = con.execute(f'SELECT {collection_id}, {cycle}, count(*) FROM read_parquet(?) GROUP BY 1,2', args).fetchall()
        if len(groups) > 20000:
            raise ValueError('Too many collection groups for this summary')
        collections = con.execute('SELECT collection_id, source_family, record_outcome FROM read_parquet(?)', [request['input']['url']]).fetchall()
        if len(collections) != request['input']['rows']:
            raise ValueError('Collection row count differs from its receipt')
        result = summarize(groups, collections, request['rows'])
        if request.get('queryResults'):
            queries = con.execute('SELECT outcome_status, profile_refusal, query_completeness, count(*) FROM read_parquet(?) GROUP BY 1,2,3', [request['urls']]).fetchall()
            if len(queries) > 100 or sum(n for _, _, _, n in queries) != request['rows']:
                raise ValueError('Query result summary does not reconcile')
            result['queryResults'] = [{'status': status or 'unknown', 'reason': reason or 'Reason not recorded', 'completeness': completeness or 'unknown', 'records': n} for status, reason, completeness, n in queries]
        return result
    finally:
        con.close()


def enrich(index, tables, result, previous):
    deadline = time.monotonic() + 360
    inputs = Inputs()
    jobs = []
    for family_id, family in index['families'].items():
        if family_id != 'fec-query':
            continue
        for file, table in family['tables'].items():
            id = file.removesuffix('.parquet')
            names = dict(table.get('columns', []))
            if 'collection_id' not in names or id == 'fec_record_evidence':
                continue  # Record evidence has its own per-witness generation pins.
            publication = BASE + '/' + family['prefix'] + '/artifact.json'
            old = previous.get(id, {}).get('collectionEvidence', {})
            if old.get('status') == 'matched' and (id != 'fec_research_response_outcomes' or 'queryResults' in old) and ('source_generation_pin' not in names or old.get('pinChecked')) and old.get('policy') == POLICY and old.get('publication') == publication and previous[id].get('fingerprint') == result[id]['fingerprint'] and previous[id].get('rows') == table['rows']:
                result[id]['collectionEvidence'] = old
                continue
            try:
                members = table.get('members') or [{'key': file, **table}]
                parent = inputs.collections(family_id, family['artifactDigest'], id, members)
                request = {'rows': table['rows'], 'hasCycle': 'source_cycle' in names, 'hasGenerationPin': 'source_generation_pin' in names, 'queryResults': id == 'fec_research_response_outcomes', 'input': parent,
                           'urls': [m['url'] for m in tables[id]['members']]}
                jobs.append((id, publication, request))
            except Exception as error:
                result[id]['collectionEvidence'] = {'policy': POLICY, 'publication': publication, 'status': 'unknown', 'reason': 'The retained collection input could not be matched.'}
                print(f'{id}: collection input unavailable: {str(error)[:120]}', flush=True)

    def measure(job):
        id, publication, request = job
        base = {'policy': POLICY, 'publication': publication}
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('Collection scan budget exhausted')
            child = subprocess.run([sys.executable, __file__], input=json.dumps(request), capture_output=True, text=True, timeout=min(120, remaining), check=True)
            return id, {**base, 'status': 'matched', 'pinChecked': request.get('hasGenerationPin', False), 'input': request['input'], **json.loads(child.stdout)}
        except Exception as error:
            print(f'{id}: collection scan unavailable: {str(error)[:100]}', flush=True)
            return id, {**base, 'status': 'unknown', 'reason': 'Collection links could not be counted.'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for id, summary in pool.map(measure, jobs):
            result[id]['collectionEvidence'] = summary
            print(f'{id}: collection links {summary["status"]}', flush=True)


if __name__ == '__main__':
    print(json.dumps(scan(json.load(sys.stdin))))
