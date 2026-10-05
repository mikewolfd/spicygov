"""Reviewed Congress coverage readers for source-specific evidence and intervals.

These readers preserve source scope. They never replace a historical input with
current data or use acquisition timestamps as record dates.
"""
import hashlib
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from collections import defaultdict

from coverage_dimensions import definition_digest, parsed_values, quote, scan_dimension, day, iso_day
from publication_census import BASE, path


def _urls(table):
    return [m['url'] for m in table['members']]


def _base(table, dim, granularity, *, overlapping=False):
    return {k: dim[k] for k in ('id', 'kind', 'label', 'meaning', 'fields')} | {
        'status': 'measured', 'rows': table['rows'], 'definitionDigest': definition_digest(dim),
        'granularity': granularity, 'unit': 'rows per period' if overlapping else 'rows',
        'overlapping': overlapping, 'partialRows': 0}


def _result(table, dim, granularity, buckets, placed, *, overlapping=False, **extra):
    if not 0 <= placed <= table['rows']:
        raise ValueError('Congress coverage placement does not reconcile')
    return _base(table, dim, granularity, overlapping=overlapping) | {
        'buckets': dict(sorted(buckets.items())), 'yearBuckets': ({y:sum(n for k,n in buckets.items() if k[:4]==y) for y in {k[:4] for k in buckets}} if granularity=='month' and not overlapping else dict(buckets) if granularity=='year' else {}), 'placedRows': placed,
        'unplacedRows': table['rows'] - placed, **extra}


def _raw(key):
    path(key)
    return subprocess.check_output(['curl', '-fsSL', '--retry', '2', '--max-time', '60', BASE + '/' + key])


def _hash(raw, expected):
    if 'sha256:' + hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Historical coverage evidence bytes differ from their pin')


def _journal(pin):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', pin.get('artifactDigest', '')):
        raise ValueError('Invalid source-evidence coverage pin')
    prefix = 'source-evidence/' + pin['artifactDigest'][7:] + '/'
    root = json.loads(_raw(prefix + 'artifact.json'))
    if root.get('artifactDigest') != pin['artifactDigest']:
        raise ValueError('Historical coverage source root differs from its pin')
    journal = None
    for descriptor in root['memberManifests']:
        raw = _raw(prefix + descriptor['objectKey']); _hash(raw, descriptor['sha256'])
        for member in json.loads(raw)['members']:
            if member['objectKey'] == 'journal.jsonl':
                raw_journal = _raw(prefix + 'journal.jsonl'); _hash(raw_journal, member['sha256'])
                journal = [json.loads(line) for line in raw_journal.splitlines() if line.strip()]
    if journal is None:
        raise ValueError('Source coverage journal is absent')
    return root, journal


def hearing_dates(table_id, table, inputs, package_ids):
    """Find every exact MODS capture reachable from the selected producing release."""
    owner = inputs.producing(table_id, table)
    artifact, found, evidence, seen = owner['artifact'], {}, [], set()
    for _ in range(32):
        sources = [p for p in artifact.get('inputs', []) if p.get('role') == 'source-evidence']
        if sources:
            pin = sources[0]
            if pin['artifactDigest'] in seen:
                raise ValueError('Repeated source-evidence history')
            seen.add(pin['artifactDigest']); source_root, events = _journal(pin)
            evidence.append({'sourceEvidenceDigest': pin['artifactDigest']})
            for event in events:
                match = re.fullmatch(r'https://api\.govinfo\.gov/packages/(CHRG-[A-Za-z0-9]+)/mods', event.get('requested_url', ''))
                if (not match or match[1] not in package_ids or match[1] in found
                        or event.get('event') != 'capture' or event.get('status_code') != 200
                        or not event.get('response_complete', True)
                        or not event.get('body_retained', source_root['spec'].get('evidence_version') is None)):
                    continue
                if not re.fullmatch(r'sha256:[a-f0-9]{64}', event.get('sha256', '')):
                    raise ValueError('MODS source coverage capture has no byte pin')
                raw = _raw('source-evidence/blobs/sha256/' + event['sha256'][7:]); _hash(raw, event['sha256'])
                xml = ET.fromstring(raw)
                dates = [node.text for node in xml.iter() if node.tag.split('}')[-1] == 'heldDate']
                if any(day(value) is None for value in dates):
                    raise ValueError('MODS heldDate has unsupported precision')
                found[match[1]] = {'dates': dates, 'sha256': event['sha256'], 'sourceEvidenceDigest': pin['artifactDigest']}
        if set(found) == package_ids:
            return found, evidence
        prior = next((p for p in artifact.get('inputs', []) if p.get('role') == 'prior-generation'), None)
        if not prior:
            break
        _, artifact, _ = inputs.artifact(owner['family'], prior['artifactDigest'])
    missing = sorted(package_ids - set(found))
    raise ValueError('Native hearing-date evidence is unavailable for: ' + ', '.join(missing[:10]))


