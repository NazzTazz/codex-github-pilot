import path from 'node:path';

const idPattern=/^[a-z0-9][a-z0-9_-]{0,63}$/;

export function observationConfig(value,baseDirectory=process.cwd()) {
  if(value===undefined)return {mode:'legacy',defaultAccountId:'local',accounts:[{id:'local',label:'Codex',codexHome:null,scopeId:'local-codex-account'}]};
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['defaultAccountId','accounts'].includes(key)))throw new Error('Invalid observation configuration');
  if(typeof value.defaultAccountId!=='string'||!Array.isArray(value.accounts)||!value.accounts.length)throw new Error('Invalid observation configuration');
  const accounts=value.accounts.map(account=>{
    if(!account||typeof account!=='object'||Array.isArray(account)||Object.keys(account).some(key=>!['id','label','codexHome'].includes(key))
      ||typeof account.id!=='string'||!idPattern.test(account.id)||typeof account.label!=='string'||!account.label.trim()||account.label.trim().length>80
      ||typeof account.codexHome!=='string'||!account.codexHome||!path.isAbsolute(account.codexHome))throw new Error('Invalid observation configuration');
    const codexHome=path.resolve(account.codexHome);
    return {id:account.id,label:account.label.trim(),codexHome,scopeId:`codex-observation:${account.id}`};
  });
  if(new Set(accounts.map(account=>account.id)).size!==accounts.length||!accounts.some(account=>account.id===value.defaultAccountId))throw new Error('Invalid observation configuration');
  const homeKey=value=>process.platform==='win32'?value.toLowerCase():value;
  if(new Set(accounts.map(account=>homeKey(account.codexHome))).size!==accounts.length)throw new Error('Invalid observation configuration');
  return {mode:'multi',defaultAccountId:value.defaultAccountId,accounts};
}
