"""The coverage builder's inventory of the same logical tables shown by Sources.

Publication files determine membership. A failed publication lookup must fail the
build rather than silently produce a smaller, apparently complete inventory.
"""
import hashlib
import json
import re
import subprocess

BASE = 'https://data.spicygov.ai'


def fetch(key):
    path(key)
    return json.loads(subprocess.check_output(
        ['curl', '-fsSL', '--retry', '2', '--max-time', '60', BASE + '/' + key]))


def path(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9_./=-]+', value) or any(
            part in ('', '.', '..') for part in value.split('/')):
        raise ValueError('Invalid publication path')
    return value


def size(value):
    return type(value) is int and 0 <= value <= 2**53 - 1


def digest(value):
    return isinstance(value, str) and bool(re.fullmatch(r'(sha256:)?[a-f0-9]{64}', value))


def table_id(file):
    if not isinstance(file, str) or not re.fullmatch(r'[a-z0-9_]+\.parquet', file):
        raise ValueError('Invalid logical table name')
    return file.removesuffix('.parquet')


def schema(columns):
    if (not isinstance(columns, list) or not columns
            or any(not isinstance(pair, (list, tuple)) or len(pair) != 2
                   or not all(isinstance(v, str) and v for v in pair) for pair in columns)
            or len({pair[0] for pair in columns}) != len(columns)):
        raise ValueError('Invalid publication schema')
    return [list(pair) for pair in columns]


def fingerprint(members):
    # Match the site's timeFingerprint, including member order.
    return json.dumps([[m.get('sha256') or m['url'], m['rows'], m['byteSize']]
                       for m in members], separators=(',', ':'))


def inputs_fingerprint(table):
    """Bind every paired mutable export read to measure a logical table."""
    paired = [[entry['id'], entry['url'], entry['rows'], entry['byteSize'],
                        entry['sha256'], entry['etag']]
                       for entry in sorted(table.get('coverageInputs', []), key=lambda entry: entry['id'])]
    if table.get('rulemakingSnapshot'):
        return json.dumps({'members': paired, 'snapshot': table['rulemakingSnapshot']},
                          sort_keys=True, separators=(',', ':'))
    return json.dumps(paired, separators=(',', ':'))


def core_tables(index):
    if (not isinstance(index, dict) or index.get('format') != 'spicy-regs-publication'
            or index.get('version') != 2 or not isinstance(index.get('families'), dict)):
        raise ValueError('Unsupported main publication')
    result = {}
    for family_id, family in index['families'].items():
        if (not re.fullmatch(r'[a-z0-9-]+', family_id) or not isinstance(family, dict)
                or not isinstance(family.get('artifactDigest'), str)
                or not re.fullmatch(r'sha256:[a-f0-9]{64}', family['artifactDigest'])
                or not isinstance(family.get('tables'), dict)):
            raise ValueError('Invalid publication family')
        prefix = path(family['prefix'])
        if prefix != f"generations/{family_id}/{family['artifactDigest'][7:]}":
            raise ValueError('Family path differs from its generation')
        for file, table in family['tables'].items():
            id = table_id(file)
            if id in result or not isinstance(table, dict) or not size(table.get('rows')) or not size(table.get('byteSize')):
                raise ValueError('Duplicate table or invalid publication counts: ' + id)
            columns = schema(table.get('columns'))
            members = table.get('members')
            if members is None:
                members = [{'key': file, **table}]
            if not isinstance(members, list) or not members:
                raise ValueError('Missing publication members: ' + id)
            parsed, keys = [], set()
            for member in members:
                if (not isinstance(member, dict) or not size(member.get('rows'))
                        or not size(member.get('byteSize')) or not digest(member.get('sha256'))):
                    raise ValueError('Invalid publication member: ' + id)
                key = path(member['key'])
                if (key in keys or not (key == file or key.startswith(id + '/'))
                        or not key.endswith('.parquet')):
                    raise ValueError('Duplicate or unrelated publication member: ' + id)
                keys.add(key)
                parsed.append({**member, 'url': BASE + '/' + prefix + '/' + key})
            if sum(m['rows'] for m in parsed) != table['rows'] or sum(m['byteSize'] for m in parsed) != table['byteSize']:
                raise ValueError('Publication members do not reconcile: ' + id)
            result[id] = {**table, 'members': parsed, 'columns': columns, 'family': family_id,
                          'artifactDigest': family['artifactDigest'], 'publishedAt': family.get('publishedAt'),
                          'recordUrl': BASE + '/' + prefix + '/artifact.json', 'kind': 'generation'}
    return result


