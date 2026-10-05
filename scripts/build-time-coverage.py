"""Measure date buckets in published Parquet files; never infer source completeness."""
import concurrent.futures, datetime, json, pathlib, subprocess, sys
import duckdb
BASE = 'https://data.spicygov.ai'
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/time-coverage.v1.json'
# These name actual record dates, not crawler update times. The selected field is
# always published with the counts; periods are counted at their stated end only.
DATES = ['transaction_date', 'expenditure_date', 'disbursement_date', 'action_date', 'activity_date', 'sponsorship_date', 'version_date', 'introduced_date', 'vote_date', 'publication_date', 'published_date', 'pub_date', 'date_issued', 'date_filed', 'filed_date', 'posted_date', 'released_date', 'meeting_date', 'held_date', 'received_date', 'date_received', 'issue_date', 'approved_date', 'act_date', 'proposed_date', 'transmitted_date', 'congressional_record_date', 'stated_date', 'event_date', 'document_date', 'reported_date', 'incurred_date', 'period_end', 'to_version_date', 'postmark_date', 'author_date', 'registration_date']
YEARS = ['edition_year', 'filing_year', 'fiscal_year', 'year_text', 'year']
OVERRIDES = {'fcc_proceedings': 'date_created', 'scorecards': 'year_text'}
def fetch(path):
    return json.loads(subprocess.check_output(['curl', '-fsSL', '--max-time', '60', BASE + '/' + path]))
def fingerprint(members):
    return json.dumps([[m.get('sha256') or m['url'], m['rows'], m['byteSize']] for m in members], separators=(',', ':'))
def select_field(id, columns):
    names = {c[0] for c in columns}
    if OVERRIDES.get(id) in names:
        f = OVERRIDES[id]
    else:
        f = next((f for f in DATES + YEARS if f in names), None)
    return f, ('year' if f in YEARS else 'month')
