"""Measure FEC selected scopes at their recorded collection/witness grain.

The generic dimension scanner handles ordinary fields and unique parent links.
This module handles generation-scoped collection context and many related events.
It never derives an empty source period from zero typed rows or a refused request.
"""
import collections
import datetime
import hashlib
import pathlib
import tempfile
import subprocess
import json
import re
import weakref
from urllib.parse import parse_qsl, urlsplit, urlencode

from coverage_dimensions import definition_digest, iso_expression, quote, parsed_values, iso_day
from collection_coverage import BASE

_CACHE = weakref.WeakKeyDictionary()
# Preserve unknown semantic filters. Only explicit transport/security controls
# are removed; a new source filter must not disappear merely because it is new.
_TRANSPORT_QUERY = {'page', 'per_page', 'offset', 'limit', 'last_index', 'last_id',
                    'hits_returned', 'from_hit'}
_SECURITY_QUERY = {'api_key', 'api-key', 'apikey', 'x_api_key', 'access_token', 'token', 'authorization',
                   'auth', 'auth_token', 'oauth_token', 'bearer_token', 'client_secret',
                   'session', 'session_id', 'password', 'passwd', 'signature', 'x-amz-signature', 'x-amz-credential',
                   'x-amz-security-token', 'x-amz-algorithm', 'x-amz-date', 'x-amz-expires',
                   'x-amz-signedheaders'}


def cache(conn):
    return _CACHE.setdefault(conn, {})


def urls(table):
    members = table.get('members', [])
    result = [m['url'] for m in members if m.get('url')]
    if not result:
        result = table.get('urls') or table.get('url')
    if isinstance(result, str): result = [result]
    if not result: raise ValueError('FEC coverage requires exact published member URLs')
    return result


def base(dim, rows, granularity, *, overlapping=False):
    return {**{k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields') if k in dim},
            'definitionDigest': definition_digest(dim), 'status': 'measured', 'rows': rows,
            'granularity': granularity, 'unit': 'rows per period' if overlapping else 'rows',
            'overlapping': overlapping, 'partialRows': 0}


def finish(result, buckets, placed, *, partial=0):
    if not 0 <= partial <= placed <= result['rows']:
        raise ValueError('FEC coverage counts do not reconcile')
    if len(buckets) > 50000: raise ValueError('FEC coverage has too many selected scopes')
    return {**result, 'buckets': dict(sorted(buckets.items())), 'placedRows': placed,
            'unplacedRows': result['rows'] - placed, 'partialRows': partial}


def retained_description(parent):
    return {k: parent[k] for k in ('family', 'artifactDigest', 'tableId', 'recordUrl', 'members', 'rows') if k in parent}


def scope(record):
    """Read actual scope structures; never read a cycle from an arbitrary filename."""
    def decode(value):
        if value is None: return {}
        obj = json.loads(value)
        if not isinstance(obj, dict): raise ValueError('Retained FEC scope must be an object')
        return obj
    requested, outcome = decode(record['requested_scope_json']), decode(record['collection_outcome_json'])
    mapping_cycle = outcome.get('tableFieldMapping', {}).get('cycle')
    mapping_cycle = str(mapping_cycle) if isinstance(mapping_cycle, int) and 1000 <= mapping_cycle <= 9999 else None
    captures = ([requested['capture']] if isinstance(requested.get('capture'), dict) else [])
    captures += requested.get('captures', []) if isinstance(requested.get('captures'), list) else []
    directory_cycles, queries, files, endpoints, requests, calendar_years, date_bounds = set(), set(), set(), set(), set(), set(), set()
    for capture in captures:
        if not isinstance(capture, dict): raise ValueError('Invalid retained capture scope')
        for key in ('requestUrl', 'resolvedUrl'):
            url = capture.get(key)
            if not isinstance(url, str): continue
            parts = urlsplit(url)
            directory_cycles.update(re.findall(r'(?:^|/)bulk-downloads/((?:19|20)[0-9]{2})/', parts.path))
            # No userinfo, query credentials or fragments enter the public map.
            endpoint = (parts.scheme + '://' + parts.netloc.rsplit('@', 1)[-1] + parts.path) if parts.scheme else parts.path
            if endpoint: endpoints.add(endpoint)
            params = tuple(sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                                  if k.lower() not in _TRANSPORT_QUERY | _SECURITY_QUERY))
            if params: queries.add(params)
            requests.add((endpoint, params))
            for k, v in params:
                if k == 'ao_year' and re.fullmatch(r'[1-9][0-9]{3}', v): calendar_years.add(v)
                # Calendar bounds are points in an exact request, not filled
                # observations or an inferred whole year/cycle search.
                if k in ('af_min_fd_date', 'af_max_fd_date', 'min_incurred_date', 'max_incurred_date'):
                    date = iso_day(v)
                    if date: date_bounds.add(date.strftime('%Y-%m'))
        key = capture.get('objectKey')
        if isinstance(key, str): files.add(key)
    member = requested.get('member')
    member = member.get('name') if isinstance(member, dict) else None
    cycle = mapping_cycle if mapping_cycle else next(iter(directory_cycles)) if len(directory_cycles) == 1 else None
    conflicting = bool(mapping_cycle and directory_cycles and directory_cycles != {mapping_cycle})
    if conflicting: cycle = None
    bounds = []
    if cycle: bounds.append('cycle ' + cycle)
    elif len(directory_cycles) > 1 or conflicting: bounds.append('ambiguous cycle')
    # Literal filters retain candidate/committee scope; paging controls are not period axes.
    # Keep filters paired with their endpoint; encode separators in literal
    # values so different selections cannot collapse into one display key.
    for endpoint, params in sorted(requests): bounds.append(endpoint + ('?' + urlencode(params) if params else ''))
    if files: bounds.extend(sorted(files))
    if member: bounds.append('member ' + member)
    description = '; '.join(bounds) if bounds else 'Period or selected member not stated'
    receiver = outcome.get('receiverDisposition')
    reason = receiver.get('reason') if isinstance(receiver, dict) else None
    return {'cycle': cycle, 'cycleAmbiguous': conflicting or len(directory_cycles) > 1,
            'sourceFamily': record['source_family'] or 'unknown',
            'outcome': record['record_outcome'] or 'unknown', 'description': description,
            'queryFilters': [[list(pair) for pair in params] for params in sorted(queries)],
            'endpoints': sorted(endpoints), 'calendarYears': sorted(calendar_years), 'dateBounds': sorted(date_bounds),
            'requests': [{'endpoint':endpoint,'filters':[list(pair) for pair in params]} for endpoint,params in sorted(requests)],
            'hasRequestedScope': bool(requested), 'reason': reason,
            'publishedRecords': outcome.get('publishedRecordCount'),
            'providerQualifiedEmpty': record['record_outcome'] == 'empty' and outcome.get('recordOutcome') == 'empty' and outcome.get('publishedRecordCount') == 0}


