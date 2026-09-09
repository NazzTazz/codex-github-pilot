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
    `);
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value); }
  enqueue(comment, issue, role, request) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO jobs
      (comment_id,issue,role,request,payload,created,updated) VALUES (?,?,?,?,?,?,?)`)
      .run(comment.id, issue.number, role, request, JSON.stringify({comment, issue}), now, now);
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
