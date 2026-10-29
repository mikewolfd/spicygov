"""A prior source audit is reused only with exact retained observations and custody."""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('audit', Path(__file__).resolve().parents[1]/'scripts/verify-register-sources.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class InheritedSourceAudit(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root/'raw'
        self.raw.mkdir()
        self.base = self.root/'base.sqlite'
        with sqlite3.connect(self.base) as db:
            db.executescript('''CREATE TABLE metadata(key TEXT,value TEXT);
                CREATE TABLE files(id TEXT,collection_id TEXT,status TEXT,sha256 TEXT,data TEXT);
                CREATE TABLE objects(sha256 TEXT,bytes INTEGER);
                CREATE TABLE raw_objects(sha256 TEXT,object TEXT,encoding TEXT,stored_bytes INTEGER,stored_sha256 TEXT,mtime_ns INTEGER);''')
            db.execute('INSERT INTO metadata VALUES(?,?)', ('generation',json.dumps('base')))
        self.older = self.source(b'<html><title>Federal Register, Volume 1 Issue 1 (Thursday, December 31, 1936)</title></html>')
        self.stable = self.source(b'<html><title>Federal Register, Volume 91 Issue 188 (Wednesday, September 30, 2026)</title></html>')
        self.target = self.source(b'''<mods xmlns="http://www.loc.gov/mods/v3"><originInfo><dateIssued>1960-12-31</dateIssued>
            </originInfo><extension><collectionCode>FR</collectionCode><accessId>FR-1960-12-31</accessId></extension></mods>''', old=True)
        original = audit.extract_metadata
        def previous_reader(dataset, body):
            return {'outcome':'unsupported'} if b'<mods' in body else original(dataset,body)
        with patch.object(audit, 'extract_metadata', side_effect=previous_reader):
            report = audit.verify(self.base,self.raw)
        # Exercise the retained version-1 audit, which omitted dates before 1994.
        report.pop('version')
        report['months'] = [m for m in report['months'] if m >= '1994-01']
        self.proof = self.root/'prior.json'
        self.proof.write_text(json.dumps(report))
        self.candidate = self.root/'candidate.sqlite'
        shutil.copyfile(self.base,self.candidate)
        with sqlite3.connect(self.candidate) as db:
            db.execute('UPDATE metadata SET value=? WHERE key=?',(json.dumps('candidate'),'generation'))
        self.listing = self.root/'affected.txt'
        self.listing.write_text(self.target[0]+'\n')

    def source(self, body, old=False):
        sha = 'sha256:'+hashlib.sha256(body).hexdigest()
        packed = gzip.compress(body,mtime=0)
        relative = f'objects/sha256/{sha[7:9]}/{sha[7:]}.gz'
        path = self.raw/relative
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_bytes(packed)
        content = {'outcome':'unsupported'} if old else audit.extract_metadata(audit.COLLECTION,body)
        mapping = {'content_metadata':content,'periods':[dict(p,origin='content') for p in content.get('periods',[])]}
        with sqlite3.connect(self.base) as db:
            db.execute('INSERT INTO files VALUES(?,?,?,?,?)',(sha,audit.COLLECTION,'held',sha,json.dumps({'mapping':mapping})))
            db.execute('INSERT INTO objects VALUES(?,?)',(sha,len(body)))
            db.execute('INSERT INTO raw_objects VALUES(?,?,?,?,?,?)',(sha,relative,'gzip',len(packed),hashlib.sha256(packed).hexdigest(),path.stat().st_mtime_ns))
        return sha,path

    def verify(self):
        return audit.verify(self.candidate,self.raw,reuse_verified=self.proof,base_index=self.base,objects_from=self.listing)

    def test_reuses_untouched_originals_and_keeps_literal_historical_dates(self):
        opened=[]
        check=audit.check_original
        def observed(raw,sha,descriptor):
            opened.append(sha)
            return check(raw,sha,descriptor)
        with patch.object(audit,'check_original',side_effect=observed):
            result=self.verify()
        self.assertEqual(opened,[self.target[0]])
        self.assertEqual(result['months'],['1936-12','1960-12','2026-09'])
        self.assertEqual(result['dateOutcomes'],{'ok':3})
        self.assertEqual(result['rehashedObjects'],1)
        self.assertEqual(result['reusedVerifiedObjects'],2)
        self.assertEqual(result['inheritedVerification']['custodyCheckedObjects'],2)
        self.assertEqual(result['inheritedVerification']['generation'],'base')

    def test_full_audit_has_no_historical_floor(self):
        result=audit.verify(self.candidate,self.raw)
        self.assertEqual(result['months'],['1936-12','1960-12','2026-09'])
        self.assertEqual(result['rehashedObjects'],3)
        self.assertEqual(result['reusedVerifiedObjects'],0)

    def test_rejects_changed_mtime_size_missing_custody_and_symlinks(self):
        path=self.stable[1]
        before=path.stat()
        os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns+1))
        with self.assertRaisesRegex(ValueError,'custody changed'):self.verify()
        os.utime(path,ns=(before.st_atime_ns,before.st_mtime_ns))
        path.write_bytes(path.read_bytes()+b'!')
        with self.assertRaisesRegex(ValueError,'custody changed'):self.verify()

    def test_rejects_unavailable_baseline_mtime(self):
        for index in (self.base,self.candidate):
            with sqlite3.connect(index) as db:db.execute('UPDATE raw_objects SET mtime_ns=NULL WHERE sha256=?',(self.stable[0],))
        with self.assertRaisesRegex(ValueError,'custody changed'):self.verify()

    def test_rejects_symlink_and_missing_reused_original(self):
        path=self.stable[1]
        outside=self.root/'outside.gz'
        path.rename(outside)
        path.symlink_to(outside)
        with self.assertRaisesRegex(ValueError,'symlink'):self.verify()
        path.unlink()
        with self.assertRaises(FileNotFoundError):self.verify()

    def test_rejects_source_removed_outside_cohort(self):
        with sqlite3.connect(self.candidate) as db:db.execute("UPDATE files SET status='missing-bytes' WHERE sha256=?",(self.stable[0],))
        with self.assertRaisesRegex(ValueError,'source set changed'):self.verify()

    def test_rejects_descriptor_changes_outside_cohort(self):
        with sqlite3.connect(self.candidate) as db:db.execute('UPDATE raw_objects SET stored_sha256=? WHERE sha256=?',('f'*64,self.stable[0]))
        with self.assertRaisesRegex(ValueError,'descriptor changed'):self.verify()

    def test_rejects_prior_proof_with_wrong_identity_outcome_or_dates(self):
        original=json.loads(self.proof.read_text())
        for key,value in [('generation','wrong'),('objectSetSha256','wrong'),('dateOutcomes',{'ok':3}),('months',[])]:
            with self.subTest(key=key):
                self.proof.write_text(json.dumps({**original,key:value}))
                with self.assertRaisesRegex(ValueError,'does not match'):self.verify()
        self.proof.write_text(json.dumps(original))

    def test_filename_dates_are_not_promoted_to_content_evidence(self):
        with sqlite3.connect(self.base) as db:
            raw=json.loads(db.execute('SELECT data FROM files WHERE sha256=?',(self.stable[0],)).fetchone()[0])
            raw['mapping']['periods'].append({'kind':'publication-date','label':'1800-01-01','origin':'receipt'})
            db.execute('UPDATE files SET data=? WHERE sha256=?',(json.dumps(raw),self.stable[0]))
        self.assertNotIn('1800-01',self.verify()['months'])


if __name__ == '__main__':unittest.main()
