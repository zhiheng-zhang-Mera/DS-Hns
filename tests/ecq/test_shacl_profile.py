import unittest,sys,tempfile,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts/ecq/baselines/shacl'))
class ShaclTests(unittest.TestCase):
 def test_real_shacl_semantic_controls(self):
  from run import evaluate
  with tempfile.TemporaryDirectory() as td:
   p=Path(td);(p/'a').write_bytes(b'ok');s={'repositoryId':'r','commit':'c','configurationDigest':'x'}
   c={'statePolicy':s,'runPolicy':{'allowedRunIds':['r1','r0']},'requiredGates':[{'id':'g','claimId':'local','scope':'job','required':True}],'claimGraph':{'nodes':['local','whole'],'edges':[['local','whole']]},'requestedClaim':'whole','admissibleTypes':{'types':['execution'],'provenance':['ci']}}
   e={'id':'e','subject':dict(s),'runId':'r0','gateId':'g','claimId':'local','scope':'job','outcome':'PASS','evidenceType':'execution','provenance':'ci','artifactRefs':[{'id':'a','path':'a','objectId':'o','expectedObjectId':'o','sha256':hashlib.sha256(b'ok').hexdigest()}]};b={'caseId':'opaque','evidence':[e]}
   self.assertTrue(evaluate(b,c,p)['authorizePass']);e['outcome']='FAIL';r=evaluate(b,c,p);self.assertEqual((r['closureStatus'],r['gateSatisfaction'],r['authorizePass']),('CLOSED','UNSATISFIED',False))
   e['outcome']='PASS';e['subject']['configurationDigest']='different';r=evaluate(b,c,p);self.assertEqual(r['closureStatus'],'VIOLATED');e['subject']=dict(s)
   e['artifactRefs'][0]['availability']='MISSING';r=evaluate(b,c,p);d={x['invariant']:x['status'] for x in r['relations']};self.assertEqual(d['I_E'],'VIOLATED');self.assertEqual(d['I_I'],'UNRESOLVED')
   e['artifactRefs'][0]['availability']='UNAVAILABLE';e['artifactRefs'][0]['objectId']='wrong';self.assertEqual({x['invariant']:x['status'] for x in evaluate(b,c,p)['relations']}['I_E'],'VIOLATED')
 def test_capability_and_execution_failure_are_distinct(self):
  from run import execute
  r=execute({'bad':1},{},'absent');self.assertEqual(r['executionStatus'],'RUNTIME_ERROR');self.assertIsNone(r['result'])
if __name__=='__main__':unittest.main()
