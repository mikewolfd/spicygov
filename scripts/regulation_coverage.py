"""Reviewed regulatory coverage scans, with receipt-bound supplementary inputs.

Stored source dates, report periods and publication scopes stay separate. This
module never substitutes a latest parent for a missing retained input.
"""
import datetime
import hashlib
import json
import re
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path

from coverage_dimensions import definition_digest, scan_dimension, day
from publication_census import BASE, digest, path, size
from native_receipt_coverage import fetch_member, selected_records

ORIGIN_LABELS = {'gao_rss': 'GAO feed', 'upstream_copy': 'Upstream copy',
                 'gao_listing': 'GAO listings', 'gao_r_package': 'R package import',
                 'gao_repair': 'GAO repairs', 'govinfo': 'GovInfo archive'}


def source_instant(value):
    if not isinstance(value, str) or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)', value):
        raise ValueError('Source observation needs a complete offset-bearing timestamp')
    try: result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc: raise ValueError('Invalid source observation timestamp') from exc
    return result.astimezone(datetime.timezone.utc)


def native_receipt_scope(table_id, table, dim, inputs):
    marker = dim['special']
    if ((marker == 'government-receipt-observation-dates' and table_id != 'usaspending_recipients')
            or (marker == 'government-receipt-origins' and table_id not in ('gao_reports', 'gao_decisions'))):
        raise ValueError('Native receipt dimension is not reviewed for this table')
    expected_fields = ['recipient_id'] if table_id == 'usaspending_recipients' else ['report_id'] if table_id == 'gao_reports' else ['decision_number', 'url']
    expected_kind = 'date' if marker == 'government-receipt-observation-dates' else 'category'
    if dim['fields'] != expected_fields or dim['kind'] != expected_kind:
        raise ValueError('Native receipt axis has different kind or identity fields')
    buckets, years, origins = {}, {}, {}; total = placed = missing = 0
    publication = source_instant(table['publishedAt']) if marker == 'government-receipt-observation-dates' else None
    with selected_records(table_id, table, inputs) as (records, evidence):
        for row, raw, witnesses in records:
            total += 1
            if marker == 'government-receipt-observation-dates':
                observed, capture = raw.get('observed_at'), raw.get('source_capture_sha256')
                if observed is None and capture is None:
                    missing += 1; continue
                if not observed or not digest(capture): raise ValueError('Recipient observation date and capture witness disagree')
                if not any(w['source_id'] == 'usaspending:ranking-page' and w['sha256'] == capture for w in witnesses):
                    raise ValueError('Recipient observation lacks its ranking-page witness')
                stamp = source_instant(observed)
                if stamp > publication: raise ValueError('Recipient source observation is after publication')
                key = f'{stamp.year:04d}-{stamp.month:02d}'
                year = f'{stamp.year:04d}'; years[year] = years.get(year, 0) + 1
            else:
                origin = raw.get('source')
                if origin is None or origin == '':
                    missing += 1; continue
                if origin not in ORIGIN_LABELS: raise ValueError('Unreviewed saved report origin: ' + str(origin))
                origins[origin] = origins.get(origin, 0) + 1
                key = json.dumps([origin])
            placed += 1; buckets[key] = buckets.get(key, 0) + 1
    if total != table['rows'] or placed + missing != total: raise ValueError('Native coverage root counts do not reconcile')
    evidence['rawField'] = 'raw_record.observed_at' if publication else 'raw_record.source'
    if origins: evidence['recordedOrigins'] = origins
    result = {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')},
              'status': 'measured', 'rows': total, 'placedRows': placed, 'unplacedRows': missing,
              'buckets': dict(sorted(buckets.items())), 'overlapping': False,
              'granularity': 'month' if publication else 'category',
              'unit': 'recipients' if publication else 'report rows' if table_id == 'gao_reports' else 'decision rows',
              'definitionDigest': definition_digest(dim), 'evidence': evidence}
    if publication:
        result['yearBuckets'] = dict(sorted(years.items()))
        result['notes'] = ['Each saved amount keeps its last ranking-read date. These are not award dates or every earlier observation. Missing legacy dates remain unplaced.']
    else:
        result['notes'] = ['This origin can remain unchanged when later updates add fields from other sources. It does not identify every field’s source or a collection date.']
    return result