def collections_lookup(conn, parent):
    key = ('collections', parent.get('artifactDigest'), tuple(parent['urls']), tuple((m.get('sha256'), m.get('rows')) for m in parent.get('members', [])))
    if key in cache(conn): return cache(conn)[key]
    names = ('collection_id','source_family','record_outcome','requested_scope_json','collection_outcome_json')
    def records():
        if not any(url.startswith(('https://','http://')) for url in parent['urls']):
            yield from conn.execute('SELECT '+','.join(names)+' FROM read_parquet(?, hive_partitioning=false)', [parent['urls']]).fetchall()
            return
        try: import pyarrow.parquet as pq
        except ImportError as error:raise ValueError('FEC retained collection scopes require pyarrow') from error
        if len(parent['members']) != len(parent['urls']):raise ValueError('FEC collection files do not match retained members')
        with tempfile.TemporaryDirectory(prefix='spicygov-fec-scopes-') as directory:
            for number,(url,member) in enumerate(zip(parent['urls'],parent['members'])):
                path=pathlib.Path(directory)/str(number)
                expected=member.get('byteSize')
                if not isinstance(expected,int) or expected<0:raise ValueError('FEC collection byte size is absent from its receipt')
                subprocess.run(['curl','-fsSL','--retry','2','--retry-all-errors','--max-time','60','--max-filesize',str(expected),'-o',str(path),url],check=True,capture_output=True)
                checksum=hashlib.sha256();size=0
                with path.open('rb') as stream:
                    while chunk:=stream.read(1024*1024):
                        size+=len(chunk);checksum.update(chunk)
                if size!=expected or 'sha256:'+checksum.hexdigest()!=member.get('sha256'):
                    raise ValueError('FEC retained collection bytes differ from their receipt')
                reader=pq.ParquetFile(path)
                if reader.metadata.num_rows!=member['rows']:raise ValueError('FEC collection footer differs from its receipt')
                for batch in reader.iter_batches(batch_size=16,columns=list(names),use_threads=False):
                    columns=[column.to_pylist() for column in batch.columns]
                    yield from zip(*columns)
    lookup = {}
    total=0
    for values in records():
        total+=1
        id = values[0]
        if not isinstance(id, str) or id in lookup: raise ValueError('Retained collection keys are not unique/non-null')
        row = dict(zip(('collection_id','source_family','record_outcome','requested_scope_json','collection_outcome_json'), values))
        lookup[id] = scope(row)
    if total != parent['rows']:raise ValueError('Retained FEC collection count differs from its receipt')
    cache(conn)[key] = lookup
    return lookup


