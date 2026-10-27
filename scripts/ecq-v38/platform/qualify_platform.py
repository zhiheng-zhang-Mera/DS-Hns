"""Qualify the captured owned run and all fixed-inventory payload subsets."""
import hashlib,importlib.util,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3];OUT=ROOT/'artifacts/paper-revision/ecq-v38/platform'
def save(name,data):(OUT/name).write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
def read(name):return json.loads((OUT/name).read_bytes())
def hashes():
    return {str(p.relative_to(ROOT)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['native','reference'] for p in (ROOT/'scripts/ecq-v38'/folder).glob('*') if p.suffix in ['.py','.mjs']}
def main():
    if (OUT/'summary.json').exists():raise RuntimeError('Completed platform evidence exists; do not overwrite original method results')
    before=hashes();save('method-hashes-before.json',before)
    manifest=read('manifest.json');errors=[]
    for m in manifest:
        b=(OUT/m['file']).read_bytes()
        if hashlib.sha256(b).hexdigest()!=m['sha256'] or len(b)!=m['bytes']:errors.append(m['file'])
    witness=read('identity-verification.json');records=read('records.json');r=records[-1];run=r['run'];identity=witness['identity']
    if not witness['verified'] or not all(witness['checks'].values()):raise ValueError('identity unverified')
    for source in witness['sources']:
        if hashlib.sha256((OUT/source['file']).read_bytes()).hexdigest()!=source['sha256']:errors.append(source['file'])
    if errors:raise ValueError('archive integrity mismatch '+str(errors))
    def definition(source):return dict(workflow=(OUT/source['file']).read_text(encoding='utf8'),workflowIdentity=dict(repository=source['repository'],path=source['path'],commit=source['commit'],verified=True))
    root,child=witness['sources'];jobs=[dict(id=j['id'],name=j['name'],status=j['status'],conclusion=j['conclusion'],type='job',runId=j['run_id'],runAttempt=j['run_attempt'],headSha=j['head_sha']) for j in r['jobs']]
    assert len(jobs)==12 and r['jobsPaginationComplete'] and r['jobsTotalCount']==12
    assert run['conclusion']=='success' and run['status']=='completed'
    env=definition(root);env.update(eventContext={'github':{'event_name':identity['eventName'],'repository':identity['repository'],'sha':identity['sha'],'workflow_sha':identity['workflowSha'],'workflow_ref':identity['workflowRef'],'run_id':identity['runId'],'run_attempt':identity['runAttempt']}},eventContextComplete=False,captureComplete=True,workflowCancelled=False,runIdentity=dict(runId=run['id'],runAttempt=run['run_attempt'],headSha=run['head_sha']),captureInventory=[{k:j[k] for k in ['id','name','runId','runAttempt','headSha']} for j in jobs],sourceJobs=jobs,reusableDefinitions={'./'+child['path']:definition(child)},claimScope='test-execution')
    save('original-envelope.json',env)
    p=subprocess.run(['node',str(ROOT/'scripts/ecq-v38/platform/erase_native.mjs'),str(OUT/'original-envelope.json'),str(OUT/'native-erasure.json')],capture_output=True,encoding='utf8',check=True)
    native=read('native-erasure.json')
    spec=importlib.util.spec_from_file_location('independent_reference',ROOT/'scripts/ecq-v38/reference/reference.py');ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)
    original=ref.qualify(env);check=ref.check_source(env,native['contract']);save('reference-original.json',ref.json_ready(original));save('source-check.json',check)
    rows=[]
    for mask in range(4096):
        remaining=[j for i,j in enumerate(jobs) if not(mask&(1<<i))]
        q=ref.qualify(env,records=remaining)
        n=native['rows'][mask]
        rows.append(dict(mask=mask,retained=len(remaining),closure=q['closure'],gate=q['gate'],authorized=q['authorized'],gain=q['authorized'] and not original['authorized'],nativeDisagreement=any(q[k]!=n[k] for k in ['closure','gate','authorized'])))
    save('reference-erasure.json',ref.json_ready(rows))
    after=hashes();save('method-hashes-after.json',after)
    summary=dict(scope='owned controlled conformance workflow; not independent external workflow cases',runId=run['id'],workflowSha=identity['workflowSha'],jobs=12,sourceCheck=check,originalNative=native['original'],originalReference=ref.json_ready(original),subsets=4096,originalIncluded=True,nativeAuthorizedSubsets=sum(x['authorized'] for x in native['rows']),referenceAuthorizedSubsets=sum(x['authorized'] for x in rows),nativeGain=sum(x['gain'] for x in native['rows']),referenceGain=sum(x['gain'] for x in rows),disagreements=sum(x['nativeDisagreement'] for x in rows),methodHashesUnchanged=before==after,rawApiResponses=len(manifest))
    save('summary.json',summary)
    assert not any(x['gain'] for x in native['rows']) and not any(x['gain'] for x in rows)
    assert before==after
    print(json.dumps({k:v for k,v in summary.items() if k not in ['originalNative','originalReference']},indent=2))
if __name__=='__main__':main()