def _hearing_sessions(conn, table_id, table, dim, inputs):
    rows = conn.execute('SELECT package_id,held_date FROM read_parquet(?, hive_partitioning=false)', [_urls(table)]).fetchall()
    if len(rows) != table['rows'] or len({r[0] for r in rows}) != len(rows):
        raise ValueError('Hearing coverage package identity does not reconcile')
    found, evidence = hearing_dates(table_id, table, inputs, {r[0] for r in rows})
    buckets, years, placed, occurrences = defaultdict(int), defaultdict(int), 0, 0
    for package, first in rows:
        dates = found[package]['dates']
        if (dates and first != dates[0]) or (not dates and first not in (None, '')):
            raise ValueError('Retained MODS dates differ from the published first hearing date')
        keys = {value[:7] for value in dates}; occurrences += len(dates)
        if keys: placed += 1
        for key in keys: buckets[key] += 1
        for year in {key[:4] for key in keys}: years[year] += 1
    return _result(table, dim, 'month', buckets, placed, overlapping=True,
                   sourceDateOccurrences=occurrences, yearBuckets=dict(sorted(years.items())), evidence=evidence,
                   notes=['Each transcript counts once per month; compiled volumes can appear in several months. Dates do not pair individual bills with every session.'])


def _member_service(conn, table, dim, inputs):
    parent = inputs.parent('members', table, dim['parent'])
    conn.read_parquet(_urls(table), hive_partitioning=False).create_view('coverage_service_members', replace=True)
    conn.read_parquet(parent['urls'], hive_partitioning=False).create_view('coverage_service_terms', replace=True)
    total, distinct = conn.execute('SELECT count(*),count(DISTINCT bioguide_id) FROM coverage_service_members').fetchone()
    if total != table['rows'] or distinct != total:
        raise ValueError('Member coverage identity is duplicated or missing')
    duplicate = conn.execute('SELECT count(*) FROM (SELECT bioguide_id,term_index FROM coverage_service_terms GROUP BY ALL HAVING count(*)>1)').fetchone()[0]
    if duplicate:
        raise ValueError('Member service term occurrence is not unique')
    unmatched_terms = conn.execute('SELECT count(*) FROM coverage_service_terms t LEFT JOIN coverage_service_members m USING(bioguide_id) WHERE m.bioguide_id IS NULL').fetchone()[0]
    if unmatched_terms:
        raise ValueError('Service term refers to a member absent from this retained roster')
    rows = conn.execute('SELECT t.bioguide_id,t.term_start,t.term_end FROM coverage_service_members m JOIN coverage_service_terms t USING(bioguide_id)').fetchall()
    buckets, years, placed, partial = defaultdict(set), defaultdict(set), set(), set()
    for identity, start, end in rows:
        keys, invalid = parsed_values({'id': dim['id'], 'kind': 'interval', 'fields': ['term_start','term_end']}, [start,end])
        if keys: placed.add(identity)
        if invalid: partial.add(identity)
        for key in keys: buckets[key].add(identity)
        for year in {key[:4] for key in keys}: years[year].add(identity)
    return _result(table, dim, 'month', {k:len(v) for k,v in buckets.items()}, len(placed),
                   overlapping=True, yearBuckets={k:len(v) for k,v in sorted(years.items())}, unit='members per period', partialRows=len(placed & partial),
                   parent={k:parent[k] for k in ('family','artifactDigest','tableId','recordUrl','members','rows')},
                   notes=['Counts use distinct members per month across their separate recorded terms. Future term ends are scheduled dates, not future observations.'])


