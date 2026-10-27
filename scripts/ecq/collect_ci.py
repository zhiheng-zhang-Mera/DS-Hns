#!/usr/bin/env python3
"""Read-only GitHub Actions collector for the preregistered fixed-job profile.

Requires authenticated gh and pinned PyYAML (recorded in collection metadata).
Every API response used is archived. No action is triggered and no token is read
or printed by this script. API records are evidence of reported job outcomes.
"""
import argparse
import base64
import copy
import hashlib
import json
import pathlib
import subprocess
import sys
from datetime import datetime, timezone
import yaml

ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'artifacts/paper-revision/ecq-v37'
PLAN=ROOT/'docs/paper-material/revision-v37/collection-plan.json'

def canonical(obj):return (json.dumps(obj,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
def write(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(canonical(obj))
def digest(data):return hashlib.sha256(data).hexdigest()
def api(endpoint,path):
    if path.exists():return json.loads(path.read_text(encoding='utf-8'))
    proc=subprocess.run(['gh','api',endpoint],capture_output=True,text=True,encoding='utf-8',timeout=60)
    if proc.returncode:raise RuntimeError(f'GitHub API {endpoint}: {proc.stderr.strip()}')
    value=json.loads(proc.stdout);write(path,value);return value
def ordered_runs(runs,cutoff):
    return sorted((r for r in runs if r['created_at']<=cutoff),key=lambda r:(r['created_at'],r['id']),reverse=True)
def variants(bundle):
    result={name:copy.deepcopy(bundle) for name in ['original','wrong-state','wrong-run','missing-gate','scope-binding','unavailable-artifact']}
    result['wrong-state']['evidence'][0]['subject']['commit']='0'*40
    result['wrong-run']['evidence'][0]['runId']='unapproved-run'
    result['missing-gate']['evidence']=result['missing-gate']['evidence'][1:]
    result['scope-binding']['evidence'][0]['claimId']='unrelated-claim'
    result['scope-binding']['evidence'][0]['scope']='unrelated-scope'
    result['unavailable-artifact']['evidence'][0]['artifactRefs'][0]['availability']='UNAVAILABLE'
    return result
def required_jobs(workflow,owner):
    # Independent collection eligibility; actual normalization is done by JS adapter.
    jobs=[]
    for key,job in workflow.get('jobs',{}).items():
        if job.get('uses') or job.get('strategy'):raise ValueError('unsupported dynamic/reusable job')
        cond=job.get('if')
        if cond and cond!=f"github.repository_owner == '{owner}'":raise ValueError('unsupported condition')
        jobs.append((key,job.get('name',key)))
    if not jobs:raise ValueError('no declared jobs')
    return jobs
def collect():
    plan=json.loads(PLAN.read_text(encoding='utf-8'))
    sources=BASE/'sources';dataset=BASE/'external-corpus'
    sources.mkdir(parents=True,exist_ok=True);dataset.mkdir(parents=True,exist_ok=True)
    # Preserve authoritative pre-collection protocol bytes and hash.
    (sources/'collection-plan.json').write_bytes(PLAN.read_bytes())
    receipt={'cutoffUtc':plan['cutoffUtc'],'planSha256':digest(PLAN.read_bytes()),'collectorStartedUtc':datetime.now(timezone.utc).isoformat(),'projects':[],
      'qualificationScope':plan['qualificationScope'],'artifactTrust':plan['artifactTrust'],
      'toolVersions':{'python':sys.version,'pyyaml':yaml.__version__}}
    manifest=[];mapping_specs=[]
    for profile in plan['workflowProfiles']:
        repo=profile['repository'];slug=repo.replace('/','--');project=sources/slug
        endpoint=f"repos/{repo}/actions/workflows/{profile['workflow']}/runs?per_page=100&status=completed&event={profile['event']}"
        listing=api(endpoint,project/'candidate-runs.json')
        candidates=ordered_runs(listing['workflow_runs'],plan['cutoffUtc'])
        selected=[];excluded=[]
        for run in candidates:
            if len(selected)>=30:break
            runid=str(run['id']);folder=project/runid
            try:
                jobsdoc=api(f'repos/{repo}/actions/runs/{runid}/jobs?per_page=100&filter=latest',folder/'jobs.json')
                workflowdoc=api(f"repos/{repo}/contents/{run['path']}?ref={run['head_sha']}",folder/'workflow-api.json')
                raw=base64.b64decode(workflowdoc['content'])
                folder.mkdir(parents=True,exist_ok=True);(folder/'workflow.yml').write_bytes(raw)
                # GitHub Actions uses YAML 1.2: `on` is a string key, not YAML
                # 1.1's boolean True. This profile only needs structural/string
                # workflow values; BaseLoader avoids silent key coercion.
                workflow=yaml.load(raw,Loader=yaml.BaseLoader)
                required=required_jobs(workflow,repo.split('/')[0])
                names=sorted(name for _,name in required)
                observed=sorted(j['name'] for j in jobsdoc['jobs'])
                if names!=observed:raise ValueError(f'independent expected jobs {names} != returned jobs {observed}')
                if any(j['conclusion'] not in ['success','failure'] for j in jobsdoc['jobs']):raise ValueError('selected job not terminal success/failure')
                commit=api(f"repos/{repo}/git/commits/{run['head_sha']}",folder/'commit.json')
                split='development' if len(selected)<10 else 'evaluation'
                opaque=digest(f'{repo}\0{runid}'.encode())[:20]
                refs={}
                artifact_dir=dataset/'artifacts'/opaque;artifact_dir.mkdir(parents=True,exist_ok=True)
                for job in jobsdoc['jobs']:
                    filename=f"job-{job['id']}.json";data=canonical(job);(artifact_dir/filename).write_bytes(data)
                    refs[str(job['id'])]={'path':filename,'sha256':digest(data)}
                mapping={'repositoryId':repo,'tree':commit['tree']['sha'],'configurationDigest':digest(raw),'caseId':opaque,'artifacts':refs}
                mapping_specs.append({'sourceRunId':runid,'repository':repo,'mappingSpec':mapping})
                input_data={'record':{'run':run,'jobs':jobsdoc['jobs']},'workflow':workflow,
                  'eventContext':{'repository_owner':repo.split('/')[0],'event_name':run['event']},'mappingSpec':mapping}
                write(folder/'normalization-input.json',input_data)
                p=subprocess.run(['node',str(ROOT/'scripts/ecq/adapters/normalize.cjs'),str(folder/'normalization-input.json'),str(folder/'normalized.json')],capture_output=True,text=True,timeout=30)
                if p.returncode:raise RuntimeError(p.stderr)
                norm=json.loads((folder/'normalized.json').read_text(encoding='utf-8'))
                for family,bundle in variants(norm['bundle']).items():
                    caseid=digest(f'{opaque}\0{family}'.encode())[:24];bundle['caseId']=caseid
                    casefolder=dataset/'cases'/caseid;write(casefolder/'bundle.json',bundle);write(casefolder/'contract.json',norm['contract'])
                    manifest.append({'caseId':caseid,'baseId':opaque,'sourceGroup':repo,'split':split,'family':family,
                      'sourceRunId':runid,'bundlePath':f'cases/{caseid}/bundle.json','contractPath':f'cases/{caseid}/contract.json','artifactRoot':f'artifacts/{opaque}'})
                row={'runId':runid,'createdAt':run['created_at'],'event':run['event'],'conclusion':run['conclusion'],
                  'headSha':run['head_sha'],'treeSha':commit['tree']['sha'],'workflowPath':run['path'],'workflowSha256':digest(raw),
                  'split':split,'baseId':opaque,'runUrl':run['html_url'],'jobConclusions':{j['name']:j['conclusion'] for j in jobsdoc['jobs']},
                  'sourceDirectory':str(folder.relative_to(BASE)).replace('\\','/'),'mappingWitnesses':norm['mappingWitnesses']}
                write(folder/'run.json',run);selected.append(row)
                print(f'{repo} {len(selected)}/30 {runid} {run["conclusion"]}',flush=True)
            except Exception as exc:
                excluded.append({'runId':runid,'createdAt':run['created_at'],'reason':str(exc)});print(f'EXCLUDE {repo} {runid}: {exc}',flush=True)
        receipt['projects'].append({'repository':repo,'profile':profile,'candidateCount':len(candidates),'selected':selected,'excluded':excluded,
          'selectedCount':len(selected),'developmentRuns':sum(r['split']=='development' for r in selected),'evaluationRuns':sum(r['split']=='evaluation' for r in selected)})
        write(sources/'selection-manifest.json',receipt)
    (dataset/'manifest.jsonl').write_text(''.join(json.dumps(x,sort_keys=True)+'\n' for x in manifest),encoding='utf-8')
    receipt['collectorCompletedUtc']=datetime.now(timezone.utc).isoformat();receipt['cases']=len(manifest)
    receipt['evaluationCases']=sum(r['split']=='evaluation' for r in manifest)
    write(sources/'selection-manifest.json',receipt)
    write(ROOT/'docs/paper-material/revision-v37/sources.json',receipt)
    write(ROOT/'docs/paper-material/revision-v37/mapping-specs.json',{'profiles':mapping_specs})
    checks=[]
    for file in sorted(sources.rglob('*')):
        if file.is_file() and file.name!='SHA256SUMS':checks.append(f'{digest(file.read_bytes())}  {file.relative_to(sources).as_posix()}')
    (sources/'SHA256SUMS').write_text('\n'.join(checks)+'\n',encoding='utf-8')
    print(json.dumps({'projects':[(p['repository'],p['selectedCount']) for p in receipt['projects']],'cases':len(manifest),'evaluationCases':receipt['evaluationCases']}))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.parse_args();collect()
