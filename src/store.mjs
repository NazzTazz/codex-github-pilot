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
    for (const [name,definition] of [['task_class',"TEXT NOT NULL DEFAULT 'unclassified'"],['task_metadata_json','TEXT'],['specification_hash','TEXT']]) {
      if (!this.db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
    }
    this.#columns('jobs',[['last_schedule_decision_id','INTEGER'],['deferred_since','TEXT']]);
    this.#columns('account_observations',[['capacity_scope_id',"TEXT NOT NULL DEFAULT 'local-codex-account'"],['capabilities_json','TEXT'],
      ['observation_source_id',"TEXT NOT NULL DEFAULT 'local'"]]);
    this.#columns('worker_runs',[
      ['scheduling_decision_id','INTEGER'],['target_id','TEXT'],['provider','TEXT'],['adapter','TEXT'],['adapter_version','TEXT'],
      ['capacity_scope_id','TEXT'],['model_effective','TEXT'],['effort_requested','TEXT'],['sandbox_effective','TEXT'],
      ['quota_pool','TEXT'],['model_observed','TEXT'],['execution_input_json','TEXT']
    ]);
    this.db.exec(`CREATE TABLE IF NOT EXISTS scheduling_decisions (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), created_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('evaluation','admission')), action TEXT NOT NULL,
        reason_code TEXT NOT NULL, fingerprint TEXT NOT NULL, decision_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scheduling_decisions_job ON scheduling_decisions(job_id,id);
      CREATE TABLE IF NOT EXISTS quota_incidents (
        id INTEGER PRIMARY KEY, capacity_scope_id TEXT NOT NULL, quota_pool TEXT NOT NULL,
        account_key TEXT, created_at TEXT NOT NULL, observed_at TEXT, job_id INTEGER REFERENCES jobs(id),
        worker_run_id INTEGER REFERENCES worker_runs(id), kind TEXT NOT NULL, not_before TEXT NOT NULL,
        cleared_at TEXT, cleared_reason TEXT);
      CREATE INDEX IF NOT EXISTS quota_incidents_scope ON quota_incidents(capacity_scope_id,quota_pool,cleared_at);
      CREATE TABLE IF NOT EXISTS scheduling_overrides (
        id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT);
      CREATE INDEX IF NOT EXISTS scheduling_overrides_job ON scheduling_overrides(job_id,created_at);`);
  }
  #columns(table,columns) {
    const existing=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(column=>column.name));
    for(const [name,definition] of columns)if(!existing.has(name))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, value); }
  enqueue(comment, issue, role, request, profile = null, options = {}) {
    const {taskClass='unclassified',taskMetadata=null,specificationHash=null,status='queued',error=null}=options;
    if (!['queued','invalid'].includes(status) || !['unclassified','mechanical','routine','complex','exploratory'].includes(taskClass)) throw new Error('Invalid job classification');
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO jobs
      (comment_id,issue,role,request,status,payload,created,updated,profile,task_class,task_metadata_json,specification_hash,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(comment.id,issue.number,role,request,status,JSON.stringify({comment,issue}),now,now,profile,taskClass,
        taskMetadata===null?null:JSON.stringify(taskMetadata),specificationHash,error);
  }
  seen(id) { return !!this.db.prepare('SELECT id FROM seen WHERE id=?').get(id); }
  markSeen(id) { this.db.prepare('INSERT OR IGNORE INTO seen VALUES (?)').run(id); }
  jobs() { return this.db.prepare('SELECT * FROM jobs ORDER BY id').all(); }
  job(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  startRun(id,assignmentOrModel,inputOrEffort=null) {
    if(typeof assignmentOrModel==='string')return Number(this.db.prepare('INSERT INTO worker_runs (job_id,model_requested,reasoning_effort,job_started_at) VALUES (?,?,?,?)')
      .run(id,assignmentOrModel,inputOrEffort,new Date().toISOString()).lastInsertRowid);
    const assignment=assignmentOrModel,input=inputOrEffort;
    return Number(this.db.prepare(`INSERT INTO worker_runs (job_id,model_requested,reasoning_effort,job_started_at,
      scheduling_decision_id,target_id,provider,adapter,adapter_version,capacity_scope_id,model_effective,
      effort_requested,sandbox_effective,quota_pool,execution_input_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,assignment.requestedModel??assignment.model,assignment.effort,new Date().toISOString(),assignment.decisionId,assignment.targetId,
        assignment.provider,assignment.adapter,assignment.adapterVersion??null,assignment.capacityScopeId,assignment.model,
        assignment.requestedEffort??assignment.effort,assignment.sandbox,assignment.quotaPool??null,input===null?null:JSON.stringify(input)).lastInsertRowid);
  }
  setRunInput(id,input) { this.db.prepare('UPDATE worker_runs SET execution_input_json=? WHERE id=?').run(JSON.stringify(input),id); }
  telemetry(id,fields) {
    const allowed=['worker_started_at','finished_at','preparation_ms','worker_ms','total_ms','pid','exit_code','timed_out',
      'session_id','completed_turns','input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens',
      'reasoning_output_tokens','usage_json','errors_json','malformed_lines','run_status','run_error','model_observed'];
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
      (started_at,finished_at,account_key,plan_type,source,status,quota_observed_at,usage_observed_at,quota_json,usage_json,errors_json,capacity_scope_id,capabilities_json,observation_source_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sample.started_at,sample.finished_at,sample.account_key,sample.plan_type,
        sample.source,sample.status,sample.quota_observed_at,sample.usage_observed_at,
        sample.quota===null?null:JSON.stringify(sample.quota),sample.usage===null?null:JSON.stringify(sample.usage),JSON.stringify(sample.errors),
        sample.capacity_scope_id??'local-codex-account',sample.capabilities===undefined||sample.capabilities===null?null:JSON.stringify(sample.capabilities),
        sample.observation_source_id??'local').lastInsertRowid);
  }
  observationsBySource(sourceId,limit=100) {
    if(typeof sourceId!=='string'||!sourceId||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw new Error('Invalid observation query');
    return this.db.prepare('SELECT * FROM account_observations WHERE observation_source_id=? ORDER BY id DESC LIMIT ?').all(sourceId,limit).reverse().map(row=>this.#observation(row));
  }
  latestObservations(sourceIds) {
    if(!Array.isArray(sourceIds)||sourceIds.some(id=>typeof id!=='string'||!id))throw new Error('Invalid observation sources');
    const statement=this.db.prepare('SELECT * FROM account_observations WHERE observation_source_id=? ORDER BY id DESC LIMIT 1');
    return sourceIds.map(id=>{const row=statement.get(id);return row?this.#observation(row):null;});
  }
  latestObservation(sourceId) {
    if(typeof sourceId!=='string'||!sourceId)throw new Error('Invalid observation source');
    const row=this.db.prepare('SELECT * FROM account_observations WHERE observation_source_id=? ORDER BY id DESC LIMIT 1').get(sourceId);
    return row?this.#observation(row):null;
  }
  #observation(row) {
    const {quota_json,usage_json,errors_json,capabilities_json,...fields}=row;
    return {...fields,quota:quota_json===null?null:JSON.parse(quota_json),usage:usage_json===null?null:JSON.parse(usage_json),errors:JSON.parse(errors_json),
      capabilities:capabilities_json===null?null:JSON.parse(capabilities_json)};
  }
  observations(limit=100) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>10000)throw new Error('Observation limit must be between 1 and 10000');
    return this.db.prepare('SELECT * FROM account_observations ORDER BY id DESC LIMIT ?').all(limit).reverse().map(row=>{
      const {quota_json,usage_json,errors_json,capabilities_json,...fields}=row;
      return {...fields,quota:quota_json===null?null:JSON.parse(quota_json),usage:usage_json===null?null:JSON.parse(usage_json),errors:JSON.parse(errors_json),
        capabilities:capabilities_json===null?null:JSON.parse(capabilities_json)};
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