def footer_collection_counts(conn, source_urls, expected):
    """Count constant key groups from statistics, reading every mixed group cell.

    Maintained PyArrow and fsspec HTTP support perform projected range reads. A
    constant min/max plus zero nulls determines every key in that row group;
    missing/inexact statistics cause a read rather than a guessed count.
    """
    try:
        import fsspec
        import pyarrow.parquet as pq
    except ImportError as error:
        raise ValueError('Large FEC source-scope scans require pyarrow, fsspec and aiohttp') from error
    counts, total = collections.Counter(), 0
    for url in source_urls:
        stats = conn.execute("SELECT row_group_id,row_group_num_rows,stats_min_value,stats_max_value,stats_null_count,min_is_exact,max_is_exact FROM parquet_metadata(?) WHERE path_in_schema='collection_id'", [url]).fetchall()
        if not stats: raise ValueError('FEC source key footer statistics are absent')
        mixed = []
        for group, n, minimum, maximum, nulls, min_exact, max_exact in stats:
            total += n
            if isinstance(minimum, str) and minimum == maximum and nulls == 0 and min_exact is True and max_exact is True: counts[minimum] += n
            else: mixed.append((group, n))
        if mixed:
            fs = fsspec.filesystem('http') if url.startswith(('https://','http://')) else fsspec.filesystem('file')
            options = {'block_size':65536, 'cache_type':'readahead'} if url.startswith(('https://','http://')) else {}
            with fs.open(url, **options) as stream:
                reader = pq.ParquetFile(stream)
                if reader.metadata.num_rows != sum(s[1] for s in stats): raise ValueError('FEC footer counts changed between readers')
                for group, n in mixed:
                    rows = reader.read_row_group(group, columns=['collection_id'])
                    if rows.num_rows != n: raise ValueError('FEC projected row-group count differs from its footer')
                    counts.update(rows.column(0).to_pylist())
    if total != expected or sum(counts.values()) != expected: raise ValueError('FEC source-key row counts differ from publication')
    return [(key, None, n) for key, n in counts.items()]


def collection_groups(conn, table_id, table, *, witness):
    source_urls = urls(table)
    key = ('groups', table_id, tuple(source_urls), table['rows'], witness)
    if key in cache(conn): return cache(conn)[key]
    names = {r[0] for r in conn.execute('DESCRIBE SELECT * FROM read_parquet(?, hive_partitioning=false)',[source_urls]).fetchall()}
    if 'collection_id' not in names: raise ValueError('FEC table has no collection key')
    if witness:
        if not {'witness_generation_pin','witness_generation_scope'} <= names: raise ValueError('FEC witness generation fields are absent')
        raw = conn.execute('SELECT collection_id,witness_generation_pin,witness_generation_scope,count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY ALL',[source_urls]).fetchall()
        if any(s != 'external' for _, _, s, _ in raw): raise ValueError('FEC witness must explicitly pin its external source generation')
        groups = [(id,pin,n) for id,pin,_,n in raw]
    elif table_id == 'fec_source_records' and table['rows'] > 1000000:
        groups = footer_collection_counts(conn, source_urls, table['rows'])
    else:
        generation = 'source_generation_pin' if 'source_generation_pin' in names else 'NULL::VARCHAR'
        groups = conn.execute(f'SELECT collection_id,{generation},count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY 1,2',[source_urls]).fetchall()
    if sum(n for _,_,n in groups) != table['rows']: raise ValueError('FEC collection groups differ from publication')
    if len(groups) > 50000: raise ValueError('FEC table has too many collection groups')
    cache(conn)[key] = groups
    return groups