def _printing_events(conn, table, dim, inputs):
    # The producer passes version_date for version_added and substitutes the run
    # stamp only when that source value is absent. Historical event identities
    # need not exist in today’s printing table after reader identity migrations.
    conn.read_parquet(_urls(table), hive_partitioning=False).create_view('coverage_activity_child', replace=True)
    conn.execute("""CREATE OR REPLACE TEMP VIEW coverage_activity_dates AS
        SELECT *, CASE WHEN event_type='version_added'
            AND occurred_at IS DISTINCT FROM detected_at THEN occurred_at END AS coverage_printing_date
        FROM coverage_activity_child""")
    total, eligible, fallback = conn.execute("""SELECT count(*),count(*) FILTER(WHERE event_type='version_added'),
        count(*) FILTER(WHERE event_type='version_added' AND occurred_at IS NOT DISTINCT FROM detected_at)
        FROM coverage_activity_dates""").fetchone()
    if total != table['rows']: raise ValueError('Activity source dates changed row count')
    measured=scan_dimension(conn,[],table['rows'],{'id':dim['id'],'kind':'date','label':dim['label'],
        'meaning':dim['meaning'],'fields':['coverage_printing_date']},source_view='coverage_activity_dates')
    measured.update(kind=dim['kind'],fields=dim['fields'],definitionDigest=definition_digest(dim),
        eligibleEventRows=eligible,possibleFallbackRows=fallback,otherEventRows=total-eligible,
        notes=['version_added carries publisher version_date; an equal run stamp is withheld as a possible processing fallback. Bill-added and stage-changed timestamps have different source semantics.'])
    return measured


def _scorecard_periods(conn, table, dim, source_view=None):
    field = quote(dim['fields'][0]);relation=quote(source_view) if source_view else 'read_parquet(?, hive_partitioning=false)'
    groups = conn.execute(f'SELECT cast(to_json({field}) AS VARCHAR),count(*) FROM {relation} GROUP BY 1', [] if source_view else [_urls(table)]).fetchall()
    buckets, placed, total, partial = defaultdict(int), 0, 0, 0
    for raw,n in groups:
        total += n; periods = json.loads(raw) if raw else None
        if periods is None: continue
        if not isinstance(periods,list): raise ValueError('Scorecard periods are not the published list shape')
        labels, invalid = set(), False
        for period in periods:
            if not isinstance(period,dict): raise ValueError('Scorecard period occurrence is not an object')
            label = {k:period[k] for k in ('period_text','kind','congress_text','year_text','session_text','chamber_text') if period.get(k) is not None}
            if not label or not any(k in label for k in ('period_text','congress_text','year_text','session_text')): invalid=True;continue
            labels.add(json.dumps(label,sort_keys=True,separators=(',',':')))
        if labels: placed += n
        if labels and invalid: partial += n
        for key in labels: buckets[key]+=n
    if total != table['rows']: raise ValueError('Scorecard period row count differs from publication')
    return _result(table,dim,'category',buckets,placed,overlapping=True,partialRows=partial,
                   notes=['Period labels retain explicit, relative and lifetime source scope. No prose period is converted to a guessed year.'])


def scan_special(conn, table_id, table, dim, inputs):
    """Return source-specific measurement, or None for a generic dimension."""
    method = dim.get('method')
    if method in ('committee-history-starts','committee-history-ends','committee-history-spans'):
        return _committee_history(conn,table,dim)
    if method == 'committee-action-dates': return _committee_action_dates(conn,table,dim)
    if method == 'activity-bill-introduction': return _bill_introduction_events(conn,table,dim,inputs)
    if method == 'committee-read-issue-dates': return _committee_read_dates(conn,table,dim,inputs)
    if method == 'roster-file-date': return _roster_file_dates(conn,table,dim)
    if method == 'funding-year-span': return _funding_years(conn,table,dim)
    if method == 'affiliation-period': return _affiliation_periods(conn,table,dim)
    if method == 'member-service-distinct': return _member_service(conn, table, dim, inputs)
    if method == 'hearing-sessions': return _hearing_sessions(conn, table_id, table, dim, inputs)
    if method == 'activity-printing-date': return _printing_events(conn, table, dim, inputs)
    if method == 'scorecard-metric-periods': return _metric_periods(conn,table_id,table,dim,inputs)
    if method == 'scorecard-period-labels': return _scorecard_periods(conn, table, dim)
    if method in ('citing-source-year','cited-read-source-year','citing-source-month','cited-read-source-month'):
        return _citation_scope(conn,table_id,table,dim,inputs)
    return None


