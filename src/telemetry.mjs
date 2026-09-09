import { StringDecoder } from 'node:string_decoder';

// Codex --json emits UTF-8 JSONL. Preserve usage as supplied, including future fields.
export class Telemetry {
  constructor(onUpdate = () => {}) {
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.usage = [];
    this.errors = [];
    this.sessionId = null;
    this.malformedLines = 0;
    this.onUpdate = onUpdate;
  }
  feed(chunk) {
    this.pending += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let newline;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0,newline));this.pending=this.pending.slice(newline+1);
    }
    // A broken producer must not consume unlimited memory. The raw log remains on disk.
    if (this.pending.length > 2000000) { this.pending='';this.malformedLines++;this.onUpdate(this.snapshot()); }
  }
  end() {
    this.pending += this.decoder.end();
    if(this.pending.trim())this.line(this.pending);
    this.pending='';
    this.onUpdate(this.snapshot());
  }
  line(line) {
    if(!line.trim())return;
    let event;
    try { event=JSON.parse(line); } catch { this.malformedLines++;this.onUpdate(this.snapshot());return; }
    if(!event || !['thread.started','turn.completed','error','turn.failed'].includes(event.type))return;
    if(event.type==='thread.started' && typeof event.thread_id==='string')this.sessionId=event.thread_id;
    if(event.type==='turn.completed' && event.usage && typeof event.usage==='object')this.usage.push(event.usage);
    if(event.type==='error' || event.type==='turn.failed')this.errors.push(event);
    this.onUpdate(this.snapshot());
  }
  snapshot() {
    const sum = key => {
      if(!this.usage.length || this.usage.some(u=>!Number.isSafeInteger(u[key]) || u[key]<0))return null;
      return this.usage.reduce((total,u)=>total+u[key],0);
    };
    return {session_id:this.sessionId,completed_turns:this.usage.length,
      input_tokens:sum('input_tokens'),cached_input_tokens:sum('cached_input_tokens'),
      cache_write_input_tokens:sum('cache_write_input_tokens'),output_tokens:sum('output_tokens'),
      reasoning_output_tokens:sum('reasoning_output_tokens'),
      usage_json:JSON.stringify(this.usage),errors_json:JSON.stringify(this.errors),malformed_lines:this.malformedLines};
  }
}
