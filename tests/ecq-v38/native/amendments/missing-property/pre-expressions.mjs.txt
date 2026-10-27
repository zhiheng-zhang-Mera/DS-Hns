export const U = Object.freeze({$unknown:true});
export const unknown = x => x === undefined || x?.$unknown === true;
export const truth = x => unknown(x) ? U : !(x === null || x === false || x === 0 || x === '' || Number.isNaN(x));
const number = x => x === null ? 0 : typeof x === 'boolean' ? +x : typeof x === 'number' ? x : typeof x === 'string' ? (x.trim()===''?0:Number(x)) : NaN;
const equal = (a,b) => unknown(a)||unknown(b)?U:typeof a===typeof b?(typeof a==='string'?a.toLowerCase()===b.toLowerCase():a===b):number(a)===number(b);
export function evaluate(expression, context={}, options={}) {
  if (typeof expression !== 'string') return expression;
  let source=expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  const tokens=[]; const re=/\s*(('(?:[^']|'')*')|(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?:[A-Za-z_][\w-]*)|&&|\|\||==|!=|[!().,\[\]-])/gy;
  let end=0,m; while((m=re.exec(source))){tokens.push(m[1]);end=re.lastIndex;} if(end!==source.length)return U;
  let p=0; const take=t=>tokens[p]===t?(p++,true):false;
  function atom(){
    if(take('!'))return {op:'!',a:atom()};
    if(take('-'))return {op:'neg',a:atom()};
    if(take('(')){const a=or();if(!take(')'))throw Error();return a;}
    const t=tokens[p++];if(!t)throw Error();
    if(t.startsWith("'"))return {value:t.slice(1,-1).replace(/''/g,"'")};
    if(/^[0-9]/.test(t))return {value:Number(t)};
    if(['true','false','null'].includes(t))return {value:JSON.parse(t)};
    if(take('(')){const args=[];if(!take(')')){do{args.push(or());}while(take(','));if(!take(')'))throw Error();}return {fn:t,args};}
    const path=[t];while(true){if(take('.'))path.push(tokens[p++]);else if(take('[')){const k=or();if(!take(']')||!('value'in k))throw Error();path.push(k.value);}else break;}return {path};
  }
  function eq(){let a=atom();while(['==','!='].includes(tokens[p]))a={op:tokens[p++],a,b:atom()};return a;}
  function and(){let a=eq();while(take('&&'))a={op:'&&',a,b:eq()};return a;}
  function or(){let a=and();while(take('||'))a={op:'||',a,b:and()};return a;}
  function run(n){
    if('value'in n)return n.value;
    if(n.path){let v=context;for(const k of n.path){if(unknown(v))return U;if(v===null||typeof v!=='object'||!Object.hasOwn(v,k))return n.path[0]==='matrix'||options.complete&&!options.partialRoots?.includes(n.path[0])?null:U;v=v[k];}return v;}
    if(n.fn){const f=n.fn.toLowerCase();if(['success','failure','cancelled','always'].includes(f))return n.args.length?U:f==='always'?true:options.status?.[f]??U;
      const a=n.args.map(run);if(a.some(unknown))return U;
      const str=x=>typeof x==='string'?x:typeof x==='number'||typeof x==='boolean'?String(x):x===null?'':null;
      if(f==='contains'&&a.length===2){if(Array.isArray(a[0])){const eq=a[0].map(x=>equal(x,a[1]));return eq.includes(true)?true:eq.some(unknown)?U:false;}return str(a[0])!==null&&str(a[1])!==null?str(a[0]).toLowerCase().includes(str(a[1]).toLowerCase()):U;}
      if(['startswith','endswith'].includes(f)&&a.length===2)return str(a[0])!==null&&str(a[1])!==null?str(a[0]).toLowerCase()[f==='startswith'?'startsWith':'endsWith'](str(a[1]).toLowerCase()):U;
      if(f==='format'&&typeof a[0]==='string'){let output='';for(let i=0;i<a[0].length;){const c=a[0][i];if(c==='{'&&a[0][i+1]==='{'){output+='{';i+=2;}else if(c==='}'&&a[0][i+1]==='}'){output+='}';i+=2;}else if(c==='{'){const match=/^\{(\d+)\}/.exec(a[0].slice(i));if(!match||+match[1]+1>=a.length)return U;const value=str(a[+match[1]+1]);if(value===null)return U;output+=value;i+=match[0].length;}else if(c==='}')return U;else{output+=c;i++;}}return output;}return U;}
    const a=run(n.a);if(n.op==='!'){const t=truth(a);return unknown(t)?U:!t;}if(n.op==='neg')return unknown(a)?U:-number(a);
    if(n.op==='&&'||n.op==='||'){const t=truth(a);if(!unknown(t)&&((n.op==='&&'&&!t)||(n.op==='||'&&t)))return a;const b=run(n.b);if(!unknown(t))return b;return U;}
    const r=equal(a,run(n.b));return n.op==='!='&&!unknown(r)?!r:r;
  }
  try{const ast=or();return p===tokens.length?run(ast):U;}catch{return U;}
}
export function render(template,context,options){
  if(typeof template!=='string')return U;let bad=false;
  const result=template.replace(/\$\{\{([\s\S]*?)\}\}/g,(_,e)=>{const v=evaluate(e,context,options);if(unknown(v)||typeof v==='object'&&v!==null){bad=true;return '';}return v===null?'':String(v);});return bad?U:result;
}