def _committee_history(conn, table, dim):
    """Native name/history periods count each published committee once per cell."""
    groups=conn.execute('SELECT history_json,count(*) FROM read_parquet(?,hive_partitioning=false) GROUP BY 1',[_urls(table)]).fetchall()
    buckets,years=defaultdict(int),defaultdict(int)
    total=placed=partial=occurrences=open_ends=invalid_occurrences=0
    for raw,n in groups:
        total+=n
        history=json.loads(raw) if raw else []
        if not isinstance(history,list) or any(not isinstance(item,dict) for item in history):
            raise ValueError('Committee native history must be an array of objects')
        keys=set();unresolved=False
        for item in history:
            start,end=iso_day(item.get('startDate')),iso_day(item.get('endDate'))
            if not item.get('endDate'):open_ends+=n
            if dim['method']=='committee-history-spans':
                values,invalid=parsed_values({'kind':'interval','fields':['start','end']},[item.get('startDate'),item.get('endDate')])
            else:
                value=start if dim['method']=='committee-history-starts' else end
                values={value.strftime('%Y-%m')} if value else set();invalid=value is None
            if values:occurrences+=n
            if invalid:invalid_occurrences+=n;unresolved=True
            keys.update(values)
        if keys:placed+=n
        if keys and unresolved:partial+=n
        for key in keys:buckets[key]+=n
        for year in {key[:4] for key in keys}:years[year]+=n
    if total!=table['rows']:raise ValueError('Committee native history rows differ from publication')
    return _result(table,dim,'month',buckets,placed,overlapping=True,yearBuckets=dict(sorted(years.items())),
        partialRows=partial,sourcePeriodOccurrences=occurrences,openEndpointOccurrences=open_ends,
        unresolvedPeriodOccurrences=invalid_occurrences,
        notes=['These are the publisher’s committee name/history boundaries and bounded periods, not dates of committee activity. ISO source timestamps use their stated date component. Each committee counts once per month/year. An open end stays unknown and is never extended to today.'])


def _committee_action_dates(conn, table, dim):
    cutoff=iso_day(table.get('publishedAt'))
    if cutoff is None:raise ValueError('Committee action coverage requires the pinned publication date for its future-date guard')
    groups=conn.execute('SELECT stated_date,stated_date_count,count(*) FROM read_parquet(?,hive_partitioning=false) GROUP BY ALL',[_urls(table)]).fetchall()
    buckets,futures=defaultdict(int),defaultdict(int);total=placed=0
    for value,number,n in groups:
        total+=n;parsed=day(value)
        if number!='1' or parsed is None:continue
        if parsed>cutoff:futures[value]+=n;continue
        placed+=n;buckets[value[:7]]+=n
    if total!=table['rows']:raise ValueError('Committee action dates changed the published row count')
    return _result(table,dim,'month',buckets,placed,
        anomalies={'futureActivityRows':sum(futures.values()),'futureDateValues':dict(sorted(futures.items()))},
        evidence={'historicalThrough':cutoff.isoformat()},
        notes=['Only passages with one supported stated action date enter this view. Dates after this file’s publication stay unresolved source values; the publication date only guards eligibility and never supplies a record date.']+
            (['Unresolved future source dates: '+', '.join(sorted(futures)[:10])+'.'] if futures else []))