def measure(item):
    id, table = item
    base = {'fingerprint': fingerprint(table['members']), 'rows': table['rows']}
    if table.get('checksum'): base['publicationSha256'] = table['checksum']
    conn = duckdb.connect()
    try:
        conn.execute("SET memory_limit='384MB'")
        conn.execute('SET threads=2')
        conn.execute('LOAD httpfs')
        conn.execute('SET http_timeout=30')
        urls = [m['url'] for m in table['members']]
        columns = table.get('columns') or [(r[0], r[1]) for r in conn.execute('DESCRIBE SELECT * FROM read_parquet(?)', [urls]).fetchall()]
        field, granularity = select_field(id, columns)
        if not field:
            return id, {**base, 'status': 'unmeasured', 'reason': 'No record date selected for this table.'}
        if id in ['agency_monthly_volume', 'comments_index']: field, granularity = 'year + month', 'month'
        names = {c[0] for c in columns}
        precision_checked = 'date_precision' in names or (field == 'date_filed' and 'date_filed_is_approximate' in names)
        if table.get('dateIndex'): field, granularity = 'posted_date (monthly index)', 'month'
        base.update(field=field, granularity=granularity)
        if precision_checked: base['precisionChecked'] = True
        old = previous.get(id, {})
        if all(old.get(k) == base.get(k) for k in base) and old.get('status') == 'measured': return id, old
        quoted = '"' + field.replace('"', '""') + '"'
        if table.get('etag'):
            def check_etag():
                checks = [(table['members'][0]['url'], table['etag'])]
                if table.get('dateIndex'): checks.append((table['dateIndex'], table['dateIndexETag']))
                for url, expected in checks:
                    headers = subprocess.check_output(['curl', '-fsSI', '--max-time', '30', url]).decode()
                    etag = next((line.split(':', 1)[1].strip() for line in headers.splitlines() if line.lower().startswith('etag:')), None)
                    if etag != expected: raise ValueError('Export file differs from its publication receipt')
            check_etag()
        if table.get('dateIndex'):
            urls = [table['dateIndex']]
            date = "CASE WHEN month BETWEEN 1 AND 12 THEN printf('%04d-%02d', year, month) END"
        elif field == 'year + month':
            date = "CASE WHEN month BETWEEN 1 AND 12 THEN printf('%04d-%02d', year, month) END"
        elif granularity == 'year':
            date = f"CASE WHEN regexp_full_match(trim(cast({quoted} AS VARCHAR)), '[0-9]{{4}}') THEN trim(cast({quoted} AS VARCHAR)) END"
        else:
            # ISO dates/timestamps only. Ambiguous or partial dates remain uncounted.
            date = f"CASE WHEN regexp_matches(cast({quoted} AS VARCHAR), '^[0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}($|[ T])') THEN strftime(try_cast({quoted} AS TIMESTAMP), '%Y-%m') END"
        if granularity == 'month' and 'date_precision' in names:
            date = f"CASE WHEN date_precision = 'day' THEN ({date}) END"
        if field == 'date_filed' and 'date_filed_is_approximate' in names:
            date = f"CASE WHEN lower(cast(date_filed_is_approximate AS VARCHAR)) IN ('false', 'f', '0') THEN ({date}) END"
        aggregate = 'sum(row_count)' if table.get('dateIndex') else 'count(*)'
        rows = conn.execute(f'SELECT {date} AS bucket, {aggregate} FROM read_parquet(?) GROUP BY 1', [urls]).fetchall()
        if table.get('etag'): check_etag()
        total = sum(n for _, n in rows)
        if total != table['rows']: raise ValueError('Published row count does not match scanned files')
        buckets = {k: n for k, n in rows if k is not None and '1700' <= k[:4] <= str(datetime.datetime.now(datetime.timezone.utc).year + 1)}
        missing = total - sum(buckets.values())
        return id, {**base, 'status': 'measured', 'measuredAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'buckets': dict(sorted(buckets.items())), 'undatedRows': missing}
    except Exception as e:
        print(f'{id}: measurement failed: {str(e)[:180]}', flush=True)
        return id, {**base, 'status': 'unmeasured', 'reason': 'Date counts could not be measured.'}
    finally: conn.close()
def timed_measure(item):
    id, table = item
    columns = table.get('columns')
    if columns:
        field, granularity = select_field(id, columns)
        if id in ['agency_monthly_volume', 'comments_index']: field, granularity = 'year + month', 'month'
        if table.get('dateIndex'): field, granularity = 'posted_date (monthly index)', 'month'
        old = previous.get(id, {})
        precision_checked = any(c[0] == 'date_precision' for c in columns) or (field == 'date_filed' and any(c[0] == 'date_filed_is_approximate' for c in columns))
        if old.get('status') == 'measured' and old.get('fingerprint') == fingerprint(table['members']) and old.get('rows') == table['rows'] and old.get('publicationSha256') == table.get('checksum') and old.get('field') == field and old.get('granularity') == granularity and (not precision_checked or old.get('precisionChecked')):
            return id, old
    try:
        child = subprocess.run([sys.executable, __file__, '--measure'], input=json.dumps({'item': item, 'previous': previous.get(id, {})}), text=True, capture_output=True, timeout=120, check=True)
        return id, json.loads(child.stdout.splitlines()[-1])
    except Exception as error:
        print(f'{id}: scan did not finish: {str(error)[:100]}', flush=True)
        base = {'fingerprint': fingerprint(table['members']), 'rows': table['rows'], 'status': 'unmeasured', 'reason': 'Date scan did not finish; coverage is unknown.'}
        if table.get('checksum'): base['publicationSha256'] = table['checksum']
        return id, base
if __name__ == '__main__' and '--measure' in sys.argv:
    request = json.load(sys.stdin)
    previous = {request['item'][0]: request['previous']}
    _, data = measure(request['item'])
    print(json.dumps(data))
    sys.exit(0)
if __name__ == '__main__':
    setup = duckdb.connect()
    setup.execute('INSTALL httpfs')
    setup.close()
    previous = json.loads(OUT.read_text()).get('tables', {}) if OUT.exists() else {}
    index = fetch('publication.v2.json'); tables = {}
    for family in index['families'].values():
        for file, table in family['tables'].items():
            members = table.get('members') or [{'key': file, **table}]
            tables[file.removesuffix('.parquet')] = {**table, 'members': [{'url': BASE + '/' + family['prefix'] + '/' + m['key'], 'rows': m['rows'], 'byteSize': m['byteSize'], 'sha256': m.get('sha256')} for m in members]}
    # The two supplementary publications use the same URL/size/count identity as the site.
    try:
        pointer = fetch('materialized/rulemaking/latest.json'); manifest = fetch(pointer['manifest_key'])
        for file, t in manifest['artifacts'].items():
            if t.get('visibility') == 'public': tables[file.removesuffix('.parquet')] = {'rows': t['rows'], 'members': [{'url': BASE + '/' + t['remote_key'], 'rows': t['rows'], 'byteSize': t['bytes']}], 'checksum': t['sha256']}
    except Exception as e: print('Rulemaking inventory unavailable:', str(e)[:100], flush=True)
    try:
        comments = fetch('comments-publication.json')
        for file in ['comments.parquet', 'comments_index.parquet']:
            t = comments['files'][file]; tables[file.removesuffix('.parquet')] = {'rows': t['rows'], 'members': [{'url': BASE + '/' + file, 'rows': t['rows'], 'byteSize': t['bytes']}], 'checksum': t['sha256'], 'etag': t['etag']}
            if file == 'comments.parquet':
                tables['comments'].update(columns=[('posted_date', 'VARCHAR')], dateIndex=BASE + '/comments_index.parquet', dateIndexETag=comments['files']['comments_index.parquet']['etag'])
    except Exception as e: print('Comments inventory unavailable:', str(e)[:100], flush=True)
    result = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for id, data in pool.map(timed_measure, tables.items()):
            result[id] = data
            print(f'{id}: {data["status"]} {data.get("field", "")}', flush=True)
    OUT.write_text(json.dumps({'format': 'spicygov-time-coverage', 'version': 1, 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'tables': result}, separators=(',', ':')) + '\n')
    print(f'Measured {sum(t["status"] == "measured" for t in result.values())}/{len(result)} tables', flush=True)
