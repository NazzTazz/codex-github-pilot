import { spawn } from 'node:child_process';

export function codexEnvironment(source = process.env) {
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

// Transitional name for callers that still describe the filtered environment as agent-wide.
export const agentEnvironment = codexEnvironment;