def _bill_introduction_events(conn, table, dim, inputs):
    relation=dim['parent']
    if relation.get('keys')!=[['bill_id','bill_id']]:raise ValueError('Introduction event coverage requires the exact bill identity')
    parent=inputs.parent('public_activity_events',table,relation)
    conn.read_parquet(_urls(table),hive_partitioning=False).create_view('coverage_intro_events',replace=True)
    conn.read_parquet(parent['urls'],hive_partitioning=False).create_view('coverage_intro_bills',replace=True)
    count,distinct=conn.execute('SELECT count(*),count(DISTINCT bill_id) FROM coverage_intro_bills').fetchone()
    if count!=parent['rows'] or count!=distinct:raise ValueError('Introduction event parent identity/row count does not reconcile')
    conn.execute("""CREATE OR REPLACE TEMP VIEW coverage_intro_dates AS SELECT c.*,
        p.bill_id IS NOT NULL AS coverage_intro_matched,
        CASE WHEN c.event_type='bill_added' AND c.occurred_at=p.introduced_date
            AND c.occurred_at IS DISTINCT FROM c.detected_at THEN p.introduced_date END AS coverage_intro_date
        FROM coverage_intro_events c LEFT JOIN coverage_intro_bills p USING(bill_id)""")
    total,matched,eligible,fallback=conn.execute("""SELECT count(*),count(*) FILTER(WHERE coverage_intro_matched),
        count(*) FILTER(WHERE event_type='bill_added'),
        count(*) FILTER(WHERE event_type='bill_added' AND coverage_intro_date IS NULL) FROM coverage_intro_dates""").fetchone()
    if total!=table['rows']:raise ValueError('Introduction event inheritance changed the child row count')
    measured=scan_dimension(conn,[],total,{'id':dim['id'],'kind':'date','fields':['coverage_intro_date'],
        'label':dim['label'],'meaning':dim['meaning']},source_view='coverage_intro_dates')
    measured.update(kind=dim['kind'],fields=dim['fields'],definitionDigest=definition_digest(dim),
        eligibleEventRows=eligible,possibleFallbackRows=fallback,otherEventRows=total-eligible,
        matchedRows=matched,unmatchedRows=total-matched,
        parent={k:parent[k] for k in ('family','artifactDigest','tableId','recordUrl','members','rows')},
        notes=['Only bill_added events equal to the exact retained bill’s introduced_date are placed. Publisher update dates and detected_at fallbacks remain unplaced. This counts change observations, not all introduced bills.'])
    return measured


