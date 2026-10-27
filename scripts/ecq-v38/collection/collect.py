"""Bounded read-only public GitHub archive collection. Never executes source."""
import base64, datetime, hashlib, json, pathlib, re, subprocess, urllib.parse, threading, concurrent.futures
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = ROOT / 'artifacts/paper-revision/ecq-v38/source'
PREFLIGHT = pathlib.Path('D:/temp/Essay-Book-revision-20261026/DS-Hns-H/arxiv/v38/audit/source-preflight')
FAMILIES = [('pytest-dev/pytest','test.yml'),('fastify/fastify','ci.yml'),('fastify/fastify','integration.yml'),('pallets/flask','tests.yaml'),('nodejs/undici','ci.yml'),('nodejs/undici','nodejs.yml'),('psf/requests','run-tests.yml'),('encode/httpx','test-suite.yml')]
CUTOFF = '2026-10-27T00:00:00Z'
manifest=[]; cache={}; calls=0; lock=threading.Lock()
def digest(b): return hashlib.sha256(b).hexdigest()
def save(path,obj): path.write_text(json.dumps(obj,indent=2,sort_keys=True)+'\n',encoding='utf8')
def api(endpoint):
    global calls
    with lock:
        if endpoint in cache: return cache[endpoint]
        if calls >= 1500: raise RuntimeError('API budget exhausted')
        calls += 1
        call_id=calls
    try:
        p=subprocess.run(['gh','api','-H','Accept: application/vnd.github+json',endpoint],capture_output=True,timeout=75)
    except subprocess.TimeoutExpired:
        p=subprocess.CompletedProcess([],124,b'{"collectionError":"request timeout"}',b'')
    name=f'{call_id:04d}-{digest(endpoint.encode())[:16]}.json'
    raw=p.stdout
    (OUT/'raw'/name).write_bytes(raw)
    entry={'endpoint':endpoint,'file':'raw/'+name,'sha256':digest(raw),'bytes':len(raw),'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':p.returncode}
    with lock:
        manifest.append(entry)
        save(OUT/'manifest.json',sorted(manifest,key=lambda x:x['file']))
    try: data=json.loads(raw)
    except Exception: data={'collectionError':'non-JSON response'}
    if p.returncode: data={'collectionError':data,'exitCode':p.returncode}
    cache[endpoint]=data
    return data
def source(repo,path,sha,depth=0,seen=None):
    seen=set() if seen is None else seen
    key=(repo,path,sha)
    if key in seen: return {'repository':repo,'path':path,'sha':sha,'cycle':True}
    seen=seen|{key}
    result={'repository':repo,'path':path,'sha':sha,'children':[]}
    data=api(f'repos/{repo}/contents/{path}?ref={sha}')
    if 'content' not in data: result['error']=data; return result
    try:
        raw=base64.b64decode(data['content']); name=digest(raw)+'.yaml'
        (OUT/'yaml'/name).write_bytes(raw); result.update(file='yaml/'+name,sha256=digest(raw))
        doc=yaml.load(raw,Loader=yaml.BaseLoader) or {}
        for job in (doc.get('jobs') or {}).values():
            use=job.get('uses') if isinstance(job,dict) else None
            if not use: continue
            if depth>=3: result['children'].append({'uses':use,'status':'UNKNOWN_DEPTH_LIMIT'}); continue
            if use.startswith('./'):
                p=use[2:]
                if '..' in pathlib.PurePosixPath(p).parts or not p.startswith('.github/workflows/'):
                    result['children'].append({'uses':use,'status':'UNKNOWN_UNSAFE_PATH'}); continue
                result['children'].append(source(repo,p,sha,depth+1,seen))
            else:
                m=re.fullmatch(r'([^/]+/[^/]+)/(.github/workflows/[^@]+)@([0-9a-fA-F]{40})',use)
                if m: result['children'].append(source(*m.groups(),depth+1,seen))
                else: result['children'].append({'uses':use,'status':'UNKNOWN_UNPINNED_REUSABLE'})
    except Exception as e: result['error']=type(e).__name__+': '+str(e)
    return result
