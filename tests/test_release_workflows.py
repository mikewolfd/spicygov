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

    def test_coverage_data_release_workflow_retired_and_retained_route_remains(self):
        self.assertFalse((ROOT/'.github/workflows/coverage-data-release.yml').exists())
        self.assertTrue((ROOT/'scripts/prepare-coverage-refresh.py').is_file())
        retained=(ROOT/'.github/workflows/pages-retained-artifact.yml').read_text()
        for operation in ('upload_only','deploy_forward','restore_prior'):self.assertIn(operation,retained)
        self.assertIn('preflight --binding',retained)

    def test_active_workflows_read_no_backend_or_secret_env(self):
        for name in ('deploy-pages.yml','ci.yml'):
            workflow=(ROOT/'.github/workflows'/name).read_text()
            self.assertNotIn('mikewolfd/spicy-regs',workflow);self.assertNotIn('SPICYGOV_',workflow)

    def test_every_workflow_test_path_exists(self):
        for workflow in sorted((ROOT/'.github/workflows').glob('*.yml')):
            for path in set(re.findall(r'\btests/\w+\.(?:py|mjs)',workflow.read_text())):
                self.assertTrue((ROOT/path).is_file(),workflow.name+' names a missing test: '+path)


if __name__=='__main__':unittest.main()