def _citation_scope(conn, table_id, table, dim, inputs):
    """Attach source periods through selected text-version receipts and exact schemas."""
    conn.read_parquet(_urls(table), hive_partitioning=False).create_view('coverage_citations',replace=True)
    if table_id == 'document_citation_reads':
        read_table = inputs.producing(table_id,table)
        states = conn.execute('SELECT document_kind,document_key,text_sha256,input_family,input_generation,input_sha256 FROM coverage_citations').fetchall()
        groups = [(kind,key,text_sha,1) for kind,key,text_sha,*_ in states]
    else:
        read_table = inputs.parent(table_id,table,{'table':'document_citation_reads','mode':'same-generation','keys':[['document_kind','document_kind'],['document_key','document_key'],['text_sha256','text_sha256']]})
        conn.read_parquet(read_table['urls'], hive_partitioning=False).create_view('coverage_citation_reads',replace=True)
        states = conn.execute('SELECT document_kind,document_key,text_sha256,input_family,input_generation,input_sha256 FROM coverage_citation_reads').fetchall()
        groups = conn.execute('SELECT document_kind,document_key,text_sha256,count(*) FROM coverage_citations GROUP BY ALL').fetchall()
    if sum(g[3] for g in groups)!=table['rows']:
        raise ValueError('Citation occurrence coverage does not reconcile')
    state_by_key={}
    for state in states:
        key=state[:3]
        if key in state_by_key:raise ValueError('Text-version read state is not unique')
        state_by_key[key]=state
    retained_cache,scoped_views={}, {}
    if not hasattr(inputs,'congress_context_cache'):inputs.congress_context_cache={}
    context_cache=inputs.congress_context_cache.setdefault((table_id,table.get('artifactDigest')), {})
    def retained(family,generation,name):
        key=(family,generation,name)
        if key not in retained_cache:retained_cache[key]=inputs.table(family,generation,name)
        return retained_cache[key]
    def view(source):
        key=(source['family'],source['artifactDigest'],source['tableId'])
        if key not in scoped_views:
            alias='coverage_context_'+str(len(scoped_views));conn.read_parquet(source['urls'], hive_partitioning=False).create_view(alias,replace=True);scoped_views[key]=alias
        return quote(scoped_views[key])
    def one(source,keys,values,fields):
        schema={r[0] for r in conn.execute('DESCRIBE '+view(source)).fetchall()}
        if any(f not in schema for f in keys+fields):raise ValueError('Historical coverage key or period is absent from its source schema')
        pred=' AND '.join('cast('+quote(f)+' AS VARCHAR) IS NOT DISTINCT FROM ?' for f in keys)
        rows=conn.execute('SELECT '+','.join(quote(f) for f in fields)+' FROM '+view(source)+' WHERE '+pred+' LIMIT 2',values).fetchall()
        if len(rows)!=1:raise ValueError('Historical source occurrence is missing or ambiguous')
        return rows[0]
    def context(kind,key,text_sha):
        cache_key=(kind,key,text_sha)
        if cache_key in context_cache:return context_cache[cache_key]
        if kind in ('govinfo_package','budget_volume'):
            name='house_activity_reports' if kind=='govinfo_package' else 'budget_volumes'
            source=inputs.parent(table_id,table,{'table':name,'mode':'same-generation','keys':[['document_key','package_id'],['text_sha256','text_sha256']]})
            date,=one(source,['package_id','text_sha256'],[key,text_sha],['date_issued'])
            result={'date':date,'source':source['recordUrl'],'attribution':'retained print issue date'}
        else:
            state=state_by_key.get(cache_key)
            if not state:raise ValueError('Citation text-version has no retained input receipt')
            _,_,_,family,generation,input_sha=state
            if not re.fullmatch(r'sha256:[a-f0-9]{64}',generation or ''):raise ValueError('Citation source generation is unpinned')
            names_by_kind={'bill_section':'bill_sections','report_section':'report_sections','lobbying_activity':'lobbying_activities','communication_authority':'house_communications','communication_report_nature':'house_communications','communication_record_entry':'house_communications','court_opinion_derived_pdf':'court_opinion_pdf_extractions'}
            if kind not in names_by_kind:raise ValueError('Unsupported retained citation source kind: '+str(kind))
            source=retained(family,generation,names_by_kind[kind])
            if len(source['members'])!=1 or source['members'][0]['sha256']!=input_sha:
                raise ValueError('Citation source table differs from its original input hash; a partitioned receipt needs its declared aggregate verification')
            columns={r[0] for r in conn.execute('DESCRIBE '+view(source)).fetchall()}
            values=json.loads(key) if isinstance(key,str) and key.startswith('[') else [key]
            if not isinstance(values,list):raise ValueError('Citation source key is not the declared composite shape')
            if kind=='bill_section':keys=['bill_id','version_code','source' if 'source' in columns else 'printing_id','seq'];body='body'
            elif kind=='report_section':keys=['package_id','part_id','seq'];body='body'
            elif kind=='lobbying_activity':keys=['filing_uuid','activity_index'];body='description'
            elif kind.startswith('communication_'):keys=['congress','communication_type','number'];body={'communication_authority':'legal_authority','communication_report_nature':'report_nature','communication_record_entry':'record_entry_text'}[kind]
            else:keys=['opinion_id','source_sha256'] if len(values)==2 else ['opinion_body_id'];body='text_content'
            if len(keys)!=len(values):raise ValueError('Citation key does not match its retained source schema')
            text,=one(source,keys,values,[body])
            if not isinstance(text,str) or 'sha256:'+hashlib.sha256(text.encode()).hexdigest()!=text_sha:
                raise ValueError('Citation text differs from its retained extraction digest')
            result={'source':source['recordUrl'],'attribution':'exact retained text input'}
            if kind=='bill_section':result['date']=one(source,keys,values,['version_date'])[0]
            elif kind.startswith('communication_'):result['date']=one(source,keys,values,['congressional_record_date'])[0]
            elif kind=='report_section':
                package,part,modified=one(source,keys,values,['package_id','part_id','last_modified']);report=retained(family,generation,'committee_reports');date,parent_modified=one(report,['package_id','part_id'],[package,part],['date_issued','last_modified'])
                if modified!=parent_modified:raise ValueError('Citation report section version differs from its report input')
                result['date']=date
            elif kind=='lobbying_activity':
                filing=one(source,keys,values,['filing_uuid'])[0];filings=retained(family,generation,'lobbying_filings');year,period=one(filings,['filing_uuid'],[filing],['filing_year','filing_period']);result.update(year=str(year),period=period,attribution='exact retained lobbying reporting period')
            else:
                cluster=one(source,keys,values,['cluster_id'])[0];snap=source['artifact']['spec'].get('readSnapshot',{}).get('families',{}).get('court-opinion-clusters')
                if not snap:raise ValueError('Court text input lacks original cluster context snapshot')
                clusters=retained('court-opinion-clusters',snap['artifactDigest'],'court_opinion_clusters');descriptor=snap['tables']['court_opinion_clusters.parquet']
                if (len(clusters['members'])!=1 or clusters['members'][0]['sha256']!=descriptor['sha256'] or clusters['rows']!=descriptor['rows']):raise ValueError('Court context table differs from its saved snapshot')
                date,approximate=one(clusters,['cluster_id'],[cluster],['date_filed','date_filed_is_approximate']);result.update(date=date,approximate=str(approximate).lower() not in ('false','f','0'),attribution='contextual filing date from original saved read snapshot; not a declared acquisition parent',context=clusters['recordUrl'])
        context_cache[cache_key]=result;return result
    buckets,years,placed,coarse=defaultdict(int),defaultdict(int),0,0
    overlapping=False
    yearly=dim['method'].endswith('year')
    for kind,key,text_sha,n in groups:
        scope=context(kind,key,text_sha);keys=[]
        if scope.get('year') and re.fullmatch(r'[0-9]{4}',scope['year']) and scope['year']!='0000':
            if yearly:keys=[scope['year']]
            else:
                quarters={'first_quarter':1,'second_quarter':4,'third_quarter':7,'fourth_quarter':10}
                if scope.get('period') in quarters:
                    start=quarters[scope['period']];keys=[scope['year']+'-'+f'{month:02d}' for month in range(start,start+3)];overlapping=True
                else:coarse+=n
        elif scope.get('date'):
            date=day(str(scope['date'])[:10])
            if date:
                if yearly:keys=[f'{date.year:04d}']
                elif not scope.get('approximate'):keys=[date.strftime('%Y-%m')]
                else:coarse+=n
        if keys:placed+=n
        for key in set(keys):buckets[key]+=n
        for year in {key[:4] for key in keys}:years[year]+=n
    return _result(table,dim,'year' if yearly else 'month',buckets,placed,
                   coarseRows=coarse,overlapping=overlapping,yearBuckets=dict(sorted(years.items())),evidence=list(context_cache.values()),
                   notes=['Source periods come from exact retained text versions. Court filing dates use explicitly labeled saved context; annual lobbying scope remains annual; explicitly named quarters cover their source-stated three-month span.'])


