"""Profile boundary controls authored separately after v1 freeze.

No oracle/native predicates are imported. Expected relation states follow the
published profile interface; fixture facts are explicit in each test.
"""
import hashlib, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/ecq/baselines/shacl'))

class ShaclBoundaries(unittest.TestCase):
    def setUp(self):
        import run
        self.engine = run
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.outer = Path(self.temp.name)
        self.root = self.outer / 'artifacts'
        self.root.mkdir()
        (self.root / 'a.bin').write_bytes(b'explicit observation')
        (self.outer / 'outside.bin').write_bytes(b'explicit observation')
        state = {'repositoryId':'project', 'commit':'abc', 'tree':'def', 'configurationDigest':'cfg'}
        self.contract = {
            'contractId':'boundary-contract', 'statePolicy':dict(state),
            'runPolicy':{'allowedRunIds':['run-1']},
            'requiredGates':[{'id':'gate', 'claimId':'local', 'scope':'job', 'required':True}],
            'claimGraph':{'nodes':['local','whole'], 'edges':[['local','whole']]},
            'requestedClaim':'whole', 'admissibleTypes':{'types':['execution'], 'provenance':['ci']}}
        self.evidence = {
            'id':'e', 'subject':dict(state), 'runId':'run-1', 'gateId':'gate',
            'claimId':'local', 'scope':'job', 'outcome':'PASS',
            'evidenceType':'execution', 'provenance':'ci',
            'artifactRefs':[{'id':'ref', 'path':'a.bin', 'objectId':'object',
                            'expectedObjectId':'object',
                            'sha256':hashlib.sha256(b'explicit observation').hexdigest()}]}
        self.bundle = {'caseId':'opaque-boundary', 'evidence':[self.evidence]}

    def status(self, invariant):
        result = self.engine.evaluate(self.bundle, self.contract, self.root)
        return next(r['status'] for r in result['relations'] if r['invariant'] == invariant)

    def test_empty_state_policy_is_unknown_not_established(self):
        self.contract['statePolicy'] = {}
        self.assertEqual(self.status('I_S'), 'UNRESOLVED')

    def test_missing_allowed_runs_is_unknown_not_disallowed(self):
        self.contract['runPolicy'] = {}
        self.assertEqual(self.status('I_R'), 'UNRESOLVED')

    def test_missing_allowed_types_is_unknown_not_disallowed(self):
        del self.contract['admissibleTypes']['types']
        self.assertEqual(self.status('I_T'), 'UNRESOLVED')

    def test_missing_allowed_provenance_is_unknown_not_disallowed(self):
        del self.contract['admissibleTypes']['provenance']
        self.assertEqual(self.status('I_T'), 'UNRESOLVED')

    def test_reflexive_path_does_not_declare_an_unknown_claim_node(self):
        self.evidence['claimId'] = 'undeclared'
        self.contract['requestedClaim'] = 'undeclared'
        self.contract['requiredGates'][0]['claimId'] = 'undeclared'
        self.assertEqual(self.status('I_V'), 'VIOLATED')

    def test_missing_claim_graph_is_unknown(self):
        del self.contract['claimGraph']
        self.assertEqual(self.status('I_V'), 'UNRESOLVED')

    def test_missing_expected_gate_claim_is_unknown_binding(self):
        del self.contract['requiredGates'][0]['claimId']
        self.assertEqual(self.status('I_C'), 'UNRESOLVED')

    def test_missing_expected_gate_scope_is_unknown_binding(self):
        del self.contract['requiredGates'][0]['scope']
        self.assertEqual(self.status('I_C'), 'UNRESOLVED')

    def test_parent_traversal_is_unavailable_not_confirmed_missing(self):
        self.evidence['artifactRefs'][0]['path'] = '../outside.bin'
        self.assertEqual(self.status('I_E'), 'UNRESOLVED')
        self.assertEqual(self.status('I_I'), 'UNRESOLVED')

    def test_absolute_path_inside_root_is_unavailable(self):
        self.evidence['artifactRefs'][0]['path'] = str(self.root / 'a.bin')
        self.assertEqual(self.status('I_E'), 'UNRESOLVED')
        self.assertEqual(self.status('I_I'), 'UNRESOLVED')

    def test_unsupported_engine_feature_is_not_generic_runtime_failure(self):
        with patch.object(self.engine, 'validate', side_effect=NotImplementedError('unsupported test feature')):
            result = self.engine.execute(self.bundle, self.contract, self.root)
        self.assertEqual(result['executionStatus'], 'UNSUPPORTED')
        self.assertEqual(result['exitCode'], 3)
        self.assertIsNone(result['result'])

    def test_known_disallowed_type_dominates_missing_provenance(self):
        self.evidence['evidenceType'] = 'simulation'
        del self.evidence['provenance']
        self.assertEqual(self.status('I_T'), 'VIOLATED')

    def test_unknown_gate_binding_is_violated_even_with_missing_scope(self):
        self.evidence['gateId'] = 'unlisted'
        del self.evidence['scope']
        self.assertEqual(self.status('I_C'), 'VIOLATED')

if __name__ == '__main__':
    unittest.main()
