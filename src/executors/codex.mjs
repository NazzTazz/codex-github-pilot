import { openSync, writeSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Telemetry } from '../telemetry.mjs';
import { codexEnvironment, execute as executeProcess } from '../process.mjs';

const quotaPattern = /usage limit|quota|rate.limit|limit reached|try again at/i;
const supportedEfforts = new Set(['low','medium','high','xhigh','max']);
const supportedSandboxes = new Set(['read-only','workspace-write']);

export function codexArgs(config, assignment, directory, output, schema) {
  if (!assignment || assignment.provider !== 'openai' || assignment.adapter !== 'codex-exec'
    || typeof assignment.model !== 'string' || !assignment.model
    || !supportedEfforts.has(assignment.effort) || !supportedSandboxes.has(assignment.sandbox)) {
    throw new Error('Invalid Codex execution assignment');
  }
  return [...config.codexCommand.slice(1), '-a', 'never',
    'exec', '--ignore-user-config', '--ephemeral', '--json', '--model', assignment.model,
    '-c', `model_reasoning_effort="${assignment.effort}"`, '-c', 'model_provider="openai"',
    '--sandbox', assignment.sandbox, '--cd', directory,
    '--output-schema', schema, '--output-last-message', output, '-'];
}

export async function checkAuth(config, run = executeProcess) {
  const result = await run(config.codexCommand[0], [...config.codexCommand.slice(1), 'login', 'status'], {env:codexEnvironment()});
  if (result.code !== 0 || !/Logged in using ChatGPT/i.test(result.stdout + result.stderr)) {
    throw new Error('ChatGPT login not confirmed. Run codex login status in the same Windows account. API fallback is disabled.');
  }
}

export function createCodexExecutor(config, {run=executeProcess, schemaPath}={}) {
  if (!schemaPath) throw new Error('Codex result schema path is required');
  return {
    async execute(input, assignment, context) {
      if (!input || input.version !== 1 || typeof input.prompt !== 'string'
        || !context || typeof context.workspacePath !== 'string' || typeof context.outputDirectory !== 'string') {
        throw new Error('Invalid Codex executor input');
      }
      const output=path.join(context.outputDirectory,'result.json');
      const eventsPath=path.join(context.outputDirectory,'events.jsonl');
      const stderrPath=path.join(context.outputDirectory,'stderr.log');
      const stdout=openSync(eventsPath,'w');
      const stderr=openSync(stderrPath,'w');
      const telemetry=new Telemetry(snapshot=>context.onEvent?.({type:'telemetry',snapshot}));
      const workerStart=performance.now();
      context.onEvent?.({type:'worker-started',at:new Date().toISOString()});
      let result;
      try {
        result=await run(config.codexCommand[0],codexArgs(config,assignment,context.workspacePath,output,schemaPath),{
          cwd:context.workspacePath,env:codexEnvironment(),input:input.prompt,timeoutMs:assignment.timeoutMs,
          onStdout:data=>{writeSync(stdout,data);telemetry.feed(data);},
          onStderr:data=>writeSync(stderr,data),
          onSpawn:pid=>context.onEvent?.({type:'spawned',pid})
        });
      } finally {
        telemetry.end();
        context.onEvent?.({type:'worker-finished',workerMs:Math.round(performance.now()-workerStart),
          exitCode:result?.code ?? null,timedOut:result ? Number(result.timedOut) : null});
        closeSync(stdout);closeSync(stderr);
      }
      const processFields={exitCode:result.code ?? null,timedOut:!!result.timedOut,workerMs:Math.round(performance.now()-workerStart)};
      const artifacts=[{name:'events.jsonl',type:'codex-events'},{name:'stderr.log',type:'stderr'}];
      if(result.timedOut)return {status:'interrupted',error:{kind:'timeout',message:'Timeout; inspect preserved checkout before another request'},
        report:null,sessionId:telemetry.sessionId ?? null,telemetry:telemetry.snapshot(),artifacts,...processFields};
      if(result.code!==0) {
        const quota=quotaPattern.test(result.stderr+result.stdout);
        return {status:'failed',error:{kind:quota?'quota':'process',message:quota?'Quota unavailable; retry explicitly when available':'Codex failed; see local stderr.log'},
          report:null,sessionId:telemetry.sessionId ?? null,telemetry:telemetry.snapshot(),artifacts,...processFields};
      }
      let report;
      try {report=JSON.parse(await readFile(output,'utf8'));}
      catch(error) {return {status:'failed',error:{kind:'invalid-result',message:error.message},report:null,
        sessionId:telemetry.sessionId ?? null,telemetry:telemetry.snapshot(),artifacts,...processFields};}
      artifacts.push({name:'result.json',type:'structured-result'});
      return {status:'completed',error:null,report,sessionId:telemetry.sessionId ?? null,telemetry:telemetry.snapshot(),artifacts,...processFields};
    }
  };
}
