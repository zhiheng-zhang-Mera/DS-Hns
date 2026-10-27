"""Execute the frozen hand controls and fixed-inventory erasure checks."""
import copy, importlib.util, itertools, json, subprocess, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('independent_reference',ROOT/'scripts/ecq-v38/reference/reference.py')
ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)
OUT=ROOT/'artifacts/paper-revision/ecq-v38/controls'

def native(cases,path):
    path.write_text(json.dumps(cases),encoding='utf-8')
    p=subprocess.run(['node',str(ROOT/'scripts/ecq-v38/study/native_batch.mjs'),str(path)],cwd=ROOT,capture_output=True,check=True,encoding='utf-8')
    return json.loads(p.stdout)

def baseline(case,kind):
    x=copy.deepcopy(case['input']); workflow=ref.load_workflow(x)
    if kind=='static-all-required':
        for job in workflow['jobs'].values():job['if']=True
    elif kind=='survivor-derived':
        contract=ref.compile_contract(x)
        keep={i['groupId'] for i in contract['instances'] if any(r['name'] in i['names'] for r in x['sourceJobs'])}
        workflow['jobs']={k:v for k,v in workflow['jobs'].items() if k in keep}
        for job in workflow['jobs'].values():
            needs=job.get('needs',[]); needs=[needs] if isinstance(needs,str) else needs
            job['needs']=[n for n in needs if n in keep]
        x['captureInventory']=[{k:r[k] for k in ('id','name','runId','runAttempt','headSha')} for r in x['sourceJobs']]
    elif kind=='unknown-as-inactive':
        for job in workflow['jobs'].values():
            if ref.evaluate(job.get('if',True),x.get('eventContext',{})) is ref.U: job['if']=False
    from io import StringIO
    y=ref.YAML(typ='safe');y.version=(1,2);buf=StringIO();y.dump(workflow,buf);x['workflow']=buf.getvalue()
    return dict(id=case['id'],input=x)

