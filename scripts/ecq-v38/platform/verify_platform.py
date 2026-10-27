"""Offline raw API/ZIP/source/witness cross-binding; does not trust derived flags."""
import base64,hashlib,io,json,pathlib,subprocess,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[3];OUT=ROOT/'artifacts/paper-revision/ecq-v38/platform'
def read(name):return json.loads((OUT/name).read_bytes())
def main():
    manifest=read('manifest.json');raw={};errors=[]
    for m in manifest:
        b=(OUT/m['file']).read_bytes()
        if hashlib.sha256(b).hexdigest()!=m['sha256'] or len(b)!=m['bytes']:errors.append('raw digest '+m['file'])
        if m['exitCode']!=0:errors.append('API error '+m['file'])
        raw[m['endpoint']]=b
    def api(endpoint):return json.loads(raw[endpoint])
    for r in read('records.json'):
        run=r['run'];repo=run['repository']['full_name'];rid=run['id'];attempt=run['run_attempt']
        if run!=api(f'repos/{repo}/actions/runs/{rid}'):errors.append('run raw binding')
        jobs=[]
        for page in range(1,r['jobsPageCount']+1):
            d=api(f'repos/{repo}/actions/runs/{rid}/attempts/{attempt}/jobs?per_page=100&page={page}');jobs.extend(d['jobs'])
            if d['total_count']!=r['jobsTotalCount']:errors.append('jobs total')
        if jobs!=r['jobs'] or len(jobs)!=r['jobsTotalCount'] or not r['jobsPaginationComplete']:errors.append('jobs capture')
        artifacts=api(f'repos/{repo}/actions/runs/{rid}/artifacts?per_page=100&page=1')['artifacts']
        if artifacts!=[a['artifact'] for a in r['artifacts']]:errors.append('artifact metadata')
        for a in r['artifacts']:
            if a['artifact']['workflow_run']['id']!=rid:errors.append('artifact run ID')
            b=raw[f"repos/{repo}/actions/artifacts/{a['artifact']['id']}/zip"]
            if b!=(OUT/a['zipFile']).read_bytes() or hashlib.sha256(b).hexdigest()!=a['zipSha256']:errors.append('ZIP binding')
            with zipfile.ZipFile(io.BytesIO(b)) as z:
                if sorted(z.namelist())!=sorted(m['member'] for m in a['members']):errors.append('ZIP inventory')
                for m in a['members']:
                    data=z.read(m['member'])
                    if data!=(OUT/m['file']).read_bytes() or hashlib.sha256(data).hexdigest()!=m['sha256']:errors.append('ZIP member binding')
    witness=read('identity-verification.json');identity=json.loads((OUT/witness['witness']['file']).read_bytes());latest=read('records.json')[-1]['run'];repo=latest['repository']['full_name']
    expected=dict(repository=repo,runId=str(latest['id']),runAttempt=str(latest['run_attempt']),sha=latest['head_sha'],eventName=latest['event'],workflowRef=repo+'/'+latest['path'].split('@')[0]+'@refs/heads/'+latest['head_branch'])
    if identity!=witness['identity'] or any(identity[k]!=v for k,v in expected.items()):errors.append('identity run binding')
    for source in witness['sources']:
        endpoint=f"repos/{source['repository']}/contents/{source['path']}?ref={source['commit']}"
        b=base64.b64decode(api(endpoint)['content'])
        if source['commit']!=identity['workflowSha'] or b!=(OUT/source['file']).read_bytes() or hashlib.sha256(b).hexdigest()!=source['sha256']:errors.append('pinned source raw binding')
    frozen={}
    snapshot=ROOT/'artifacts/paper-revision/ecq-v38/evaluation-history/blind-724d230/method-724d230.zip'
    for rel,actual in read('method-hashes-before.json').items():
        if snapshot.is_file():
            with zipfile.ZipFile(snapshot) as z: source_bytes=z.read(rel)
        else:
            p=subprocess.run(['git','show','724d230:'+rel],cwd=ROOT,capture_output=True,check=True)
            source_bytes=p.stdout
        frozen[rel]=hashlib.sha256(source_bytes).hexdigest()==actual
    if not all(frozen.values()):errors.append('method differs from frozen 724d230')
    result=dict(passed=not errors,errors=errors,rawResponses=len(manifest),frozenMethodCommit='724d230',frozenMethodMatches=frozen,checked=['raw digests','run and exact-attempt ordered jobs','artifact metadata/run identity','ZIP complete member bytes','explicit identity witness fields','pinned source bytes vs raw contents','frozen core Git bytes'])
    (OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8');print(json.dumps(result,indent=2))
    if errors:raise SystemExit(1)
if __name__=='__main__':main()
