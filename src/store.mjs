import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, comment_id INTEGER UNIQUE NOT NULL,
        issue INTEGER NOT NULL, role TEXT NOT NULL, request TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', payload TEXT NOT NULL,
        sha TEXT, directory TEXT, result TEXT, error TEXT,
        created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS worker_runs (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), model_requested TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL, job_started_at TEXT NOT NULL,
        worker_started_at TEXT, finished_at TEXT, preparation_ms INTEGER,
        worker_ms INTEGER, total_ms INTEGER, pid INTEGER, exit_code INTEGER,
        timed_out INTEGER, session_id TEXT, completed_turns INTEGER DEFAULT 0,
        input_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
        output_tokens INTEGER, reasoning_output_tokens INTEGER,
        usage_json TEXT NOT NULL DEFAULT '[]', errors_json TEXT NOT NULL DEFAULT '[]',
        malformed_lines INTEGER NOT NULL DEFAULT 0, run_status TEXT NOT NULL DEFAULT 'running', run_error TEXT);
      CREATE TABLE IF NOT EXISTS account_observations (
        id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
        account_key TEXT, plan_type TEXT, source TEXT NOT NULL, status TEXT NOT NULL,
        quota_observed_at TEXT, usage_observed_at TEXT, quota_json TEXT, usage_json TEXT,
        errors_json TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'profile')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN profile TEXT');
    }
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value); }
  enqueue(comment, issue, role, request, profile = null) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO jobs
      (comment_id,issue,role,request,payload,created,updated,profile) VALUES (?,?,?,?,?,?,?,?)`)
      .run(comment.id, issue.number, role, request, JSON.stringify({comment, issue}), now, now, profile);
  }
  seen(id) { return !!this.db.prepare('SELECT id FROM seen WHERE id=?').get(id); }
  markSeen(id) { this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?)').run(id); }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY id').all(); }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  startRun(id,model,effort) {
    return Number(this.db.prepare('INSERT INTO worker_runs (job_id,model_requested,reasoning_effort,job_started_at) VALUES (?,?,?,?)')
      .run(id,model,effort,new Date().toISOString()).lastInsertRowid);
  }
  telemetry(id,fields) {
    const allowed=['worker_started_at','finished_at','preparation_ms','worker_ms','total_ms','pid','exit_code','timed_out',
      'session_id','completed_turns','input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens',
      'reasoning_output_tokens','usage_json','errors_json','malformed_lines','run_status','run_error'];
    if(Object.keys(fields).some(k=>!allowed.includes(k)))throw new Error('Invalid telemetry field');
    this.db.prepare(`UPDATE worker_runs SET ${Object.keys(fields).map(k=>`${k}=?`).join(',')} WHERE id=?`)
      .run(...Object.values(fields),id);
  }
  metrics() {
    return this.db.prepare(`SELECT r.*,j.issue,j.role,j.status,j.created AS queued_at,
      j.sha,j.directory,j.error FROM worker_runs r JOIN jobs j ON j.id=r.job_id ORDER BY r.id`).all();
  }
  recordObservation(sample) {
    return Number(this.db.prepare(`INSERT INTO account_observations
      (started_at,finished_at,account_key,plan_type,source,status,quota_observed_at,usage_observed_at,quota_json,usage_json,errors_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sample.started_at,sample.finished_at,sample.account_key,sample.plan_type,
        sample.source,sample.status,sample.quota_observed_at,sample.usage_observed_at,
        sample.quota===null?null:JSON.stringify(sample.quota),sample.usage===null?null:JSON.stringify(sample.usage),JSON.stringify(sample.errors)).lastInsertRowid);
  }
  observations(limit=100) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>10000)throw new Error('Observation limit must be between 1 and 10000');
    return this.db.prepare('SELECT * FROM account_observations ORDER BY id DESC LIMIT ?').all(limit).reverse().map(row=>{
      const {quota_json,usage_json,errors_json,...fields}=row;
      return {...fields,quota:quota_json===null?null:JSON.parse(quota_json),usage:usage_json===null?null:JSON.parse(usage_json),errors:JSON.parse(errors_json)};
    });
  }
  update(id, fields) {
    const allowed = ['status','sha','directory','result','error'];
    if (Object.keys(fields).some(key => !allowed.includes(key))) throw new Error('Invalid job field');
    this.db.prepare(`UPDATE jobs SET ${Object.keys(fields).map(k => `${k}=?`).join(',')}, updated=? WHERE id=?`)
      .run(...Object.values(fields), new Date().toISOString(), id);
  }
  claim() {
    return this.db.prepare(`UPDATE jobs SET status='running', updated=? WHERE id=(
      SELECT id FROM jobs WHERE status='queued' ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE status='running') RETURNING *`)
      .get(new Date().toISOString());
  }
  recover() {
    this.db.prepare("UPDATE worker_runs SET run_status='interrupted',run_error='Parent process stopped; final duration unknown' WHERE finished_at IS NULL").run();
    this.db.prepare(`UPDATE jobs SET status='interrupted', error='Previous process stopped; inspect workspace before retry', updated=? WHERE status='running'`)
      .run(new Date().toISOString());
  }
  close() { this.db.close(); }
}
