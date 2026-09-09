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
    this.db.prepare(`UPDATE jobs SET status='interrupted', error='Previous process stopped; inspect workspace before retry', updated=? WHERE status='running'`)
      .run(new Date().toISOString());
  }
  close() { this.db.close(); }
}
