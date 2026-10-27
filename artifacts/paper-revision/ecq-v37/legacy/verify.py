#!/usr/bin/env python3
"""Byte verification and independent legacy outcome reconstruction; no rerun."""
import argparse,collections,hashlib,json,pathlib,subprocess,sys,tempfile,zipfile

ROOT=pathlib.Path(__file__).resolve().parent/'source'
EXPECTED={'safe-campaign-01':'fbcc54b064a9f677aea25b9712a3b0b5d20fca3d86170be80987d7f28596b5ed',
 'safe-gap-v2':'488e5ef9488186a3cc2595e24b3eb4d2c71af2806f6bc12a3610b571bcbe1d39'}
def sha(b):return hashlib.sha256(b).hexdigest()
def verify():
 report={'scope':'Independent read-only reanalysis of original component records; 750 arm observations, not new ECQ qualification cases.',
  'archives':[],'legacyLatencyMeaning':'spawn-to-terminal-exit, including failed exits; no cross-runtime causal recovery-speed claim',
  'sourceCommit':'4023749389233a424b48320f6d30c160784986bd'}
 for name,expected in EXPECTED.items():
  directory=ROOT/'artifacts/paper-revision'/name;archive=directory/'raw-evidence.zip'
  actual=sha(archive.read_bytes());assert actual==expected
  with zipfile.ZipFile(archive) as z:
   inner=z.read('RAW_CHECKSUMS.sha256').decode();count=0
   for line in inner.splitlines():
    digest,filename=line.split('  ',1);assert sha(z.read(filename))==digest,(name,filename);count+=1
   rows=[json.loads(x) for x in z.read('attempts.jsonl').decode().splitlines()]
   groups=collections.defaultdict(lambda:{'n':0,'overBudgetEpisodes':0,'complete':0,'exactSequence':0,'duplicateEpisodes':0,'nonzeroResumeExits':0})
   for row in rows:
    key='|'.join((row['experiment'],row['scenario'],row['arm']));g=groups[key];g['n']+=1
    raw=json.loads(z.read(row['rawPath']))
    if row['experiment']=='A4':
     prefix=row['rawPath'].rsplit('/',1)[0]
     effects=[json.loads(x) for x in z.read(prefix+'/effects.jsonl').decode().splitlines() if x]
     expected_steps=json.loads(z.read(prefix+'/spec.json'))['steps']
     complete=all(step in effects for step in expected_steps);exact=effects==expected_steps
     duplicate=len(effects)-len({x['id'] for x in effects})
     assert complete==row['complete'] and exact==row['duplicateFree'] and duplicate==row['duplicateCount']
     g['complete']+=complete;g['exactSequence']+=exact;g['duplicateEpisodes']+=duplicate>0
     g['nonzeroResumeExits']+=sum(a['phase']=='resume' and a['code'] not in (0,None) for a in raw['attempts'])
    else:
     accepted=[];oracle=[];over=False;disagreements=0
     for event in raw['events']:
      # Original protocol retains events on the inclusive 1000-ms edge.
      now=event['atVirtualMs'];accepted=[t for t in accepted if now-t<=1000];oracle=[t for t in oracle if now-t<=1000]
      oracle_allowed=len(oracle)<3
      assert oracle_allowed==event['oracleAllowed']
      if oracle_allowed:oracle.append(now)
      over_event=event['allowed'] and len(accepted)>=3
      assert over_event==event['overBudget']
      over|=over_event;disagreements+=event['allowed']!=oracle_allowed
      if event['allowed']:accepted.append(now)
     assert over==row['overBudget'] and disagreements==row['disagreements']
     g['overBudgetEpisodes']+=over
   with tempfile.TemporaryDirectory(prefix='h37-legacy-') as temp:
    z.extractall(temp)
    proc=subprocess.run([sys.executable,str(ROOT/'scripts/paper-revision/analyze_safe.py'),temp],capture_output=True,text=True,timeout=300)
    assert proc.returncode==0,proc.stderr
    recomputed=json.loads((pathlib.Path(temp)/'analysis.json').read_text())
    published=json.loads((directory/'analysis.json').read_text())
    assert recomputed==published
   report['archives'].append({'id':name,'zipSha256':actual,'verifiedInnerFiles':count,'zipMembersIncludingChecksum':len(z.namelist()),
    'rows':len(rows),'recomputedAnalysisEqualPublished':True,'independentlyReconstructedGroups':dict(sorted(groups.items())),
    'nonzeroResumeExits':sum(g['nonzeroResumeExits'] for g in groups.values())})
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',required=True);args=p.parse_args()
 result=verify();target=pathlib.Path(args.out);target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
 print(json.dumps({'verified':True,'archives':[(a['id'],a['rows'],a['verifiedInnerFiles'],a['nonzeroResumeExits']) for a in result['archives']]}))
