"""Bounded read-only license provenance for redistributed source snapshots."""
import base64,concurrent.futures,datetime,hashlib,json,pathlib,subprocess,threading
ROOT=pathlib.Path(__file__).resolve().parents[3];OUT=ROOT/'artifacts/paper-revision/ecq-v38/licenses'
SOURCE=ROOT/'artifacts/paper-revision/ecq-v38/source';lock=threading.Lock();manifest=[];calls=0
def digest(b):return hashlib.sha256(b).hexdigest()
def save(name,data):(OUT/name).write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
def api(endpoint):
    global calls
    with lock:
        if calls>=60:return {'collectionError':'60-call bound reached'}
        calls+=1;number=calls
    try:p=subprocess.run(['gh','api','-H','Accept: application/vnd.github+json',endpoint],capture_output=True,timeout=75)
    except subprocess.TimeoutExpired:p=subprocess.CompletedProcess([],124,b'{"collectionError":"timeout"}',b'')
    name=f'raw/{number:03d}-{digest(endpoint.encode())[:16]}.json';(OUT/name).write_bytes(p.stdout)
    m=dict(endpoint=endpoint,file=name,sha256=digest(p.stdout),bytes=len(p.stdout),exitCode=p.returncode,retrievedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    with lock:manifest.append(m);save('manifest.json',sorted(manifest,key=lambda x:x['file']))
    try:data=json.loads(p.stdout)
    except Exception:data={'collectionError':'non-JSON response'}
    return dict(response=data,manifest=m)
def collect(s):
    repo=s['repository'];sha=s['commit'];attempts=[]
    for endpoint in [f'repos/{repo}/license?ref={sha}',f'repos/{repo}/contents/LICENSE?ref={sha}',f'repos/{repo}/contents/LICENCE?ref={sha}']:
        result=api(endpoint);attempts.append(result)
        data=result.get('response',{})
        if result.get('manifest',{}).get('exitCode')==0 and data.get('encoding')=='base64' and 'content' in data:
            try:
                raw=base64.b64decode(data['content']);name=f"decoded/{repo.replace('/','--')}--{sha}--{digest(raw)[:12]}.txt";(OUT/name).write_bytes(raw)
                return dict(**s,status='FOUND',licenseFile=name,licenseSha256=digest(raw),licensePath=data.get('path'),licenseBlobSha=data.get('sha'),licenseHtmlUrl=data.get('html_url'),licenseMetadata=data.get('license'),retrievedEndpoint=endpoint,attempts=attempts)
            except Exception as e:attempts[-1]['decodeError']=type(e).__name__
    return dict(**s,status='UNKNOWN',attempts=attempts,reason='No decodable historical repository license under bounded endpoint/fallback policy')
def main():
    OUT.mkdir(parents=True,exist_ok=True)
    for d in ['raw','decoded']:(OUT/d).mkdir(exist_ok=True)
    if (OUT/'manifest.json').exists():raise RuntimeError('Do not overwrite or refetch existing attribution archive')
    records=json.loads((SOURCE/'records.json').read_bytes());snapshots={}
    def add(s,kind,runid):
        if 'file' in s:
            key=(s['repository'],s['sha256'])
            snapshots.setdefault(key,dict(repository=s['repository'],workflowSourceSha256=s['sha256'],commit=s['sha'],sourceFile=s['file'],sourcePath=s['path'],selectionKind=kind,firstRunId=runid))
    # Primary head-source bindings always choose the first selected record's head.
    for r in records:add(r['headSourceSnapshot'],'headSourceSnapshot',r['run']['id'])
    def walk(s,runid):
        add(s,'additional-redistributed-source',runid)
        for c in s.get('children',[]):walk(c,runid)
    for r in records:
        walk(r['headSourceSnapshot'],r['run']['id'])
        for s in r.get('candidateExecutionSources',[]):walk(s,r['run']['id'])
    save('selection.json',dict(policy='first formal selected head record per(repository,headSourceSnapshot.sha256), then first additional candidate/reusable bytes per(repository,sha256)',maxApiCalls=60,workers=6,snapshots=list(snapshots.values())))
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:bindings=list(pool.map(collect,snapshots.values()))
    save('bindings.json',bindings)
    summary=dict(snapshots=len(bindings),primaryHeadSnapshots=sum(b['selectionKind']=='headSourceSnapshot' for b in bindings),additionalSnapshots=sum(b['selectionKind']!='headSourceSnapshot' for b in bindings),apiCalls=calls,found=sum(b['status']=='FOUND' for b in bindings),unknown=sum(b['status']!='FOUND' for b in bindings))
    save('summary.json',summary);print(json.dumps(summary,indent=2))
if __name__=='__main__':main()
