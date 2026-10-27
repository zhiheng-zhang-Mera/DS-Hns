"""Candidate-source extraction study; never upgrades unknown execution identity."""
import argparse,hashlib,importlib.util,json,subprocess
from collections import Counter,defaultdict
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];SOURCE=ROOT/'artifacts/paper-revision/ecq-v38/source';OUT=ROOT/'artifacts/paper-revision/ecq-v38/archive-study'
spec=importlib.util.spec_from_file_location('reference',ROOT/'scripts/ecq-v38/reference/reference.py');ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)

def envelope(record):
    source=record['headSourceSnapshot']; definitions={}; conflicts=set()
    def walk(parent):
        for child in parent.get('children',[]):
            if 'file' not in child:continue
            text=(SOURCE/child['file']).read_text(encoding='utf-8')
            if hashlib.sha256((SOURCE/child['file']).read_bytes()).hexdigest()!=child['sha256']:raise ValueError('source hash mismatch')
            identity=dict(repository=child['repository'],path=child['path'],commit=child['sha'],verified=True)
            definition=dict(workflow=text,workflowIdentity=identity)
            keys=[child['repository']+'/'+child['path']+'@'+child['sha']]
            if child['repository']==parent['repository'] and child['sha']==parent['sha']:keys.append('./'+child['path'])
            for key in keys:
                if key in definitions and definitions[key]!=definition:conflicts.add(key)
                definitions[key]=definition
            walk(child)
    walk(source)
    for key in conflicts:definitions.pop(key,None)
    run=record['run']; runid=run['id'];attempt=run['run_attempt'];head=run['head_sha']
    jobs=[dict(id=j['id'],name=j['name'],conclusion=j.get('conclusion'),status=j.get('status'),type='job',runId=j.get('run_id'),runAttempt=attempt,headSha=j.get('head_sha')) for j in record['jobs']]
    context={'github':{'event_name':run['event'],'repository':record['repository'],'repository_owner':record['repository'].split('/')[0],'actor':run.get('actor',{}).get('login'),'run_id':str(runid),'run_attempt':str(attempt)}}
    text=(SOURCE/source['file']).read_text(encoding='utf-8')
    if hashlib.sha256((SOURCE/source['file']).read_bytes()).hexdigest()!=source['sha256']:raise ValueError('source hash mismatch')
    return dict(workflow=text,workflowIdentity=dict(repository=record['repository'],path=source['path'],commit=source['sha'],verified=False),eventContext=context,eventContextComplete=False,captureComplete=record['jobsPaginationComplete'],runIdentity=dict(runId=runid,runAttempt=attempt,headSha=head),captureInventory=[{k:j[k] for k in ('id','name','runId','runAttempt','headSha')} for j in jobs],sourceJobs=jobs,reusableDefinitions=definitions)

def run(split):
    OUT.mkdir(parents=True,exist_ok=True); records=[r for r in json.loads((SOURCE/'records.json').read_text(encoding='utf-8')) if r['split']==split]
    cases=[]; rows=[]
    for record in records:
        try:cases.append({'id':record['groupId'],'input':envelope(record)})
        except Exception as e:rows.append({'id':record['groupId'],'inputError':str(e)})
    inputs=OUT/(split+'-inputs.json');inputs.write_text(json.dumps(cases)+'\n',encoding='utf-8')
    p=subprocess.run(['node',str(ROOT/'scripts/ecq-v38/study/native_batch.mjs'),str(inputs)],cwd=ROOT,capture_output=True,encoding='utf-8',check=True)
    native=json.loads(p.stdout);(OUT/(split+'-native.json')).write_text(p.stdout+'\n',encoding='utf-8')
    byid={r['groupId']:r for r in records}
    for c,n in zip(cases,native):
        record=byid[c['id']];row=dict(id=c['id'],repository=record['repository'],workflow=record['workflow'],runId=record['run']['id'],split=split,logicalRevisionGroup=record['logicalRevisionGroup'],originalConclusion=record['run']['conclusion'],jobCount=len(record['jobs']),captureComplete=record['jobsPaginationComplete'],rootExecutionIdentity='UNKNOWN')
        if 'error' in n:row['nativeError']=n['error']
        else:
            contract=n['contract'];q=n['qualification']; names=[(i['id'],name) for i in contract['instances'] for name in i['names']]
            counts=Counter(name for _,name in names);inventoryCounts=Counter(j['name'] for j in c['input']['captureInventory'])
            row.update(nativeAuthorized=q['authorized'],nativeClosure=q['closure'],nativeGate=q['gate'],sourceInstances=len(contract['instances']),sourceGroups=len(contract['jobGroups']),unsupportedGroups=len({f['groupId'] for f in contract['unresolvedFeatures']}),unknownApplicability=sum(v=='UNKNOWN' for v in q['applicability'].values()),uniqueLeafBindings=sum(counts[j['name']]==1 and inventoryCounts[j['name']]==1 for j in c['input']['captureInventory']),nativeDiagnosticKinds=dict(Counter(o['kind'] for o in q['obligations'] if o['value']!='TRUE')))
            try:row['sourceCheck']=ref.check_source(c['input'],contract)
            except Exception as e:row['sourceCheckError']=str(e)
        try:
            rc=ref.compile_contract(c['input']);rq=ref.qualify(c['input']);row.update(referenceAuthorized=rq['authorized'],referenceClosure=rq['closure'],referenceGate=rq['gate'],referenceInstances=len(rc['instances']))
        except Exception as e:row['referenceError']=str(e)
        rows.append(row)
    groups=[]
    for (repo,workflow),group in itertools_group(rows):
        comparable=[r for r in group if 'nativeAuthorized' in r and 'referenceAuthorized' in r]
        groups.append(dict(repository=repo,workflow=workflow,runs=len(group),jobs=sum(r.get('jobCount',0) for r in group),uniqueLeafBindings=sum(r.get('uniqueLeafBindings',0) for r in group),sourceCheckFailures=sum(r.get('sourceCheck',{}).get('valid') is False for r in group),authorizationDisagreements=sum(r['nativeAuthorized']!=r['referenceAuthorized'] for r in comparable),nativeAuthorized=sum(bool(r.get('nativeAuthorized')) for r in group),referenceAuthorized=sum(bool(r.get('referenceAuthorized')) for r in group),nativeErrors=sum('nativeError' in r for r in group),referenceErrors=sum('referenceError' in r for r in group),unsupportedRuns=sum(r.get('unsupportedGroups',0)>0 for r in group)))
    summary=dict(split=split,runs=len(records),inputErrors=sum('inputError' in r for r in rows),rootExecutionIdentityUnknown=len(records),nativeAuthorized=sum(bool(r.get('nativeAuthorized')) for r in rows),referenceAuthorized=sum(bool(r.get('referenceAuthorized')) for r in rows),groups=groups)
    for name,data in [('results',rows),('summary',summary)]: (OUT/(split+'-'+name+'.json')).write_text(json.dumps(data,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(summary,indent=2))

def itertools_group(rows):
    groups=defaultdict(list)
    for row in rows:groups[(row.get('repository','INPUT_ERROR'),row.get('workflow','INPUT_ERROR'))].append(row)
    return sorted(groups.items())
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--split',choices=['development','evaluation'],default='development');run(parser.parse_args().split)
