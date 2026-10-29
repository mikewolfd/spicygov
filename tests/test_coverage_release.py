"""Constructed full release fixtures; no source scan or production qualification."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from coverage_dimensions import binding, definition_digest
from coverage_release import complete, implementation_files, read_base, sha
from publication_census import census, census_digest
from test_publication_census import documents


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        core, pointer, manifest, comments = documents()
        self.captured = {key: json.dumps(value).encode() for key, value in {
            'publication.v2.json':core, 'materialized/rulemaking/latest.json':pointer,
            pointer['manifest_key']:manifest, 'comments-publication.json':comments}.items()}
        self.tables = census(core,pointer,manifest,comments)
        self.policies, maps, self.revisions = {}, {}, {}
        for id, table in self.tables.items():
            columns = table.get('columns') or [['day','DATE']]
            policy = {'family':table['family'], 'classification':'fixture', 'schema':columns,
                      'dimensions':[{'id':'snapshot','kind':'snapshot','label':'Saved rows','meaning':'Constructed test fixture.'}]}
            self.policies[id] = policy
            self.revisions[id] = 'sha256:'+'a'*64
            maps[id] = {**binding({**table,'columns':columns}, policy), 'status':'measured',
                        'classification':'fixture','note':'Constructed fixture, not a measured production release.',
                        'measuredAt':'2026-10-16T00:00:00Z','measurementRevision':self.revisions[id],
                        'dimensions':[{'id':'snapshot','label':'Saved rows','meaning':'Constructed test fixture.',
                          'status':'measured','definitionDigest':definition_digest(policy['dimensions'][0]),
                          'granularity':'snapshot','rows':table['rows'],'placedRows':table['rows'],
                          'unplacedRows':0,'buckets':{}}]}
        self.document = {'format':'spicygov-coverage-maps','version':1,'partial':False,
                         'generatedAt':'2026-10-16T00:00:00Z','censusDigest':census_digest(self.tables),'tables':maps}
        self.release = self.root/'release'

    def create(self):
        return complete(ROOT, self.release, json.dumps(self.document).encode(), self.captured, self.policies, self.revisions)

    def create_refresh(self):
        current = copy.deepcopy(self.document['tables']['records'])
        # Unrelated earlier counts remain earlier; they do not block this refresh.
        for value in self.document['tables'].values():
            value['fingerprint'] = 'earlier publication'
        base = json.dumps(self.document).encode()
        self.document['tables']['records'] = current
        return complete(ROOT, self.release, json.dumps(self.document).encode(), self.captured,
                        {'records': self.policies['records']}, {'records': self.revisions['records']}, base_bytes=base)

    def test_refresh_accepts_only_recounted_table_and_preserves_earlier_maps(self):
        pin = self.create_refresh()['manifestSha256']
        result = json.loads(self.consume(pin).stdout)
        self.assertEqual((result['scope'], result['measuredTables']), ('refresh', 1))
        self.assertEqual((result['networkRequests'], result['sourceRestorations']), (0, 0))
        base = json.loads((self.release/'base-coverage-maps.v1.json').read_bytes())
        served = json.loads((self.release/'coverage-maps.v1.json').read_bytes())
        self.assertNotEqual(served['tables']['records'], base['tables']['records'])
        for id in set(base['tables']) - {'records'}:
            self.assertEqual(served['tables'][id], base['tables'][id])
        # The same incomplete refresh cannot be admitted as a full release.
        manifest = json.loads((self.release/'manifest.json').read_bytes())
        manifest.update(format='spicygov-completed-coverage-release', owner='scripts/build-coverage-maps.py:full-completion')
        raw = json.dumps(manifest).encode(); (self.release/'manifest.json').write_bytes(raw)
        self.assertNotEqual(self.consume(sha(raw), False).returncode, 0)

    def test_refresh_refuses_changed_earlier_map_or_unbound_current_map(self):
        self.create_refresh()
        path = self.release/'coverage-maps.v1.json'
        original = path.read_bytes()
        other = next(id for id in self.document['tables'] if id != 'records')
        for id, field, value, message in (
            (other, 'note', 'silently revised', 'unselected measurement'),
            ('records', 'fingerprint', 'wrong publication', 'source selection differs'),
            ('records', 'measurementRevision', 'sha256:'+'f'*64, 'policy/revision changed'),
        ):
            with self.subTest(id=id, field=field):
                document = json.loads(original); document['tables'][id][field] = value
                path.write_text(json.dumps(document))
                result = self.consume(self.reseal('coverage-maps.v1.json'), False)
                self.assertNotEqual(result.returncode, 0); self.assertIn(message, result.stderr)

    def test_refresh_requires_exact_reviewed_base_bytes(self):
        path = self.root/'base.json'; raw = json.dumps(self.document).encode(); path.write_bytes(raw)
        self.assertEqual(read_base(path, sha(raw)), raw)
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            read_base(path, 'sha256:'+'f'*64)
        path.write_bytes(raw+b'\n')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            read_base(path, sha(raw))

    def consume(self, pin, check=True):
        return subprocess.run(['node',str(ROOT/'scripts/consume-coverage-release.mjs'),
            '--release',str(self.release),'--sha256',pin],text=True,capture_output=True,check=check,cwd=ROOT)

    def reseal(self, member):
        # A selected altered fixture must still pass independent semantics.
        manifest = json.loads((self.release/'manifest.json').read_text())
        raw = (self.release/member).read_bytes()
        manifest['members'][member] = {'bytes':len(raw),'sha256':sha(raw)}
        raw = json.dumps(manifest).encode(); (self.release/'manifest.json').write_bytes(raw)
        return sha(raw)

    def test_complete_fixture_is_consumed_offline_and_runtime_source_change_is_stale(self):
        pin = self.create()['manifestSha256']
        result = json.loads(self.consume(pin).stdout)
        self.assertEqual((result['networkRequests'],result['sourceRestorations']),(0,0))
        code = """
