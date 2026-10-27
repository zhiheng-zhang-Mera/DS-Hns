"""Hand-specified development controls; not labels inferred from a checker."""
import copy, hashlib, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'artifacts/paper-revision/ecq-v38/controls'

def envelope(workflow, jobs, **extra):
    records=[dict(id=i+1,name=name,conclusion=outcome,status='completed',type='job',runId=19,runAttempt=1,headSha='controlled-source') for i,(name,outcome) in enumerate(jobs)]
    x=dict(workflow=workflow,workflowIdentity=dict(commit='controlled-source',path='workflow.yml',verified=True),eventContext={'github':{'event_name':'push'}},workflowCancelled=False,runIdentity=dict(runId=19,runAttempt=1,headSha='controlled-source'),captureInventory=[{k:r[k] for k in ('id','name','runId','runAttempt','headSha')} for r in records],sourceJobs=records)
    x.update(extra);return x

def cases():
    out=[]
    def add(name,workflow,jobs,expected,**extra):out.append(dict(id=name,expectedAuthorized=expected,input=envelope(workflow,jobs,**extra)))
    simple='jobs:\n  test:\n    runs-on: ubuntu-latest\n'
    add('active-success',simple,[('test','success')],True)
    add('active-failure',simple,[('test','failure')],False)
    add('active-cancelled',simple,[('test','cancelled')],False)
    add('active-skipped',simple,[('test','skipped')],False)
    add('active-missing',simple,[],False)
    add('false-empty','jobs:\n  test:\n    if: false\n',[],True)
    add('false-skipped','jobs:\n  test:\n    if: false\n',[('test','skipped')],True)
    add('false-contradiction','jobs:\n  test:\n    if: false\n',[('test','success')],False)
    add('false-nonvacuous','jobs:\n  test:\n    if: false\n',[],False,claimScope='test-execution')
    add('unknown-guard','jobs:\n  test:\n    if: github.event.pull_request.merged\n',[],False)
    add('short-circuit-false','jobs:\n  test:\n    if: github.event_name == \'pull_request\' && github.event.pull_request.merged\n',[],True)
    add('tolerated-failure','jobs:\n  test:\n    continue-on-error: true\n',[('test','failure')],True)
    add('tolerated-missing','jobs:\n  test:\n    continue-on-error: true\n',[],False)
    add('needs-success','jobs:\n  a: {}\n  b:\n    needs: a\n',[('a','success'),('b','success')],True)
    add('needs-skipped','jobs:\n  a:\n    if: false\n  b:\n    needs: a\n',[('a','skipped'),('b','skipped')],True)
    add('tolerated-needs','jobs:\n  a:\n    continue-on-error: true\n  b:\n    needs: a\n',[('a','failure'),('b','success')],True)
    matrix='jobs:\n  test:\n    strategy:\n      matrix:\n        axis: [a, b]\n'
    add('matrix-all',matrix,[('test (a)','success'),('test (b)','success')],True)
    add('matrix-missing',matrix,[('test (a)','success')],False)
    add('matrix-false-placeholder','jobs:\n  test:\n    if: false\n    strategy:\n      matrix:\n        axis: [a, b]\n',[('test','skipped')],True)
    add('matrix-include-metadata',matrix+'        include:\n          - axis: a\n            extra: true\n',[('test (a)','success'),('test (b)','success')],True)
    add('matrix-exclude',matrix+'        exclude:\n          - axis: b\n',[('test (a)','success')],True)
    add('matrix-name-fallback',"jobs:\n  test:\n    name: ${{ matrix.label || matrix.python }}\n    strategy:\n      matrix:\n        include:\n          - python: '3.14'\n          - python: '3.13'\n            label: Windows\n",[('3.14','success'),('Windows','success')],True)
    add('duplicate-binding',simple,[('test','success'),('test','success')],False)
    add('unmatched-capture',simple,[('test','success'),('other','failure')],False)
    add('unverified-source',simple,[('test','success')],False,workflowIdentity=dict(commit='controlled-source',path='workflow.yml',verified=False))
    for field,value in [('runId',20),('runAttempt',2),('headSha','wrong'),('name','wrong'),('status','in_progress'),('type','step')]:
        c=copy.deepcopy(out[0]);c['id']='wrong-'+field;c['expectedAuthorized']=False;c['input']['sourceJobs'][0][field]=value;out.append(c)
    for key in ('constructor','toString','hasOwnProperty','__proto__'):
        add('prototype-job-'+key,f'jobs:\n  {key}: {{}}\n',[],False)
    add('prototype-context',"jobs:\n  test:\n    if: github.constructor == null\n",[],False,eventContextComplete=True)
    add('inactive-name-collision','jobs:\n  a:\n    name: shared\n    if: false\n  b:\n    name: shared\n    if: false\n',[('shared','skipped')],False)
    child="on:\n  workflow_call:\n    inputs:\n      label:\n        type: string\n        required: true\njobs:\n  test:\n    name: ${{ inputs.label }}\n"
    uses='example/project/.github/workflows/child.yml@'+'b'*40
    definition=dict(workflow=child,workflowIdentity=dict(repository='example/project',path='.github/workflows/child.yml',commit='b'*40,verified=True))
    caller=f"jobs:\n  call:\n    uses: {uses}\n    with:\n      label: unit\n"
    add('pinned-reuse',caller,[('call / unit','success')],True,reusableDefinitions={uses:definition})
    add('pinned-reuse-missing',caller,[],False,reusableDefinitions={uses:definition})
    add('pinned-reuse-unresolved',caller,[('call / unit','success')],False)
    add('pinned-reuse-root-unknown',caller,[('call / unit','success')],False,reusableDefinitions={uses:definition},workflowIdentity=dict(commit='controlled-source',path='workflow.yml',verified=False))
    add('false-unresolved-reuse',f'jobs:\n  call:\n    if: false\n    uses: {uses}\n',[],False)
    add('false-dynamic-matrix',"jobs:\n  test:\n    if: false\n    strategy:\n      matrix: ${{ github.event.matrix }}\n",[],False)
    add('incomplete-empty-capture','jobs:\n  test:\n    if: false\n',[],False,captureComplete=False)
    add('generated-needs-output',"jobs:\n  first:\n    outputs:\n      flag: go\n  second:\n    needs: first\n    if: needs.first.outputs.flag == 'go'\n",[('first','success')],False,eventContextComplete=True,claimScope='test-execution')
    axis_gold={'active-success':('CLOSED','SAT'),'active-failure':('CLOSED','UNSAT'),'active-cancelled':('CLOSED','UNSAT'),'active-skipped':('CLOSED','UNSAT'),'active-missing':('OPEN','UNKNOWN'),'false-empty':('CLOSED','SAT'),'false-skipped':('CLOSED','SAT'),'false-nonvacuous':('CLOSED','UNSAT'),'unknown-guard':('OPEN','UNKNOWN'),'unverified-source':('OPEN','SAT'),'generated-needs-output':('OPEN','UNKNOWN')}
    for case in out:
        if case['id'] in axis_gold:case['expectedClosure'],case['expectedGate']=axis_gold[case['id']]
    return out

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    raw=(json.dumps(cases(),ensure_ascii=False,indent=2)+'\n').encode()
    (OUT/'development.json').write_bytes(raw)
    (OUT/'development.freeze.json').write_text(json.dumps({'schema':'ecq-v38-controls/1','cases':len(cases()),'sha256':hashlib.sha256(raw).hexdigest(),'labels':'hand-specified authorization; not implementation-derived','scope':'development controls, not held-out real-archive performance'},indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'cases':len(cases()),'sha256':hashlib.sha256(raw).hexdigest()}))