def rulemaking_tables(pointer, manifest):
    if (not isinstance(pointer, dict) or pointer.get('format_version') != 2 or pointer.get('dataset') != 'rulemaking'
            or not re.fullmatch(r'snapshot_[a-zA-Z0-9]+', pointer.get('snapshot_id', ''))):
        raise ValueError('Unsupported rulemaking pointer')
    prefix = 'materialized/rulemaking/snapshots/' + pointer['snapshot_id']
    if (pointer.get('manifest_key') != prefix + '/manifest.json' or not isinstance(manifest, dict)
            or manifest.get('format_version') != 2 or manifest.get('dataset') != 'rulemaking'
            or manifest.get('snapshot_id') != pointer['snapshot_id'] or not isinstance(manifest.get('artifacts'), dict)):
        raise ValueError('Rulemaking manifest differs from pointer')
    result = {}
    native = manifest.get('etlReceipts')
    if native is not None:
        receipt = manifest['artifacts'].get(native.get('key')) if isinstance(native, dict) else None
        if (not isinstance(native, dict) or native.get('key') != 'etl_receipts.parquet'
                or not isinstance(native.get('generationId'), str) or not native['generationId']
                or native['generationId'] != manifest.get('run_id')
                or not isinstance(native.get('policies'), list) or not native['policies']
                or any(not isinstance(policy, dict) for policy in native['policies'])
                or not isinstance(receipt, dict) or receipt.get('visibility') != 'internal'
                or receipt.get('remote_key') != prefix + '/etl_receipts.parquet'
                or not size(receipt.get('rows')) or not size(receipt.get('bytes'))
                or not digest(receipt.get('sha256'))):
            raise ValueError('Invalid selected rulemaking receipts')
        manifest_digest = 'sha256:' + hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    for file, entry in manifest['artifacts'].items():
        if not isinstance(entry, dict) or entry.get('visibility') != 'public':
            continue
        id = table_id(file)
        if (entry.get('remote_key') != prefix + '/' + file or not size(entry.get('rows'))
                or not size(entry.get('bytes')) or not digest(entry.get('sha256'))):
            raise ValueError('Invalid rulemaking artifact: ' + id)
        result[id] = {'family': 'rulemaking', 'kind': 'rulemaking', 'rows': entry['rows'],
                      'checksum': entry['sha256'], 'recordUrl': BASE + '/' + pointer['manifest_key'],
                      'publishedAt': manifest.get('asserted_at'), 'snapshotId': pointer['snapshot_id'],
                      'members': [{'url': BASE + '/' + entry['remote_key'], 'rows': entry['rows'], 'byteSize': entry['bytes']}]}
        if native is not None:
            def selected(name, item):
                return {'key': name, 'rows': item['rows'], 'byteSize': item['bytes'],
                        'sha256': 'sha256:' + item['sha256'].removeprefix('sha256:')}
            result[id]['rulemakingSnapshot'] = {
                'pointer': dict(pointer), 'manifestDefinitionDigest': manifest_digest,
                'generationId': native['generationId'], 'subjects': [selected(file, entry)],
                'receipts': selected(native['key'], receipt),
            }
    return result


def comments_tables(receipt):
    if (not isinstance(receipt, dict) or receipt.get('format_version') != 1
            or not isinstance(receipt.get('files'), dict) or not isinstance(receipt.get('source'), dict)):
        raise ValueError('Unsupported comments publication')
    result = {}
    # Agency partitions duplicate the logical comments table.
    for file in ('comments.parquet', 'comments_index.parquet'):
        if file not in receipt['files']:
            continue
        entry = receipt['files'][file]
        id = table_id(file)
        if (not isinstance(entry, dict) or not size(entry.get('rows')) or not size(entry.get('bytes'))
                or not digest(entry.get('sha256')) or not isinstance(entry.get('etag'), str) or not entry['etag']):
            raise ValueError('Invalid comments file: ' + id)
        result[id] = {'family': 'comments', 'kind': 'comments', 'rows': entry['rows'],
                      'checksum': entry['sha256'], 'etag': entry['etag'], 'recordUrl': BASE + '/comments-publication.json',
                      'members': [{'url': BASE + '/' + file, 'rows': entry['rows'], 'byteSize': entry['bytes']}]}
    if 'comments' in result and 'comments_index' in result:
        result['comments'].update(columns=[['posted_date', 'VARCHAR']], dateIndex=BASE + '/comments_index.parquet',
                                  dateIndexETag=result['comments_index']['etag'])
    paired = [{'id': id, 'url': table['members'][0]['url'], 'rows': table['rows'],
               'byteSize': table['members'][0]['byteSize'], 'sha256': table['checksum'],
               'etag': table['etag']} for id, table in sorted(result.items())]
    for table in result.values(): table['coverageInputs'] = paired
    return result


def census(index, pointer, manifest, comments):
    result = core_tables(index)
    # Sources gives the main publication precedence when a supplementary table migrates.
    for other in (rulemaking_tables(pointer, manifest), comments_tables(comments)):
        for id, table in other.items():
            result.setdefault(id, table)
    return result


def load(fetcher=fetch):
    index = fetcher('publication.v2.json')
    pointer = fetcher('materialized/rulemaking/latest.json')
    # Validate before using an externally supplied path.
    if not isinstance(pointer, dict) or not re.fullmatch(r'snapshot_[a-zA-Z0-9]+', pointer.get('snapshot_id', '')):
        raise ValueError('Invalid rulemaking pointer')
    expected_key = f"materialized/rulemaking/snapshots/{pointer['snapshot_id']}/manifest.json"
    if pointer.get('manifest_key') != expected_key:
        raise ValueError('Invalid rulemaking manifest path')
    manifest = fetcher(expected_key)
    comments = fetcher('comments-publication.json')
    return index, census(index, pointer, manifest, comments)


def census_digest(tables):
    return 'sha256:' + hashlib.sha256(json.dumps({id: {
        'family': t['family'], 'fingerprint': fingerprint(t['members']), 'rows': t['rows'],
        'schema': t.get('columns'), 'publicationSha256': t.get('checksum'),
        'artifactDigest': t.get('artifactDigest'),
        'publishedAt': t.get('publishedAt'), 'inputsFingerprint': inputs_fingerprint(t),
    } for id, t in sorted(tables.items())}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
