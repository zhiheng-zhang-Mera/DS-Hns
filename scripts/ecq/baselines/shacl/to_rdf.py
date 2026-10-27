"""MIT. Lossless JSON facts plus explicit profile RDF; no qualification predicates."""
import json,hashlib
from pathlib import Path, PurePosixPath
import re
from rdflib import Graph,Namespace,URIRef,Literal,RDF
X=Namespace('urn:ecq:');SH=Namespace('http://www.w3.org/ns/shacl#')
def convert(bundle,contract,root):
 g=Graph();hub=X.audit;relations={};root=Path(root).resolve()
 def put(s,p,v):
  if v is not None:g.add((s,X[p],Literal(v)))
 def uri(label):return URIRef('urn:ecq:object:'+hashlib.sha256(label.encode()).hexdigest())
 cn=uri('contract');g.add((hub,X.contract,cn));put(cn,'json',json.dumps(contract,sort_keys=True))
 runs=contract.get('runPolicy',{}).get('allowedRunIds');put(cn,'runsKnown',isinstance(runs,list))
 for r in runs or []:put(cn,'allowedRun',r)
 types=contract.get('admissibleTypes',{}).get('types');put(cn,'typesKnown',isinstance(types,list))
 for r in types or []:put(cn,'allowedType',r)
 provenance=contract.get('admissibleTypes',{}).get('provenance');put(cn,'provenanceKnown',isinstance(provenance,list))
 for r in provenance or []:put(cn,'allowedProvenance',r)
 cg=contract.get('claimGraph')or {};put(cn,'graphKnown',isinstance(cg.get('nodes'),list)and isinstance(cg.get('edges'),list))
 for a,b in (contract.get('claimGraph')or {}).get('edges',[]):g.add((uri('claim:'+a),X.supports,uri('claim:'+b)))
 for n in (contract.get('claimGraph')or {}).get('nodes',[]):g.add((uri('claim:'+n),RDF.type,X.Claim))
 if contract.get('requestedClaim') is not None:g.add((cn,X.requested,uri('claim:'+contract['requestedClaim'])))
 gates={}
 for gate in contract.get('requiredGates',[]):
  if gate.get('required') is False:continue
  gn=uri('gate:'+gate['id']);gates[gate['id']]=gn;g.add((cn,X.gate,gn));put(gn,'claim',gate.get('claimId'));put(gn,'scope',gate.get('scope'))
 def relation(inv,suffix,witness,ev=None,gate=None,ref=None):
  oid=inv+':'+suffix;rn=uri('relation:'+oid);g.add((hub,X.relation,rn));put(rn,'kind',inv);g.add((rn,X.contract,cn));
  if ev is not None:g.add((rn,X.evidence,ev))
  if gate is not None:g.add((rn,X.gate,gate))
  if ref is not None:g.add((rn,X.ref,ref))
  relations[rn]={'obligationId':oid,'invariant':inv,'witnessRefs':sorted(witness)};return rn
 for gid,gn in gates.items():relation('I_G','g:'+gid,['/contract/requiredGates/'+gid],gate=gn)
 for e in bundle.get('evidence',[]):
  eid=e['id'];ev=uri('evidence:'+eid);put(ev,'json',json.dumps(e,sort_keys=True));g.add((cn,X.evidence,ev));pre='/evidence/'+eid
  for k,p in [('runId','run'),('claimId','claim'),('scope','scope'),('evidenceType','type'),('provenance','provenance'),('outcome','outcome'),('gateId','gateId')]:put(ev,p,e.get(k))
  if e.get('gateId') in gates:g.add((ev,X.gate,gates[e['gateId']]));g.add((gates[e['gateId']],X.evidence,ev))
  if e.get('claimId') is not None:g.add((ev,X.claimNode,uri('claim:'+e['claimId'])))
  for inv,wp in [('I_S',['/contract/statePolicy',pre+'/subject']),('I_R',['/contract/runPolicy',pre+'/runId']),('I_V',['/contract/claimGraph',pre+'/claimId']),('I_C',['/contract/requiredGates'+('/'+str(e['gateId'])if e.get('gateId')is not None else ''),pre+'/binding']),('I_T',['/contract/admissibleTypes',pre+'/type'])]:
   rn=relation(inv,'e:'+eid,wp,ev=ev)
   if inv=='I_S':
    for key,expected in (contract.get('statePolicy')or {'__missing__':None}).items():
     field=uri('state:'+eid+':'+key);g.add((rn,X.field,field));put(field,'expected',expected);put(field,'actual',(e.get('subject')or {}).get(key))
  for ref in e.get('artifactRefs') or [{'id':'required'}]:
   rid=ref.get('id','required');rf=uri('ref:'+eid+':'+rid);put(rf,'json',json.dumps(ref,sort_keys=True));status=ref.get('availability')
   actual=None
   if status not in ['MISSING','UNAVAILABLE']:
    try:
     raw=str(ref.get('path')or '').replace('\\','/');p=(root/raw).resolve()
     invalid=not raw or PurePosixPath(raw).is_absolute()or bool(re.match(r'^[A-Za-z]:',raw))or '..'in PurePosixPath(raw).parts or '\0'in raw or not p.is_relative_to(root)
     if invalid:status='UNAVAILABLE'
     elif not p.is_file():status='MISSING'
     else:actual=hashlib.sha256(p.read_bytes()).hexdigest();status='FOUND'
    except OSError:status='UNAVAILABLE'
   put(rf,'readStatus',status);put(rf,'object',ref.get('objectId'));put(rf,'expectedObject',ref.get('expectedObjectId'));put(rf,'digest',actual);put(rf,'expectedDigest',ref.get('sha256'))
   for inv in ['I_E','I_I']:relation(inv,'a:'+eid+':'+rid,[pre+'/artifacts/'+rid],ref=rf)
 return g,relations