def readable_utc(stamp):
    return f'{stamp.strftime("%b")} {stamp.day}, {stamp.year} at {stamp:%H:%M} UTC'


def shift_months(stamp, months):
    # DuckDB's UTC calendar-month subtraction clamps the day at month end.
    import calendar
    year, month = divmod(stamp.year * 12 + stamp.month - 1 + months, 12)
    month += 1
    return stamp.replace(year=year, month=month, day=min(stamp.day, calendar.monthrange(year, month)[1]))


def discovery_snapshot(table, dim, inputs):
    if dim['kind'] != 'snapshot' or dim['fields']: raise ValueError('Discovery calculation facts require a snapshot axis')
    owner = inputs.producing('discovery_signals', table)
    key, artifact, members = inputs.artifact(owner['family'], owner['artifactDigest'])
    if (not isinstance(dim.get('reviewedImplementation'), str)
            or artifact.get('producer', {}).get('implementationId') != dim['reviewedImplementation']):
        raise ValueError('Discovery calculation implementation needs coverage review')
    selected = [m for m in members if m['objectKey'] == 'discovery_signals.parquet' and m.get('role') == 'table']
    if len(selected) != 1: raise ValueError('Discovery snapshot member is missing or ambiguous')
    with tempfile.TemporaryDirectory(prefix='coverage-discovery-facts-') as directory:
        file = fetch_member(inputs, key, selected[0], directory)
        import pyarrow.parquet as pq
        with pq.ParquetFile(file) as parquet:
            metadata = {k.decode(): v.decode() for k, v in (parquet.metadata.metadata or {}).items() if k.startswith(b'spicy_regs.')}
            if parquet.metadata.num_rows != table['rows']: raise ValueError('Discovery facts row count differs')
    prefix = 'spicy_regs.discovery_signals.'
    parent = artifact['spec'].get('parents', {}).get('documents.parquet', {})
    snapshot = artifact['spec'].get('readSnapshot', {}).get('families', {}).get(parent.get('family'), {})
    descriptor = snapshot.get('tables', {}).get('documents.parquet', {})
    if (metadata.get(prefix + 'timezone') != 'UTC'
            or metadata.get(prefix + 'date_policy') != 'source offsets preserved; offset-free values use UTC'
            or not digest(parent.get('sha256')) or metadata.get('spicy_regs.input.documents.sha256') != parent['sha256']
            or snapshot.get('artifactDigest') != parent.get('artifactDigest')
            or descriptor.get('sha256') != parent['sha256'] or descriptor.get('byteSize') != parent.get('byteSize')
            or metadata.get('spicy_regs.input.documents.rows') != str(descriptor.get('rows'))):
        raise ValueError('Discovery calculation metadata differs from exact source input')
    retained_parent = inputs.parent('discovery_signals', table,
                                    {'table': 'documents', 'mode': 'recorded-parent'})
    if retained_parent['rows'] != descriptor.get('rows'):
        raise ValueError('Discovery calculation source count differs from its retained input')
    # The native writer emits '+00'; qualify that explicitly before normalizing.
    raw_time = metadata.get(prefix + 'as_of')
    if isinstance(raw_time, str) and raw_time.endswith('+00'): raw_time += ':00'
    as_of = source_instant(raw_time)
    if as_of > source_instant(table['publishedAt']): raise ValueError('Discovery calculation is after publication')
    recent = as_of - datetime.timedelta(days=30)
    first, last = shift_months(as_of, -13), shift_months(as_of, -1)
    facts = [{'label': 'Recent posting window', 'value': f'{readable_utc(recent)} through {readable_utc(as_of)}; both endpoints included'},
             {'label': 'Comparison posting window', 'value': f'{readable_utc(first)} through {readable_utc(last)}; end excluded'},
             {'label': 'Comparison measure', 'value': 'Monthly average across the comparison window'},
             {'label': 'Included agencies', 'value': 'At least 24 comparison-window documents and at least twice the monthly average'}]
    return {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')},
            'status': 'measured', 'rows': table['rows'], 'placedRows': table['rows'], 'unplacedRows': 0,
            'granularity': 'snapshot', 'buckets': {}, 'overlapping': False, 'unit': 'agency rows',
            'definitionDigest': definition_digest(dim),
            'snapshot': {'publishedAt': table.get('publishedAt'), 'artifactDigest': owner['artifactDigest'],
                         'recordUrl': table['recordUrl'], 'asOf': as_of.isoformat(), 'facts': facts},
            'evidence': {'calculationMetadata': metadata, 'reviewedImplementation': dim['reviewedImplementation'],
                         'documentsInput': {k: retained_parent[k] for k in ('family', 'artifactDigest', 'tableId', 'recordUrl', 'members', 'rows')},
                         'windows': {'recentStartInclusive': recent.isoformat(), 'recentEndInclusive': as_of.isoformat(),
                                     'baselineStartInclusive': first.isoformat(), 'baselineEndExclusive': last.isoformat()}}}