def collection_dimension(conn, table_id, table, dim, inputs):
    witness = dim['special'].startswith('witness-')
    groups = collection_groups(conn, table_id, table, witness=witness)
    parents = {}
    if witness:
        for _, pin, _ in groups:
            if not isinstance(pin,str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',pin): raise ValueError('FEC witness has no valid sealed source pin')
            if pin not in parents: parents[pin] = inputs.table('fec-observations', pin, 'fec_collections')
    else:
        parent = inputs.parent(table_id, table, dim['parent'])
        parents[parent['artifactDigest']] = parent
    lookups = {pin:collections_lookup(conn,parent) for pin,parent in parents.items()}
    cycle_dimension = dim['special'].endswith('-cycle')
    calendar_dimension = dim['special'].endswith('-calendar')
    bounds_dimension = dim['special'].endswith('-date-bounds')
    temporal = cycle_dimension or calendar_dimension or bounds_dimension
    buckets, placed, matched, partial = collections.Counter(), 0, 0, 0
    outcomes, empty, used, ambiguous = collections.Counter(), {}, set(), 0
    for collection_id, pin, n in groups:
        selected_pin = pin if witness or pin is not None else next(iter(parents))
        item = lookups.get(selected_pin, {}).get(collection_id)
        if not item: continue
        matched += n
        used.add((selected_pin,collection_id))
        if item['providerQualifiedEmpty']:
            empty[(selected_pin,collection_id)]={'collectionId':collection_id,'sourceGeneration':selected_pin,'queryFilters':item['queryFilters'],'scope':item['description'],'qualification':'Empty only for this exact retained request and its filters; no whole-cycle absence claim.'}
        if cycle_dimension:
            if item['cycle']: buckets[item['cycle']] += n;placed += n
            if item['cycleAmbiguous']: ambiguous += n
        elif calendar_dimension or bounds_dimension:
            values = item['calendarYears'] if calendar_dimension else item['dateBounds']
            for value in values: buckets[value] += n
            if values: placed += n
        else:
            key = json.dumps([item['sourceFamily'],item['outcome'],item['description']],separators=(',',':'))
            buckets[key] += n;placed += n
            if not item['hasRequestedScope']: partial += n
    for pin,id in used:outcomes[lookups[pin][id]['outcome']]+=1
    result = finish(base(dim,table['rows'],'month' if bounds_dimension else 'year' if temporal else 'category',
                         overlapping=calendar_dimension or bounds_dimension),buckets,placed,partial=partial)
    if bounds_dimension:
        year_counts = collections.Counter()
        for collection_id,pin,n in groups:
            selected_pin = pin if witness or pin is not None else next(iter(parents))
            item = lookups.get(selected_pin, {}).get(collection_id)
            if item:
                for year in {v[:4] for v in item['dateBounds']}: year_counts[year] += n
        result['yearBuckets'] = dict(sorted(year_counts.items()))
    result.update(matchedRows=matched,unmatchedRows=table['rows']-matched,
                  parent=[retained_description(p) for p in parents.values()],
                  evidence={'usedCollections':len(used),'usedCollectionOutcomes':dict(outcomes),
                            'qualifiedEmptyRequests':list(empty.values()),'ambiguousCycleRows':ambiguous},
                  notes=[f'{matched:,} rows match an exact retained collection; {table["rows"]-matched:,} do not. {ambiguous:,} rows have ambiguous cycle evidence.',
                         'Counts represent table rows linked to exact retained collection scope. Requests producing no table rows require separate selected-input evidence.',
                         'No record date or source-wide completeness is inferred from capture times, dictionary refusals or zero payloads.'])
    if calendar_dimension or bounds_dimension:
        result['notes'].insert(1, f'{table["rows"]-placed:,} rows have no supported stated calendar request scope. Request dates describe selection, not collected activity.')
    return result


def related_events(conn, table, dim, parent):
    relation=dim['parent'];key=relation['keys']
    if len(key)!=1:raise ValueError('Related FEC events require one explicit scoped key')
    child_key,parent_key=key[0]
    source_urls=urls(table)
    # Each child key must identify one observation; repeated source IDs never merge.
    total,unique=conn.execute('SELECT count(*),count(DISTINCT record_id) FROM read_parquet(?, hive_partitioning=false)',[source_urls]).fetchone()
    if total!=table['rows'] or unique!=total:raise ValueError('Related-event child observation keys are not unique')
    date=iso_expression('event_date')
    links=conn.execute(f'WITH child AS (SELECT record_id,{quote(child_key)} AS parent_key FROM read_parquet(?, hive_partitioning=false)), events AS (SELECT {quote(parent_key)} AS parent_key,strftime({date},\'%Y-%m\') AS bucket FROM read_parquet(?, hive_partitioning=false) WHERE date_precision IN (\'day\',\'month\')) SELECT DISTINCT child.record_id,events.bucket FROM child LEFT JOIN events USING(parent_key)',[source_urls,parent['urls']]).fetchall()
    month_ids,year_ids=collections.defaultdict(set),collections.defaultdict(set)
    placed_ids,unresolved_ids=set(),set()
    for record_id,bucket in links:
        if bucket is None:unresolved_ids.add(record_id);continue
        placed_ids.add(record_id);month_ids[bucket].add(record_id);year_ids[bucket[:4]].add(record_id)
    buckets={key:len(ids) for key,ids in month_ids.items()}
    result=finish(base(dim,total,'month',overlapping=True),buckets,len(placed_ids),partial=len(placed_ids & unresolved_ids))
    result['yearBuckets']={key:len(ids) for key,ids in sorted(year_ids.items())}
    result['parent']=retained_description(parent)
    result['notes']=['Each distinct child observation is counted once per month containing an explicitly related legal event. These dates do not establish when a party role or finding began.']
    return result


def related_filing_context(conn, table_id, table, dim, inputs):
    """Related periods stay at root observation grain, including repeated reports.

    Exact source header coordinates select report witnesses. Explicit filing IDs
    select API observations. Neither route invents a unique or controlling filing.
    """
    parent = inputs.parent(table_id, table, dim['parent'])
    field_names = [f for _, f in dim['parent']['keys']]
    period = dim['special'] != 'associated-filing-dates'
    fields = ['period_start','period_end'] if dim['special'] == 'related-filing-periods' else ['coverage_start_date','coverage_end_date'] if period else ['receipt_date']
    parent_rows = conn.execute('SELECT '+','.join(quote(f) for f in field_names + fields)+' FROM read_parquet(?, hive_partitioning=false)', [parent['urls']]).fetchall()
    if len(parent_rows) != parent['rows']: raise ValueError('Related filing parent count differs from receipt')
    lookup = {}
    for row in parent_rows:
        key = tuple(row[:len(field_names)])
        if any(v is None or v == '' for v in key): continue
        if field_names == ['record_id'] and key in lookup:
            raise ValueError('Explicit related filing observation IDs are not unique')
        item = lookup.setdefault(key, {'buckets':set(), 'years':set(), 'periods':set(), 'records':0, 'missing':0, 'invalid':0})
        item['records'] += 1
        values = [str(v) if v is not None else None for v in row[len(field_names):]]
        if period:
            buckets, invalid = parsed_values({'id':dim['id'],'kind':'interval','fields':fields}, values)
        else:
            date = iso_day(values[0])
            buckets, invalid = ([date.strftime('%Y-%m')], False) if date else ([], True)
        if buckets:
            item['buckets'].update(buckets);item['years'].update(v[:4] for v in buckets)
            item['periods'].add(tuple(values))
        elif any(v is None or v == '' for v in values): item['missing'] += 1
        elif invalid: item['invalid'] += 1
    source_urls = urls(table)
    unique_key = ('root-observation-uniqueness', tuple(source_urls), table['rows'])
    if unique_key not in cache(conn):
        total, unique = conn.execute('SELECT count(*),count(DISTINCT record_id) FROM read_parquet(?, hive_partitioning=false)', [source_urls]).fetchone()
        if total != table['rows'] or unique != total: raise ValueError('Related filing root observation IDs are not unique/count-reconciled')
        cache(conn)[unique_key] = True
    if dim['special'] == 'related-filing-periods':
        children = [f for f, _ in dim['parent']['keys']]
        groups_key = ('related-header-groups', tuple(source_urls), tuple(children))
        if groups_key not in cache(conn):
            cache(conn)[groups_key] = conn.execute('SELECT '+','.join(quote(f) for f in children)+',count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY ALL', [source_urls]).fetchall()
        roots = [(tuple(row[:-1]), row[-1]) for row in cache(conn)[groups_key]]
        association = False
    else:
        raw = conn.execute('SELECT record_id,association_status,filing_observation_ids FROM read_parquet(?, hive_partitioning=false)', [source_urls]).fetchall()
        roots = []
        for record_id,status,ids in raw:
            if ids is not None and (not isinstance(ids,list) or any(not isinstance(v,str) for v in ids)):
                raise ValueError('Related filing observation IDs must be a literal list of strings')
            # Only the producer's explicit resolved association supplies context.
            roots.append((set(ids or []) if status == 'resolved_native_filing_key' else set(), 1))
        association = True
    buckets, years = collections.Counter(), collections.Counter()
    counts = collections.Counter()
    for keys,n in roots:
        keys = [(v,) for v in keys] if association else [keys]
        matched_items = [lookup[k] for k in keys if k in lookup]
        missing_links = sum(k not in lookup for k in keys)
        periods, months, root_years = set(), set(), set()
        for item in matched_items:
            periods.update(item['periods']);months.update(item['buckets']);root_years.update(item['years'])
        if matched_items: counts['matchedRows'] += n
        else: counts['noParentRows'] += n
        if matched_items and not months: counts['matchedNoPeriodRows'] += n
        if missing_links: counts['missingRelatedParentRows'] += n
        if any(item['missing'] for item in matched_items): counts['missingPeriodWitnessRows'] += n
        if any(item['invalid'] for item in matched_items): counts['invalidPeriodRows'] += n
        if any(item['records'] > 1 for item in matched_items): counts['multipleParentWitnessRows'] += n
        if len(periods)>1: counts['multiplePeriodRows'] += n
        # Different periods from distinct explicit filings are related context;
        # competing dates attached to the same exact source header are conflicts.
        if not association and len(periods)>1: counts['conflictingPeriodRows'] += n
        if months:
            counts['placedRows'] += n
            for value in months: buckets[value] += n
            for value in root_years: years[value] += n
            if missing_links or any(item['missing'] or item['invalid'] for item in matched_items) or (not association and len(periods)>1): counts['partialRows'] += n
    result = finish(base(dim,table['rows'],'month',overlapping=True), buckets, counts['placedRows'], partial=counts['partialRows'])
    result['yearBuckets'] = dict(sorted(years.items()))
    result['parent'] = retained_description(parent)
    result['matchedRows'] = counts['matchedRows'];result['unmatchedRows'] = counts['noParentRows']
    result['evidence'] = {key:counts[key] for key in ('noParentRows','matchedNoPeriodRows','missingRelatedParentRows','missingPeriodWitnessRows','invalidPeriodRows','multipleParentWitnessRows','multiplePeriodRows','conflictingPeriodRows')}
    noun = 'receipt date' if not period else 'report period'
    result['notes'] = [
        f"{counts['matchedRows']:,} rows have an exact related filing; {counts['noParentRows']:,} have none. {counts['matchedNoPeriodRows']:,} matched rows have no usable {noun}.",
        f"{counts['partialRows']:,} dated rows also have missing, invalid or competing context. {counts['invalidPeriodRows']:,} rows have invalid dates; {counts['conflictingPeriodRows']:,} have competing periods for one exact source header.",
        f"{counts['multiplePeriodRows']:,} rows have multiple related periods; each root row counts once per month and year. These dates describe related filings, not when the child transaction or text occurred.",
        'Only exact retained source coordinates or explicitly selected filing IDs supply context; no controlling filing or complete amendment history is inferred.'
    ]
    return result


def loan_due_date(value):
    """Read full literal deadlines; do not assign a century to two-digit years."""
    if value is not None and not isinstance(value,str): raise ValueError('Loan due_date_terms must retain literal strings')
    if value is None or not value.strip(): return None, 'missing'
    value=value.strip()
    ambiguous_order=True
    if re.fullmatch(r'[0-9]{8}',value): parts=(value[:4],value[4:6],value[6:])
    elif re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}',value): parts=value.split('-');ambiguous_order=False
    else:
        match=re.fullmatch(r'([0-9]{1,2})([/\-])([0-9]{1,2})\2([0-9]{4})',value)
        if match: parts=(match[4],match[1],match[3])
        elif re.fullmatch(r'[0-9]{1,2}([/\-])[0-9]{1,2}\1[0-9]{2}',value): return None,'twoDigitYear'
        else: return None,'invalidDate' if re.fullmatch(r'[0-9/\-]+',value) else 'nonDateTerms'
    try: date=datetime.date(*(int(v) for v in parts))
    except ValueError: return None,'invalidDate'
    if ambiguous_order:
        try: alternative=datetime.date(date.year,date.day,date.month)
        except ValueError: alternative=None
        if alternative and alternative!=date:return None,'ambiguousDate'
    return date,None


