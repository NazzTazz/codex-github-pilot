import { createHash } from 'node:crypto';

export const taskClasses = Object.freeze(['mechanical','routine','complex','exploratory']);
const taskClassSet = new Set(taskClasses);
const rootKeys = new Set(['class','executionContract']);
const contractKeys = new Set(['scope','expectedResult','invariants','areas','acceptanceCriteria','validationCommands']);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownKeysOnly = (value, allowed) => Object.keys(value).every(key => allowed.has(key));
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const textArray = (value, required) => {
  if (!Array.isArray(value) || (required && !value.length)) return null;
  const normalized=Array.from(value,text);
  return normalized.every(Boolean) ? normalized : null;
};

/** @param {unknown} value @returns {{scope:string,expectedResult:string,invariants:string[],areas:string[],acceptanceCriteria:string[],validationCommands:string[]}} */
export function validateExecutionContract(value) {
  if (!object(value) || !ownKeysOnly(value,contractKeys)) throw new Error('Invalid execution contract');
  const scope=text(value.scope),expectedResult=text(value.expectedResult);
  const invariants=textArray(value.invariants,true),areas=value.areas===undefined?[]:textArray(value.areas,false);
  const acceptanceCriteria=textArray(value.acceptanceCriteria,true),validationCommands=textArray(value.validationCommands,true);
  if (!scope || !expectedResult || !invariants || !areas || !acceptanceCriteria || !validationCommands) throw new Error('Invalid execution contract');
  return {scope,expectedResult,invariants,areas,acceptanceCriteria,validationCommands};
}

/** @param {string} request @returns {{kind:'absent'}|{kind:'valid',taskMetadata:{version:1,class:string,executionContract:null|object}}|{kind:'invalid',error:string}} */
export function parseTaskMetadata(request) {
  const lines=request.split(/\r?\n/);
  const first=lines.findIndex(line=>line.trim() !== '');
  if(first<0 || lines[first] !== '```pilot-task') return {kind:'absent'};
  const closing=lines.findIndex((line,index)=>index>first && line==='```');
  if(closing<0) return {kind:'invalid',error:'pilot-task-unclosed'};
  const json=lines.slice(first+1,closing).join('\n');
  if(Buffer.byteLength(json,'utf8')>16*1024) return {kind:'invalid',error:'pilot-task-too-large'};
  let value;
  try { value=JSON.parse(json); } catch { return {kind:'invalid',error:'pilot-task-json-invalid'}; }
  try {
    if(!object(value) || !ownKeysOnly(value,rootKeys) || typeof value.class !== 'string' || !taskClassSet.has(value.class)) throw new Error('Invalid task metadata');
    const executionContract=value.executionContract===undefined?null:validateExecutionContract(value.executionContract);
    return {kind:'valid',taskMetadata:{version:1,class:value.class,executionContract}};
  } catch { return {kind:'invalid',error:'pilot-task-schema-invalid'}; }
}

/** @param {{title?:unknown,body?:unknown}} issue */
export function specificationHash(issue) {
  return createHash('sha256').update(JSON.stringify({version:1,title:issue.title ?? '',body:issue.body ?? null}),'utf8').digest('hex');
}
