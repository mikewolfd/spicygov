"""Read the bounded native government receipt format for coverage only.

This reader follows spicy_regs.etl_receipts' canonical typed JSON, content
hashes and one-to-one subject admission rules. It supports the explicitly
reviewed government-sources policies below, not arbitrary processing formats.
All files come from the subject's producing generation. Receipt dates and
origins remain evidence about saved rows, not a publisher completeness claim.
"""
import base64
import datetime
import hashlib
import json
import math
import re
import sqlite3
import tempfile
import zlib
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from publication_census import BASE
from gao_receipt_policy import is_gao_report_v2, validate_gao_report_v2_schema

POLICIES = {'usaspending_recipients': ('government-sources/1', ['recipient_id']),
            'gao_reports': ('government-sources/1', ['report_id']),
            'gao_decisions': ('government-sources/2', ['decision_number', 'url'])}
WITNESS = pa.struct([(key, pa.string()) for key in
                    ('source_id', 'source_uri', 'sha256', 'locator', 'body_version')])
RECEIPT_SCHEMA = pa.schema([(key, pa.string()) for key in
    ('receipt_id', 'dataset', 'policy_version', 'generation_id', 'record_id',
     'subject_version', 'identity_json', 'attempt_id', 'outcome', 'processor')]
    + [('witnesses', pa.list_(WITNESS)), ('processing_json', pa.string()), ('diagnostic_json', pa.string())])


def pack(value):
    if value is None: return ['null', None]
    if type(value) in (bool, int, str): return [type(value).__name__, value]
    if isinstance(value, Decimal): return ['decimal', str(value)]
    if isinstance(value, datetime.datetime): return ['datetime', value.isoformat()]
    if isinstance(value, datetime.date): return ['date', value.isoformat()]
    if isinstance(value, bytes): return ['bytes', base64.b64encode(value).decode()]
    if isinstance(value, float) and math.isfinite(value): return ['float', value.hex()]
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return ['dict', [[k, pack(v)] for k, v in sorted(value.items())]]
    if isinstance(value, (list, tuple)): return ['list', [pack(v) for v in value]]
    raise ValueError('Unsupported canonical receipt value')


def exact(value):
    return json.dumps(pack(value), ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def unpack(value):
    if not isinstance(value, list) or len(value) != 2: raise ValueError('Malformed typed receipt JSON')
    tag, body = value
    if tag == 'null' and body is None: return None
    if tag in ('bool', 'int', 'str') and type(body).__name__ == tag: return body
    if tag == 'dict' and isinstance(body, list):
        if any(not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str) for pair in body):
            raise ValueError('Malformed receipt dictionary')
        return {k: unpack(v) for k, v in body}
    if tag == 'list' and isinstance(body, list): return [unpack(v) for v in body]
    converters = {'decimal': Decimal, 'datetime': datetime.datetime.fromisoformat,
                  'date': datetime.date.fromisoformat, 'bytes': lambda s: base64.b64decode(s, validate=True),
                  'float': float.fromhex}
    if tag in converters and isinstance(body, str): return converters[tag](body)
    raise ValueError('Unsupported typed receipt JSON')


def decode(value):
    try: result = unpack(json.loads(value))
    except (ValueError, TypeError, KeyError) as exc: raise ValueError('Malformed canonical receipt JSON') from exc
    if exact(result) != value: raise ValueError('Noncanonical receipt JSON')
    return result


def content_hash(value):
    return 'sha256:' + hashlib.sha256(exact(value).encode()).hexdigest()


def policy_schema(descriptor):
    required = {'dataset', 'policy_version', 'subject_schema', 'identity_fields',
                'receipt_fields', 'receipt_only', 'nullable_identity_fields'}
    if not isinstance(descriptor, dict) or set(descriptor) != required:
        raise ValueError('Unsupported native receipt policy descriptor')
    expected = POLICIES.get(descriptor['dataset'])
    gao_v2 = is_gao_report_v2(descriptor)
    if (not expected or (not gao_v2 and (descriptor['policy_version'], descriptor['identity_fields']) != expected)
            or descriptor['receipt_fields'] != ['raw_record'] or descriptor['receipt_only'] is not False
            or descriptor['nullable_identity_fields'] != []):
        raise ValueError('Unsupported government receipt policy')
    try: schema = pa.ipc.read_schema(pa.BufferReader(base64.b64decode(descriptor['subject_schema'], validate=True)))
    except (ValueError, TypeError, pa.ArrowException) as exc: raise ValueError('Invalid native subject schema') from exc
    if not set(expected[1]) <= set(schema.names) or len(schema.names) != len(set(schema.names)):
        raise ValueError('Native subject schema has invalid identity fields')
    if gao_v2: validate_gao_report_v2_schema(schema)
    return schema


