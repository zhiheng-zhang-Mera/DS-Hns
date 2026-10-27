'use strict';
// ECQ profile 1. Predicates consume facts and a separately supplied contract.
const capabilities=Object.freeze({authorization:true,closure:true,gateSatisfaction:true,relationDiagnostics:true,witnesses:true});
const known=x=>x!==null&&x!==undefined;
function aggregate(statuses){return statuses.includes('VIOLATED')?'VIOLATED':statuses.includes('UNRESOLVED')?'UNRESOLVED':'CLOSED';}
function combine(statuses){return statuses.includes('VIOLATED')?'VIOLATED':statuses.includes('UNRESOLVED')?'UNRESOLVED':'ESTABLISHED';}
function equality(a,b){return !known(a)||!known(b)?'UNRESOLVED':a===b?'ESTABLISHED':'VIOLATED';}
function membership(value,allowed){return !known(value)||!Array.isArray(allowed)?'UNRESOLVED':allowed.includes(value)?'ESTABLISHED':'VIOLATED';}
function reachable(start,target,graph){
 if(!known(start)||!known(target)||!graph||!Array.isArray(graph.nodes)||!Array.isArray(graph.edges))return 'UNRESOLVED';
 if(!graph.nodes.includes(start)||!graph.nodes.includes(target))return 'VIOLATED';
 const seen=new Set(),todo=[start];while(todo.length){const x=todo.pop();if(x===target)return 'ESTABLISHED';if(seen.has(x))continue;seen.add(x);for(const edge of graph.edges)if(edge[0]===x)todo.push(edge[1]);}return 'VIOLATED';
}
function gateSatisfaction(bundle,contract){
 const required=contract.requiredGates.filter(g=>g.required!==false);
 if(!required.length)return 'UNRESOLVED';
 let incomplete=false;
 for(const gate of required){const items=bundle.evidence.filter(e=>e.gateId===gate.id);if(items.some(e=>e.outcome==='FAIL'))return 'UNSATISFIED';if(!items.length||items.some(e=>e.outcome!=='PASS'))incomplete=true;}
 return incomplete?'UNRESOLVED':'SATISFIED';
}
function validateInput(bundle,contract){
 if(!bundle||!Array.isArray(bundle.evidence)||!contract||!Array.isArray(contract.requiredGates))throw new TypeError('Bundle evidence and contract requiredGates must be arrays');
 const ids=bundle.evidence.map(e=>e.id);if(ids.some(x=>typeof x!=='string')||new Set(ids).size!==ids.length)throw new TypeError('Evidence IDs must be unique strings');
 const gateIds=contract.requiredGates.map(g=>g.id);if(gateIds.some(x=>typeof x!=='string')||new Set(gateIds).size!==gateIds.length)throw new TypeError('Gate IDs must be unique strings');
 for(const e of bundle.evidence){if(Array.isArray(e.artifactRefs)){const refs=e.artifactRefs.map(r=>r.id);if(refs.some(x=>typeof x!=='string')||new Set(refs).size!==refs.length)throw new TypeError('Artifact IDs must be unique strings within evidence');}}
}
module.exports={known,aggregate,combine,equality,membership,reachable,gateSatisfaction,validateInput,capabilities};
