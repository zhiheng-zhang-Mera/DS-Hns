"""Development-only field diagnostics; never reads held-out archives."""
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path
import reference as r

ROOT=Path(__file__).resolve().parents[3]
DATA=ROOT/'artifacts/paper-revision/ecq-v38/archive-study'
def compare(a,b,path=''):
    if isinstance(a,dict) and isinstance(b,dict):
        for k in sorted(set(a)|set(b)):
            if k in ('sourceRange','schemaVersion'): continue
            if k not in a or k not in b: yield {'path':path+'/'+k,'reference':a.get(k),'native':b.get(k)}
            else: yield from compare(a[k],b[k],path+'/'+k)
    elif isinstance(a,list) and isinstance(b,list):
        if len(a)!=len(b): yield {'path':path+'/length','reference':len(a),'native':len(b)}
        for i,(x,y) in enumerate(zip(a,b)): yield from compare(x,y,path+'/'+str(i))
    elif type(a)!=type(b) or a!=b: yield {'path':path,'reference':a,'native':b}
def run():
    inputs=json.loads((DATA/'development-inputs.json').read_text())
    native={c['id']:c for c in json.loads((DATA/'development-native.json').read_text())}
    if '--current-native' in sys.argv:
        script="import {compile} from './scripts/ecq-v38/native/index.mjs';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>({id:x.id,contract:compile(x.input)}))));"
        native={c['id']:c for c in json.loads(subprocess.check_output(['node','--input-type=module','-e',script],input=json.dumps(inputs).encode(),cwd=ROOT))}
    cases=[]
    for case in inputs:
        env=case['input']; expected=r.json_ready(r.compile_contract(env)); actual=native[case['id']]['contract']
        actual=dict(actual,dependencies={g['id']:g['needs'] for g in actual['jobGroups']})
        diffs=list(compare(expected,actual))
        cases.append({'id':case['id'],'checkerValid':r.check_source(env,native[case['id']]['contract'])['valid'],'diffs':diffs})
    return {'scope':'80 frozen DEVELOPMENT inputs only; no held-out access','checkerFailures':sum(not c['checkerValid'] for c in cases),'fieldCounts':dict(Counter(d['path'].split('/')[1] for c in cases for d in c['diffs'])),'cases':cases}
if __name__=='__main__': print(json.dumps(run(),indent=2,ensure_ascii=False))