def parquet_rows(file):
    # ParquetFile avoids inferred Hive columns and preserves native values.
    with pq.ParquetFile(file) as parquet:
        for batch in parquet.iter_batches(batch_size=2000): yield from batch.to_pylist()


def subject_keys(dataset, row):
    identity = [[name, row[name]] for name in POLICIES[dataset][1]]
    if any(value is None for _, value in identity): raise ValueError('Null native subject identity')
    return content_hash([dataset, identity]), content_hash([dataset, row]), exact(identity)


def validate_context(row, generation, descriptors):
    dataset = row['dataset']
    if dataset not in descriptors or row['policy_version'] != descriptors[dataset]['policy_version']:
        raise ValueError('Receipt dataset or policy differs from recorded descriptor')
    if row['generation_id'] != generation: raise ValueError('Receipt generation differs from selected release')
    if any(not isinstance(row[k], str) or not row[k] for k in ('attempt_id', 'processor', 'generation_id')):
        raise ValueError('Receipt processing identity is incomplete')
    if row['receipt_id'] != content_hash({k: v for k, v in row.items() if k != 'receipt_id'}):
        raise ValueError('Receipt digest differs from its contents')
    witnesses = row['witnesses']
    if not isinstance(witnesses, list) or not witnesses: raise ValueError('Receipt has no input witness')
    for witness in witnesses:
        if (not isinstance(witness, dict) or set(witness) != {f.name for f in WITNESS}
                or any(value is not None and not isinstance(value, str) for value in witness.values())
                or not witness['source_id'] or not (witness['sha256'] or witness['body_version'])
                or witness['sha256'] is not None and not re.fullmatch(r'(?:sha256:)?[a-f0-9]{64}', witness['sha256'])):
            raise ValueError('Invalid receipt input witness')
    diagnostic = decode(row['diagnostic_json'])
    if not isinstance(diagnostic, dict): raise ValueError('Receipt diagnostics are not an object')
    processing = decode(row['processing_json'])
    if not isinstance(processing, dict): raise ValueError('Receipt processing is not an object')
    outcome = row['outcome']; accepted = outcome == 'accepted'
    if outcome not in ('accepted', 'rejected', 'refused', 'error', 'observed'):
        raise ValueError('Unknown receipt outcome')
    if accepted != (row['subject_version'] is not None) or accepted and not (row['record_id'] and row['identity_json']):
        raise ValueError('Receipt outcome and subject identity disagree')
    allowed = {'raw_record'} if outcome in ('accepted', 'observed') else set(policy_schema(descriptors[dataset]).names) | {'raw_record'}
    if set(processing) - allowed: raise ValueError('Unclassified receipt processing fields')
    if accepted and (set(processing) != {'raw_record'} or not isinstance(processing['raw_record'], dict)):
        raise ValueError('Accepted government receipt lacks its original row')
    return processing


@contextmanager
def qualified_records(subject, receipts, dataset, descriptors, generation, expected_rows, expected_receipts):
    """Complete schema/digest/one-to-one admission before yielding selected rows."""
    if dataset not in descriptors or not isinstance(generation, str) or not generation:
        raise ValueError('Missing selected native receipt policy or generation')
    schemas = {key: policy_schema(value) for key, value in descriptors.items()}
    if any(key != value['dataset'] for key, value in descriptors.items()): raise ValueError('Receipt descriptor dataset differs')
    with pq.ParquetFile(subject) as file:
        # Match the maintained shared reader: Parquet normalizes list-child
        # names from Arrow 'item' to 'element'; value types/fields stay exact.
        if not file.schema_arrow.equals(schemas[dataset]) or file.metadata.num_rows != expected_rows:
            raise ValueError('Native subject schema/count differs from selected policy')
    with pq.ParquetFile(receipts) as file:
        if not file.schema_arrow.equals(RECEIPT_SCHEMA) or file.metadata.num_rows != expected_receipts:
            raise ValueError('Native receipt schema/count differs from selected publication')
    with tempfile.TemporaryDirectory(prefix='coverage-native-joins-') as directory, sqlite3.connect(str(Path(directory) / 'joins.db')) as conn:
        conn.execute('CREATE TABLE receipts(dataset TEXT,record_id TEXT,version TEXT,identity_json TEXT,receipt_id TEXT UNIQUE,outcome TEXT,processing BLOB,witnesses TEXT,used INTEGER DEFAULT 0)')
        conn.execute("CREATE UNIQUE INDEX accepted_identity ON receipts(dataset,record_id) WHERE outcome='accepted'")
        for row in parquet_rows(receipts):
            validate_context(row, generation, descriptors)
            try:
                conn.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,0)',
                    [row[k] for k in ('dataset', 'record_id', 'subject_version', 'identity_json', 'receipt_id', 'outcome')]
                    + [zlib.compress(row['processing_json'].encode(), level=1), json.dumps(row['witnesses'])])
            except sqlite3.IntegrityError as exc: raise ValueError('Duplicate or ambiguous native receipt') from exc
        count = 0
        for row in parquet_rows(subject):
            count += 1; record, version, identity = subject_keys(dataset, row)
            found = conn.execute("SELECT receipt_id,used FROM receipts WHERE dataset=? AND record_id=? AND version=? AND identity_json=? AND outcome='accepted'", [dataset, record, version, identity]).fetchone()
            if found is None or found[1]: raise ValueError('Missing, mismatched or reused exact subject receipt')
            conn.execute('UPDATE receipts SET used=1 WHERE receipt_id=?', [found[0]])
        if count != expected_rows: raise ValueError('Native root rows do not reconcile')
        if conn.execute("SELECT 1 FROM receipts WHERE dataset=? AND outcome='accepted' AND used=0", [dataset]).fetchone():
            raise ValueError('Accepted receipt has no matching native subject')
        def admitted():
            for row in parquet_rows(subject):
                record, version, identity = subject_keys(dataset, row)
                body, witnesses = conn.execute("SELECT processing,witnesses FROM receipts WHERE dataset=? AND record_id=? AND version=? AND identity_json=? AND outcome='accepted' AND used=1", [dataset, record, version, identity]).fetchone()
                raw = decode(zlib.decompress(body).decode())['raw_record']
                if any(raw.get(key) != row[key] for key in POLICIES[dataset][1]):
                    raise ValueError('Original row identity differs from its exact subject')
                yield row, raw, json.loads(witnesses)
        yield admitted()


