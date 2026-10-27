"""Hand-authored specification controls, independent of the generated corpus."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[2] / 'scripts/ecq/corpus/reference_labels.py'


class ReferenceLabelsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        data = b'actual recorded observation\n'
        (self.root / 'record.txt').write_bytes(data)
        self.contract = {
            'contractId': 'handwritten',
            'statePolicy': {'repositoryId': 'project', 'commit': 'abc', 'tree': 'def',
                            'configurationDigest': 'config-A'},
            'runPolicy': {'allowedRunIds': ['current', 'authorized-prior']},
            'requiredGates': [{'id': 'tests', 'claimId': 'tested', 'scope': 'test-suite', 'required': True}],
            'claimGraph': {'nodes': ['tested', 'release', 'unrelated'], 'edges': [['tested', 'release']]},
            'requestedClaim': 'release',
            'admissibleTypes': {'types': ['executed'], 'provenance': ['local-runner']},
        }
        self.bundle = {'caseId': 'opaque', 'evidence': [{
            'id': 'observation', 'subject': copy.deepcopy(self.contract['statePolicy']),
            'runId': 'current', 'gateId': 'tests', 'claimId': 'tested', 'scope': 'test-suite',
            'outcome': 'PASS', 'evidenceType': 'executed', 'provenance': 'local-runner',
            'artifactRefs': [{'id': 'log', 'path': 'record.txt', 'objectId': 'test-record',
                              'expectedObjectId': 'test-record', 'sha256': hashlib.sha256(data).hexdigest()}],
        }]}

    def tearDown(self):
        self.temp.cleanup()

    def oracle(self):
        self.assertTrue(MODULE_PATH.exists(), 'independent reference evaluator must exist')
        spec = importlib.util.spec_from_file_location('independent_reference', MODULE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(callable(getattr(module, 'evaluate', None)), 'reference evaluator must expose evaluate')
        return module

    def result(self):
        return self.oracle().evaluate(self.bundle, self.contract, self.root)

    @staticmethod
    def states(result):
        return {r['obligationId']: r['status'] for r in result['relations']}

    def test_complete_pass_and_honest_fail_are_closed(self):
        self.assertEqual((self.result()['closureStatus'], self.result()['authorizePass']), ('CLOSED', True))
        self.bundle['evidence'][0]['outcome'] = 'FAIL'
        result = self.result()
        self.assertEqual((result['closureStatus'], result['gateSatisfaction'], result['authorizePass']),
                         ('CLOSED', 'UNSATISFIED', False))

    def test_authorized_reuse_and_forbidden_reuse_differ_by_contract(self):
        self.bundle['evidence'][0]['runId'] = 'authorized-prior'
        self.assertTrue(self.result()['authorizePass'])
        self.contract['runPolicy']['allowedRunIds'] = ['current']
        self.assertEqual(self.states(self.result())['I_R:e:observation'], 'VIOLATED')

    def test_same_commit_configuration_mismatch_is_a_state_violation(self):
        self.bundle['evidence'][0]['subject']['configurationDigest'] = 'config-B'
        self.assertEqual(self.states(self.result())['I_S:e:observation'], 'VIOLATED')

    def test_unknown_state_and_known_mismatch_keep_violation(self):
        self.bundle['evidence'][0]['subject']['configurationDigest'] = None
        self.assertEqual(self.states(self.result())['I_S:e:observation'], 'UNRESOLVED')
        self.bundle['evidence'][0]['subject']['commit'] = 'other'
        self.assertEqual(self.states(self.result())['I_S:e:observation'], 'VIOLATED')

    def test_missing_reference_violates_reference_but_leaves_integrity_unknown(self):
        (self.root / 'record.txt').unlink()
        states = self.states(self.result())
        self.assertEqual(states['I_E:a:observation:log'], 'VIOLATED')
        self.assertEqual(states['I_I:a:observation:log'], 'UNRESOLVED')

    def test_unavailable_reference_is_unknown_not_confirmed_missing(self):
        self.bundle['evidence'][0]['artifactRefs'][0]['availability'] = 'UNAVAILABLE'
        result = self.result()
        self.assertEqual(result['closureStatus'], 'UNRESOLVED')
        self.assertEqual(self.states(result)['I_E:a:observation:log'], 'UNRESOLVED')

    def test_known_object_mismatch_dominates_unavailable_bytes(self):
        reference = self.bundle['evidence'][0]['artifactRefs'][0]
        reference['availability'] = 'UNAVAILABLE'
        reference['objectId'] = 'known-wrong-object'
        states = self.states(self.result())
        self.assertEqual(states['I_E:a:observation:log'], 'VIOLATED')
        self.assertEqual(states['I_I:a:observation:log'], 'UNRESOLVED')

    def test_construction_ledger_cannot_supply_the_expected_verdict(self):
        module = self.oracle()
        facts = {'bundle': self.bundle, 'artifactRoot': self.root}
        correct = module.label_case(facts, {'name': 'valid'}, self.contract)
        misleading = module.label_case(facts, {'name': 'broken', 'expectedAuthorizePass': False}, self.contract)
        self.assertEqual(correct, misleading)
        self.assertTrue(misleading['expectedAuthorizePass'])

    def test_corrupt_bytes_and_wrong_object_have_distinct_relationships(self):
        (self.root / 'record.txt').write_bytes(b'changed')
        states = self.states(self.result())
        self.assertEqual(states['I_E:a:observation:log'], 'ESTABLISHED')
        self.assertEqual(states['I_I:a:observation:log'], 'VIOLATED')
        self.bundle['evidence'][0]['artifactRefs'][0]['objectId'] = 'another'
        self.assertEqual(self.states(self.result())['I_E:a:observation:log'], 'VIOLATED')

    def test_claim_graph_uses_paths_not_prefix(self):
        self.bundle['evidence'][0]['claimId'] = 'release:looks-related'
        states = self.states(self.result())
        self.assertEqual(states['I_V:e:observation'], 'VIOLATED')
        self.assertEqual(states['I_C:e:observation'], 'VIOLATED')

    def test_claim_rebinding_and_type_combination_retains_all_findings(self):
        e = self.bundle['evidence'][0]
        e['claimId'] = 'unrelated'
        e['evidenceType'] = 'simulation'
        states = self.states(self.result())
        self.assertEqual([states['I_' + i + ':e:observation'] for i in ['V', 'C', 'T']],
                         ['VIOLATED'] * 3)
        self.assertEqual(len(states), 8)

    def test_missing_gate_binding_witness_points_to_contract_collection(self):
        del self.bundle['evidence'][0]['gateId']
        relation = next(r for r in self.result()['relations'] if r['invariant'] == 'I_C')
        self.assertEqual(relation['status'], 'UNRESOLVED')
        self.assertEqual(relation['witnessRefs'], ['/contract/requiredGates', '/evidence/observation/binding'])

    def test_no_artifact_does_not_vacuously_establish_integrity(self):
        self.bundle['evidence'][0]['artifactRefs'] = []
        states = self.states(self.result())
        self.assertEqual(states['I_E:a:observation:required'], 'UNRESOLVED')
        self.assertEqual(states['I_I:a:observation:required'], 'UNRESOLVED')

    def test_empty_evidence_and_fail_dominates_missing_gate(self):
        self.contract['requiredGates'].append({'id': 'missing', 'claimId': 'tested', 'scope': 'x', 'required': True})
        self.bundle['evidence'][0]['outcome'] = 'FAIL'
        result = self.result()
        self.assertEqual(result['gateSatisfaction'], 'UNSATISFIED')
        self.assertEqual(result['closureStatus'], 'VIOLATED')
        self.bundle['evidence'] = []
        self.assertEqual(self.result()['gateSatisfaction'], 'UNRESOLVED')

    def test_sorting_and_equivalent_paths_preserve_relations(self):
        before = self.result()
        self.bundle['evidence'][0]['artifactRefs'][0]['path'] = './record.txt'
        self.contract['claimGraph']['nodes'].reverse()
        self.assertEqual(before, self.result())
        for relation in before['relations']:
            self.assertEqual(relation['witnessRefs'], sorted(relation['witnessRefs']))
            self.assertEqual(relation['reasonCode'], relation['invariant'] + '_' + relation['status'])

    def test_cli_keeps_manifest_metadata_and_resolves_relative_paths(self):
        (self.root / 'bundle.json').write_text(json.dumps(self.bundle), encoding='utf-8')
        (self.root / 'contract.json').write_text(json.dumps(self.contract), encoding='utf-8')
        row = {'caseId': 'opaque', 'baseId': 'base', 'sourceGroup': 'hand', 'split': 'development',
               'bundlePath': 'bundle.json', 'contractPath': 'contract.json', 'artifactRoot': '.'}
        manifest = self.root / 'manifest.jsonl'
        manifest.write_text(json.dumps(row) + '\n', encoding='utf-8')
        self.oracle()
        result = subprocess.run([sys.executable, str(MODULE_PATH), '--cases', str(manifest), '--out', str(self.root / 'labels.jsonl')],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        label = json.loads((self.root / 'labels.jsonl').read_text())
        self.assertEqual((label['baseId'], label['expectedClosure'], label['expectedAuthorizePass']), ('base', 'CLOSED', True))


if __name__ == '__main__':
    unittest.main()
