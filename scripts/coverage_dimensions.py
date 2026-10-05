"""Count reviewed coverage dimensions without guessing a table's date field.

Definitions name source fields and their meaning. Every scalar dimension
reconciles placed and unplaced rows; list and span dimensions count a row once
per bucket and explicitly report that their bucket counts can overlap.
"""
import datetime
import email.utils
import hashlib
import json
import re

import publication_census
from publication_census import fingerprint


def definition_digest(definition):
    return 'sha256:' + hashlib.sha256(json.dumps(definition, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()


def quote(field):
    if not isinstance(field, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', field):
        raise ValueError('Invalid coverage field')
    return '"' + field + '"'


def validate_generic_options(dim):
    """Refuse unsupported options rather than silently changing source meaning."""
    if not isinstance(dim, dict): raise ValueError('Invalid coverage dimension')
    if dim.get('special') or dim.get('method'):
        # Specialized readers validate their own source-specific options.
        return
    kind = dim.get('kind')
    if kind == 'inherited':
        nested = dim.get('dimension')
        if not isinstance(nested, dict) or nested.get('kind') == 'inherited':
            raise ValueError('Inherited coverage requires one actual parent dimension')
        validate_generic_options(nested)
        return
    supported = {
        'snapshot': (None,),
        'category': (None, 'literal', 'agenda', 'positive-integer'),
        'date': (None, 'iso', 'rfc2822', 'year-month'),
        'interval': (None, 'date', 'iso', 'year'),
        'year': (None, 'year'),
        'list': ('date', 'year', 'literal'),
    }
    if kind not in supported or dim.get('syntax') not in supported[kind]:
        raise ValueError('Unsupported dimension syntax: ' + str(dim.get('id', kind)))
    boundary = dim.get('endBoundary')
    if boundary is not None and (kind != 'interval' or boundary not in ('inclusive', 'exclusive')):
        raise ValueError('Unsupported interval endBoundary: ' + str(dim.get('id', kind)))
    if kind == 'interval' and dim.get('syntax') == 'year' and boundary == 'exclusive':
        raise ValueError('Year intervals require inclusive source endpoints')


def validate_definition(definition, columns):
    names = {c[0] for c in columns}
    if not isinstance(definition, dict) or not isinstance(definition.get('dimensions'), list) or not definition['dimensions']:
        raise ValueError('Every table requires an explicit coverage definition')
    ids = set()
    for dim in definition['dimensions']:
        if (not isinstance(dim, dict) or not isinstance(dim.get('id'), str) or dim['id'] in ids
                or not all(isinstance(dim.get(k), str) and dim[k].strip() for k in ('label', 'meaning'))
                or dim.get('kind') not in ('date', 'year', 'category', 'interval', 'list', 'snapshot', 'inherited')):
            raise ValueError('Invalid or duplicate coverage dimension')
        ids.add(dim['id'])
        validate_generic_options(dim)
        fields = dim.get('fields', [])
        if not isinstance(fields, list) or len(fields) != len(set(fields)):
            raise ValueError('Invalid coverage fields')
        if dim['kind'] == 'inherited':
            # The inherited scanner validates the exact retained parent schema.
            if not isinstance(dim.get('parent'), dict): raise ValueError('Missing coverage parent')
            continue
        if any(quote(f) is None or f not in names for f in fields):
            raise ValueError('Coverage field is not published: ' + dim['id'])
        if dim['kind'] in ('date', 'year', 'list') and len(fields) != (2 if dim.get('syntax') == 'year-month' else 1):
            raise ValueError('Scalar/list dimension requires one field')
        if dim['kind'] == 'interval' and len(fields) != 2:
            raise ValueError('A span requires both source endpoints')
        if dim['kind'] == 'category' and not fields:
            raise ValueError('A category requires source fields')
        for field in ('precisionField', 'approximateField'):
            if dim.get(field) and dim[field] not in names: raise ValueError('Missing precision field')
        for condition in dim.get('conditions', []):
            if (not isinstance(condition, dict) or condition.get('field') not in names
                    or not isinstance(condition.get('values'), list)
                    or not all(isinstance(v, str) for v in condition['values'])):
                raise ValueError('Invalid coverage row condition')


def iso_expression(field):
    value = f'trim(cast({quote(field)} AS VARCHAR))'
    # Year/month-only source values cannot masquerade as exact dates.
    return f"CASE WHEN regexp_matches({value}, '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}($|[ T])') THEN try_cast({value} AS TIMESTAMP) END"


def scalar_expression(dim):
    fields, kind = dim['fields'], dim['kind']
    if kind == 'date':
        syntax = dim.get('syntax', 'iso')
        if syntax == 'iso': value = f"strftime({iso_expression(fields[0])}, '%Y-%m')"
        elif syntax == 'year-month':
            value = (f"CASE WHEN regexp_full_match(trim(cast({quote(fields[0])} AS VARCHAR)), '[0-9]+') "
                     f"AND regexp_full_match(trim(cast({quote(fields[1])} AS VARCHAR)), '[0-9]+') "
                     f"AND try_cast({quote(fields[1])} AS INTEGER) BETWEEN 1 AND 12 "
                     f"AND try_cast({quote(fields[0])} AS INTEGER) BETWEEN 1 AND 9999 "
                     f"THEN printf('%04d-%02d', try_cast({quote(fields[0])} AS INTEGER), try_cast({quote(fields[1])} AS INTEGER)) END")
        else: return None
    elif kind == 'year':
        raw = f'trim(cast({quote(fields[0])} AS VARCHAR))'
        value = f"CASE WHEN regexp_full_match({raw}, '[0-9]{{4}}') AND {raw} <> '0000' THEN {raw} END"
    elif kind == 'category':
        if dim.get('syntax') == 'agenda': return None
        values = [f'nullif(trim(cast({quote(f)} AS VARCHAR)), \'\')' for f in fields]
        checks = ' AND '.join(v + ' IS NOT NULL' for v in values)
        if dim.get('syntax') == 'positive-integer':
            checks += ' AND ' + ' AND '.join(f"regexp_full_match({v}, '[0-9]+') AND try_cast({v} AS BIGINT) > 0" for v in values)
        value = f"CASE WHEN {checks} THEN cast(to_json(list_value({','.join(values)})) AS VARCHAR) END"
    else: return None
    if dim.get('precisionField'):
        value = f"CASE WHEN {quote(dim['precisionField'])} = 'day' THEN ({value}) END"
    if dim.get('approximateField'):
        value = f"CASE WHEN lower(cast({quote(dim['approximateField'])} AS VARCHAR)) IN ('false','f','0') THEN ({value}) END"
    for condition in dim.get('conditions', []):
        literals = ','.join("'" + v.replace("'", "''") + "'" for v in condition['values'])
        value = f"CASE WHEN cast({quote(condition['field'])} AS VARCHAR) IN ({literals}) THEN ({value}) END"
    return value


def day(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value): return None
    try: return datetime.date.fromisoformat(value)
    except ValueError: return None


def iso_day(value):
    if not isinstance(value, str) or not re.match(r'^\d{4}-\d{2}-\d{2}($|[ T])', value): return None
    try:
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).date() if len(value) > 10 else day(value)
    except ValueError: return None


def eligibility(dim):
    parts = []
    if dim.get('precisionField'): parts.append(f"{quote(dim['precisionField'])} = 'day'")
    if dim.get('approximateField'): parts.append(f"lower(cast({quote(dim['approximateField'])} AS VARCHAR)) IN ('false','f','0')")
    for condition in dim.get('conditions', []):
        literals = ','.join("'" + v.replace("'", "''") + "'" for v in condition['values'])
        parts.append(f"cast({quote(condition['field'])} AS VARCHAR) IN ({literals})")
    return ' AND '.join(parts) or 'TRUE'


def parsed_values(dim, values):
    """Return bucket keys and whether a source value remains unresolved."""
    validate_generic_options(dim)
    kind = dim['kind']
    if kind == 'date' and dim.get('syntax') == 'rfc2822':
        value = values[0]
        if not isinstance(value, str) or not re.fullmatch(
                r'(?:[A-Za-z]{3},\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+(?:[+-]\d{4}|GMT|UTC)', value.strip()):
            return [], True
        try:
            stamp = email.utils.parsedate_to_datetime(value)
            return [stamp.strftime('%Y-%m')], False
        except (ValueError, TypeError): return [], True
    if kind == 'category' and dim.get('syntax') == 'agenda':
        value = values[0]
        if isinstance(value, str) and re.fullmatch(r'[0-9]{4}(04|10)', value) and value[:4] != '0000':
            return [value[:4] + ('-spring' if value[-2:] == '04' else '-fall')], False
        return [], True
    if kind == 'interval':
        if dim.get('syntax') == 'year':
            valid = all(isinstance(v, str) and re.fullmatch(r'\d{4}', v) and v != '0000' for v in values)
            start, end = (int(v) for v in values) if valid else (None, None)
            return ([f'{y:04d}' for y in range(start, end + 1)], False) if valid and 0 <= end - start <= 9999 else ([], True)
        start, end = (iso_day(v) for v in values)
        if start and end:
            try:
                first_time, last_time = (datetime.datetime.fromisoformat(v.replace('Z', '+00:00')) for v in values)
                if last_time < first_time or (dim.get('endBoundary') == 'exclusive' and last_time == first_time): return [], True
            except (TypeError, ValueError): return [], True
            if dim.get('endBoundary') == 'exclusive' and last_time.time() == datetime.time(): end -= datetime.timedelta(days=1)
        if not start or not end or end < start: return [], True
        first, last = start.year * 12 + start.month - 1, end.year * 12 + end.month - 1
        # Keep a malformed long span visible as unresolved rather than allocating unbounded cells.
        if last - first > 12000: return [], True
        return [f'{i // 12:04d}-{i % 12 + 1:02d}' for i in range(first, last + 1)], False
    if kind == 'list':
        try: source = json.loads(values[0]) if isinstance(values[0], str) else values[0]
        except (ValueError, TypeError): return [], True
        if not isinstance(source, list): return [], True
        buckets, invalid = set(), False
        for value in source:
            if dim.get('syntax') == 'year':
                text = str(value)
                bucket = text if re.fullmatch(r'\d{4}', text) and text != '0000' else None
            elif dim.get('syntax') == 'date':
                date = day(value)
                bucket = date.strftime('%Y-%m') if date else None
            else:
                bucket = json.dumps(value, sort_keys=True, separators=(',', ':')) if value is not None else None
            if bucket: buckets.add(bucket)
            else: invalid = True
        return sorted(buckets), invalid or not buckets
    raise ValueError('Unsupported dimension syntax: ' + dim['id'])


def scan_dimension(conn, urls, expected_rows, dim, *, weight=None, snapshot=None, source_view=None):
    validate_generic_options(dim)
    base = {k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields') if k in dim}
    base.update(status='measured', unit='rows', rows=expected_rows,
                definitionDigest=definition_digest(dim))
    source = quote(source_view) if source_view else 'read_parquet(?, hive_partitioning=false)'
    args = [] if source_view else [urls]
    if dim['kind'] == 'inherited': raise ValueError('Inherited dimensions require exact pinned inputs')
    if dim['kind'] == 'snapshot':
        total = conn.execute(f'SELECT count(*) FROM {source}', args).fetchone()[0]
        if total != expected_rows: raise ValueError('Snapshot row count differs from publication')
        return {**base, 'granularity': 'snapshot', 'snapshot': snapshot, 'placedRows': total, 'unplacedRows': 0, 'buckets': {}}
    expression = scalar_expression(dim)
    aggregate = f'sum({quote(weight)})' if weight else 'count(*)'
    if expression:
        groups = conn.execute(f'SELECT {expression}, {aggregate} FROM {source} GROUP BY 1', args).fetchall()
        buckets = {k: int(n) for k, n in groups if k is not None and (not k[:4] == '0000')}
        total = sum(int(n) for _, n in groups)
        placed = sum(buckets.values())
        partial = 0
    else:
        fields = dim['fields']
        selection = ','.join(f'cast({quote(f)} AS VARCHAR)' for f in fields)
        groups = conn.execute(f'SELECT {selection}, ({eligibility(dim)}) IS TRUE, {aggregate} FROM {source} GROUP BY ALL', args).fetchall()
        total, placed, partial, buckets, year_buckets = 0, 0, 0, {}, {}
        for *values, eligible, n in groups:
            total += int(n)
            keys, unresolved = parsed_values(dim, values) if eligible else ([], True)
            if keys: placed += int(n)
            if keys and unresolved: partial += int(n)
            for key in keys: buckets[key] = buckets.get(key, 0) + int(n)
            if dim['kind'] in ('interval', 'list') and dim.get('syntax') in ('date', 'iso', None):
                for year in {key[:4] for key in keys}:
                    year_buckets[year] = year_buckets.get(year, 0) + int(n)
    if total != expected_rows: raise ValueError('Dimension row count differs from publication: ' + dim['id'])
    if len(buckets) > 50000: raise ValueError('Dimension has too many distinct scopes: ' + dim['id'])
    granularity = ('month' if dim['kind'] == 'date' or (dim['kind'] in ('interval', 'list') and dim.get('syntax') != 'year' and dim.get('syntax') != 'literal')
                   else 'year' if dim['kind'] == 'year' or dim.get('syntax') == 'year'
                   else 'season' if dim.get('syntax') == 'agenda' else 'category')
    result = {**base, 'granularity': granularity, 'buckets': dict(sorted(buckets.items())),
              'placedRows': placed, 'unplacedRows': total - placed, 'partialRows': partial,
              'overlapping': dim['kind'] in ('interval', 'list')}
    if result['overlapping']: result['unit'] = 'rows per period'
    if result['overlapping'] and granularity == 'month': result['yearBuckets'] = dict(sorted(year_buckets.items()))
    if dim['kind'] == 'interval':
        result['notes'] = ['Counts show source-stated spans; they do not establish observations in every intervening month.']
    return result


def binding(table, definition):
    return {'fingerprint': fingerprint(table['members']), 'rows': table['rows'],
            'family': table['family'], 'artifactDigest': table.get('artifactDigest'),
            'publicationSha256': table.get('checksum'), 'schema': table.get('columns'),
            'publishedAt': table.get('publishedAt'),
            'inputsFingerprint': publication_census.inputs_fingerprint(table),
            'definitionDigest': definition_digest(definition)}
