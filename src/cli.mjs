import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { GitHub } from './github.mjs';
import { poll } from './core.mjs';
import { checkAuth, execute, runJob, publishJob, githubToken } from './runner.mjs';
import { collectObservation, observationDelta } from './observation.mjs';
import { createDashboardServer } from './dashboard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function loadConfig(file) {
  const config = JSON.parse(await readFile(file,'utf8'));
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository) || !Array.isArray(config.allowedAuthors)
    || !config.allowedAuthors.length || !config.allowedAuthors.every(x=>typeof x==='string' && /^[\w-]+$/.test(x))
    || typeof config.activeLabel !== 'string' || !config.activeLabel
    || !Array.isArray(config.codexCommand) || !config.codexCommand.length || !config.codexCommand.every(x=>typeof x==='string' && x)
    || !Number.isFinite(config.pollSeconds) || config.pollSeconds < 30
    || !Number.isFinite(config.timeoutMinutes) || config.timeoutMinutes < 1 || config.timeoutMinutes > 120
    || typeof config.publish !== 'boolean'
    || !['environment','git-credential',undefined].includes(config.githubAuth)) throw new Error('Invalid configuration; see config.example.json');
  config.stateDirectory = path.resolve(path.dirname(file),config.stateDirectory);
  config.checkout = path.resolve(path.dirname(file),config.checkout);
  return config;
}
export async function lock(directory) {
  const key = process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  const port = 49152 + createHash('sha256').update(key).digest().readUInt16BE(0) % 16384;
  const server = createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',error=>reject(new Error(`Pilot lock unavailable on localhost:${port}: ${error.code}`)));
    server.listen({host:'127.0.0.1',port,exclusive:true},resolve);
  });
  return () => new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  if (command === 'help') {
    console.log('node src/cli.mjs <doctor|setup|status|metrics|observe|usage|stop-observe|dashboard|stop-dashboard|poll|run|stop|publish ID|retry ID|cancel ID|resume-quota> [--config path] [--once]\nmetrics --json exports worker telemetry. observe collects account quota/tokens once; --watch --interval 60 repeats. usage [--json] [--limit 100] reads saved account observations. stop-observe stops that observer. dashboard [--port 4173] serves the local dashboard; stop-dashboard stops only the dashboard. Default config: config.local.json. poll only queues; run executes.'); return;
  }
  const configIndex = args.indexOf('--config');
  const config = await loadConfig(path.resolve(configIndex >= 0 ? args[configIndex+1] : path.join(root,'config.local.json')));
  if(command==='dashboard' || command==='stop-dashboard') {
    await mkdir(config.stateDirectory,{recursive:true});
    const stopFile=path.join(config.stateDirectory,'dashboard-stop.requested');
    if(command==='stop-dashboard') {await writeFile(stopFile,new Date().toISOString());console.log('Dashboard stop requested. Observer and pilot are unchanged.');return;}
    const index=args.indexOf('--port'),port=index<0?4173:Number(args[index+1]);
    if(!Number.isSafeInteger(port) || port<1024 || port>65535)throw new Error('Dashboard port must be between 1024 and 65535');
    const assets=path.join(root,'dashboard','dist');
    if(!existsSync(path.join(assets,'index.html')))throw new Error('Build the dashboard first: npm run dashboard:build');
    const release=await lock(path.join(config.stateDirectory,'dashboard'));
    const server=createDashboardServer({stateDirectory:config.stateDirectory,assetDirectory:assets});
    let timer;
    const stop=()=>{clearInterval(timer);server.close();server.closeIdleConnections();};
    try {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
      if(existsSync(stopFile))await unlink(stopFile);
      console.log(`Dashboard local: http://127.0.0.1:${port}/`);
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
      timer=setInterval(()=>{if(existsSync(stopFile))stop();},1000);
      await new Promise(resolve=>server.once('close',resolve));
    } finally {clearInterval(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);server.close();await release();}
    return;
  }
  const github = new GitHub(config.repository,['doctor','setup','poll','run','publish'].includes(command) ? await githubToken(config) : undefined);
  if (command === 'setup') {
    for await (const label of github.pages('/labels')) {
      if (label.name === config.activeLabel) { console.log('Activation label already exists.'); return; }
    }
    await github.request('/labels','POST',{name:config.activeLabel,color:'1d76db',description:'Allow local Codex pilot commands on this thread'});
    console.log('Activation label created. No issue or PR was activated.'); return;
  }
  if (command === 'doctor') {
    const version = await execute(config.codexCommand[0],[...config.codexCommand.slice(1),'--version']);
    console.log(version.stdout.trim());
    await checkAuth(config);
    console.log('ChatGPT authentication confirmed; no API key fallback.');
    const repo = await github.request('');
    console.log(`GitHub read access: ${repo.full_name}; authenticated: ${!!github.token}; publication: ${config.publish}`);
    console.log(`Checkout: ${config.checkout}\nState: ${config.stateDirectory}`); return;
  }
  await mkdir(config.stateDirectory,{recursive:true});
  const stopFile = path.join(config.stateDirectory,'stop.requested');
  if (command === 'stop') { await writeFile(stopFile,new Date().toISOString()); console.log('Stop requested after the current operation.'); return; }
  const observationStopFile=path.join(config.stateDirectory,'observation-stop.requested');
  if(command==='stop-observe') { await writeFile(observationStopFile,new Date().toISOString());console.log('Observer stop requested. Pilot execution is unchanged.');return; }
  const store = new Store(path.join(config.stateDirectory,'queue.sqlite'));
  if(command==='usage') {
    try {
      const limitIndex=args.indexOf('--limit');
      const rows=store.observations(limitIndex<0?100:Number(args[limitIndex+1]));
      if(args.includes('--json'))console.log(JSON.stringify(rows.map((row,i)=>({...row,delta:observationDelta(rows[i-1],row)})),null,2));
      else if(!rows.length)console.log('No account observations yet. Run: node src/cli.mjs observe');
      else {
        console.table(rows.map((row,i)=>({id:row.id,at:row.finished_at,status:row.status,lifetime_tokens:row.usage?.lifetime_tokens ?? null,
          account_tokens_delta:observationDelta(rows[i-1],row)?.account_tokens_delta ?? null,errors:JSON.stringify(row.errors)})));
        printObservation(rows.at(-1));
      }
    } finally {store.close();}return;
  }
  if(command==='observe') {
    let release;
    let stopping=false;
    const stop=()=>{stopping=true;};
    try {
      const index=args.indexOf('--interval'),interval=index<0?60:Number(args[index+1]);
      if(!Number.isSafeInteger(interval) || interval<30 || interval>86400)throw new Error('Observation interval must be 30–86400 seconds');
      if(args.includes('--once') && args.includes('--watch'))throw new Error('Choose --once or --watch');
      release=await lock(path.join(config.stateDirectory,'account-observer'));
      if(existsSync(observationStopFile))await unlink(observationStopFile);
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
      do {
        const sample=await collectObservation(config,store);
        if(args.includes('--json'))console.log(JSON.stringify(sample));else printObservation(sample);
        if(!args.includes('--watch')) {if(sample.status!=='ok')process.exitCode=1;break;}
        for(let elapsed=0;elapsed<interval && !stopping;elapsed++) {
          if(existsSync(observationStopFile)){stopping=true;break;}
          await new Promise(resolve=>setTimeout(resolve,1000));
        }
      } while(!stopping);
    } finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);store.close();if(release)await release();}
    return;
  }
  if(command==='metrics') {
    const rows=store.metrics();
    if(args.includes('--json'))console.log(JSON.stringify(rows,null,2));
    else console.table(rows.map(r=>({run:r.id,job:r.job_id,role:r.role,status:r.run_status,input:r.input_tokens,cached:r.cached_input_tokens,
      output:r.output_tokens,reasoning:r.reasoning_output_tokens,preparation_ms:r.preparation_ms,worker_ms:r.worker_ms,total_ms:r.total_ms})));
    store.close();return;
  }
  if (command === 'status') {
    console.log(`Quota paused: ${store.get('quotaPaused') === 'yes'}`);
    console.table(store.jobs().map(({id,issue,role,status,sha,error})=>({id,issue,role,status,sha,error}))); store.close(); return;
  }
  const release = await lock(config.stateDirectory);
  let stopping = false;
  process.on('SIGINT',()=>{ stopping=true; console.log('Stopping after the current operation.'); });
  process.on('SIGTERM',()=>{ stopping=true; });
  try {
    if (!store.get('firstStarted')) store.set('firstStarted',new Date().toISOString());
    if (command === 'resume-quota') { store.set('quotaPaused','no'); console.log('Queue unpaused. Existing quota_wait jobs remain preserved.'); return; }
    if (command === 'poll') {
      console.log(`Queued ${await poll(config,store,github)} request(s). No agent launched.`); return;
    }
    if (['publish','retry','cancel'].includes(command)) {
      const id = Number(args[1]);
      const job = Number.isSafeInteger(id) && store.job(id);
      if (!job) throw new Error('Unknown job');
      if (command === 'publish') await publishJob(config,store,github,job);
      if (command === 'cancel') {
        if (['published','publishing'].includes(job.status)) throw new Error('Cannot cancel an already published or ambiguous publication');
        store.update(id,{status:'cancelled'});
      }
      if (command === 'retry') {
        if (!['failed','interrupted','quota_wait'].includes(job.status)) throw new Error('Only failed/interrupted/quota jobs can be retried');
        // Never overwrite a partially edited checkout or silently repeat an implementation.
        if (job.directory) throw new Error('Workspace exists: inspect it and post a new command. Original artifacts are preserved.');
        store.update(id,{status:'queued',error:null});
      }
      return;
    }
    if (command !== 'run') throw new Error('Unknown command');
    if (existsSync(stopFile)) await unlink(stopFile);
    await checkAuth(config);
    if (config.publish && !github.token) throw new Error('Set GITHUB_TOKEN before enabling publication');
    store.recover();
    do {
      try {
        console.log(`${new Date().toISOString()} queued=${await poll(config,store,github)}`);
        if (config.publish) {
          for (const pending of store.jobs().filter(j=>j.status==='publishing')) await publishJob(config,store,github,pending);
        }
        if (existsSync(stopFile)) stopping=true;
        if (!stopping && store.get('quotaPaused') !== 'yes') {
          const job = store.claim();
          if (job) { console.log(`Running job ${job.id}: ${job.role} #${job.issue}`); await runJob(config,store,github,job,root); console.log(`Job ${job.id}: ${store.job(job.id).status}`); }
        }
      } catch (error) { console.error(error.message); }
      if (args.includes('--once')) break;
      for (let elapsed=0; elapsed<config.pollSeconds && !stopping; elapsed++) {
        if (existsSync(stopFile)) { stopping=true; break; }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
    } while (!stopping);
  } finally { store.close(); await release(); }
}
function printObservation(sample) {
  console.log(`Account observation #${sample.id} ${sample.finished_at}: ${sample.status}; plan=${sample.plan_type ?? 'unknown'}`);
  if(sample.quota) {
    console.table(sample.quota.windows.map(w=>({bucket:w.limit_id,window:w.window,remaining_percent:w.remaining_percent,
      window_minutes:w.window_minutes,resets_at:w.resets_at===null?null:new Date(w.resets_at*1000).toISOString()})));
    console.log(`Ordinary usage allowed (server): ${sample.quota.ordinary_usage_allowed ?? 'unknown'}`);
  }
  if(sample.usage) {
    console.log(`Account lifetime tokens: ${sample.usage.lifetime_tokens ?? 'unknown'}; daily peak: ${sample.usage.peak_daily_tokens ?? 'unknown'}`);
    if(sample.usage.daily_buckets)console.table(sample.usage.daily_buckets.slice(-7));
  }
  if(Object.keys(sample.errors).length)console.log(`Unavailable data: ${JSON.stringify(sample.errors)}`);
  console.log('Account-wide observations; worker tokens remain in metrics. No automatic queue resume.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{ console.error(error.message); process.exitCode=1; });
}
