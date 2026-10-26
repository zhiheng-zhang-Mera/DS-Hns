"""Independent reconstruction of fixture outcomes and paired seeded analysis.
Standard library only. All unfavorable observations remain in denominators.
"""
from pathlib import Path
import sys,json,hashlib,math,random,statistics,collections

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def wilson(k,n):
    if not n:return None
    z=1.959963984540054;p=k/n;d=1+z*z/n
    m=(p+z*z/(2*n))/d;h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [max(0,m-h),min(1,m+h)]
def ci(values,stat=statistics.mean):
    rng=random.Random(20261026);n=len(values)
    means=sorted(stat(rng.choices(values,k=n)) for _ in range(10000))
    return [means[249],means[9749]]
def analyze(root):
    config=json.loads((root/'config.json').read_text());rows=[json.loads(x) for x in (root/'attempts.jsonl').read_text().splitlines()]
    assert len(rows)==len(config['seeds'])*21
    cells=set();errors=[]
    for row in rows:
        cell=(row['experiment'],row['scenario'],row['seed'],row['arm']);assert cell not in cells;cells.add(cell)
        for key in ('candidateSha','candidateTree','driverSha'):assert row[key]==config[key]
        raw=root/row['rawPath'];assert sha(raw)==row['rawHash'];data=json.loads(raw.read_text())
        if row['experiment']=='A4':
            episode=raw.parent
            effects=[json.loads(x) for x in (episode/'effects.jsonl').read_text().splitlines() if x]
            spec=json.loads((episode/'spec.json').read_text());expected=spec['steps']
            duplicates=len(effects)-len({x['id'] for x in effects})
            complete=all(step in effects for step in expected)
            exact=effects==expected
            assert row['complete']==complete and row['duplicateCount']==duplicates and row['duplicateFree']==exact
            assert row['effectCount']==len(effects)
            if row['scenario']!='no-fault':
                assert data['attempts'][0]['handshake']['step']==spec['faultStep']
                assert data['attempts'][0]['killedByRunner'] is True
                assert len(data['attempts'])==2 and data['attempts'][0]['ownedPid']!=data['attempts'][1]['ownedPid']
        if row['status']!='OBSERVED':errors.append(row['episodeId'])
    groups=collections.defaultdict(list)
    for r in rows:groups[(r['experiment'],r['scenario'],r['arm'])].append(r)
    summary=[]
    for (experiment,scenario,arm),rr in sorted(groups.items()):
        v={'experiment':experiment,'scenario':scenario,'arm':arm,'n':len(rr),'errors':sum(r['status']!='OBSERVED' for r in rr)}
        if experiment=='A4':
            k=sum(r['duplicateFree'] for r in rr);lat=[r['recoveryMs'] for r in rr if r['recoveryMs'] is not None]
            v.update(complete=sum(r['complete'] for r in rr),exactly_once=k,duplicate_episodes=sum(r['duplicateCount']>0 for r in rr),duplicate_count_mean=statistics.mean(r['duplicateCount'] for r in rr),wilson95_fixture_only=wilson(k,len(rr)),recovery_ms_median=statistics.median(lat) if lat else None)
        else:v.update(over_budget=sum(r['overBudget'] for r in rr),disagreement_episodes=sum(r['disagreements']>0 for r in rr),accepted_mean=statistics.mean(r['accepted'] for r in rr))
        summary.append(v)
    paired=[]
    for scenario in config['checkpointScenarios']:
        full={r['seed']:r for r in groups[('A4',scenario,'checkpoint')]}
        for comparator in ('replay','simple-journal','langgraph-sqlite'):
            other={r['seed']:r for r in groups[('A4',scenario,comparator)]}
            assert full.keys()==other.keys()
            diff=[int(full[s]['duplicateFree'])-int(other[s]['duplicateFree']) for s in sorted(full)]
            duplicates=[other[s]['duplicateCount']-full[s]['duplicateCount'] for s in sorted(full)]
            lat=[full[s]['recoveryMs']-other[s]['recoveryMs'] for s in sorted(full)] if scenario!='no-fault' else []
            paired.append({'scenario':scenario,'comparator':comparator,'n_pairs':len(diff),'exact_success_difference':statistics.mean(diff),'exact_difference_bootstrap95':ci(diff),'duplicate_reduction_mean':statistics.mean(duplicates),'duplicate_reduction_bootstrap95':ci(duplicates),'recovery_latency_difference_ms_median':statistics.median(lat) if lat else None,'latency_difference_bootstrap95':ci(lat,statistics.median) if lat else None,'cross_runtime_latency_causal_claim_allowed':comparator!='langgraph-sqlite'})
    out={'protocol':config['protocol'],'mode':config['mode'],'total_arm_observations':len(rows),'budget_arm_observations':sum(r['experiment']=='A3' for r in rows),'checkpoint_arm_observations':sum(r['experiment']=='A4' for r in rows),'infrastructure_errors':errors,'new_ecq_episodes':0,'groups':summary,'paired':paired,'limitations':['One Windows host; component adapters, not desktop product workflow.','A3 is deterministic virtual-time policy testing, three fixed schedule families; no physical restart.','A4 uses 30 generated seeds in each fixed fault stratum; four arms paired, not independent populations.','Wilson and bootstrap intervals conditional on sampled fixture seeds; structural outcomes are not general reliability estimates.','Effect and checkpoint are not one transaction; gap duplicates are counterevidence retained.','Cross-runtime launch/import latency not an algorithmic speed comparison.']}
    (root/'analysis.json').write_text(json.dumps(out,indent=2)+'\n',encoding='utf-8')
    lines=['# Safe mechanism campaign results','',f"{len(rows)} arm observations; {len(errors)} infrastructure errors; 0 ECQ episodes.",'','| Experiment | Stratum | Arm | n | Main outcome |','|---|---|---|---:|---|']
    for g in summary:
        value=f"exactly-once {g['exactly_once']}/{g['n']}; complete {g['complete']}/{g['n']}; duplicate episodes {g['duplicate_episodes']}" if g['experiment']=='A4' else f"over-budget episodes {g['over_budget']}; oracle disagreement episodes {g['disagreement_episodes']}"
        lines.append(f"| {g['experiment']} | {g['scenario']} | {g['arm']} | {g['n']} | {value} |")
    lines+=['','## Interpretation','',*['- '+x for x in out['limitations']]]
    (root/'RESULTS.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'rows':len(rows),'errors':len(errors),'analysis':str(root/'analysis.json')}))
if __name__=='__main__':analyze(Path(sys.argv[1]))