def loan_deadlines(conn, table, dim):
    if dim.get('kind')!='date' or dim.get('fields')!=['due_date_terms']:
        raise ValueError('FEC loan deadline reader requires only due_date_terms as a date axis')
    values=conn.execute('SELECT due_date_terms,count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY 1',[urls(table)]).fetchall()
    if sum(n for _,n in values)!=table['rows']:raise ValueError('FEC loan deadline count differs from publication')
    buckets,reasons=collections.Counter(),collections.Counter()
    for value,n in values:
        date,reason=loan_due_date(value)
        if date: buckets[f'{date.year:04d}-{date.month:02d}']+=n
        else: reasons[reason]+=n
    result=finish(base(dim,table['rows'],'month'),buckets,sum(buckets.values()))
    result['evidence']={'unplacedReasons':dict(reasons),'acceptedFormats':['YYYYMMDD','YYYY-MM-DD','M/D/YYYY','M-D-YYYY']}
    result['notes']=[f"{reasons['missing']:,} rows have no stated terms; {reasons['twoDigitYear']:,} have two-digit years; {reasons['ambiguousDate']:,} have ambiguous day/month order; {reasons['invalidDate']:,} have invalid date values; {reasons['nonDateTerms']:,} state non-date terms.",
                     'Only valid full dates with explicit four-digit years enter this calendar. Compact and month-first forms stay unplaced if swapping day/month gives a different valid date. Original wording remains in the loan due-date terms view. Future deadlines are preserved; no century, collection-year limit or repayment activity is inferred.']
    return result