def fetch_member(inputs, key, member, directory):
    if (member.get('role') != 'table' or not isinstance(member.get('recordCount'), int)
            or isinstance(member['recordCount'], bool) or not 0 <= member['recordCount'] <= 500000
            or not isinstance(member.get('byteSize'), int) or isinstance(member['byteSize'], bool)
            or not 0 <= member['byteSize'] <= 128 * 2**20):
        raise ValueError('Unbounded or invalid native coverage member')
    data = inputs.fetch(key + '/' + member['objectKey'])
    if (not isinstance(data, bytes) or len(data) != member['byteSize']
            or 'sha256:' + hashlib.sha256(data).hexdigest() != member.get('sha256')):
        raise ValueError('Native coverage member bytes differ from its SHA receipt')
    file = Path(directory) / member['objectKey']; file.write_bytes(data)
    return file


@contextmanager
def selected_records(table_id, table, inputs):
    if table_id not in POLICIES: raise ValueError('Unreviewed native receipt dataset')
    owner = inputs.producing(table_id, table)
    key, artifact, members = inputs.artifact(owner['family'], owner['artifactDigest'])
    if artifact != owner['artifact']: raise ValueError('Native producing artifact differs')
    spec = artifact['spec'].get('etlReceipts', {})
    if spec.get('key') != 'etl_receipts.parquet' or not isinstance(spec.get('policies'), list):
        raise ValueError('Producing release has no supported native receipts')
    descriptors = {d['dataset']: d for d in spec['policies']}
    if len(descriptors) != len(spec['policies']): raise ValueError('Duplicate native receipt policies')
    subject = [m for m in members if m['objectKey'] == table_id + '.parquet' and m.get('role') == 'table']
    receipts = [m for m in members if m['objectKey'] == spec['key'] and m.get('role') == 'table']
    if len(subject) != 1 or len(receipts) != 1 or spec.get('rows') != receipts[0]['recordCount']:
        raise ValueError('Native receipt or subject member is missing/ambiguous')
    actual = subject[0]
    if owner['members'] != [{'key': actual['objectKey'], 'sha256': actual['sha256'],
                            'rows': actual['recordCount'], 'byteSize': actual['byteSize']}]:
        raise ValueError('Native subject differs from its producing file identity')
    with tempfile.TemporaryDirectory(prefix='coverage-native-files-') as directory:
        subject_path = fetch_member(inputs, key, subject[0], directory)
        receipt_path = fetch_member(inputs, key, receipts[0], directory)
        evidence = {'recordUrl': BASE + '/' + key + '/artifact.json', 'artifactDigest': owner['artifactDigest'],
                    'generationId': spec.get('generationId'), 'dataset': table_id,
                    'identityFields': POLICIES.get(table_id, (None, []))[1],
                    'subject': subject[0], 'receipts': receipts[0], 'matchedRows': table['rows'],
                    'qualification': 'Canonical shared receipts matched one-to-one by natural identity and exact subject version.'}
        with qualified_records(subject_path, receipt_path, table_id, descriptors, spec.get('generationId'), table['rows'], receipts[0]['recordCount']) as records:
            yield records, evidence
