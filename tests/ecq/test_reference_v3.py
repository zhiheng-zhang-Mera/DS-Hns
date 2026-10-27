"""Current independent oracle boundary controls; frozen predecessor is untouched."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]


class CurrentReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        (self.root/'evidence.txt').write_bytes(b'observation')
        self.contract={'contractId':'hand-control','statePolicy':{'repositoryId':'repo','commit':'code','tree':'tree','configurationDigest':'configuration'},
            'runPolicy':{'allowedRunIds':['run']},'requiredGates':[{'id':'g','claimId':'tested','scope':'tests','required':True}],
            'claimGraph':{'nodes':['tested','whole'],'edges':[['tested','whole']]},'requestedClaim':'whole',
            'admissibleTypes':{'types':['execution'],'provenance':['runner']}}
        self.bundle={'caseId':'opaque','evidence':[{'id':'e','subject':copy.deepcopy(self.contract['statePolicy']),
            'runId':'run','gateId':'g','claimId':'tested','scope':'tests','outcome':'PASS','evidenceType':'execution','provenance':'runner',
            'artifactRefs':[{'id':'a','path':'evidence.txt','objectId':'object','expectedObjectId':'object','sha256':hashlib.sha256(b'observation').hexdigest()}]}]}

    def tearDown(self):self.temp.cleanup()

    def reference(self):
        p=ROOT/'scripts/ecq/corpus/reference_labels_v3.py'
        self.assertTrue(p.is_file(),'current amended independent reference must exist')
        spec=importlib.util.spec_from_file_location('reference_v3',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        return m.evaluate(self.bundle,self.contract,self.root)

    def state(self):return next(r['status'] for r in self.reference()['relations'] if r['invariant']=='I_S')

    def test_empty_state_policy_is_unresolved(self):
        self.contract['statePolicy']={}
        self.assertEqual(self.state(),'UNRESOLVED')
        self.assertEqual(self.reference()['closureStatus'],'UNRESOLVED')
        self.assertFalse(self.reference()['authorizePass'])

    def test_missing_state_fact_is_unresolved(self):
        del self.bundle['evidence'][0]['subject']['commit']
        self.assertEqual(self.state(),'UNRESOLVED')

    def test_known_state_mismatch_dominates_other_missing_fact(self):
        self.bundle['evidence'][0]['subject']['commit']=None
        self.bundle['evidence'][0]['subject']['configurationDigest']='different'
        self.assertEqual(self.state(),'VIOLATED')

    def test_legitimate_fail_remains_closed(self):
        self.bundle['evidence'][0]['outcome']='FAIL'
        r=self.reference()
        self.assertEqual((r['closureStatus'],r['gateSatisfaction'],r['authorizePass']),('CLOSED','UNSATISFIED',False))


if __name__=='__main__':unittest.main()
