'use strict';
const fs=require('node:fs');
const {normalizeActions}=require('./github-actions.cjs');
if(require.main===module) {
  const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const result=normalizeActions(input.record,input.workflow,input.eventContext,input.mappingSpec);
  fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2)+'\n');
}
module.exports={normalizeActions};
