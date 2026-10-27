"""Preserve bounded Apache NOTICE evidence and render verified attribution."""
import base64,concurrent.futures,hashlib,json,pathlib
import collect_licenses as collect
ROOT=collect.ROOT;OUT=collect.OUT
def read(name):return json.loads((OUT/name).read_bytes())
def main():
    bindings=read('bindings.json');collect.manifest=read('manifest.json');collect.calls=len(collect.manifest)
    if (OUT/'notice-bindings.json').exists():notices=read('notice-bindings.json')
    else:
        def notice(b):
            result=collect.api(f"repos/{b['repository']}/contents/NOTICE?ref={b['commit']}");data=result.get('response',{})
            row=dict(repository=b['repository'],commit=b['commit'],workflowSourceSha256=b['workflowSourceSha256'],attempt=result)
            if 'content' in data and data.get('encoding')=='base64':
                raw=base64.b64decode(data['content']);name=f"decoded/{b['repository'].replace('/','--')}--{b['commit']}--NOTICE.txt";(OUT/name).write_bytes(raw)
                row.update(status='FOUND',file=name,sha256=hashlib.sha256(raw).hexdigest())
            elif data.get('status')=='404':row.update(status='NOT_FOUND_AT_NOTICE_PATH')
            else:row.update(status='UNKNOWN')
            return row
        apache=[b for b in bindings if (b.get('licenseMetadata') or {}).get('spdx_id')=='Apache-2.0']
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:notices=list(pool.map(notice,apache))
        collect.save('notice-bindings.json',notices)
    manifest=read('manifest.json');raw={};errors=[]
    for m in manifest:
        data=(OUT/m['file']).read_bytes()
        if hashlib.sha256(data).hexdigest()!=m['sha256'] or len(data)!=m['bytes']:errors.append('raw hash '+m['file'])
        raw[m['endpoint']]=json.loads(data)
    for b in bindings:
        if b['status']!='FOUND':continue
        text=(OUT/b['licenseFile']).read_bytes();api=raw[b['retrievedEndpoint']]
        if hashlib.sha256(text).hexdigest()!=b['licenseSha256'] or base64.b64decode(api['content'])!=text:errors.append('license content '+b['licenseFile'])
        source=(collect.SOURCE/b['sourceFile']).read_bytes()
        if hashlib.sha256(source).hexdigest()!=b['workflowSourceSha256']:errors.append('workflow source hash')
        if not b['retrievedEndpoint'].endswith('?ref='+b['commit']):errors.append('license commit binding')
    for n in notices:
        if n['status']=='FOUND':
            data=(OUT/n['file']).read_bytes()
            if hashlib.sha256(data).hexdigest()!=n['sha256'] or base64.b64decode(n['attempt']['response']['content'])!=data:errors.append('NOTICE content')
    packaged={hashlib.sha256(p.read_bytes()).hexdigest() for p in (collect.SOURCE/'yaml').glob('*.yaml')}
    if packaged!={b['workflowSourceSha256'] for b in bindings}:errors.append('packaged YAML attribution coverage')
    result=dict(passed=not errors,errors=errors,snapshots=len(bindings),primaryHeadSnapshots=sum(b['selectionKind']=='headSourceSnapshot' for b in bindings),additionalSnapshots=sum(b['selectionKind']!='headSourceSnapshot' for b in bindings),apiCalls=len(manifest),found=sum(b['status']=='FOUND' for b in bindings),unknown=sum(b['status']!='FOUND' for b in bindings),noticeStatusCounts={s:sum(n['status']==s for n in notices) for s in sorted({n['status'] for n in notices})},sourceCollectionManifestSha256=hashlib.sha256((collect.SOURCE/'manifest.json').read_bytes()).hexdigest())
    collect.save('verification.json',result);collect.save('summary.json',result)
    lines=['# Third-party source notices','', 'The repository MIT license covers our authored code. Redistributed third-party workflow YAML retains its original bytes, source attribution and upstream license/copyright notices. The complete historical license texts are packaged under `artifacts/paper-revision/ecq-v38/licenses/decoded/`; they are not relicensed under the repository MIT license. No peer-paper PDF is redistributed by this attribution package.','',f"This archive binds {len(bindings)} distinct (repository, workflow-source SHA-256) snapshots: {result['primaryHeadSnapshots']} formal head-source snapshots and {result['additionalSnapshots']} additional candidate/reusable sources. Each primary binding uses the first selected record's exact head commit. Additional source bytes use their first encountered pinned commit. All {result['found']} historical license lookups succeeded; unknown licenses: {result['unknown']}. Raw API JSON, endpoints, retrieval times and digests are preserved. No latest-branch license was substituted for historical source.",'','| Upstream repository | Workflow source SHA-256 | Pinned source commit | Historical license | Full license/copyright text |','|---|---|---|---|---|']
    for b in bindings:
        license=(b.get('licenseMetadata') or {}).get('spdx_id','UNKNOWN')
        link='../../../artifacts/paper-revision/ecq-v38/licenses/'+b.get('licenseFile','')
        lines.append(f"| [{b['repository']}](https://github.com/{b['repository']}) | `{b['workflowSourceSha256']}` | [{b['commit']}](https://github.com/{b['repository']}/blob/{b['commit']}/{b['sourcePath']}) | {license} | [Original {b.get('licensePath','license')}]({link}) |")
    lines+=['', 'The license API identified MIT for pytest, Fastify, Fastify workflows and Undici; BSD-3-Clause for Flask and HTTPX; and Apache-2.0 for Requests. These labels are GitHub metadata; the unmodified full texts above are authoritative package contents. Original YAML headers are preserved in the source archive.','', 'Requests NOTICE checks were also made at each of its eight bound historical commits, using only the conventional root `NOTICE` path. Results: '+json.dumps(result['noticeStatusCounts'])+'. Full responses and original NOTICE text are retained.','', '| Requests historical commit | Original NOTICE |','|---|---|']
    for n in notices:
        if n['status']=='FOUND':lines.append(f"| `{n['commit']}` | [Preserved NOTICE](../../../artifacts/paper-revision/ecq-v38/licenses/{n['file']}) |")
        else:lines.append(f"| `{n['commit']}` | {n['status']} |")
    lines+=['',f"Offline verification passed: {result['passed']}. It checks all {len(manifest)} raw API response hashes, exact decoded-license bytes, workflow-source hashes, complete packaged-YAML attribution coverage, commit query bindings and any decoded NOTICE. Detailed per-source attribution is in `artifacts/paper-revision/ecq-v38/licenses/bindings.json`; the original 1,093-response formal source manifest and frozen selection protocol were not altered.",'']
    (ROOT/'docs/paper-material/revision-v38/THIRD_PARTY_NOTICES.md').write_text('\n'.join(lines),encoding='utf8')
    print(json.dumps(result,indent=2))
    if errors:raise SystemExit(1)
if __name__=='__main__':main()
