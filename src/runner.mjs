import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { roles, active, permitted, parseCommand, promptFor, validateResult } from './core.mjs';
import { Telemetry } from './telemetry.mjs';

export function agentEnvironment(source = process.env) {
  const env = {...source};
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_.*|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|GIT_ASKPASS|SSH_ASKPASS)$/i.test(key)) delete env[key];
  }
  return env;
}
export async function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd:options.cwd, env:options.env || process.env,
      windowsHide:true, shell:false, detached:process.platform !== 'win32', stdio:['pipe','pipe','pipe']});
    if(child.pid)options.onSpawn?.(child.pid);
    let stdout = '', stderr = '', timedOut = false, killFallback;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
        killer.on('error',()=>child.kill('SIGKILL'));
        killFallback = setTimeout(()=>{child.kill('SIGKILL');killer.kill();},2000);
      }
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }, options.timeoutMs || 60000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2000000); options.onStdout?.(data); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-200000); options.onStderr?.(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killFallback); resolve({code,stdout,stderr,timedOut}); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input || '');
  });
}
async function gitCommand(args, cwd) {
  const result = await execute('git', args, {cwd, env:{...agentEnvironment(), GIT_TERMINAL_PROMPT:'0'}});
  if (result.code !== 0) throw new Error(`Git command failed: ${args[0]}\n${result.stderr}`);
  return result.stdout.trim();
}
export async function checkAuth(config) {
  const result = await execute(config.codexCommand[0], [...config.codexCommand.slice(1), 'login', 'status'], {env:agentEnvironment()});
  if (result.code !== 0 || !/Logged in using ChatGPT/i.test(result.stdout + result.stderr)) {
    throw new Error('ChatGPT login not confirmed. Run codex login status in the same Windows account. API fallback is disabled.');
  }
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
export function codexArgs(config, job, directory, output, schema) {
  const role = roles[job.role];
  return [...config.codexCommand.slice(1), '-a', 'never',
    'exec', '--ignore-user-config', '--ephemeral', '--json', '--model', role.model,
    '-c', `model_reasoning_effort="${role.effort}"`, '-c', 'model_provider="openai"',
    '--sandbox', role.sandbox, '--cd', directory,
    '--output-schema', schema, '--output-last-message', output, '-'];
}
export async function runJob(config, store, github, job, baseDirectory, dependencies = {}) {
  const git = dependencies.git || gitCommand;
  const authenticate = dependencies.authenticate || checkAuth;
  const run = dependencies.execute || execute;
  const jobStart=performance.now();
  const runId=store.startRun(job.id,roles[job.role].model,roles[job.role].effort);
  try {
    const issue = await github.issue(job.issue);
    const comment = await github.request(`/issues/comments/${job.comment_id}`);
    const command = parseCommand(comment.body);
    if (!active(issue, config) || !permitted(comment, config) || command?.role !== job.role || command?.request !== job.request) {
      store.update(job.id, {status:'cancelled', error:'Thread paused/closed or request changed'}); return;
    }
    const pr = issue.pull_request ? await github.pr(job.issue) : null;
    if (pr && (pr.head.repo?.full_name?.toLowerCase() !== config.repository.toLowerCase() || pr.state !== 'open')) {
      throw new Error('Only open same-repository PRs are supported');
    }
    if (job.role !== 'sol-implement' && !pr) throw new Error('Counter-review requires a PR with an explicit head commit');
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
    const output = path.join(directory,'result.json');
    await writeFile(path.join(directory,'task.txt'),promptFor(job,issue,sha));
    const stdout = openSync(path.join(directory,'events.jsonl'),'w');
    const stderr = openSync(path.join(directory,'stderr.log'),'w');
    const workerStart=performance.now();
    store.telemetry(runId,{worker_started_at:new Date().toISOString(),preparation_ms:Math.round(workerStart-jobStart)});
    const telemetry=new Telemetry(snapshot=>store.telemetry(runId,snapshot));
    let result;
    try {
      result = await run(config.codexCommand[0], codexArgs(config,job,checkout,output,path.join(baseDirectory,'result.schema.json')), {
        cwd:checkout, env:agentEnvironment(), input:promptFor(job,issue,sha),
        timeoutMs:config.timeoutMinutes * 60000,
        onStdout:data => {writeSync(stdout,data);telemetry.feed(data);}, onStderr:data => writeSync(stderr,data),
        onSpawn:pid=>store.telemetry(runId,{pid})
      });
    } finally {
      telemetry.end();
      store.telemetry(runId,{worker_ms:Math.round(performance.now()-workerStart),exit_code:result?.code ?? null,timed_out:result ? Number(result.timedOut) : null});
      closeSync(stdout);closeSync(stderr);
    }
    if (result.timedOut) { store.update(job.id,{status:'interrupted',error:'Timeout; inspect preserved checkout before another request'}); return; }
    if (result.code !== 0) {
      const quota = /usage limit|quota|rate.limit|limit reached|try again at/i.test(result.stderr + result.stdout);
      if (quota) store.set('quotaPaused','yes');
      store.update(job.id,{status:quota ? 'quota_wait' : 'failed',error:quota ? 'Quota unavailable; retry explicitly when available' : 'Codex failed; see local stderr.log'}); return;
    }
    const value = validateResult(JSON.parse(await readFile(output,'utf8')));
    if (await git(['rev-parse','HEAD'],checkout) !== sha) throw new Error('Agent changed HEAD; inspect the preserved checkout');
    const changes = await git(['status','--porcelain'],checkout);
    await writeFile(path.join(directory,'changes.txt'),changes);
    await writeFile(path.join(directory,'changes.patch'),await git(['diff','--binary','HEAD'],checkout));
    if (job.role !== 'sol-implement' && await git(['status','--porcelain','--untracked-files=no'],checkout)) throw new Error('Reviewer changed tracked files; result is not accepted');
    store.update(job.id,{status:'completed',result:JSON.stringify(value)});
    if (config.publish) await publishJob(config,store,github,store.job(job.id));
  } catch (error) {
    const current = store.job(job.id);
    store.update(job.id,{status:current.status === 'publishing' ? 'publishing' : 'failed',error:error.message});
  } finally {
    const current=store.job(job.id);
    store.telemetry(runId,{finished_at:new Date().toISOString(),total_ms:Math.round(performance.now()-jobStart),run_status:current.status,run_error:current.error});
  }
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
