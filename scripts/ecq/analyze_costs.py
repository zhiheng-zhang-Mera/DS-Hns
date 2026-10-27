"""Independent, deterministic cost-table derivation; standard library only.

Complete 30-round summaries and budget-censored attempts remain distinct.
This analysis consumes measurements; it never imports benchmark/evaluator code.
"""
import argparse
from collections import defaultdict
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re

METRICS=('normalize_ms','rdf_and_digest_ms','rule_ms','end_to_end_ms','peak_rss_bytes')


def _read(path):return json.loads(path.read_text(encoding='utf-8-sig'))


def _lines(path):return [json.loads(x) for x in path.read_text(encoding='utf-8-sig').splitlines() if x.strip()]


def _fixture(name):
    match=re.search(r'fixture-(\d+)-(\d+)',name)
    return (int(match[1]),int(match[2])) if match else (None,None)


def _quartile(values,p):
    values=sorted(values);index=(len(values)-1)*p;lower=int(index);upper=min(lower+1,len(values)-1)
    return values[lower]+(index-lower)*(values[upper]-values[lower])


def _describe(values):
    if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) or v<0 for v in values):
        raise ValueError('invalid cost measurement')
    return {'n':len(values),'median':_quartile(values,.5),'q1':_quartile(values,.25),'q3':_quartile(values,.75)}