def _receipt(inputs, key):
    path(key)
    data = inputs.fetch(key)
    return json.loads(data) if isinstance(data, (str, bytes)) else data


def export_header(url):
    """Read mutable export identity without treating an HTTP timestamp as data age."""
    if not re.fullmatch(re.escape(BASE) + r'/[a-z0-9_]+\.parquet', url):
        raise ValueError('Unrecognized mutable coverage export')
    raw = subprocess.check_output(['curl', '-fsSI', '--max-time', '30', url]).decode()
    headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip()
               for line in raw.splitlines() if ':' in line}
    return headers.get('etag'), int(headers.get('content-length', '-1'))


def _comments_binding(table, receipt, table_id):
    file = table_id + '.parquet'
    entry = receipt.get('files', {}).get(file)
    if (not isinstance(entry, dict) or not digest(entry.get('sha256')) or not size(entry.get('rows'))
            or not size(entry.get('bytes')) or not isinstance(entry.get('etag'), str)):
        raise ValueError('Incomplete paired comments publication')
    if (len(table['members']) != 1 or table['members'][0]['url'] != BASE + '/' + file
            or table['rows'] != entry['rows'] or table['members'][0]['byteSize'] != entry['bytes']
            or table.get('checksum') != entry['sha256'] or table.get('etag') != entry['etag']):
        raise ValueError('Comments file differs from its retained publication receipt')
    return entry


def _check_export(file, entry):
    if export_header(BASE + '/' + file) != (entry['etag'], entry['bytes']):
        raise ValueError('Comments export changed relative to its retained receipt')


def comments_index(conn, table_id, table, dim, inputs):
    receipt = _receipt(inputs, 'comments-publication.json')
    selected = _comments_binding(table, receipt, table_id)
    files = receipt['files']
    index = files.get('comments_index.parquet')
    comments = files.get('comments.parquet')
    if (not isinstance(index, dict) or not isinstance(comments, dict)
            or any(not digest(e.get('sha256')) or not size(e.get('rows')) or not size(e.get('bytes'))
                   or not isinstance(e.get('etag'), str) for e in (index, comments))):
        raise ValueError('Missing paired comments index evidence')
    # Both before and after: a scan racing replacement cannot silently succeed.
    for file, entry in [('comments.parquet', comments), ('comments_index.parquet', index)]:
        _check_export(file, entry)
    urls = [BASE + '/comments_index.parquet']
    group_rows, represented = conn.execute(
        'SELECT count(*), sum(row_count) FROM read_parquet(?, hive_partitioning=false)', [urls]).fetchone()
    if group_rows != index['rows'] or represented != comments['rows']:
        raise ValueError('Comment index groups or weights do not reconcile to the paired publication')
    invalid_weights = conn.execute('SELECT count(*) FROM read_parquet(?, hive_partitioning=false) WHERE row_count IS NULL OR row_count < 0', [urls]).fetchone()[0]
    if invalid_weights: raise ValueError('Invalid comment index weights')
    copied = {**dim, 'kind': 'date', 'syntax': 'year-month', 'fields': ['year', 'month']}
    if table_id == 'comments':
        result = scan_dimension(conn, urls, comments['rows'], copied, weight='row_count')
        result['fields'] = dim['fields']
        result['unit'] = 'comments'
    else:
        result = scan_dimension(conn, urls, index['rows'], copied)
        represented_map = scan_dimension(conn, urls, comments['rows'], copied, weight='row_count')
        result['representedComments'] = {'rows': comments['rows'], 'buckets': represented_map['buckets'],
                                        'placedRows': represented_map['placedRows'], 'unplacedRows': represented_map['unplacedRows']}
        result['unit'] = 'index groups'
    result['definitionDigest'] = definition_digest(dim)
    result['evidence'] = {'recordUrl': BASE + '/comments-publication.json',
                          'comments': comments, 'index': index, 'indexGroups': group_rows}
    for file, entry in [('comments.parquet', comments), ('comments_index.parquet', index)]:
        _check_export(file, entry)
    return result