def _funding_years(conn,table,dim):
    field,end=map(quote,dim['fields'])
    conn.read_parquet(_urls(table), hive_partitioning=False).create_view('coverage_funding_source',replace=True)
    conn.execute(f'CREATE OR REPLACE TEMP VIEW coverage_funding AS SELECT *,coalesce(nullif(trim(cast({end} AS VARCHAR)),\'\'),cast({field} AS VARCHAR)) AS coverage_funding_end FROM coverage_funding_source')
    measured=scan_dimension(conn,[],table['rows'],{**dim,'fields':[dim['fields'][0],'coverage_funding_end'],'syntax':'year'},source_view='coverage_funding')
    measured.update(fields=dim['fields'],definitionDigest=definition_digest(dim))
    return measured


def _affiliation_periods(conn,table,dim):
    conn.read_parquet(_urls(table), hive_partitioning=False).create_view('coverage_affiliation_source',replace=True)
    conn.execute('CREATE OR REPLACE TEMP VIEW coverage_affiliation AS SELECT *, CASE WHEN start_status=\'valid\' AND end_status=\'valid\' THEN affiliation_start END AS coverage_affiliation_start,CASE WHEN start_status=\'valid\' AND end_status=\'valid\' THEN affiliation_end END AS coverage_affiliation_end FROM coverage_affiliation_source')
    measured=scan_dimension(conn,[],table['rows'],{**dim,'fields':['coverage_affiliation_start','coverage_affiliation_end'],'conditions':[]},source_view='coverage_affiliation')
    measured.update(fields=dim['fields'],definitionDigest=definition_digest(dim))
    return measured


