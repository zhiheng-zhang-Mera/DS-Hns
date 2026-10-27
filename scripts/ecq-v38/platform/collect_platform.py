"""Read-only archive of five already-owned conformance runs; no CI trigger."""
import base64, datetime, hashlib, io, json, pathlib, subprocess, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[3]
OUT=ROOT/'artifacts/paper-revision/ecq-v38/platform'
REPO='zhiheng-zhang-Mera/DS-Hns'
RUNS=[40484867702,40487176775,40487671049,40487863785,40488340238]
manifest=[]
def sha(b):return hashlib.sha256(b).hexdigest()
def save(name,data):
    p=OUT/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
def api(endpoint,binary=False):
    p=subprocess.run(['gh','api',endpoint],capture_output=True,timeout=90)
    name=f"raw/{len(manifest)+1:03d}-{sha(endpoint.encode())[:16]}"+('.zip' if binary and p.returncode==0 else '.json')
    (OUT/name).write_bytes(p.stdout)
    manifest.append(dict(endpoint=endpoint,file=name,sha256=sha(p.stdout),bytes=len(p.stdout),exitCode=p.returncode,retrievedAt=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    save('manifest.json',manifest)
    if p.returncode:return {'collectionError':True,'raw':name}
    return (p.stdout,name) if binary else json.loads(p.stdout)
def extract(raw,artifact_id):
    result=[]
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if len(z.infolist())>30 or sum(i.file_size for i in z.infolist())>2_000_000:raise ValueError('ZIP bound')
        for i in z.infolist():
            path=pathlib.PurePosixPath(i.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in i.filename or ':' in i.filename or (i.external_attr>>16)&0o170000==0o120000:raise ValueError('unsafe ZIP member')
            if i.is_dir():continue
            b=z.read(i); name=f'artifacts/{artifact_id}/'+i.filename
            target=(OUT/name).resolve()
            if OUT.resolve() not in target.parents:raise ValueError('ZIP traversal')
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b)
            result.append(dict(member=i.filename,file=name,sha256=sha(b),bytes=len(b)))
    return result
def main():
    OUT.mkdir(parents=True,exist_ok=True);(OUT/'raw').mkdir(exist_ok=True)
    if (OUT/'manifest.json').exists():raise RuntimeError('Archive already exists; do not overwrite or refetch')
    records=[]
    for rid in RUNS:
        run=api(f'repos/{REPO}/actions/runs/{rid}'); attempt=run['run_attempt'];jobs=[];complete=False;pages=[];total=None
        for page in range(1,11):
            d=api(f'repos/{REPO}/actions/runs/{rid}/attempts/{attempt}/jobs?per_page=100&page={page}');pages.append(d)
            if 'jobs' not in d:break
            if total is None:total=d['total_count']
            if d['total_count']!=total:break
            jobs.extend(d['jobs'])
            if len(jobs)==total:complete=True;break
            if not d['jobs']:break
        arts=[]
        for page in range(1,4):
            d=api(f'repos/{REPO}/actions/runs/{rid}/artifacts?per_page=100&page={page}')
            batch=d.get('artifacts',[]);arts.extend(batch)
            if len(arts)==d.get('total_count') or not batch:break
        downloads=[]
        for a in arts:
            if a.get('expired'):downloads.append({'artifact':a,'error':'expired'});continue
            data=api(f"repos/{REPO}/actions/artifacts/{a['id']}/zip",True)
            if isinstance(data,dict):downloads.append({'artifact':a,'error':data});continue
            b,path=data;downloads.append({'artifact':a,'zipFile':path,'zipSha256':sha(b),'members':extract(b,a['id'])})
        records.append(dict(run=run,jobs=jobs,jobsTotalCount=total,jobsPaginationComplete=complete,jobsPageCount=len(pages),artifacts=downloads,startupCause='UNKNOWN' if complete and total==0 and run['conclusion']=='failure' else 'NOT_APPLICABLE'))
        save('records.json',records);print(rid,run['conclusion'],len(jobs),len(arts),flush=True)
    latest=records[-1];matches=[m for a in latest['artifacts'] if a['artifact']['name']=='expression-observations' for m in a.get('members',[]) if m['member']=='identity.json']
    if len(matches)!=1:raise ValueError('missing unique explicit latest identity witness')
    identity=json.loads((OUT/matches[0]['file']).read_bytes());run=latest['run']
    expected_ref=REPO+'/'+run['path'].split('@')[0]+'@refs/heads/'+run['head_branch']
    checks=dict(repository=identity['repository']==REPO,runId=str(identity['runId'])==str(run['id']),runAttempt=str(identity['runAttempt'])==str(run['run_attempt']),headSha=identity['sha']==run['head_sha'],eventName=identity['eventName']==run['event'],workflowRef=identity['workflowRef']==expected_ref,workflowShaImmutable=len(identity['workflowSha'])==40 and all(c in '0123456789abcdef' for c in identity['workflowSha']))
    if not all(checks.values()):raise ValueError('identity mismatch '+str(checks))
    sources=[]
    for path in [run['path'].split('@')[0],'.github/workflows/ecq-v38-probe-reusable.yml']:
        data=api(f"repos/{REPO}/contents/{path}?ref={identity['workflowSha']}")
        b=base64.b64decode(data['content']); file='source/'+path.split('/')[-1]; (OUT/file).parent.mkdir(exist_ok=True);(OUT/file).write_bytes(b)
        sources.append(dict(repository=REPO,path=path,commit=identity['workflowSha'],file=file,sha256=sha(b)))
    save('identity-verification.json',dict(identity=identity,witness=matches[0],checks=checks,verified=all(checks.values()),sources=sources,limitation='Owned artifact testimony and GitHub API provenance; no cryptographic producer authentication'))
if __name__=='__main__':main()