def stage_events(conn, table, dim):
    """One proceeding per stored event month, including docket-less proceedings."""
    groups = conn.execute('SELECT stage_events_json, count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY 1',
                          [[m['url'] for m in table['members']]]).fetchall()
    total, placed, partial, buckets, sources, year_buckets = 0, 0, 0, {}, {}, {}
    for raw, n in groups:
        total += n
        try: events = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError): events = None
        if not isinstance(events, list):
            continue
        months, unresolved, source_names = set(), not events, set()
        for event in events:
            if not isinstance(event, dict):
                unresolved = True
                continue
            value = event.get('effective_date')
            stamp = day(value) if isinstance(value, str) else None
            if stamp: months.add(stamp.strftime('%Y-%m'))
            else: unresolved = True
            if isinstance(event.get('source'), str): source_names.add(event['source'])
        if months: placed += n
        if months and unresolved: partial += n
        for month in months: buckets[month] = buckets.get(month, 0) + n
        for year in {month[:4] for month in months}: year_buckets[year] = year_buckets.get(year, 0) + n
        for source in source_names: sources[source] = sources.get(source, 0) + n
    if total != table['rows']: raise ValueError('Proceeding event scan differs from publication')
    if len(buckets) > 50000: raise ValueError('Too many proceeding event months')
    return {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')},
            'status': 'measured', 'rows': total, 'placedRows': placed, 'unplacedRows': total - placed,
            'partialRows': partial, 'buckets': dict(sorted(buckets.items())), 'granularity': 'month',
            'overlapping': True, 'unit': 'proceedings per event month', 'definitionDigest': definition_digest(dim),
            'yearBuckets': dict(sorted(year_buckets.items())), 'evidence': {'datingSources': sources, 'field': 'stage_events_json.effective_date'},
            'notes': ['Events date source publication or upload. They do not establish legal effective dates or observations between events.']}


def activity_boundary(table):
    """Choose one explicit UTC month for classifying later-month activity."""
    publication = table.get('publishedAt')
    if publication is not None:
        try: stamp = source_instant(publication)
        except ValueError as error:
            raise ValueError('Recorded publication timestamp is invalid') from error
        return {'month': f'{stamp.year:04d}-{stamp.month:02d}', 'basis': 'publication-month'}
    if '_coverageAsOfMonth' in table:
        month = table['_coverageAsOfMonth']
        if (not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}-(?:0[1-9]|1[0-2])', month)
                or month.startswith('0000-')):
            raise ValueError('Coverage as-of month must be a valid YYYY-MM')
    else:
        stamp = datetime.datetime.now(datetime.timezone.utc)
        month = f'{stamp.year:04d}-{stamp.month:02d}'
    return {'month': month, 'basis': 'measurement-month'}


def flag_future(result, dim, table):
    """Place distant-future activity literals in a visible anomaly bin, not history."""
    if result.get('overlapping'):
        raise ValueError('Future activity filtering requires scalar row memberships; overlapping coverage must deduplicate retained rows')
    result['activityBoundary'] = activity_boundary(table)
    boundary = result['activityBoundary']['month']
    future = {key: n for key, n in result['buckets'].items() if key > boundary}
    if future:
        result['anomalies'] = {'futureActivityRows': sum(future.values()), 'futureActivityBuckets': future,
                               'boundaryMonth': boundary}
        result['buckets'] = {key: n for key, n in result['buckets'].items() if key not in future}
        if 'yearBuckets' in result:
            result['yearBuckets'] = {}
            for month, count in result['buckets'].items():
                year = month[:4]; result['yearBuckets'][year] = result['yearBuckets'].get(year, 0) + count
        result['placedRows'] -= sum(future.values())
        result['unplacedRows'] += sum(future.values())
        result['notes'] = ['Future activity literals remain in anomaly counts; they do not establish collected future activity.']
    return result


