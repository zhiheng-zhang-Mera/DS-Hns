'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function resolveArtifact(ref,artifactRoot){
 if(ref.availability==='UNAVAILABLE')return {status:'UNAVAILABLE'};
 if(ref.availability==='MISSING')return {status:'MISSING'};
 if(typeof ref.path!=='string'||!ref.path||path.isAbsolute(ref.path)||/^[a-zA-Z]:/.test(ref.path)||ref.path.startsWith('\\'))return {status:'UNAVAILABLE'};
 const root=path.resolve(artifactRoot),target=path.resolve(root,ref.path);const rel=path.relative(root,target);
 if(rel==='..'||rel.startsWith(`..${path.sep}`)||path.isAbsolute(rel))return {status:'UNAVAILABLE'};
 try{
  const realRoot=fs.realpathSync(root),realTarget=fs.realpathSync(target),realRel=path.relative(realRoot,realTarget);
  if(realRel==='..'||realRel.startsWith(`..${path.sep}`)||path.isAbsolute(realRel))return {status:'UNAVAILABLE'};
  const bytes=fs.readFileSync(realTarget);return {status:'FOUND',actualSha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes};
 }catch(error){return {status:['ENOENT','ENOTDIR'].includes(error.code)?'MISSING':'UNAVAILABLE'};}
}
module.exports={resolveArtifact};