def _committee_read_dates(conn, table, dim, inputs):
    """Issue dates of attempted package reads, with consistent report-part context."""
    conn.read_parquet(_urls(table),hive_partitioning=False).create_view('coverage_read_attempts',replace=True)
    context={};sources=[]
    for name in ('committee_reports','hearing_transcripts'):
        parent=inputs.parent('committee_report_reads',table,{'table':name,'mode':'same-generation','keys':[['package_id','package_id']]})
        sources.append({k:parent[k] for k in ('family','artifactDigest','tableId','recordUrl','members','rows')})
        for package,date in conn.execute('SELECT DISTINCT package_id,date_issued FROM read_parquet(?,hive_partitioning=false)',[parent['urls']]).fetchall():
            if package in context and context[package]!=date:
                raise ValueError('Read-attempt package has inconsistent issue dates across parts')
            context[package]=date
    buckets,years,placed,total=defaultdict(int),defaultdict(int),0,0
    for package,n in conn.execute('SELECT package_id,count(*) FROM coverage_read_attempts GROUP BY 1').fetchall():
        total+=n;date=day(str(context.get(package,''))[:10])
        if date:placed+=n;buckets[date.strftime('%Y-%m')]+=n;years[f'{date.year:04d}']+=n
    if total!=table['rows']:raise ValueError('Read-attempt package rows differ from publication')
    return _result(table,dim,'month',buckets,placed,yearBuckets=dict(sorted(years.items())),
        evidence=sources,notes=['An issue date comes from the exact retained package output. Refused packages without published source context stay unplaced; complete is a read outcome, not archive completeness.'])


def _roster_file_dates(conn,table,dim):
    import datetime
    groups=conn.execute('SELECT file_date,count(*) FROM read_parquet(?,hive_partitioning=false) GROUP BY 1',[_urls(table)]).fetchall()
    buckets,years,placed,total=defaultdict(int),defaultdict(int),0,0
    for value,n in groups:
        total+=n;parsed=None
        if isinstance(value,str):
            for form in ('%B %d, %Y','%A, %B %d, %Y'):
                try:
                    stamp=datetime.datetime.strptime(value,form)
                    # strptime accepts a mismatched weekday; preserve that as unresolved.
                    if form.startswith('%A') and value.split(',')[0]!=stamp.strftime('%A'):continue
                    parsed=stamp;break
                except ValueError:pass
        if parsed:placed+=n;buckets[parsed.strftime('%Y-%m')]+=n;years[parsed.strftime('%Y')]+=n
    if total!=table['rows']:raise ValueError('Roster file-date rows differ from publication')
    return _result(table,dim,'month',buckets,placed,yearBuckets=dict(sorted(years.items())),
        notes=['These dates locate the retained roster snapshot, not a complete record of assignment tenure. Supported source syntax is full month/day/year, optionally prefixed by its matching weekday.'])


def _metric_periods(conn,table_id,table,dim,inputs):
    parent=inputs.parent(table_id,table,dim['parent']);keys=dim['parent']['keys']
    if keys not in ([['scorecard_id','scorecard_id'],['metric_id','metric_id']],[['scorecard_id','scorecard_id'],['parent_metric_id','metric_id']],[['scorecard_id','scorecard_id'],['component_metric_id','metric_id']]):raise ValueError('Metric scope keys are not the declared publisher identities')
    conn.read_parquet(_urls(table),hive_partitioning=False).create_view('coverage_metric_child',replace=True)
    conn.read_parquet(parent['urls'],hive_partitioning=False).create_view('coverage_metric_parent',replace=True)
    duplicates=conn.execute('SELECT count(*) FROM (SELECT scorecard_id,metric_id FROM coverage_metric_parent GROUP BY ALL HAVING count(*)>1)').fetchone()[0]
    if duplicates:raise ValueError('Metric period parent identity is not unique')
    on=' AND '.join('c.'+quote(c)+'=p.'+quote(p) for c,p in keys)
    conn.execute('CREATE OR REPLACE TEMP VIEW coverage_metric_scope AS SELECT c.*,p.periods AS coverage_metric_periods,p.metric_id IS NOT NULL AS coverage_metric_matched FROM coverage_metric_child c LEFT JOIN coverage_metric_parent p ON '+on)
    total,matched=conn.execute('SELECT count(*),count(*) FILTER(WHERE coverage_metric_matched) FROM coverage_metric_scope').fetchone()
    if total!=table['rows']:raise ValueError('Metric period inheritance changed child row count')
    measured=_scorecard_periods(conn,table,{**dim,'fields':['coverage_metric_periods']},source_view='coverage_metric_scope')
    measured.update(fields=dim['fields'],definitionDigest=definition_digest(dim),matchedRows=matched,unmatchedRows=total-matched,
        parent={k:parent[k] for k in ('family','artifactDigest','tableId','recordUrl','members','rows')})
    return measured
