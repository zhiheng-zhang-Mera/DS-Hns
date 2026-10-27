import importlib.util
import json
from pathlib import Path
import hashlib
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    file = ROOT / 'scripts/ecq' / (name + '.py')
    if not file.exists():
        return None
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CampaignAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.manifest = [
            {'caseId': 'valid', 'baseId': 'one', 'sourceGroup': 'controlled', 'family': 'pass'},
            {'caseId': 'invalid', 'baseId': 'one', 'sourceGroup': 'controlled', 'family': 'S'},
            {'caseId': 'fail', 'baseId': 'two', 'sourceGroup': 'controlled', 'family': 'fail'},
        ]
        self.labels = [
            {'caseId': 'valid', 'expectedClosure': 'CLOSED', 'expectedGateSatisfaction': 'SATISFIED', 'expectedAuthorizePass': True, 'relations': []},
            {'caseId': 'invalid', 'expectedClosure': 'VIOLATED', 'expectedGateSatisfaction': 'SATISFIED', 'expectedAuthorizePass': False,
             'relations': [{'obligationId': 'I_S:e:x', 'invariant': 'I_S', 'status': 'VIOLATED', 'witnessRefs': ['/a']}]},
            {'caseId': 'fail', 'expectedClosure': 'CLOSED', 'expectedGateSatisfaction': 'UNSATISFIED', 'expectedAuthorizePass': False, 'relations': []},
        ]
        self.attempts = []
        for method in ['B0', 'ECQ']:
            for label in self.labels:
                result = {'authorizePass': label['expectedAuthorizePass'], 'closureStatus': label['expectedClosure'],
                          'gateSatisfaction': label['expectedGateSatisfaction'], 'relations': label['relations']}
                if method == 'B0':
                    result = {'authorizePass': label['caseId'] != 'fail', 'closureStatus': None,
                              'gateSatisfaction': None, 'relations': None}
                self.attempts.append({'campaignId': 'hand', 'caseId': label['caseId'], 'methodId': method,
                    'methodRevision': 'revision', 'attemptId': 1, 'executionStatus': 'COMPLETED', 'exitCode': 0,
                    'capabilities': {'authorization': True, 'closure': method == 'ECQ', 'gateSatisfaction': method == 'ECQ',
                                     'relationDiagnostics': method == 'ECQ', 'witnesses': method == 'ECQ'}, 'result': result})
        self.manifest_file = self.root / 'manifest.jsonl'
        self.manifest_file.write_text(''.join(json.dumps(x)+'\n' for x in self.manifest))
        self.freeze_file = self.root / 'freeze.json'
        self.freeze_file.write_text(json.dumps({'files': {}}))
        self.campaign = {'campaignId': 'hand', 'methodRevision': 'revision', 'methods': ['B0', 'ECQ'],
                         'manifestPath': 'manifest.jsonl', 'manifestSha256': hashlib.sha256(self.manifest_file.read_bytes()).hexdigest(),
                         'freezeSha256': hashlib.sha256(self.freeze_file.read_bytes()).hexdigest()}

    def tearDown(self):
        self.temp.cleanup()

    def write_campaign(self):
        (self.root/'campaign.json').write_text(json.dumps(self.campaign))
        (self.root/'attempts.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in self.attempts))

    def verifier(self):
        module = load('verify-campaign')
        self.assertIsNotNone(module, 'campaign verifier must exist')
        return module

    def analyzer(self):
        module = load('analyze')
        self.assertIsNotNone(module, 'independent analyzer must exist')
        return module

    def test_exact_membership_accepts_complete_grid(self):
        self.write_campaign()
        report = self.verifier().verify(self.root, self.freeze_file)
        self.assertEqual(report['expectedOutputs'], 6)
        self.assertTrue(report['verified'])

    def test_missing_record_rejected(self):
        self.attempts.pop()
        self.write_campaign()
        with self.assertRaises(ValueError): self.verifier().verify(self.root, self.freeze_file)

    def test_duplicate_record_rejected(self):
        self.attempts.append(self.attempts[0])
        self.write_campaign()
        with self.assertRaises(ValueError): self.verifier().verify(self.root, self.freeze_file)

    def test_wrong_revision_rejected(self):
        self.attempts[0]['methodRevision'] = 'other'
        self.write_campaign()
        with self.assertRaises(ValueError): self.verifier().verify(self.root, self.freeze_file)

    def test_changed_input_digest_rejected(self):
        self.manifest_file.write_text(self.manifest_file.read_text()+'\n')
        self.write_campaign()
        with self.assertRaises(ValueError): self.verifier().verify(self.root, self.freeze_file)

    def test_error_is_retained_but_not_a_correct_rejection(self):
        row = next(r for r in self.attempts if r['methodId']=='ECQ' and r['caseId']=='invalid')
        row.update(executionStatus='RUNTIME_ERROR', exitCode=2, result=None)
        self.write_campaign()
        self.assertEqual(self.verifier().verify(self.root, self.freeze_file)['executionFailures'], 1)
        summary = self.analyzer().analyze(self.manifest, self.attempts, self.labels, bootstrap_repetitions=100)
        ecq = summary['methods']['ECQ']
        self.assertEqual(ecq['authorizationAccuracy'], {'numerator': 2, 'denominator': 3, 'rate': 2/3})
        self.assertEqual(ecq['falseAuthorization']['unfinished'], 1)
        self.assertEqual(ecq['executionFailures'], 1)

    def test_success_axes_diagnostics_and_paired_clusters(self):
        summary = self.analyzer().analyze(self.manifest, self.attempts, self.labels, bootstrap_repetitions=100)
        ecq, b0 = summary['methods']['ECQ'], summary['methods']['B0']
        self.assertEqual(ecq['semanticMatch']['numerator'], 3)
        self.assertEqual(ecq['diagnostics']['all']['f1'], 1)
        self.assertEqual(ecq['witnesses']['rate'], 1)
        self.assertEqual(b0['falseAuthorization']['rate'], 1)
        self.assertIsNone(b0['semanticMatch'])
        comparison = summary['pairedBootstrap'][0]
        self.assertEqual(comparison['clusters'], 2)
        self.assertEqual(comparison['repetitions'], 100)

    def test_wrong_witness_is_not_correct_diagnosis_witness(self):
        next(r for r in self.attempts if r['methodId']=='ECQ' and r['caseId']=='invalid')['result']['relations'] = [
            {'obligationId': 'I_S:e:x', 'invariant': 'I_S', 'status': 'VIOLATED', 'witnessRefs': ['/wrong']}]
        summary = self.analyzer().analyze(self.manifest, self.attempts, self.labels, bootstrap_repetitions=10)
        self.assertEqual(summary['methods']['ECQ']['diagnostics']['all']['f1'], 1)
        self.assertEqual(summary['methods']['ECQ']['witnesses']['rate'], 0)


if __name__ == '__main__': unittest.main()