import {consumeRelease} from './scripts/consume-coverage-release.mjs';
import {build} from 'esbuild';
const r=await consumeRelease(process.argv[1],process.argv[2]);
const {outputFiles}=await build({entryPoints:['lib/coverage-map.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {currentCoverageMap,coverageMapForDisplay}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
const t=r.tables[0]; if(!currentCoverageMap(t,r.maps))throw Error('fixture not current');
const changed={...t,rows:t.rows+1};
if(currentCoverageMap(changed,r.maps)!==undefined||coverageMapForDisplay(changed,r.maps).freshness!=='previous-release')throw Error('changed live publication accepted');
"""
        subprocess.run(['node','--input-type=module','-e',code,str(self.release),pin],check=True,cwd=ROOT)

    def test_corruption_and_unselected_manifest_refuse(self):
        pin = self.create()['manifestSha256']
        self.assertNotEqual(self.consume('sha256:'+'f'*64,False).returncode,0)
        (self.release/'coverage-maps.v1.json').write_bytes(b'{}')
        self.assertNotEqual(self.consume(pin,False).returncode,0)

    def test_workflow_argument_shape_uses_default_selection_and_unavailable_mode(self):
        pin=self.create()['manifestSha256']
        (self.root/'content').mkdir()
        (self.root/'content/coverage-release-selection.v1.json').write_text(json.dumps({
            'format':'spicygov-coverage-release-selection','version':1,
            'directory':str(self.release),'manifestSha256':pin}))
        # Replace only the asset compiler for this CLI-shape probe.
        executable=self.root/'npm'
        executable.write_text('''#!/bin/sh
test "$1 $2" = "run build:assets" || exit 7
mkdir -p dist
printf '%s' "$VITE_SOURCE_CATALOG_URL" > dist/compiled-catalog-url.txt
cp -R public/source-catalog dist/
node --input-type=module -e 'import {readFile,writeFile} from "node:fs/promises"; const {generation}=JSON.parse(await readFile("dist/source-catalog/manifest.json")); await writeFile("dist/register-source-periods.v1.json",JSON.stringify({format:"spicygov-register-source-periods",version:1,generation,months:[]}));'
''')
        executable.chmod(0o755)
        env={**os.environ,'PATH':str(self.root)+os.pathsep+os.environ['PATH'],
             'VITE_SOURCE_CATALOG_URL':'https://example.test/older-catalog/manifest.json'}
        script=str(ROOT/'scripts/build-ui.mjs')
        missing_catalog=subprocess.run(['node',script,'--coverage','completed'],cwd=self.root,env=env,capture_output=True,text=True)
        self.assertNotEqual(missing_catalog.returncode,0)
        self.assertIn('source-catalog',missing_catalog.stderr)
        catalog=self.root/'public/source-catalog'
        catalog.mkdir(parents=True)
        (catalog/'manifest.json').write_text(json.dumps({'format':'spicy-source-catalog','version':1,
            'generation':'sha256:'+'a'*64,'generatedAt':'2026-10-10T00:00:00Z','collections':[],'totals':{}}))
        for mode in ('completed','unavailable'):
            subprocess.run(['node',script,'--coverage',mode],cwd=self.root,env=env,check=True,capture_output=True)
            served=json.loads((self.root/'dist/coverage-maps.v1.json').read_text())
            self.assertEqual(served['format'],'spicygov-coverage-maps' if mode=='completed' else 'spicygov-coverage-unavailable')
            self.assertEqual((self.root/'dist/compiled-catalog-url.txt').read_text(),'/source-catalog/manifest.json')
            self.assertEqual((self.root/'public/register-source-periods.v1.json').read_bytes(),
                             (self.root/'dist/register-source-periods.v1.json').read_bytes())
        compiler=executable.read_text()
        executable.write_text(compiler.replace('version:1,generation,months:[]',
            'version:1,generation:"sha256:"+"b".repeat(64),months:[]'))
        mismatched=subprocess.run(['node',script,'--coverage','unavailable'],cwd=self.root,env=env,capture_output=True,text=True)
        self.assertNotEqual(mismatched.returncode,0)
        self.assertIn('Built source dates differ',mismatched.stderr)
        executable.write_text(compiler)
        missing=subprocess.run(['node',script,'--coverage'],cwd=self.root,env=env,capture_output=True,text=True)
        self.assertNotEqual(missing.returncode,0);self.assertIn('Missing value',missing.stderr)
        (self.root/'empty').mkdir()
        unselected=subprocess.run(['node',script,'--coverage','completed'],cwd=self.root/'empty',env=env,capture_output=True,text=True)
        self.assertNotEqual(unselected.returncode,0);self.assertIn('reviewed selection',unselected.stderr);self.assertNotIn('Error: ENOENT',unselected.stderr)

    def test_changed_source_selection_refuses_even_if_rehashed(self):
        self.create()
        path=self.release/'publications/publication.v2.json'
        document=json.loads(path.read_text());document['families']['test']['tables']['records.parquet']['rows']+=1
        path.write_text(json.dumps(document))
        result=self.consume(self.reseal('publications/publication.v2.json'),False)
        self.assertNotEqual(result.returncode,0);self.assertIn('source selection differs',result.stderr)

    def test_partial_unknown_and_changed_policy_refuse(self):
        self.document['partial']=True
        with self.assertRaisesRegex(ValueError,'complete'):self.create()
        self.document['partial']=False;self.create()
        path=self.release/'coverage-maps.v1.json';document=json.loads(path.read_text())
        document['tables']['records']['definitionDigest']='sha256:'+'f'*64;path.write_text(json.dumps(document))
        self.assertNotEqual(self.consume(self.reseal('coverage-maps.v1.json'),False).returncode,0)

    def test_changed_implementation_identity_refuses(self):
        self.create()
        manifest=json.loads((self.release/'manifest.json').read_text())
        manifest['implementation']['scripts/build-coverage-maps.py']='sha256:'+'f'*64
        raw=json.dumps(manifest).encode();(self.release/'manifest.json').write_bytes(raw)
        result=self.consume(sha(raw),False)
        self.assertNotEqual(result.returncode,0);self.assertIn('implementation changed',result.stderr)

    def test_release_binding_removed_implementation_files_refuses_clearly(self):
        self.create()
        original=(self.release/'manifest.json').read_bytes()
        for key in ('scripts/coverage_revision.py','content/legacy-coverage-compatibility.v1.json'):
            with self.subTest(key=key):
                manifest=json.loads(original);manifest['implementation'][key]='sha256:'+'f'*64
                raw=json.dumps(manifest).encode();(self.release/'manifest.json').write_bytes(raw)
                result=self.consume(sha(raw),False)
                self.assertNotEqual(result.returncode,0);self.assertIn('implementation',result.stderr);self.assertNotIn('Error: ENOENT',result.stderr)

    def test_bound_implementation_files_all_exist(self):
        files=implementation_files(ROOT)
        self.assertTrue(files and all(path.is_file() for path in files))
        self.assertFalse({'coverage_revision.py','select_native_coverage_reader.py','legacy-coverage-compatibility.v1.json'}&{path.name for path in files})

    def test_release_binds_files_that_no_measurement_revision_hashes(self):
        # Allowances and orchestration keep checkpoints, but a release still records the exact code that ran.
        bound={path.name for path in implementation_files(ROOT)}
        self.assertLessEqual({'coverage_scan.py','coverage_allowances.py','build-coverage-maps.py','coverage_release.py'},bound)

    def test_expired_measurement_month_refuses(self):
        self.document['tables']['records']['dimensions'][0]['activityBoundary']={'month':'2001-01','basis':'measurement-month'}
        with self.assertRaises(subprocess.CalledProcessError):self.create()


if __name__=='__main__':unittest.main()