def source_date_literals(conn, table, dim):
    """Disclose unusually early/late source years without correcting schedules."""
    result = scan_dimension(conn, [m['url'] for m in table['members']], table['rows'], dim)
    first, last = dim.get('reviewYearBounds', [1900, 2100])
    questionable = {k: n for k, n in result['buckets'].items() if int(k[:4]) < first or int(k[:4]) > last}
    if questionable:
        result['anomalies'] = {'sourceLiteralReviewBuckets': questionable,
                               'sourceLiteralReviewRows': sum(questionable.values()),
                               'reviewYearBounds': [first, last]}
        result.setdefault('notes', []).append(
            f"{sum(questionable.values()):,} rows state dates outside {first}–{last}. "
            'These literal dates remain visible and need source review; they are not corrected or treated as completed events.')
    return result


def timetable_value(value):
    """Read native Reginfo dates, keeping day 00 at month precision."""
    match = re.fullmatch(r'(\d{1,2})/(\d{1,2})/(\d{4})', value.strip()) if isinstance(value, str) else None
    if not match: return None, 'undated'
    month, date, year = map(int, match.groups())
    try: stamp = datetime.date(year, month, date or 1)
    except ValueError: return None, 'invalid'
    return f'{stamp.year:04d}-{stamp.month:02d}', 'month' if date == 0 else 'day'


def timetable(conn, table, dim):
    """Count every stored milestone, distinct agenda rows per month and year."""
    groups = conn.execute('SELECT timetable_json, count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY 1',
                          [[m['url'] for m in table['members']]]).fetchall()
    total = placed = partial = review_rows = 0
    buckets, years, entry_counts, examples, review_buckets = {}, {}, {}, [], {}
    marker = dim['special']
    for raw, n in groups:
        total += n
        try: entries = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, ValueError): entries = None
        states, months, unresolved_labels = set(), set(), set()
        if not isinstance(entries, list):
            states.add('invalid timetable')
        elif not entries:
            states.add('empty timetable')
        else:
            for entry in entries:
                if not isinstance(entry, dict):
                    key, precision = None, 'invalid'
                    literal = {'value': entry, 'precision': precision}
                else:
                    key, precision = timetable_value(entry.get('date'))
                    literal = {f: entry.get(f) for f in ('action', 'date', 'fr_citation')} | {'precision': precision}
                states.add(precision)
                entry_counts[precision] = entry_counts.get(precision, 0) + n
                if key: months.add(key)
                else:
                    unresolved_labels.add(json.dumps(literal, sort_keys=True, separators=(',', ':')))
                    if len(examples) < 12 and literal not in examples: examples.append(literal)
        questionable = {m for m in months if not 1900 <= int(m[:4]) <= 2100}
        if questionable: review_rows += n
        for month in questionable: review_buckets[month] = review_buckets.get(month, 0) + n
        if marker == 'agenda-timetable-months':
            keys = months
            if months and (states & {'undated', 'invalid'}): partial += n
        elif marker == 'agenda-timetable-precision':
            keys = {json.dumps([state]) for state in states}
        elif marker == 'agenda-timetable-unresolved':
            keys = unresolved_labels
            if states == {'invalid timetable'}: keys = {json.dumps({'precision': 'invalid timetable', 'value': raw}, sort_keys=True)}
        else: raise ValueError('Unknown timetable coverage view')
        if keys: placed += n
        for key in keys: buckets[key] = buckets.get(key, 0) + n
        if marker == 'agenda-timetable-months':
            for year in {m[:4] for m in months}: years[year] = years.get(year, 0) + n
    if total != table['rows']: raise ValueError('Timetable rows differ from publication')
    result = {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')},
              'status': 'measured', 'rows': total, 'placedRows': placed, 'unplacedRows': total - placed,
              'partialRows': partial, 'overlapping': True, 'buckets': dict(sorted(buckets.items())),
              'granularity': 'month' if marker == 'agenda-timetable-months' else 'category',
              'unit': 'agenda rows per source month' if marker == 'agenda-timetable-months' else 'agenda rows per source scope',
              'definitionDigest': definition_digest(dim),
              'evidence': {'milestoneEntriesByPrecision': entry_counts, 'unresolvedExamples': examples},
              'notes': [f"Milestone entries: {entry_counts.get('day', 0):,} dated to a day; "
                        f"{entry_counts.get('month', 0):,} dated to a month; "
                        f"{entry_counts.get('undated', 0):,} undated; {entry_counts.get('invalid', 0):,} invalid.",
                        'Source dates can describe past actions or future plans. Month-only dates do not acquire a day, and no action is selected as upcoming.']}
    if marker == 'agenda-timetable-months': result['yearBuckets'] = dict(sorted(years.items()))
    if review_rows:
        result['anomalies'] = {'sourceLiteralReviewRows': review_rows, 'sourceLiteralReviewBuckets': review_buckets}
        result['notes'].append(f'{review_rows:,} agenda rows include milestone years outside 1900–2100. They remain literal source statements and need source review.')
    return result


