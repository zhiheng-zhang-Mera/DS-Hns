import copy
import importlib.util
import itertools
import json
import pathlib
import subprocess
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('reference',ROOT/'scripts/ecq-v38/reference/reference.py')
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)

def case(workflow='jobs:\n  test:\n    runs-on: ubuntu-latest\n'):
    e={'workflow':workflow,'workflowIdentity':{'verified':True},'runIdentity':{'runId':1,'runAttempt':1,'headSha':'abc'},'eventContext':{}}
    c=r.compile_contract(e)
    e['sourceJobs']=[dict(id=n,name=i['names'][0],conclusion='success',type='job',status='completed',runId=1,runAttempt=1,headSha='abc') for n,i in enumerate(c['instances'])]
    e['captureInventory']=r.freeze_inventory(c,e['sourceJobs'])
    return e

class ReferenceTests(unittest.TestCase):
    def test_raw_tolerance_and_independent_gate_axes(self):
        e=case('jobs:\n  test:\n    strategy:\n      matrix:\n        tolerated: [true, false]\n    continue-on-error: ${{ matrix.tolerated }}\n')
        self.assertEqual(r.compile_contract(e)['instances'][0]['continueOnError'],'${{ matrix.tolerated }}')
        e['sourceJobs'][0]['conclusion']='failure'
        self.assertTrue(r.qualify(e)['authorized'])
        e['workflowIdentity']['verified']=False
        q=r.qualify(e); self.assertEqual((q['closure'],q['gate'],q['authorized']),('OPEN','SAT',False))
        e['sourceJobs'][1]['conclusion']='failure'
        q=r.qualify(e); self.assertEqual((q['closure'],q['gate']),('OPEN','UNSAT'))
        e['sourceJobs'][1].pop('conclusion'); self.assertEqual(r.qualify(e)['gate'],'UNKNOWN')
        e['sourceJobs'][0]['conclusion']='failure'; e['sourceJobs'][0].pop('runId')
        self.assertEqual(r.qualify(e)['gate'],'UNKNOWN')
        e=case('jobs:\n  a: {}\n  b: {if: github.unavailable}\n'); e['sourceJobs'][0]['conclusion']='failure'
        self.assertEqual(r.qualify(e)['gate'],'UNSAT')
    def test_pinned_reusable_expansion_and_missing_definition(self):
        sha='a'*40
        e=case('jobs:\n  call:\n    strategy:\n      matrix:\n        os: [linux, windows]\n    uses: owner/repo/.github/workflows/child.yml@'+sha+'\n    with:\n      platform: ${{ matrix.os }}\n')
        e['reusableDefinitions']={'owner/repo/.github/workflows/child.yml@'+sha:{'workflow':"on:\n  workflow_call:\n    inputs:\n      platform: {type: string, required: true}\njobs:\n  check:\n    name: Check ${{ inputs.platform }}\n",'workflowIdentity':{'repository':'owner/repo','path':'.github/workflows/child.yml','commit':sha,'verified':True}}}
        c=r.compile_contract(e)
        self.assertEqual([i['names'] for i in c['instances']],[['call (linux) / Check linux'],['call (windows) / Check windows']])
        self.assertEqual(c['unresolvedFeatures'],[])
        e['sourceJobs']=[dict(id=n,name=i['names'][0],conclusion='success',type='job',status='completed',runId=1,runAttempt=1,headSha='abc') for n,i in enumerate(c['instances'])]
        e['captureInventory']=r.freeze_inventory(c,e['sourceJobs'])
        self.assertTrue(r.qualify(e)['authorized'])
        forged=copy.deepcopy(c); forged['jobGroups'][1]['parentGroup']='forged'
        self.assertFalse(r.check_source(e,forged)['valid'])
        e['sourceJobs'].pop(); self.assertFalse(r.qualify(e)['authorized'])
        e['workflow']=e['workflow'].replace('os: [linux, windows]','os: [1, 2]')
        illtyped=r.compile_contract(e)
        self.assertEqual(len(illtyped['instances']),2)
        self.assertTrue(illtyped['jobGroups'][0]['unsupported'])
        self.assertEqual([g['id'] for g in illtyped['jobGroups'] if g['unsupported']],['call'])
        self.assertFalse(r.qualify(e)['authorized'])
        del e['reusableDefinitions']; self.assertTrue(r.compile_contract(e)['unresolvedFeatures'])
    def test_local_nested_reuse_pin_and_source_universe(self):
        sha='b'*40
        e=case('jobs:\n  outer:\n    uses: ./.github/workflows/a.yml\n')
        e['workflowIdentity']={'repository':'owner/repo','commit':sha,'verified':True}
        e['reusableDefinitions']={
          './.github/workflows/a.yml':{'workflow':'on: {workflow_call: {}}\njobs:\n  inner:\n    uses: ./.github/workflows/b.yml\n','workflowIdentity':{'repository':'owner/repo','commit':sha,'path':'.github/workflows/a.yml','verified':True}},
          './.github/workflows/b.yml':{'workflow':'on: {workflow_call: {}}\njobs:\n  one: {}\n  two: {needs: one}\n','workflowIdentity':{'repository':'owner/repo','commit':sha,'path':'.github/workflows/b.yml','verified':True}}}
        c=r.compile_contract(e)
        self.assertEqual([i['id'] for i in c['instances']],['outer[0]/inner[0]/one[0]','outer[0]/inner[0]/two[0]'])
        self.assertEqual([i['names'] for i in c['instances']],[['outer / inner / one'],['outer / inner / two']])
        e['sourceJobs']=[dict(id=n,name=i['names'][0],conclusion='success',type='job',status='completed',runId=1,runAttempt=1,headSha='abc') for n,i in enumerate(c['instances'])]
        e['captureInventory']=r.freeze_inventory(c,e['sourceJobs'])
        self.assertTrue(r.qualify(e)['authorized'])
        leaf=c['instances'][0]['sourceWitness']
        self.assertEqual(leaf['workflowIdentity']['path'],'.github/workflows/b.yml')
        self.assertEqual(len(leaf['callerChain']),2)
        script="import {compile} from './scripts/ecq-v38/native/index.mjs';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(compile(JSON.parse(s))));"
        native=json.loads(subprocess.check_output(['node','--input-type=module','-e',script],input=json.dumps(e).encode(),cwd=ROOT))
        self.assertTrue(r.check_source(e,native)['valid'])
        e['workflowIdentity']['verified']=False
        self.assertEqual(len(r.compile_contract(e)['instances']),2)
        self.assertFalse(r.qualify(e)['authorized'])
        e['workflowIdentity']['verified']=True
        e['reusableDefinitions']['./.github/workflows/b.yml']['workflowIdentity']['commit']='c'*40
        self.assertFalse(r.qualify(e)['authorized'])
    def test_quoted_status_text_keeps_implicit_success(self):
        e=case("jobs:\n  a: {}\n  b:\n    needs: a\n    if: ${{ 'failure()' == 'failure()' }}\n")
        e['sourceJobs'][0]['conclusion']='failure'
        self.assertFalse(r.qualify(e)['authorized'])
    def test_native_certificate_semantic_projection(self):
        here=pathlib.Path(__file__).parent
        env=json.loads((here/'cross_fixture.json').read_text())
        contract=json.loads((here/'native_contract_check.json').read_text())['contract']
        self.assertTrue(r.check_source(env,contract)['valid'])
        contract['instances'].pop()
        self.assertFalse(r.check_source(env,contract)['valid'])
    def test_native_reuse_certificate_and_trust_metadata_attacks(self):
        here=pathlib.Path(__file__).parent
        env=json.loads((here/'reuse_fixture.json').read_text())
        contract=json.loads((here/'native_reuse_check.json').read_text())['contract']
        self.assertTrue(r.check_source(env,contract)['valid'])
        for key in ('workflowIdentity','callerPath','callerMatrixIndex','callerChain'):
            forged=copy.deepcopy(contract); forged['instances'][0]['sourceWitness'].pop(key)
            self.assertFalse(r.check_source(env,forged)['valid'])
        forged=copy.deepcopy(contract); forged['sourceIdentities'].pop()
        self.assertFalse(r.check_source(env,forged)['valid'])
        forged=copy.deepcopy(contract); forged['jobGroups'][0]['reusableIdentity']['commit']='f'*40
        self.assertFalse(r.check_source(env,forged)['valid'])
    def test_matrix_bound_and_claim_scope(self):
        matrix={'a':list(range(17)),'b':list(range(17))}
        self.assertTrue(r.matrix_rows(matrix)[1])
        rows,issues=r.matrix_rows({'os':['linux'],'exclude':[{'os':'LINUX'}]})
        self.assertEqual(len(rows),1)
        rows,issues=r.matrix_rows({'n':[1],'exclude':[{'n':'1'}]})
        self.assertEqual(len(rows),1)
        e=case('jobs:\n  a:\n    if: false\n'); e['sourceJobs']=[]; e['captureInventory']=[]
        self.assertTrue(r.qualify(e)['authorized'])
        e['claimScope']='test-execution'; self.assertFalse(r.qualify(e)['authorized'])
        self.assertEqual((r.qualify(e)['closure'],r.qualify(e)['gate']),('CLOSED','UNSAT'))
        e['claimScope']='workflow-conformity'
        for flag in (False,{'$unknown':True},None):
            e['captureComplete']=flag; self.assertFalse(r.qualify(e)['authorized'])
        e['captureComplete']=True; self.assertTrue(r.qualify(e)['authorized'])
        e=case(); e['workflow']='jobs:\n  test:\n    if: false\n    strategy:\n      matrix: ${{ fromJSON(github.unavailable) }}\n'
        c=r.compile_contract(e)
        self.assertEqual(len(c['instances']),1)
        self.assertEqual(c['instances'][0]['names'],[])
        self.assertFalse(r.qualify(e)['authorized'])
    def test_operand_values_and_types(self):
        for text,want in [("true && 'Windows' || 'Linux'",'Windows'),("null == 0",True),("'ABC' == 'abc'",True),("'2' == 2",True),("'false' && 7",7),("matrix.absent || 'fallback'",'fallback')]:
            self.assertEqual(r.evaluate(text,{'matrix':{}}),want)
        self.assertIs(r.evaluate('github.event.pull_request.user.login',{'github':{}}),r.U)
        self.assertIs(r.evaluate('unsupported(1)',{}),r.U)
        self.assertTrue(r.evaluate("'0xff' == 255",{}))
        self.assertTrue(r.evaluate("' ' == 0",{}))
        self.assertIs(r.evaluate("(missing && false) == false",{}),r.U)
        self.assertIs(r.evaluate("needs.a.outputs.flag == 'yes'",{'needs':{'a':{'result':'success'}},'$complete':True}),r.U)
    def test_yaml12_and_matrix(self):
        e=case('on: push\njobs:\n  test:\n    strategy:\n      matrix:\n        python: ["3.11", "3.12"]\n        os: [linux, windows]\n        exclude: [{python: "3.11", os: windows}]\n        include: [{python: "3.12", extra: true}, {python: "3.13", os: linux}]\n')
        c=r.compile_contract(e)
        self.assertEqual(len(c['instances']),4)
        self.assertEqual(c['instances'][1]['matrix']['extra'],True)
        self.assertTrue(r.qualify(e)['authorized'])
    def test_duplicate_ambiguity_cannot_be_deleted(self):
        e=case(); duplicate=dict(e['sourceJobs'][0],id=99)
        e['sourceJobs'].append(duplicate); e['captureInventory']=r.freeze_inventory(r.compile_contract(e),e['sourceJobs'])
        self.assertFalse(r.qualify(e)['authorized'])
        e['sourceJobs'].pop()
        self.assertFalse(r.qualify(e)['authorized'])
    def test_surplus_malformed_deletion(self):
        e=case(); e['sourceJobs'].append({'id':99,'name':'extra','type':'malformed'})
        e['captureInventory']=r.freeze_inventory(r.compile_contract(e),e['sourceJobs'])
        self.assertFalse(r.qualify(e)['authorized'])
        e['sourceJobs'].pop(); self.assertFalse(r.qualify(e)['authorized'])
    def test_unknown_guard_and_zero_active(self):
        e=case('jobs:\n  test:\n    if: github.event.missing\n')
        self.assertFalse(r.qualify(e)['authorized'])
        e=case('jobs:\n  test:\n    if: false\n'); e['sourceJobs']=[]; e['captureInventory']=[]
        self.assertTrue(r.qualify(e)['authorized'])
        self.assertFalse(r.qualify(e,nonvacuity=True)['authorized'])
    def test_inactive_captured_obligations(self):
        e=case('jobs:\n  test:\n    if: false\n    strategy:\n      matrix:\n        os: [linux, windows]\n')
        e['sourceJobs']=[dict(id=0,name='test',conclusion='skipped',type='job',status='completed',runId=1,runAttempt=1,headSha='abc')]
        e['captureInventory']=r.freeze_inventory(r.compile_contract(e),e['sourceJobs'])
        self.assertTrue(r.qualify(e)['authorized'])
        e['sourceJobs'][0]['conclusion']='success'; self.assertFalse(r.qualify(e)['authorized'])
        e['sourceJobs']=[]; self.assertFalse(r.qualify(e)['authorized'])
    def test_source_checker_detects_omission_and_matrix_tamper(self):
        e=case(); c=r.compile_contract(e)
        self.assertTrue(r.check_source(e,c)['valid'])
        c['instances']=[]; self.assertFalse(r.check_source(e,c)['valid'])
        self.assertFalse(r.qualify(e,contract=c)['authorized'])
        c=r.compile_contract(e); c['jobGroups']=[]; self.assertFalse(r.check_source(e,c)['valid'])
        c=r.compile_contract(e); c['instances'][0]['names']=['forged']; self.assertFalse(r.check_source(e,c)['valid'])
        c=r.compile_contract(e); c['instances'][0]['sourceWitness']['path']=['jobs','forged']; self.assertFalse(r.check_source(e,c)['valid'])
        c=r.compile_contract(e); c['instances'][0]['continueOnError']=True; self.assertFalse(r.check_source(e,c)['valid'])
        c=r.compile_contract(e); c['jobGroups'][0]['placeholderName']='forged'; self.assertFalse(r.check_source(e,c)['valid'])
        c=r.compile_contract(e); c['sourceWitnesses']=[]; self.assertFalse(r.check_source(e,c)['valid'])
    def test_dag_tolerance_and_missing_predecessor(self):
        e=case('jobs:\n  first:\n    continue-on-error: true\n  second:\n    needs: first\n')
        e['sourceJobs'][0]['conclusion']='failure'
        self.assertTrue(r.qualify(e)['authorized'])
        e['sourceJobs'].pop(0); self.assertFalse(r.qualify(e)['authorized'])
        with self.assertRaises(ValueError): r.compile_contract({'workflow':'jobs: {a: {needs: b}, b: {needs: a}}'})
    def test_exhaustive_fact_erasures(self):
        e=case('jobs:\n  a: {}\n  b: {needs: a}\n')
        keys=[(n,k) for n in range(2) for k in ('conclusion','runId','runAttempt')]
        for mask in itertools.product((False,True),repeat=len(keys)):
            erased=copy.deepcopy(e)
            for flag,(n,k) in zip(mask,keys):
                if flag: erased['sourceJobs'][n].pop(k)
            self.assertEqual(r.qualify(erased)['authorized'],not any(mask))

if __name__=='__main__': unittest.main()
