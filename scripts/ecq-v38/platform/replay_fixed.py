"""Offline final-core replay; cache only pure compilation of an identical frame.

Qualification/checking predicates are unchanged. Timing from this utility is not
used in the uncached resource benchmark.
"""
import argparse,hashlib,importlib.util,json,pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[3]
DATA=ROOT/'artifacts/paper-revision/ecq-v38/platform'
def fingerprint(x):return hashlib.sha256(json.dumps(x,sort_keys=True).encode()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);a=p.parse_args();out=pathlib.Path(a.out).resolve();out.mkdir(parents=True,exist_ok=True)
    env=json.loads((DATA/'original-envelope.json').read_text(encoding='utf-8'));fixed=fingerprint(env)
    paths=[ROOT/'scripts/ecq-v38/native/index.mjs',ROOT/'scripts/ecq-v38/native/expressions.mjs',ROOT/'scripts/ecq-v38/reference/reference.py']
    before={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    subprocess.run(['node',str(ROOT/'scripts/ecq-v38/platform/erase_native.mjs'),str(DATA/'original-envelope.json'),str(out/'native.json')],cwd=ROOT,check=True)
    native=json.loads((out/'native.json').read_text(encoding='utf-8'));old=json.loads((DATA/'reference-erasure.json').read_text(encoding='utf-8'))
    spec=importlib.util.spec_from_file_location('independent',ROOT/'scripts/ecq-v38/reference/reference.py');ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)
    check=ref.check_source(env,native['contract'])
    if not check['valid']:raise ValueError('source certificate rejected')
    original_compile=ref.compile_contract;compiled=original_compile(env);contract_hash=fingerprint(ref.json_ready(compiled))
    # The API takes records separately; env itself is exactly identical in every
    # invocation. Reusing this pure result cannot change qualification predicates.
    def cached_compile(frame,_depth=0):
        return compiled if _depth==0 and fingerprint(frame)==fixed else original_compile(frame,_depth)
    ref.compile_contract=cached_compile
    rows=[];uncached={}
    for mask in range(4096):
        records=[j for i,j in enumerate(env['sourceJobs']) if not(mask&(1<<i))]
        q=ref.qualify(env,records=records);row=dict(mask=mask,closure=q['closure'],gate=q['gate'],authorized=q['authorized']);rows.append(row)
        if mask in (0,1,2,3,15,255,2048,4095):uncached[mask]=row
    ref.compile_contract=original_compile
    for mask,row in uncached.items():
        q=ref.qualify(env,records=[j for i,j in enumerate(env['sourceJobs']) if not(mask&(1<<i))])
        if any(q[k]!=row[k] for k in ('closure','gate','authorized')):raise ValueError('cached compilation changed predicate result')
    if fingerprint(env)!=fixed or fingerprint(ref.json_ready(compiled))!=contract_hash:raise ValueError('fixed source frame mutated')
    fields=('closure','gate','authorized');disagreements=sum(any(r[k]!=n[k] for k in fields) for r,n in zip(rows,native['rows']));changed=sum(any(r[k]!=o[k] for k in fields) for r,o in zip(rows,old))
    after={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    report={'status':'PASS' if not disagreements and not changed and before==after else 'FAIL','subsets':4096,'properErasures':4095,'nativeAuthorized':sum(r['authorized'] for r in native['rows']),'referenceAuthorized':sum(r['authorized'] for r in rows),'axesDisagreements':disagreements,'changedFromOriginalReference':changed,'sourceCheck':check,'fixedFrameSha256':fixed,'compiledReferenceSha256':contract_hash,'cache':'pure source compilation only; byte-identical envelope per call; predicates unchanged','uncachedSpotChecks':len(uncached),'methodHashesUnchanged':before==after,'methodHashes':before}
    (out/'reference.json').write_text(json.dumps(rows,indent=2)+'\n',encoding='utf-8');(out/'verification.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
    if report['status']!='PASS' or report['nativeAuthorized']!=1 or report['referenceAuthorized']!=1:raise SystemExit(1)
if __name__=='__main__':main()
