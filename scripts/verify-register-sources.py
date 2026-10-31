"""Verify locally held Federal Register bytes and date observations offline."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import stat

from spicy_regs.source_catalog.raw_archive import contained_file
from spicy_regs.source_catalog.raw_content import extract_metadata, reader_inputs
from spicy_regs.source_catalog.storage import connect


COLLECTION = 'family:federal-register'


def object_set(objects):
    return 'sha256:' + hashlib.sha256(''.join(sha+'\n' for sha in sorted(objects)).encode()).hexdigest()


def interpretation():
    """Content identities, independent of the installed package directory."""
    result = {}
    for path in reader_inputs(COLLECTION):
        parts = path.parts
        package = next(i for i, part in enumerate(parts) if part in ('spicy_regs', 'spicy_docs'))
        result['/'.join(parts[package:])] = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def retained_interpretation(index):
    """Qualify older reports from the source reader pins retained in their base."""
    with connect(index, readonly=True) as db:
        row = db.execute("SELECT value FROM metadata WHERE key='reconciliation'").fetchone()
    result = {}
    for name, pin in (json.loads(row[0]).get('phaseInputs', {}) if row else {}).items():
        parts = Path(name).parts
        for i, part in enumerate(parts):
            if part in ('spicy_regs', 'spicy_docs'):
                key = '/'.join(parts[i:])
                if key in result and result[key] != pin['sha256']:
                    raise ValueError('Conflicting retained source reader pins')
                result[key] = pin['sha256']
                break
    return result


def custody(raw, objects):
    """Check metadata without opening source bodies; bind same-size replacements too."""
    records = []
    for sha, descriptor in sorted(objects.items()):
        _size, reference, _encoding, stored_size, _stored_sha, _mtime = descriptor
        info = contained_file(raw, reference).stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != stored_size:
            raise ValueError('Source custody changed; renew its byte audit: '+sha)
        records.append([sha, *descriptor, info.st_dev, info.st_ino, info.st_size,
                        info.st_mtime_ns, info.st_ctime_ns])
    return 'sha256:' + hashlib.sha256(json.dumps(records, separators=(',', ':')).encode()).hexdigest()


def inventory(index):
    with connect(index, readonly=True) as db:
        generation = json.loads(db.execute("SELECT value FROM metadata WHERE key='generation'").fetchone()[0])
        columns = {row[1] for row in db.execute('PRAGMA table_info(raw_objects)')}
        mtime = 'r.mtime_ns' if 'mtime_ns' in columns else 'NULL'
        rows = db.execute(f'''SELECT DISTINCT o.sha256,o.bytes,r.object,r.encoding,r.stored_bytes,r.stored_sha256,{mtime}
            FROM files f JOIN objects o ON o.sha256=f.sha256 JOIN raw_objects r ON r.sha256=f.sha256
            WHERE f.collection_id=? AND f.status='held' ''', (COLLECTION,)).fetchall()
    return generation, {row[0]: tuple(row[1:]) for row in rows}


def retained_observations(index):
    """Use authenticated reader observations, never dates guessed from names."""
    observations = {}
    with connect(index, readonly=True) as db:
        for sha, data in db.execute("SELECT sha256,data FROM files WHERE collection_id=? AND status='held'", (COLLECTION,)):
            mapping = json.loads(data).get('mapping', {})
            outcome = mapping.get('content_metadata', {}).get('outcome', 'unsupported')
            dates = {p['label'] for p in mapping.get('periods', [])
                     if p.get('origin') in {'content', 'publication-context'} and p.get('kind') == 'publication-date'}
            previous = observations.setdefault(sha, (outcome, set()))
            if previous[0] != outcome:
                raise ValueError('Inconsistent retained extraction outcomes: '+sha)
            previous[1].update(dates)
    return observations


def check_original(raw, sha, descriptor):
    size, reference, encoding, stored_size, stored_sha, _mtime = descriptor
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
    content = extract_metadata(COLLECTION, bytes(body)) if size <= 4 * 1024**2 else {'outcome': 'not-read'}
    return sha, content['outcome'], {p['label'] for p in content.get('periods', []) if p['kind'] == 'publication-date'}


def read_cohort(path):
    values = path.read_text().splitlines()
    if len(values) != len(set(values)) or any(not re.fullmatch(r'sha256:[0-9a-f]{64}', value) for value in values):
        raise ValueError('Object list must contain unique canonical SHA-256 identities')
    return set(values)


def verify(index, raw, *, reuse_verified=None, base_index=None, objects_from=None,
           require_index_agreement=False):
    generation, objects = inventory(index)
    reader = interpretation()
    before = custody(raw, objects)
    reuse = any(value is not None for value in (reuse_verified, base_index, objects_from))
    inherited, reread, custody_checked = {}, set(objects), 0
    carried_readers = []
    indexed_observations = retained_observations(index) if require_index_agreement else None
    if indexed_observations is not None and set(indexed_observations) != set(objects):
        raise ValueError('Candidate date observations do not cover its held source set')
    prior = None
    if reuse:
        if not all(value is not None for value in (reuse_verified, base_index, objects_from)):
            raise ValueError('Audit reuse requires its prior proof, base index and affected object list')
        prior = json.loads(reuse_verified.read_text())
        base_generation, baseline = inventory(base_index)
        observations = retained_observations(base_index)
        baseline_dates = {date for _, dates in observations.values() for date in dates}
        # Reports before version 2 intentionally omitted literal dates before
        # 1994. This comparison validates that old result, not the new output.
        prior_dates = baseline_dates if prior.get('version', 1) >= 2 else {d for d in baseline_dates if d >= '1994-01-01'}
        expected = {'generation': base_generation, 'verifiedObjects': len(baseline),
                    'objectSetSha256': object_set(baseline),
                    'dateOutcomes': dict(Counter(value[0] for value in observations.values())),
                    'months': sorted({date[:7] for date in prior_dates}),
                    'latestIndexedDate': max(prior_dates, default=None)}
        if any(prior.get(key) != value for key, value in expected.items()) or set(observations) != set(baseline):
            raise ValueError('Prior byte audit does not match the retained base source set and observations')
        if not baseline.keys() <= objects.keys():
            raise ValueError('Held source set changed; renew its byte audit')
        reread = read_cohort(objects_from) | (objects.keys() - baseline.keys())
        if not reread <= objects.keys():
            raise ValueError('Affected object is not a held source in this candidate')
        carried_readers = (prior.get('dateInterpretations') or [
            prior.get('interpretation') or retained_interpretation(base_index)]) if baseline else []
        if any(not isinstance(value,dict) or 'spicy_regs/source_catalog/raw_content.py' not in value
               or any(not isinstance(pin,str) or not re.fullmatch(r'sha256:[0-9a-f]{64}',pin)
                      for pin in value.values())
               for value in carried_readers):
            raise ValueError('Retained date interpretation is unavailable; qualify an affected cohort or renew its byte audit')
        current_observations = indexed_observations if indexed_observations is not None else retained_observations(index)
        if prior.get('custodySha256') and custody(raw, baseline) != prior['custodySha256']:
            raise ValueError('Source custody changed since its prior byte audit')
        for sha, descriptor in objects.items():
            if sha in reread:
                continue
            if baseline.get(sha) != descriptor:
                raise ValueError('Source descriptor changed outside the affected cohort: '+sha)
            if current_observations.get(sha) != observations[sha]:
                raise ValueError('Date observations changed outside the affected cohort: '+sha)
            _size, reference, _encoding, stored_size, _stored_sha, mtime = descriptor
            path = contained_file(raw, reference)
            info = path.stat()
            if (mtime is None or not stat.S_ISREG(info.st_mode) or info.st_size != stored_size
                    or info.st_mtime_ns != mtime):
                raise ValueError('Source custody changed; renew its byte audit: '+sha)
            custody_checked += 1
            inherited[sha] = observations[sha]
    counts, dates = Counter(), set()
    for outcome, observed in inherited.values():
        counts[outcome] += 1
        dates.update(observed)
    mismatches = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for sha, outcome, observed in pool.map(lambda sha: check_original(raw, sha, objects[sha]), sorted(reread)):
            counts[outcome] += 1
            dates.update(observed)
            if indexed_observations is not None and indexed_observations[sha] != (outcome, observed):
                expected_outcome,expected_dates = indexed_observations[sha]
                mismatches.append({'sha256':sha,
                    'expected':{'outcome':expected_outcome,'dates':sorted(expected_dates)},
                    'observed':{'outcome':outcome,'dates':sorted(observed)}})
    if custody(raw, objects) != before:
        raise ValueError('Source custody changed during verification')
    if not inherited:
        carried_readers = []
    interpretations = {json.dumps(value,sort_keys=True):value for value in carried_readers}
    if reread:
        interpretations[json.dumps(reader,sort_keys=True)] = reader
    report = {'version': 3, 'generation': generation, 'checkedAt': datetime.now(timezone.utc).isoformat(),
              'dateInterpretations':list(interpretations.values()),
              'rehashedInterpretation':reader if reread else None, 'custodySha256': before,
              'verifiedObjects': len(objects), 'objectSetSha256': object_set(objects),
              'dateOutcomes': dict(counts), 'months': sorted({date[:7] for date in dates}),
              'latestIndexedDate': max(dates, default=None),
              'rehashedObjects': len(reread), 'reusedVerifiedObjects': len(inherited),
              'rereadObjectSetSha256': object_set(reread)}
    if prior is not None:
        report['inheritedVerification'] = {'generation': prior['generation'], 'checkedAt': prior['checkedAt'],
            'proofSha256': 'sha256:'+hashlib.sha256(reuse_verified.read_bytes()).hexdigest(),
            'custodyCheckedObjects': custody_checked,
            'carriedInterpretations':carried_readers,
            'scope': 'Carried dates retain their recorded interpretation; current code was applied only to new or explicitly affected rehashed objects. Exact observations and current custody were checked.'}
    if require_index_agreement:
        report['indexAgreement'] = {'status':'mismatch' if mismatches else 'matched',
                                  'checkedObjects':len(reread),'mismatches':mismatches}
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--raw-root', type=Path, required=True)
    parser.add_argument('--reuse-verified', type=Path)
    parser.add_argument('--base-index', type=Path)
    parser.add_argument('--objects-from', type=Path)
    parser.add_argument('--require-index-agreement',action='store_true',
                        help='Reject fresh outcomes/dates that disagree with the candidate, using the same source read')
    args = parser.parse_args()
    report = verify(args.index, args.raw_root, reuse_verified=args.reuse_verified,
                    base_index=args.base_index, objects_from=args.objects_from,
                    require_index_agreement=args.require_index_agreement)
    print(json.dumps(report))
    if report.get('indexAgreement',{}).get('status') == 'mismatch':
        raise SystemExit(1)