def main():
    global calls,manifest,cache
    OUT.mkdir(parents=True,exist_ok=True)
    for d in ['raw','yaml']: (OUT/d).mkdir(exist_ok=True)
    if (OUT/'manifest.json').exists():
        manifest=json.loads((OUT/'manifest.json').read_bytes())
        calls=max(int(x['file'].split('/')[1].split('-')[0]) for x in manifest)
        for x in manifest:
            try: cache[x['endpoint']]=json.loads((OUT/x['file']).read_bytes())
            except Exception: cache[x['endpoint']]={'collectionError':'cached non-JSON'}
    excluded=set(); preflight=[]
    for p in sorted(PREFLIGHT.glob('*.json')):
        raw=p.read_bytes(); preflight.append({'name':p.name,'sha256':digest(raw)})
        try: data=json.loads(raw)
        except Exception: continue
        if isinstance(data,dict):
            excluded.update(r['id'] for r in data.get('workflow_runs',[]))
            excluded.update(j['run_id'] for j in data.get('jobs',[]) if 'run_id' in j)
        m=re.search(r'--(\d+)-jobs-',p.name)
        if m: excluded.add(int(m[1]))
    save(OUT/'preflight-exclusions.json',{'runIds':sorted(excluded),'cacheFiles':preflight})
    selected=[]; strata=[]
    for repo,wf in FAMILIES:
        for status in ['success','failure']:
            candidates=[]
            for page in range(1,11):
                data=api(f'repos/{repo}/actions/workflows/{wf}/runs?status={status}&created=%3C{CUTOFF}&per_page=100&page={page}')
                rows=data.get('workflow_runs',[])
                candidates.extend(r for r in rows if r['id'] not in excluded and r.get('created_at','')<CUTOFF and r.get('conclusion')==status and r.get('status')=='completed')
                if len(candidates)>=15 or len(rows)<100: break
            candidates=sorted({r['id']:r for r in candidates}.values(),key=lambda r:(r['created_at'],r['id']),reverse=True)[:15]
            strata.append({'repository':repo,'workflow':wf,'conclusion':status,'selected':len(candidates),'deficit':15-len(candidates)})
            for i,r in enumerate(candidates): selected.append({'repository':repo,'workflow':wf,'split':'development' if i<5 else 'evaluation','selectionRank':i+1,'run':r})
    save(OUT/'selection.json',{'cutoffExclusive':CUTOFF,'strata':strata,'records':selected})
    records=[]
    def collect_one(item):
        index,s=item
        repo=s['repository']; r=s['run']; rid=r['id']; attempt=r.get('run_attempt',1)
        detail=api(f'repos/{repo}/actions/runs/{rid}')
        jobs=[]; jobpages=[]; total=None; complete=False
        for page in range(1,21):
            d=api(f'repos/{repo}/actions/runs/{rid}/attempts/{attempt}/jobs?per_page=100&page={page}')
            jobpages.append(d)
            if 'jobs' not in d: break
            if total is None: total=d.get('total_count')
            if total != d.get('total_count'): break
            jobs.extend(d['jobs'])
            if len(jobs)==total: complete=True; break
            if not d['jobs'] or len(jobs)>total: break
        head=source(repo,'.github/workflows/'+s['workflow'],r['head_sha'])
        refs=detail.get('referenced_workflows',[]) if isinstance(detail,dict) else []
        roots=[]; witnesses=[]
        for ref in refs:
            path=ref.get('path',''); sha=ref.get('sha','')
            if path.startswith(repo+'/.github/workflows/') and re.fullmatch('[0-9a-f]{40}',sha):
                commit=api(f'repos/{repo}/commits/{sha}')
                parents=[p.get('sha') for p in commit.get('parents',[])]
                witnesses.append({'referencedWorkflow':ref,'commitParents':parents,'headIsParent':r['head_sha'] in parents})
                roots.append(source(repo,'.github/workflows/'+s['workflow'],sha))
        record={**s,'detail':detail,'jobs':jobs,'jobsTotalCount':total,'jobsPaginationComplete':complete,'jobsPageCount':len(jobpages),'headSourceSnapshot':head,'candidateExecutionSources':roots,'executionWitnesses':witnesses,'rootExecutionIdentity':{'status':'UNKNOWN','reason':'REST run metadata does not independently witness root workflow_sha; head and referenced callee commits are source candidates only'},'eventContext':{'event_name':r.get('event'),'head_sha':r.get('head_sha'),'historicalPayload':'UNKNOWN'},'groupId':f"{repo}:{s['workflow']}:{rid}",'logicalRevisionGroup':f"{repo}:{r['head_sha']}"}
        print(f'{index+1}/{len(selected)} {repo} {rid} jobs={len(jobs)} complete={complete} calls={calls}',flush=True)
        return record
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for record in pool.map(collect_one,enumerate(selected)):
            records.append(record); save(OUT/'records.json',records)
    save(OUT/'summary.json',{'records':len(records),'apiCalls':calls,'strata':strata,'zeroJobRuns':[x['run']['id'] for x in records if x['jobsPaginationComplete'] and x['jobsTotalCount']==0],'incompleteJobs':[x['run']['id'] for x in records if not x['jobsPaginationComplete']],'rootIdentityUnknown':len(records)})
if __name__=='__main__': main()
