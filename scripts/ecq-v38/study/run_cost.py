"""Bounded per-runtime cost; stages and raw rounds preserved."""
import importlib.util,json,platform,statistics,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];OUT=ROOT/'artifacts/paper-revision/ecq-v38/cost'
spec=importlib.util.spec_from_file_location('reference',ROOT/'scripts/ecq-v38/reference/reference.py');ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)

def run():
    OUT.mkdir(parents=True,exist_ok=True)
    p=subprocess.run(['node',str(ROOT/'scripts/ecq-v38/study/bench_native.mjs')],cwd=ROOT,capture_output=True,encoding='utf-8',check=True,timeout=750)
    native=json.loads(p.stdout);(OUT/'native.json').write_text(p.stdout+'\n',encoding='utf-8')
    rows=[]
    for size in (1,10,100,256):
        axes=list(range(size));workflow='jobs:\n  test:\n    strategy:\n      matrix:\n        axis: ['+', '.join(map(str,axes))+']\n'
        records=[dict(id=i+1,name=f'test ({i})',conclusion='success',status='completed',type='job',runId=19,runAttempt=1,headSha='controlled-source') for i in axes]
        env=dict(workflow=workflow,workflowIdentity=dict(commit='controlled-source',path='workflow.yml',verified=True),runIdentity=dict(runId=19,runAttempt=1,headSha='controlled-source'),sourceJobs=records,captureInventory=[{k:r[k] for k in ('id','name','runId','runAttempt','headSha')} for r in records])
        start=time.perf_counter();done=0
        for i in range(-5,30):
            if time.perf_counter()-start>180:break
            t0=time.perf_counter();contract=ref.compile_contract(env);t1=time.perf_counter();decision=ref.qualify(env);t2=time.perf_counter();check=ref.check_source(env,contract);t3=time.perf_counter()
            if not decision['authorized'] or not check['valid']:raise ValueError('cost control unexpectedly rejected')
            if i>=0:rows.append(dict(size=size,round=i,compileMs=(t1-t0)*1000,qualifyIncludingRecompileMs=(t2-t1)*1000,certificateCheckMs=(t3-t2)*1000,totalQualificationMs=(t2-t0)*1000));done+=1
        if done!=30:rows.append(dict(size=size,censored=True,completed=done,target=30,budgetSeconds=180))
    python=dict(runtime=platform.python_version(),platform=platform.platform(),warmups=5,rounds=30,rows=rows)
    (OUT/'reference.json').write_text(json.dumps(python,indent=2)+'\n',encoding='utf-8')
    summary=[]
    for method,data in [('native',native),('reference',python)]:
        for size in (1,10,100,256):
            rs=[r for r in data['rows'] if r['size']==size and 'round' in r];entry=dict(method=method,size=size,completed=len(rs),target=30,censored=len(rs)!=30)
            for key in ('compileMs','qualifyIncludingRecompileMs','certificateCheckMs','totalMs','totalQualificationMs'):
                if len(rs)==30 and key in rs[0]:entry[key+'Median']=statistics.median(r[key] for r in rs)
            summary.append(entry)
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8');print(json.dumps(summary,indent=2))
if __name__=='__main__':run()
