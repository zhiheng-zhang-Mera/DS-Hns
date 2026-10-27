"""MIT. Independent SHACL-SPARQL qualification profile, executed by pySHACL."""
import json,sys,time,argparse,traceback
from pathlib import Path
from rdflib import Graph
from pyshacl import validate
from to_rdf import convert,X,SH
CAPABILITIES=dict(authorization=True,closure=True,gateSatisfaction=True,relationDiagnostics=True,witnesses=True)
SHAPES=Graph().parse(Path(__file__).with_name('profile.ttl'),format='turtle')
def evaluate(bundle,contract,root,prepared=None):
 if not isinstance(bundle.get('evidence'),list) or not contract.get('requiredGates'):raise ValueError('malformed profile input')
 for records in [bundle['evidence'],contract['requiredGates']]+[e.get('artifactRefs',[])for e in bundle['evidence']if isinstance(e.get('artifactRefs'),list)]:
  ids=[r.get('id')for r in records]
  if any(not isinstance(i,str)for i in ids)or len(ids)!=len(set(ids)):raise ValueError('object IDs must be unique strings')
 graph,metadata=prepared if prepared is not None else convert(bundle,contract,root)
 conform,report,_=validate(graph,shacl_graph=SHAPES,advanced=False,inference='none')
 if not isinstance(report,Graph):raise RuntimeError('pySHACL validation failure')
 statuses={n:set() for n in metadata}
 for r in report.subjects(SH.resultMessage,None):
  node=report.value(r,SH.value);status=str(report.value(r,SH.resultMessage))
  if node not in metadata or status not in ['VIOLATED','UNRESOLVED']:raise RuntimeError('unexpected SHACL report')
  statuses[node].add(status)
 relations=[]
 for node,meta in metadata.items():
  ss=statuses[node];s='VIOLATED' if 'VIOLATED' in ss else 'UNRESOLVED' if ss else 'ESTABLISHED';relations.append({**meta,'status':s,'reasonCode':meta['invariant']+'_'+s})
 relations.sort(key=lambda r:r['obligationId']);ss={r['status'] for r in relations};closure='VIOLATED' if 'VIOLATED'in ss else 'UNRESOLVED' if 'UNRESOLVED'in ss else 'CLOSED'
 required=[g['id'] for g in contract['requiredGates'] if g.get('required')is not False];outcomes=[[e.get('outcome') for e in bundle['evidence'] if e.get('gateId')==gid] for gid in required]
 gate='UNSATISFIED' if any('FAIL'in oo for oo in outcomes) else 'SATISFIED' if required and all(oo and all(v=='PASS'for v in oo)for oo in outcomes) else 'UNRESOLVED'
 return dict(closureStatus=closure,gateSatisfaction=gate,authorizePass=closure=='CLOSED'and gate=='SATISFIED',relations=relations,methodIdentity='shacl-profile-v2',shaclConforms=conform)
def execute(bundle,contract,root):
 start=time.perf_counter()
 try:return dict(executionStatus='COMPLETED',exitCode=0,result=evaluate(bundle,contract,root),capabilities=CAPABILITIES,timings={'end_to_end_ms':(time.perf_counter()-start)*1000})
 except NotImplementedError as e:return dict(executionStatus='UNSUPPORTED',exitCode=3,result=None,capabilities=CAPABILITIES,error=str(e),timings={'end_to_end_ms':(time.perf_counter()-start)*1000})
 except Exception as e:return dict(executionStatus='RUNTIME_ERROR',exitCode=2,result=None,capabilities=CAPABILITIES,error=str(e),timings={'end_to_end_ms':(time.perf_counter()-start)*1000})
def main():
 p=argparse.ArgumentParser();p.add_argument('--bundle');p.add_argument('--contract');p.add_argument('--artifacts');p.add_argument('--out');p.add_argument('--service',action='store_true');a=p.parse_args()
 if a.service:
  for line in sys.stdin:
   try:
    req=json.loads(line);result=execute(req['bundle'],req['contract'],req['artifacts']);print(json.dumps(result),flush=True)
   except Exception as e:print(json.dumps({'executionStatus':'RUNTIME_ERROR','exitCode':2,'result':None,'error':str(e)}),flush=True)
 else:
  out=execute(json.loads(Path(a.bundle).read_text()),json.loads(Path(a.contract).read_text()),a.artifacts);Path(a.out).write_text(json.dumps(out));sys.exit(out['exitCode'])
if __name__=='__main__':main()
