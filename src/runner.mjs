import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { roles, profiles, executionFor, active, permitted, parseCommand, promptFor, validateResult } from './core.mjs';
import { execute, codexEnvironment, agentEnvironment } from './process.mjs';
import { createCodexExecutor, checkAuth, codexArgs } from './executors/codex.mjs';
import { specificationHash } from './task-classification.mjs';
import { localCodexTarget, schedulingConfig } from './scheduling-config.mjs';

export { execute, agentEnvironment, checkAuth, codexArgs };
async function gitCommand(args, cwd) {
  const result = await execute('git', args, {cwd, env:{...codexEnvironment(), GIT_TERMINAL_PROMPT:'0'}});
  if (result.code !== 0) throw new Error(`Git command failed: ${args[0]}\n${result.stderr}`);
  return result.stdout.trim();
}
export async function githubToken(config) {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (config.githubAuth !== 'git-credential') return undefined;
  const result = await execute('git',['credential','fill'],{
    cwd:config.checkout, input:'protocol=https\nhost=github.com\n\n',
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},timeoutMs:15000
  });
  if (result.code !== 0) throw new Error('GitHub credential helper unavailable; authenticate Git or set GITHUB_TOKEN.');
  const password = result.stdout.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9);
  if (!password) throw new Error('Git credential helper returned no usable credential');
  return password; // In memory only, never written to configuration or logs.
}
export function staticAssignment(job, execution, config) {
  const target=localCodexTarget({scheduling:config.scheduling ?? schedulingConfig(),observation:config.observation});
  const effectiveProfile=job.profile ?? Object.entries(profiles)
    .find(([,profile])=>profile.model===execution.model && profile.effort===execution.effort)?.[0] ?? null;
  return {version:1,routing:'static',targetId:target.id,provider:target.provider,adapter:target.adapter,
    observationSourceId:target.observationSourceId,capacityScopeId:target.capacityScopeId,requestedProfile:job.profile ?? null,effectiveProfile,
    requestedModel:execution.model,requestedEffort:execution.effort,model:execution.model,effort:execution.effort,
    sandbox:execution.sandbox,timeoutMs:config.timeoutMinutes*60000,adapterVersion:null,quotaPool:null,
    decisionId:null,observationId:null,overrideId:null,policyVersion:null,policyHash:null,mode:null,reason:'static-profile'};
}
export function executionInput(config, job, issue, sha, runId, taskMetadata = null) {
  const role=roles[job.role];
  const prompt=promptFor(job,issue,sha,taskMetadata);
  return {version:1,jobId:job.id,runId,repository:config.repository,revision:sha,requestedRole:job.role,
    functionalRole:role.functionalRole,title:issue.title,
    specification:issue.body,request:job.request,instructions:roles[job.role].instruction,
    requirements:{workspaceWrite:role.sandbox==='workspace-write',mayChangeTrackedFiles:role.mayChangeTrackedFiles,
      trackedFilesMustRemainUnchanged:!role.mayChangeTrackedFiles},
    taskClass:job.task_class || 'unclassified',taskMetadata,executionContract:taskMetadata?.executionContract ?? null,
    reportSchema:{name:'result.schema.json'},prompt};
}
export async function runJob(config, store, github, job, baseDirectory, dependencies = {}) {
  const git = dependencies.git || gitCommand;
  const authenticate = dependencies.authenticate || checkAuth;
  const jobStart=performance.now();
  const execution=executionFor(job);
  const assignment=staticAssignment(job,execution,config);
  const executor=dependencies.executor || createCodexExecutor(config,{run:dependencies.execute || execute,
    schemaPath:path.join(baseDirectory,'result.schema.json')});
  const runId=store.startRun(job.id,assignment,null);
  const attempt=()=>({runId,jobStart,status:store.job(job.id).status});
  try {
    const issue = await github.issue(job.issue);
    const comment = await github.request(`/issues/comments/${job.comment_id}`);
    const command = parseCommand(comment.body);
    const persistedMetadata=job.task_metadata_json ?? null;
    const currentMetadata=command?.taskMetadata===null||command?.taskMetadata===undefined?null:JSON.stringify(command.taskMetadata);
    const classificationChanged=command && (command.classificationError!==null
      || command.taskClass!==(job.task_class || 'unclassified') || currentMetadata!==persistedMetadata);
    if (!active(issue, config) || !permitted(comment, config) || command?.role !== job.role || command?.request !== job.request
      || (command?.profile ?? null) !== (job.profile ?? null) || classificationChanged) {
      store.update(job.id, {status:'cancelled', error:'Thread paused/closed or request/classification changed'}); return attempt();
    }
    if(job.specification_hash && specificationHash(issue)!==job.specification_hash) {
      store.update(job.id,{status:'cancelled',error:'Issue specification changed after queueing'});return attempt();
    }
    const pr = issue.pull_request ? await github.pr(job.issue) : null;
    if (pr && (pr.head.repo?.full_name?.toLowerCase() !== config.repository.toLowerCase() || pr.state !== 'open')) {
      throw new Error('Only open same-repository PRs are supported');
    }
    const role=roles[job.role];
    if (role.requiresPr && !pr) throw new Error('This role requires a PR with an explicit head commit');
    await authenticate(config);
    const directory = path.join(config.stateDirectory, 'runs', String(job.id));
    const checkout = path.join(directory, 'checkout');
    await mkdir(directory, {recursive:true});
    store.update(job.id, {directory});
    // Clone without inherited credential-bearing remotes. Preserve every run for inspection.
    await git(['clone','--no-hardlinks','--no-checkout','--',config.checkout,checkout], baseDirectory);
    await git(['remote','set-url','origin',`https://github.com/${config.repository}.git`], checkout);
    const repository = await github.request('');
    const ref = pr ? `refs/pull/${job.issue}/head` : `refs/heads/${repository.default_branch}`;
    await git(['fetch','--no-tags','origin',ref], checkout);
    const sha = await git(['rev-parse','FETCH_HEAD'], checkout);
    if (pr && sha !== pr.head.sha) throw new Error('PR changed while preparing checkout; retry with a new request');
    await git(['checkout','-b',`pilot/job-${job.id}`,sha], checkout);
    store.update(job.id, {sha});
    const taskMetadata=job.task_metadata_json?JSON.parse(job.task_metadata_json):null;
    const input=executionInput(config,job,issue,sha,runId,taskMetadata);
    store.setRunInput(runId,input);
    await writeFile(path.join(directory,'task.txt'),input.prompt);
    const outcome=await executor.execute(input,assignment,{workspacePath:checkout,outputDirectory:directory,onEvent:event=>{
      if(event.type==='worker-started')store.telemetry(runId,{worker_started_at:event.at,preparation_ms:Math.round(performance.now()-jobStart)});
      if(event.type==='spawned')store.telemetry(runId,{pid:event.pid});
      if(event.type==='telemetry')store.telemetry(runId,event.snapshot);
      if(event.type==='worker-finished')store.telemetry(runId,{worker_ms:event.workerMs,exit_code:event.exitCode,timed_out:event.timedOut});
    }});
    store.telemetry(runId,{worker_ms:outcome.workerMs,exit_code:outcome.exitCode ?? null,timed_out:Number(!!outcome.timedOut),
      ...outcome.telemetry});
    if(outcome.status==='interrupted') {store.update(job.id,{status:'interrupted',error:outcome.error.message});return attempt();}
    if(outcome.status!=='completed') {
      const quota=outcome.error?.kind==='quota';
      if(quota)store.set('quotaPaused','yes');
      store.update(job.id,{status:quota?'quota_wait':'failed',error:outcome.error?.message || 'Codex execution failed'});
      return attempt();
    }
    const value=validateResult(outcome.report);
    if (await git(['rev-parse','HEAD'],checkout) !== sha) throw new Error('Agent changed HEAD; inspect the preserved checkout');
    const changes = await git(['status','--porcelain'],checkout);
    await writeFile(path.join(directory,'changes.txt'),changes);
    await writeFile(path.join(directory,'changes.patch'),await git(['diff','--binary','HEAD'],checkout));
    if (!role.mayChangeTrackedFiles && await git(['status','--porcelain','--untracked-files=no'],checkout)) throw new Error('Role changed tracked files; result is not accepted');
    store.update(job.id,{status:'completed',result:JSON.stringify(value)});
  } catch (error) {
    store.update(job.id,{status:'failed',error:error.message});
  } finally {
    const current=store.job(job.id);
    store.telemetry(runId,{finished_at:new Date().toISOString(),total_ms:Math.round(performance.now()-jobStart),run_status:current.status,run_error:current.error});
  }
  return attempt();
}
export async function publishJob(config,store,github,job) {
  if (!['completed','publishing'].includes(job.status)) throw new Error('Job has no publishable result');
  const issue = await github.issue(job.issue);
  if (!active(issue,config)) { store.update(job.id,{status:'cancelled',error:'Thread no longer active; result retained locally'}); return; }
  if (issue.pull_request && (await github.pr(job.issue)).head.sha !== job.sha) {
    store.update(job.id,{status:'stale',error:'PR head changed; result retained locally'}); return;
  }
  const result = validateResult(JSON.parse(job.result));
  const marker = `<!-- codex-pilot:${config.repository}:${job.comment_id}:${job.role} -->`;
  const body = `### ${job.role} — ${result.verdict}\n\nCommit : \`${job.sha}\`\n\n${result.summary}\n\n` +
    `Constats :\n${result.findings.map(x=>`- ${x}`).join('\n') || '- Aucun signalé.'}\n\n` +
    `Vérifications :\n${result.validation.map(x=>`- ${x}`).join('\n') || '- Aucune déclarée.'}\n\n` +
    (job.role === 'sol-implement' ? 'Les modifications restent dans une copie locale ; aucun commit ou push automatique.\n\n' : '') +
    'Rapport automatisé ; aucune approbation de gameplay ni fusion automatique.';
  if (body.length > 50000) throw new Error('Report too long to publish; inspect locally');
  store.update(job.id,{status:'publishing'});
  await github.publish(job.issue,marker,body);
  store.update(job.id,{status:'published',error:null});
}