def analyze(root):
    root=Path(root).resolve();groups=[];startup=[];inputs={};configs={}
    for folder in [root/'benchmark-v2',root/'benchmark-shacl-v2']:
        if not folder.is_dir():continue
        config_path=folder/'config.json'
        if not config_path.is_file():raise ValueError('missing benchmark configuration: '+folder.name)
        config=_read(config_path);configs[folder.name]=config
        input_paths=[config_path]
        primary=folder/'measurements.jsonl'
        warmup_file=folder/'warmups.jsonl'
        raw_by_key={};source_keys=set();row_sources={}
        all_files=sorted(folder.glob('fixture-*.all-attempts.jsonl'))
        files=([primary] if primary.exists() else [])+([warmup_file] if warmup_file.exists() else [])+all_files
        for file in files:
            input_paths.append(file);local_keys=set()
            for row in _lines(file):
                if file==warmup_file:row={**row,'phase':'warmup'}
                key=(row['methodId'],row['gates'],row['artifact_bytes'],row.get('phase','formal'),row['round'])
                if key in local_keys:raise ValueError('duplicate cost round in '+file.name)
                local_keys.add(key)
                if key in raw_by_key and raw_by_key[key]!=row:
                    raise ValueError('inconsistent duplicate cost round across record views')
                raw_by_key[key]=row;row_sources[key]=file.name
        censored={}
        for file in sorted(folder.glob('fixture-*.censored.json')):
            input_paths.append(file);gates,size=_fixture(file.name);censored[('B2',gates,size)]=_read(file)
        grouped=defaultdict(list)
        for key,row in raw_by_key.items():grouped[key[:3]].append(row)
        expected=set(grouped)|set(censored)
        if config.get('gates') is not None and config.get('sizes') is not None:
            expected|={(method,gates,size) for method in config['methods'] for gates in config['gates'] for size in config['sizes']}
        rounds=config.get('rounds',30);warmups=config.get('warmups',5)
        for method,gates,size in sorted(expected):
            key=(method,gates,size);rows=grouped[key]
            formal=[r for r in rows if r.get('phase','formal')=='formal']
            warm=[r for r in rows if r.get('phase')=='warmup']
            if any(r['round'] not in range(rounds) for r in formal):raise ValueError('formal round out of declared range')
            if any(r['round'] not in range(-warmups,0) for r in warm):raise ValueError('warmup round out of declared range')
            complete={r['round'] for r in formal}==set(range(rounds))
            censor=censored.get(key)
            if censor:status='BUDGET_CENSORED'
            elif complete:status='COMPLETE'
            else:status='INCOMPLETE'
            # New native cost runs archive warmups separately. Older prototype
            # recordings only declare warmups: never invent observed records.
            warmups_available=bool(all_files) or method=='B2' or warmup_file.exists()
            recorded_warm=len(warm) if warmups_available else None
            if complete and warmups_available and {r['round'] for r in warm}!=set(range(-warmups,0)):
                raise ValueError('completed configuration lacks declared warmups')
            stats=None
            if status=='COMPLETE':
                stats={metric:_describe([r[metric] for r in formal]) for metric in METRICS if all(metric in r for r in formal)}
                for metric in ['normalize_ms','rule_ms','end_to_end_ms','peak_rss_bytes']:
                    if metric not in stats:raise ValueError('complete configuration lacks metric '+metric)
            groups.append({'methodId':method,'gates':gates,'artifact_bytes':size,'status':status,
                           'formalCount':len(formal),'formalRoundsExpected':rounds,'warmupsDeclared':warmups,
                           'warmupsRecorded':recorded_warm,'metrics':stats,'budget':censor,
                           'authorizationFailures':sum(r.get('authorizePass') is not True or r.get('ruleAuthorizePass') is not True for r in formal),
                           'partialObservedRounds':sorted(r['round'] for r in formal) if status!='COMPLETE' else None})
        starts=folder/'startup.json'
        if starts.exists():
            input_paths.append(starts)
            for row in _read(starts):
                gates,size=_fixture(row.get('fixture',''))
                startup.append({'methodId':row['methodId'],'gates':row.get('gates',gates),
                                'artifact_bytes':row.get('artifact_bytes',size),'startup_ms':row['startup_ms'],
                                'status':row.get('status','COMPLETED'),'observations':1})
        for file in sorted(input_paths):inputs[file.relative_to(root).as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
    if not configs:raise ValueError('no cost recordings found')
    return {'schemaVersion':1,'groups':sorted(groups,key=lambda r:(r['methodId'],r['gates'],r['artifact_bytes'])),
            'coldStartup':sorted(startup,key=lambda r:(r['methodId'],r['gates'] or 0,r['artifact_bytes'] or 0)),
            'configurations':configs,'inputSha256':dict(sorted(inputs.items())),
            'quantiles':'Linear interpolation at (n-1)*p; median p=.5, q1=.25, q3=.75.',
            'interpretation':'Same-host, single-OS descriptive measurements. B2 is measured after Node methods, not paired in time across runtimes. OS cache is uncontrolled. Censored/incomplete configurations have no full-round estimate. Warmup records are counted when archived, otherwise unavailable rather than inferred from the declaration. RSS is cumulative worker high-water mark; startup observations are separate.'}


def write_analysis(root,out,verify_existing=False):
    summary=analyze(root);out=Path(out)
    json_bytes=(json.dumps(summary,indent=2,sort_keys=True)+'\n').encode('utf-8')
    stream=io.StringIO(newline='');writer=csv.writer(stream)
    writer.writerow(['method','gates','artifact_bytes','status','formal_count','expected_formal','warmups_declared','warmups_recorded','metric','n','median','q1','q3'])
    for group in summary['groups']:
        metrics=group['metrics'] or {'N/A':{}}
        for metric,values in sorted(metrics.items()):
            writer.writerow([group['methodId'],group['gates'],group['artifact_bytes'],group['status'],group['formalCount'],group['formalRoundsExpected'],group['warmupsDeclared'],group['warmupsRecorded'],metric,*[values.get(k) for k in ('n','median','q1','q3')]])
    outputs={'cost-summary.json':json_bytes,'cost-summary.csv':stream.getvalue().encode('utf-8')}
    if verify_existing:
        for name,data in outputs.items():
            if not (out/name).is_file() or (out/name).read_bytes()!=data:
                raise ValueError('published cost analysis differs: '+name)
    else:
        out.mkdir(parents=True,exist_ok=True)
        for name,data in outputs.items():(out/name).write_bytes(data)
    return summary


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--verify-existing',action='store_true')
    args=parser.parse_args();summary=write_analysis(args.root,args.out,args.verify_existing)
    print(json.dumps({'groups':len(summary['groups']),'complete':sum(g['status']=='COMPLETE' for g in summary['groups']),
                      'censored':sum(g['status']=='BUDGET_CENSORED' for g in summary['groups']),
                      'formalMeasurements':sum(g['formalCount'] for g in summary['groups']),
                      'verifiedExisting':args.verify_existing}))


if __name__=='__main__':main()
