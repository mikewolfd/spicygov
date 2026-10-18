"""Finite workflow-condition probe; no Actions API, upload or deployment."""
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT=Path(__file__).resolve().parents[1]


class Conditions(unittest.TestCase):
    def test_deploy_condition_and_coverage_modes(self):
        workflow=(ROOT/'.github/workflows/deploy-pages.yml').read_text()
        self.assertIn("if: ${{ github.event_name == 'workflow_dispatch' && !inputs.build_only && !inputs.source_catalog }}",workflow)
        self.assertIn("if: ${{ github.event_name == 'workflow_dispatch' && inputs.source_catalog && !inputs.build_only }}",workflow)
        self.assertIn("github.event_name == 'workflow_dispatch' && !inputs.build_only && 'completed' || 'unavailable'",workflow)
        self.assertNotIn('.coverage-backend',workflow)
        self.assertNotIn('build-coverage-maps.py',workflow)
        cases=[]
        for event in ('push','schedule','workflow_dispatch'):
            for catalog in (False,True):
                for build in (False,True):
                    refused=event=='workflow_dispatch' and catalog and not build
                    deploy=event=='workflow_dispatch' and not build and not catalog
                    stage=event=='workflow_dispatch' and catalog and build
                    self.assertFalse(refused and (deploy or stage))
                    if event!='workflow_dispatch':self.assertFalse(deploy or stage or refused)
                    cases.append((event,catalog,build,refused,deploy,stage))
        self.assertEqual(len(cases),12)

    def test_data_refresh_owns_full_builder_and_retained_route_is_unchanged(self):
        refresh=(ROOT/'.github/workflows/coverage-data-release.yml').read_text()
        self.assertIn('build-coverage-maps.py --release-output',refresh)
        self.assertNotIn('actions/deploy-pages',refresh)
        retained=(ROOT/'.github/workflows/pages-retained-artifact.yml').read_text()
        for operation in ('upload_only','deploy_forward','restore_prior'):self.assertIn(operation,retained)
        self.assertIn('preflight --binding',retained)

    def test_coverage_data_release_selects_exactly_one_reviewed_backend(self):
        refresh=(ROOT/'.github/workflows/coverage-data-release.yml').read_text()
        self.assertEqual(refresh.count('repository: mikewolfd/spicy-regs'),1)
        self.assertRegex(refresh,r'repository: mikewolfd/spicy-regs\n\s+ref: \$\{\{ inputs\.backend_revision \}\}\n')
        declared=refresh.split('      backend_revision:\n',1)[1].split('\npermissions:',1)[0]
        self.assertIn('required: true',declared);self.assertIn('type: string',declared)
        self.assertIsNone(re.search(r'\b[0-9a-f]{40}\b',refresh))
        self.assertNotIn('catalog-producer',refresh)
        self.assertEqual(refresh.count('actions/setup-python@v5'),1)
        self.assertLess(refresh.index('actions/setup-python@v5'),refresh.index('Require an exact maintained backend revision'))
        self.assertEqual(set(re.findall(r'SPICYGOV_[A-Z_]+',refresh)),{'SPICYGOV_COVERAGE_PYTHON'})
        self.assertIn('run: python scripts/build-coverage-maps.py --release-output',refresh)
        self.assertIn('run: pip install duckdb==1.4.4 pyarrow==21.0.0 fsspec==2026.9.0 aiohttp==3.11.14',refresh)
        readers=['additional_native_coverage','court_extraction_coverage','bulk_court_coverage','source_navigation_coverage',
                 'small_native_coverage','bulk_native_coverage','regulatory_native_coverage','rulemaking_native_coverage',
                 'regulatory_coverage_restore','vote_coverage_receipt_scope']
        self.assertEqual(re.findall(r'\$SPICYGOV_COVERAGE_PYTHON (tests/\w+\.py)',refresh),['tests/test_%s.py'%name for name in readers])
        guard=re.search(r'^\s+run: python -c "(.*)"$',refresh,re.M).group(1)
        for revision,accepted in (('a'*40,True),('main',False),('a'*39,False),('A'*40,False)):
            result=subprocess.run([sys.executable,'-c',guard],env={'BACKEND_REVISION':revision},capture_output=True)
            self.assertEqual(result.returncode==0,accepted,revision)
        for name in ('deploy-pages.yml','ci.yml'):
            workflow=(ROOT/'.github/workflows'/name).read_text()
            self.assertNotIn('mikewolfd/spicy-regs',workflow);self.assertNotIn('SPICYGOV_',workflow)

    def test_a_long_release_saves_its_checkpoints_even_when_the_scan_step_times_out(self):
        refresh=(ROOT/'.github/workflows/coverage-data-release.yml').read_text()
        job=int(re.search(r'^    timeout-minutes: (\d+)$',refresh,re.M).group(1))
        scan=refresh.split('        id: coverage-scan\n',1)[1].split('      - name: Save validated coverage checkpoints',1)[0]
        step=int(re.search(r'^        timeout-minutes: (\d+)$',scan,re.M).group(1))
        # The step ends first, leaving the job time to save the cache and retain the release;
        # a job-level timeout would cancel the scan step and lose its checkpoints.
        self.assertEqual((step,job),(300,330))
        self.assertLessEqual(step+15,job);self.assertLessEqual(job,360)
        save=refresh.split('      - name: Save validated coverage checkpoints\n',1)[1].split('      - name: Retain completed',1)[0]
        self.assertIn("if: ${{ always() && steps.coverage-cache.outcome == 'success' && steps.coverage-scan.outcome != 'skipped' && hashFiles('.cache/coverage-maps/*.json') != '' }}",save)
        self.assertIn('actions/cache/save@v5',save)

    def test_every_workflow_test_path_exists(self):
        for workflow in sorted((ROOT/'.github/workflows').glob('*.yml')):
            for path in set(re.findall(r'\btests/\w+\.(?:py|mjs)',workflow.read_text())):
                self.assertTrue((ROOT/path).is_file(),workflow.name+' names a missing test: '+path)


if __name__=='__main__':unittest.main()
