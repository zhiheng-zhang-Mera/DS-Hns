'use strict';
const capabilities=Object.freeze({authorization:true,closure:false,gateSatisfaction:false,relationDiagnostics:false,witnesses:false});
function evaluate(bundle){if(!bundle||!Array.isArray(bundle.evidence))throw new TypeError('Missing evidence array');return {authorizePass:bundle.evidence.length>0&&bundle.evidence.every(e=>e.outcome==='PASS'),closureStatus:null,gateSatisfaction:null,relations:null,capabilities,methodIdentity:'outcome-only-v1'};}
module.exports=evaluate;module.exports.evaluate=evaluate;module.exports.capabilities=capabilities;