@contextmanager
def snapshot_parent(table_id, table, parent_id, inputs):
    """Read a same-snapshot supplementary parent after exact file SHA verification.

    The manifest must name the child's exact files as well as the parent's. This
    is for bounded materialized inputs, not a latest-publication lookup.
    """
    if any(not isinstance(value, str) or not re.fullmatch(r'[a-z][a-z0-9_]*', value) for value in (table_id, parent_id)):
        raise ValueError('Invalid supplementary coverage table')
    record = table.get('recordUrl', '')
    match = re.fullmatch(re.escape(BASE) + r'/(materialized/rulemaking/snapshots/(snapshot_[a-zA-Z0-9]+)/manifest\.json)', record)
    if not match or table.get('snapshotId') != match[2]: raise ValueError('Missing exact rulemaking snapshot binding')
    manifest = _receipt(inputs, match[1])
    if (manifest.get('snapshot_id') != match[2] or manifest.get('dataset') != 'rulemaking'
            or manifest.get('format_version') != 2):
        raise ValueError('Rulemaking snapshot identity differs')
    entries = manifest.get('artifacts', {})
    child = entries.get(table_id + '.parquet', {})
    prefix = match[1].rsplit('/', 1)[0] + '/'
    if (child.get('sha256') != table.get('checksum') or child.get('rows') != table['rows']
            or len(table['members']) != 1 or child.get('bytes') != table['members'][0]['byteSize']
            or BASE + '/' + str(child.get('remote_key')) != table['members'][0]['url']):
        raise ValueError('Rulemaking child differs from manifest')
    parent = entries.get(parent_id + '.parquet', {})
    key = prefix + parent_id + '.parquet'
    if (parent.get('remote_key') != key or parent.get('visibility') != 'public'
            or not digest(parent.get('sha256')) or not size(parent.get('rows'))
            or not size(parent.get('bytes')) or parent['bytes'] > 64 * 2**20):
        raise ValueError('Invalid or oversized exact rulemaking parent')
    data = inputs.fetch(key)
    if (not isinstance(data, bytes) or len(data) != parent['bytes']
            or hashlib.sha256(data).hexdigest() != parent['sha256'].removeprefix('sha256:')):
        raise ValueError('Rulemaking parent bytes differ from retained SHA')
    with tempfile.TemporaryDirectory(prefix='spicygov-coverage-parent-') as directory:
        file = Path(directory) / (parent_id + '.parquet'); file.write_bytes(data)
        yield {'family': 'rulemaking', 'artifactDigest': None, 'snapshotId': match[2], 'manifestDefinitionDigest': definition_digest(manifest),
               'tableId': parent_id, 'recordUrl': record, 'rows': parent['rows'], 'urls': [str(file)],
               'members': [{'key': key, 'sha256': parent['sha256'], 'rows': parent['rows'], 'byteSize': parent['bytes']}]}


