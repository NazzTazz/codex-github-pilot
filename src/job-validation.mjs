import { active,permitted,parseCommand,roles } from './core.mjs';
import { specificationHash } from './task-classification.mjs';
import { GitHubHttpError } from './github.mjs';

async function readJobResource(read) {
  try {return await read();}
  catch(error) {
    // Missing resources invalidate this job. Auth, rate limits and network failures remain retryable.
    if(error instanceof GitHubHttpError&&[404,410].includes(error.status))return null;
    throw error;
  }
}

/** Shared pre-admission and pre-checkout validation. No persistence or authentication. */
export async function validateQueuedJob(config,github,job) {
  const issue=await readJobResource(()=>github.issue(job.issue));
  if(!issue)return {valid:false,error:'GitHub issue is no longer available'};
  const comment=await readJobResource(()=>github.request(`/issues/comments/${job.comment_id}`));
  if(!comment)return {valid:false,error:'GitHub request comment is no longer available'};
  const command=parseCommand(comment.body);
  const metadata=command?.taskMetadata==null?null:JSON.stringify(command.taskMetadata);
  if(!active(issue,config)||!permitted(comment,config)||command?.role!==job.role||command?.request!==job.request
    ||(command?.profile??null)!==(job.profile??null)||command?.classificationError!==null
    ||command?.taskClass!==(job.task_class||'unclassified')||metadata!==(job.task_metadata_json??null))
    return {valid:false,error:'Thread paused/closed or request/classification changed'};
  if(job.specification_hash&&specificationHash(issue)!==job.specification_hash)
    return {valid:false,error:'Issue specification changed after queueing'};
  const pr=issue.pull_request?await readJobResource(()=>github.pr(job.issue)):null;
  if(issue.pull_request&&!pr)return {valid:false,error:'GitHub PR is no longer available'};
  if(pr&&(pr.head.repo?.full_name?.toLowerCase()!==config.repository.toLowerCase()||pr.state!=='open'))
    return {valid:false,technical:true,error:'Only open same-repository PRs are supported'};
  if(roles[job.role].requiresPr&&!pr)return {valid:false,technical:true,error:'This role requires a PR with an explicit head commit'};
  return {valid:true,issue,pr};
}
