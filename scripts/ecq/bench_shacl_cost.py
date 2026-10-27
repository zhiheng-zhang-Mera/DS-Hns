"""MIT. B2 persistent-process cost stages on the exact Node-generated fixtures."""
import argparse,json,time,sys,subprocess,os,statistics,ctypes
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent/'baselines/shacl'))
from run import evaluate
from to_rdf import convert
def peak_rss():
 if os.name!='nt':
  import resource
  return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024
 from ctypes import wintypes
 class Counters(ctypes.Structure):
  _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(x,ctypes.c_size_t)for x in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
 c=Counters();c.cb=ctypes.sizeof(c)
 kernel=ctypes.windll.kernel32;kernel.GetCurrentProcess.restype=wintypes.HANDLE
 api=ctypes.windll.psapi.GetProcessMemoryInfo;api.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD];api.restype=wintypes.BOOL
 if not api(kernel.GetCurrentProcess(),ctypes.byref(c),c.cb):raise OSError('GetProcessMemoryInfo failed')
 return c.PeakWorkingSetSize
def main():
 p=argparse.ArgumentParser();p.add_argument('--fixtures',required=True);p.add_argument('--out',required=True);p.add_argument('--worker');a=p.parse_args();fixtures=Path(a.fixtures);out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
 if not a.worker and (out/'measurements.jsonl').exists():raise ValueError('Refusing benchmark overwrite')
 if a.worker:
  f=Path(a.worker);bt=(f/'bundle.json').read_text();ct=(f/'contract.json').read_text();rows=[]
  print(json.dumps({'ready':True}),flush=True)
  for index in range(-5,30):
   t=time.perf_counter();b=json.loads(bt);c=json.loads(ct);normalize=(time.perf_counter()-t)*1000
   t=time.perf_counter();prepared=convert(b,c,f/'artifacts');rdf=(time.perf_counter()-t)*1000
   t=time.perf_counter();r=evaluate(b,c,f/'artifacts',prepared);rule=(time.perf_counter()-t)*1000
   t=time.perf_counter();e=evaluate(json.loads(bt),json.loads(ct),f/'artifacts');end=(time.perf_counter()-t)*1000
   measurement={'phase':'warmup' if index<0 else 'formal','methodId':'B2','gates':len(c['requiredGates']),'artifact_bytes':sum(x.stat().st_size for x in (f/'artifacts').iterdir()),'round':index,'normalize_ms':normalize,'rdf_and_digest_ms':rdf,'rule_ms':rule,'end_to_end_ms':end,'peak_rss_bytes':peak_rss(),'authorizePass':e['authorizePass'],'ruleAuthorizePass':r['authorizePass']}
   with (out/(f.name+'.all-attempts.jsonl')).open('a')as stream:stream.write(json.dumps(measurement)+'\n')
   if index>=0:rows.append(measurement)
  (out/(f.name+'.jsonl')).write_text(''.join(json.dumps(r)+'\n'for r in rows));print(json.dumps({'completed':len(rows)}));return
 starts=[]
 for f in sorted(fixtures.glob('fixture-*')):
  t=time.perf_counter();child=subprocess.Popen([sys.executable,__file__,'--fixtures',str(fixtures),'--out',str(out),'--worker',str(f)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
  ready=child.stdout.readline();startup=(time.perf_counter()-t)*1000
  if not json.loads(ready).get('ready'):raise RuntimeError(ready)
  try:stdout,stderr=child.communicate(timeout=180)
  except subprocess.TimeoutExpired:
   child.kill();stdout,stderr=child.communicate();(out/(f.name+'.censored.json')).write_text(json.dumps({'status':'BUDGET_CENSORED','budgetSeconds':180,'stage':'warmup or formal loop','stdout':stdout,'stderr':stderr}));starts.append({'fixture':f.name,'methodId':'B2','startup_ms':startup,'status':'BUDGET_CENSORED'});print(f.name,'BUDGET_CENSORED',flush=True);continue
  if child.returncode:raise RuntimeError(stderr)
  starts.append({'fixture':f.name,'methodId':'B2','startup_ms':startup});print(f.name,stdout.strip(),flush=True)
 (out/'startup.json').write_text(json.dumps(starts,indent=2));(out/'config.json').write_text(json.dumps({'warmups':5,'rounds':30,'methods':['B2'],'order':'Separate B2 process after Node campaign, not paired-in-time across runtimes','normalizationDefinition':'JSON decoding only; RDF mapping plus digest separate; rule validates already prepared graph','rssDefinition':'OS cumulative process peak RSS isolated per configuration','cachePolicy':'OS cache uncontrolled, five warmups, E2E reopens and hashes files','secondOS':False,'configurationBudgetSeconds':180,'budgetRule':'Parent kills owned worker at 180 seconds; all finished warmup/formal attempts retained; censored configurations have no complete 30-round estimate'},indent=2))
 (out/'measurements.jsonl').write_text(''.join(f.read_text()for f in sorted(out.glob('fixture-*.jsonl'))if not f.name.endswith('.all-attempts.jsonl')))
if __name__=='__main__':main()