def run():
    cases=json.loads((OUT/'development.json').read_text(encoding='utf-8'))
    ns=native(cases,OUT/'execution-input.json')
    rows=[]; attacks=[]; mutants=[]
    for c,n in zip(cases,ns):
        try:r=ref.qualify(c['input'],nonvacuity=c['input'].get('claimScope')=='test-execution')
        except Exception as e:r={'error':str(e)}
        rows.append({'id':c['id'],'expectedAuthorized':c['expectedAuthorized'],'native':n.get('qualification'),'reference':ref.json_ready(r),'sourceCheck':ref.check_source(c['input'],n['contract']) if 'contract' in n else None})
        if 'contract' in n:
            for kind in ('drop-instance','drop-group','forge-source-hash','forge-name'):
                cert=copy.deepcopy(n['contract'])
                if kind=='drop-instance' and cert['instances']:cert['instances'].pop()
                elif kind=='drop-group' and cert['jobGroups']:cert['jobGroups'].pop()
                elif kind=='forge-source-hash' and cert['instances']:cert['instances'][0]['sourceWitness']['sourceSha256']='0'*64
                elif kind=='forge-name' and cert['instances']:cert['instances'][0]['names']=['forged']
                else:continue
                attacks.append({'id':c['id'],'attack':kind,'rejected':not ref.check_source(c['input'],cert)['valid']})
        # Exhaustive erasures for three semantically relevant scalar facts per
        # first two records, plus complete payload erasure. Never alter inventory.
        coords=[(i,k) for i in range(min(2,len(c['input']['sourceJobs']))) for k in ('conclusion','runId','status')]
        for bits in itertools.product((False,True),repeat=len(coords)):
            x=copy.deepcopy(c['input'])
            for erase,(i,k) in zip(bits,coords):
                if erase:x['sourceJobs'][i].pop(k,None)
            mutants.append({'id':c['id']+'/facts/'+''.join(map(lambda v:str(int(v)),bits)),'input':x,'parent':c['id']})
        for count in range(len(c['input']['sourceJobs'])+1):
            for deleted in itertools.combinations(range(len(c['input']['sourceJobs'])),count):
                x=copy.deepcopy(c['input']);x['sourceJobs']=[r for i,r in enumerate(x['sourceJobs']) if i not in deleted]
                mutants.append({'id':c['id']+'/records/'+','.join(map(str,deleted)),'input':x,'parent':c['id']})
    mn=native(mutants,OUT/'erasure-input.json')
    parent={row['id']:row for row in rows};erasures=[]
    for m,n in zip(mutants,mn):
        r=ref.qualify(m['input'],nonvacuity=m['input'].get('claimScope')=='test-execution')
        na=n.get('qualification',{}).get('authorized');ra=r['authorized'];p=parent[m['parent']]
        erasures.append({'id':m['id'],'parent':m['parent'],'nativeAuthorized':na,'referenceAuthorized':ra,'nativeGain':na and not p['native']['authorized'],'referenceGain':ra and not p['reference']['authorized']})
    comparisons={}
    for kind in ('static-all-required','survivor-derived','unknown-as-inactive'):
        outputs=native([baseline(c,kind) for c in cases],OUT/(kind+'-inputs.json'))
        comparisons[kind]=[{'id':c['id'],'expectedAuthorized':c['expectedAuthorized'],'authorized':n.get('qualification',{}).get('authorized'),'error':n.get('error')} for c,n in zip(cases,outputs)]
    summary={'controls':len(rows),'nativeGoldErrors':sum(row['native']['authorized']!=row['expectedAuthorized'] for row in rows),'referenceGoldErrors':sum(row['reference']['authorized']!=row['expectedAuthorized'] for row in rows),'authorizationDisagreements':sum(row['native']['authorized']!=row['reference']['authorized'] for row in rows),'sourceCheckFailures':sum(not row['sourceCheck']['valid'] for row in rows),'certificateAttacks':len(attacks),'certificateAcceptedAttacks':sum(not a['rejected'] for a in attacks),'erasureVariants':len(erasures),'nativeAuthorizationGains':sum(bool(e['nativeGain']) for e in erasures),'referenceAuthorizationGains':sum(bool(e['referenceGain']) for e in erasures),'erasureDisagreements':sum(e['nativeAuthorized']!=e['referenceAuthorized'] for e in erasures),'baselines':{kind:{'falseAuthorization':sum(r['authorized'] is True and not r['expectedAuthorized'] for r in data),'falseBlocking':sum(r['authorized'] is False and r['expectedAuthorized'] for r in data),'errors':sum(r['error'] is not None for r in data)} for kind,data in comparisons.items()}}
    for name,data in [('results',rows),('certificate-attacks',attacks),('erasure-results',erasures),('baseline-results',comparisons),('summary',summary)]:
        (OUT/(name+'.json')).write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
    summary['closureDisagreements']=sum(r['native']['closure']!=r['reference']['closure'] for r in rows)
    summary['gateDisagreements']=sum(r['native']['gate']!=r['reference']['gate'] for r in rows)
    summary['axisGoldCases']=sum('expectedGate' in c for c in cases)
    summary['nativeAxisGoldErrors']=sum(any(n['qualification'][field]!=c['expected'+field.capitalize()] for field in ('closure','gate')) for c,n in zip(cases,ns) if 'expectedGate' in c)
    summary['referenceAxisGoldErrors']=sum(any(r['reference'][field]!=c['expected'+field.capitalize()] for field in ('closure','gate')) for c,r in zip(cases,rows) if 'expectedGate' in c)
    (OUT/'summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(summary,indent=2))
    required_zero=('nativeGoldErrors','referenceGoldErrors','authorizationDisagreements','sourceCheckFailures','certificateAcceptedAttacks','nativeAuthorizationGains','referenceAuthorizationGains','erasureDisagreements','closureDisagreements','gateDisagreements','nativeAxisGoldErrors','referenceAxisGoldErrors')
    if any(summary[k] for k in required_zero):raise SystemExit('Control validation failed: '+', '.join(k for k in required_zero if summary[k]))
    return summary

if __name__=='__main__':run()