def saved_text_availability(conn, table_id, table, dim):
    """Count saved text, reading every group whose footer cannot decide it."""
    allowed = {'documents': {'text_content'}, 'comments': {'text_content', 'comment_text'},
               'fcc_filings': {'text_data'}}
    if dim['kind'] != 'category' or len(dim['fields']) != 1 or dim['fields'][0] not in allowed.get(table_id, set()):
        raise ValueError('Saved text availability is not reviewed for this field')
    import pyarrow.parquet as pq
    field = dim['fields'][0]
    counts = {'no_saved_text': 0, 'saved_blank_text': 0, 'saved_nonblank_text': 0}
    total = read_groups = footer_groups = 0
    for member in table['members']:
        url = member['url']
        stats = conn.execute('SELECT row_group_id,row_group_num_rows,stats_min_value,stats_max_value,stats_null_count,min_is_exact,max_is_exact FROM parquet_metadata(?) WHERE path_in_schema=?', [url, field]).fetchall()
        if not stats:
            schema = dict((r[0],r[1]) for r in conn.execute('DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)',[url]).fetchall())
            actual = conn.execute('SELECT count(*) FROM read_parquet(?, hive_partitioning=false)',[url]).fetchone()[0]
            if schema.get(field) != 'VARCHAR' or actual != 0: raise ValueError('Saved text footer or reviewed field is absent')
            continue
        mixed = []
        for group, n, minimum, maximum, nulls, min_exact, max_exact in stats:
            total += n
            if nulls is not None and not 0 <= nulls <= n: raise ValueError('Saved text null statistics are invalid')
            if nulls == n:
                counts['no_saved_text'] += n; footer_groups += 1
            elif isinstance(minimum, str) and minimum == maximum and nulls is not None and min_exact is True and max_exact is True:
                counts['no_saved_text'] += nulls
                counts['saved_nonblank_text' if minimum.strip() else 'saved_blank_text'] += n - nulls
                footer_groups += 1
            else: mixed.append((group, n))
        if mixed:
            remote = url.startswith(('http://', 'https://'))
            if remote:
                import fsspec
                stream = fsspec.filesystem('http').open(url, block_size=65536, cache_type='readahead')
            else: stream = open(url, 'rb')
            with stream:
                reader = pq.ParquetFile(stream)
                if reader.metadata.num_rows != sum(s[1] for s in stats): raise ValueError('Saved text footer counts changed between readers')
                for group, n in mixed:
                    group_rows = 0
                    for rows in reader.iter_batches(row_groups=[group], columns=[field], batch_size=2048):
                        group_rows += rows.num_rows
                        for value in rows.column(0).to_pylist():
                            if value is not None and not isinstance(value, str): raise ValueError('Saved text is not a string')
                            key = 'no_saved_text' if value is None else 'saved_nonblank_text' if value.strip() else 'saved_blank_text'
                            counts[key] += 1
                    if group_rows != n: raise ValueError('Saved text projected group count differs')
                    read_groups += 1
    if total != table['rows'] or sum(counts.values()) != total: raise ValueError('Saved text counts differ from publication')
    return {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')},
            'status': 'measured', 'rows': total, 'placedRows': total, 'unplacedRows': 0,
            'buckets': {json.dumps([k]): v for k, v in counts.items() if v},
            'overlapping': False, 'granularity': 'category', 'unit': 'rows',
            'definitionDigest': definition_digest(dim),
            'evidence': {'readRowGroups': read_groups, 'exactFooterRowGroups': footer_groups,
                         'blankDefinition': 'Empty or entirely Python str.strip whitespace; NULL is distinct.'}}


def scan_special(conn, table_id, table, dim, inputs):
    marker = dim.get('special')
    if marker == 'saved-text-availability': return saved_text_availability(conn, table_id, table, dim)
    if marker in ('government-receipt-observation-dates', 'government-receipt-origins'):
        return native_receipt_scope(table_id, table, dim, inputs)
    if marker == 'discovery-snapshot-facts':
        if table_id != 'discovery_signals': raise ValueError('Discovery snapshot marker is not supported for this table')
        return discovery_snapshot(table, dim, inputs)
    if marker in ('comments-index-posted', 'comments-index-groups'):
        return comments_index(conn, table_id, table, dim, inputs)
    if marker == 'proceeding-stage-events': return stage_events(conn, table, dim)
    if marker == 'source-date-literals': return source_date_literals(conn, table, dim)
    if marker in ('agenda-timetable-months', 'agenda-timetable-precision', 'agenda-timetable-unresolved'):
        return timetable(conn, table, dim)
    if marker == 'literal-date-anomalies':
        result = scan_dimension(conn, [m['url'] for m in table['members']], table['rows'], dim)
        return flag_future(result, dim, table)
    if marker is not None: raise ValueError('Unsupported reviewed regulatory coverage scan: ' + str(marker))
    return None
