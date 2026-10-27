"""Offline integrity and sampling audit; no API calls."""
import base64, collections, hashlib, json, pathlib
ROOT=pathlib.Path(__file__).resolve().parents[3]
OUT=ROOT/'artifacts/paper-revision/ecq-v38/source'
def read(name): return json.loads((OUT/name).read_bytes())
def main():
    manifest=read('manifest.json'); selection=read('selection.json'); records=read('records.json')
    excluded=set(read('preflight-exclusions.json')['runIds']); errors=[]
    raw_by_endpoint=collections.defaultdict(list)
    for m in manifest:
        b=(OUT/m['file']).read_bytes()
        if hashlib.sha256(b).hexdigest()!=m['sha256'] or len(b)!=m['bytes']: errors.append('raw hash '+m['file'])
        try: data=json.loads(b)
        except Exception: data={'collectionError':'non-JSON response'}
        if m['exitCode']: data={'collectionError':data,'exitCode':m['exitCode']}
        raw_by_endpoint[m['endpoint']].append(data)
    def raw(endpoint):
        values=raw_by_endpoint.get(endpoint,[])
        if not values:
            errors.append('missing raw endpoint '+endpoint); return {}
        if any(x!=values[0] for x in values[1:]): errors.append('conflicting repeated raw endpoint '+endpoint)
        return values[-1]
    raw_runs=collections.defaultdict(list)
    for endpoint,values in raw_by_endpoint.items():
        if '/actions/workflows/' in endpoint and '/runs?' in endpoint:
            repo=endpoint.split('/actions/')[0].removeprefix('repos/')
            wf=endpoint.split('/actions/workflows/',1)[1].split('/runs?',1)[0]
            for value in values:
                for run in value.get('workflow_runs',[]): raw_runs[(repo,wf,run['id'])].append(run)
    for s in selection['records']:
        if s['run'] not in raw_runs[(s['repository'],s['workflow'],s['run']['id'])]: errors.append('selected run differs from raw run-list')
    expected=[(x['repository'],x['workflow'],x['run']['id'],x['split']) for x in selection['records']]
    actual=[(x['repository'],x['workflow'],x['run']['id'],x['split']) for x in records]
    if expected!=actual: errors.append('record order/selection mismatch')
    for selected,record in zip(selection['records'],records):
        if any(record.get(k)!=v for k,v in selected.items()): errors.append('record selected fields mismatch')
    for r in records:
        key=(r['repository'],r['workflow'],r['run']['id'])
        if r['run'] not in raw_runs[key]: errors.append('record run differs from raw run-list')
        if r['detail']!=raw(f"repos/{r['repository']}/actions/runs/{r['run']['id']}"): errors.append('detail differs from raw response')
        page_jobs=[]; total=None; complete=False; count=0
        for page in range(1,21):
            endpoint=f"repos/{r['repository']}/actions/runs/{r['run']['id']}/attempts/{r['run'].get('run_attempt',1)}/jobs?per_page=100&page={page}"
            data=raw(endpoint); count+=1
            if 'jobs' not in data: break
            if total is None: total=data.get('total_count')
            if total!=data.get('total_count'): break
            page_jobs.extend(data['jobs'])
            if len(page_jobs)==total: complete=True; break
            if not data['jobs'] or len(page_jobs)>total: break
        if r['jobs']!=page_jobs: errors.append('jobs differ from raw exact-attempt pages')
        if (r['jobsTotalCount'],r['jobsPaginationComplete'],r['jobsPageCount'])!=(total,complete,count): errors.append('jobs page metadata differs from raw reconstruction')
        if r['run']['id'] in excluded: errors.append('preflight contamination')
        if r['run']['created_at']>=selection['cutoffExclusive']: errors.append('cutoff')
        if r['jobsPaginationComplete'] and len(r['jobs'])!=r['jobsTotalCount']: errors.append('pagination total')
        if len({j['id'] for j in r['jobs']})!=len(r['jobs']): errors.append('duplicate job ID')
        for j in r['jobs']:
            if j.get('run_id')!=r['run']['id'] or j.get('run_attempt')!=r['run'].get('run_attempt',1): errors.append('job run/attempt binding')
    def check_source(s):
        if 'file' in s:
            source_bytes=(OUT/s['file']).read_bytes()
            if hashlib.sha256(source_bytes).hexdigest()!=s['sha256']: errors.append('source digest')
            data=raw(f"repos/{s['repository']}/contents/{s['path']}?ref={s['sha']}")
            try:
                if base64.b64decode(data['content'])!=source_bytes: errors.append('decoded YAML differs from raw contents response')
            except Exception: errors.append('source has no decodable raw contents response')
        for c in s.get('children',[]): check_source(c)
    for r in records:
        head=r['headSourceSnapshot']
        if (head.get('repository'),head.get('path'),head.get('sha'))!=(r['repository'],'.github/workflows/'+r['workflow'],r['run']['head_sha']): errors.append('head source identity differs from selected run')
        check_source(r['headSourceSnapshot'])
        for s in r['candidateExecutionSources']: check_source(s)
    revisions=collections.defaultdict(set)
    for r in records: revisions[r['logicalRevisionGroup']].add(r['split'])
    result={'passed':not errors,'errors':errors,'records':len(records),'rawResponses':len(manifest),'rawApiErrors':sum(x['exitCode']!=0 for x in manifest),'splitCounts':dict(collections.Counter(x['split'] for x in records)),'zeroJobs':sum(x['jobsPaginationComplete'] and x['jobsTotalCount']==0 for x in records),'rootIdentityUnknown':sum(x['rootExecutionIdentity']['status']=='UNKNOWN' for x in records),'logicalRevisionCrossSplit':[k for k,v in revisions.items() if len(v)>1]}
    result['verificationSchemaVersion']=2
    result['rawDerivedBindingChecks']=['selected-run-list-whole-values','record-selection-whole-values','run-detail-whole-values','exact-attempt-job-pages-whole-values-and-order','pagination-total-completeness-error-stop','decoded-yaml-base64-content-byte-equality','source-repository-path-ref-binding']
    (OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    print(json.dumps(result,indent=2))
    if errors: raise SystemExit(1)
if __name__=='__main__': main()