def scan_special(conn, table_id, table, dim, inputs):
    """Return a normal measured dimension, or None for ordinary dispatch."""
    special=dim.get('special')
    if special is None:return None
    if special=='loan-due-dates':return loan_deadlines(conn,table,dim)
    if special in ('collection-cycle','collection-scopes','witness-cycle','witness-scopes','collection-calendar','witness-calendar','collection-date-bounds','witness-date-bounds'):
        return collection_dimension(conn,table_id,table,dim,inputs)
    if special=='collection-outcomes':
        # Include zero-output dispositions by reading the collection table itself.
        parent=inputs.producing(table_id,table)
        lookup=collections_lookup(conn,parent)
        buckets=collections.Counter(json.dumps([v['outcome']],separators=(',',':')) for v in lookup.values())
        result=finish(base(dim,table['rows'],'category'),buckets,len(lookup))
        result['evidence']={'qualifiedEmptyRequests':[{'collectionId':id,'sourceGeneration':parent['artifactDigest'],'queryFilters':v['queryFilters'],'scope':v['description']} for id,v in lookup.items() if v['providerQualifiedEmpty']],
                            'refusals':[{'collectionId':id,'sourceFamily':v['sourceFamily'],'reason':v['reason'],'scope':v['description']} for id,v in lookup.items() if v['outcome'] in ('refused','unresolved')]}
        result['notes']=['selection_context/inventory_only are retained metadata; refused/unresolved are not successful empty parsing. Qualified empties apply only to exact request filters.']
        return result
    if special=='related-events':return related_events(conn,table,dim,inputs.parent(table_id,table,dim['parent']))
    if special in ('related-filing-periods','associated-filing-periods','associated-filing-dates'):
        return related_filing_context(conn,table_id,table,dim,inputs)
    if special=='precision-year':
        field=quote(dim['fields'][0]);expr=f"CASE WHEN date_precision IN ('day','month','year') THEN strftime(try_cast({field} AS DATE),'%Y') END"
        rows=conn.execute(f'SELECT {expr},count(*) FROM read_parquet(?, hive_partitioning=false) GROUP BY 1',[urls(table)]).fetchall()
        if sum(n for _,n in rows)!=table['rows']:raise ValueError('FEC legal year count differs from publication')
        buckets={k:n for k,n in rows if k is not None and k!='0000'}
        return finish(base(dim,table['rows'],'year'),buckets,sum(buckets.values()))
    raise ValueError('Unknown FEC coverage scanner: ' + str(special))
