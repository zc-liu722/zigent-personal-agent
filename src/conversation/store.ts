import { projectHistoryParts } from "../memory/history-parts.js";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import { ConversationReader } from "./reader.js";
import type { WebMessage } from "../web/store.js";
import type { ModelConversationMessage } from "../models/types.js";
import type { AgentRunSnapshot, AgentActivityItem } from "../agent/transcript.js";

export class ConversationStore extends ConversationReader {
  constructor(db: DatabaseSync, options: { initialize?: boolean } = {}) {
    super(db);
    if (options.initialize === false) {
      const format = prepareSql(db,"SELECT format,mode FROM conversation_control WHERE singleton=1").get();
      if (format?.format !== 1 || format.mode !== "canonical") throw new Error("CONVERSATION_FORMAT_UNAVAILABLE");
      this.installSql(); return;
    }
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_objects(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,body BLOB NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_object_edges(parent TEXT NOT NULL,child TEXT NOT NULL,PRIMARY KEY(parent,child));
      CREATE TABLE IF NOT EXISTS conversation_roots(owner TEXT NOT NULL,slot TEXT NOT NULL,hash TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,slot));
      CREATE INDEX IF NOT EXISTS conversation_root_hash ON conversation_roots(hash);
      CREATE TABLE IF NOT EXISTS conversation_runs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,reply_id TEXT,
        draft_id TEXT NOT NULL,versions TEXT NOT NULL,stage TEXT NOT NULL,generation_status TEXT NOT NULL,delivery_status TEXT NOT NULL,
        context_status TEXT NOT NULL,updated_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS conversation_run_reply ON conversation_runs(reply_id);
      CREATE INDEX IF NOT EXISTS conversation_run_turn ON conversation_runs(session_id,turn_id);
      CREATE TABLE IF NOT EXISTS conversation_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,model TEXT NOT NULL,
        state TEXT NOT NULL,started_at INTEGER NOT NULL,finished_at INTEGER);
      CREATE TABLE IF NOT EXISTS conversation_tool_operations(run_id TEXT NOT NULL,call_id TEXT NOT NULL,operation_id TEXT NOT NULL,state TEXT NOT NULL,
        call_hash TEXT NOT NULL,result_hash TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(run_id,call_id));
      CREATE TABLE IF NOT EXISTS conversation_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,message_id TEXT NOT NULL,
        run_id TEXT,hash TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,delivered_at INTEGER);
      CREATE INDEX IF NOT EXISTS conversation_outbox_pending ON conversation_outbox(channel,seq) WHERE delivered_at IS NULL;
      CREATE TABLE IF NOT EXISTS conversation_message_parts(message_id TEXT NOT NULL,part_id TEXT NOT NULL,category TEXT NOT NULL,
        ordinal TEXT NOT NULL,type TEXT NOT NULL,hash TEXT NOT NULL,metadata TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(message_id,part_id));
      CREATE TABLE IF NOT EXISTS conversation_migration_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state TEXT NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT);
      INSERT OR IGNORE INTO conversation_migration_state VALUES(1,'pending',0,NULL);
      CREATE TABLE IF NOT EXISTS conversation_storage_baselines(source TEXT PRIMARY KEY,metadata TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_visibility(session_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,deleted_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_identity(source TEXT NOT NULL,source_id TEXT NOT NULL,message_id TEXT,run_id TEXT,
        status TEXT NOT NULL,PRIMARY KEY(source,source_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_revision(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO conversation_revision VALUES(1,0);`);
    for (const table of ["messages","sessions","conversation_message_parts","conversation_visibility"]) for (const event of ["INSERT","UPDATE","DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_revision_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN UPDATE conversation_revision SET version=version+1 WHERE singleton=1; END`);
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_revision_run AFTER UPDATE OF stage,generation_status,delivery_status,context_status ON conversation_runs
      WHEN OLD.stage<>NEW.stage OR OLD.generation_status<>NEW.generation_status OR OLD.delivery_status<>NEW.delivery_status OR OLD.context_status<>NEW.context_status
      BEGIN UPDATE conversation_revision SET version=version+1 WHERE singleton=1; END`);
    const attemptColumns = db.prepare("PRAGMA table_info(conversation_attempts)").all() as {name:string}[];
    for (const [name,type] of [["supplier","TEXT"],["failure_kind","TEXT"],["retry_attempt","INTEGER"],["model_round","INTEGER"]]) {
      if (!attemptColumns.some(column=>column.name===name)) db.exec(`ALTER TABLE conversation_attempts ADD COLUMN ${name} ${type}`);
    }
    if (!(db.prepare("PRAGMA table_info(conversation_tool_operations)").all() as {name:string}[]).some(row=>row.name==="outcome")) db.exec("ALTER TABLE conversation_tool_operations ADD COLUMN outcome TEXT NOT NULL DEFAULT 'pending'");
    if (!(db.prepare("PRAGMA table_info(conversation_runs)").all() as {name:string}[]).some(row=>row.name==="routing_active")) db.exec("ALTER TABLE conversation_runs ADD COLUMN routing_active INTEGER NOT NULL DEFAULT 1");
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_control(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,mode TEXT NOT NULL);
      INSERT OR IGNORE INTO conversation_control VALUES(1,1,'canonical');`);
    if (prepareSql(db,"SELECT mode FROM conversation_control WHERE singleton=1").get()?.mode === "legacy") sqliteTransaction(db,()=>{
      // A legacy release may have added/edited records after offline hydration. Rebuild from those sources.
      db.exec(`DELETE FROM conversation_roots WHERE (owner LIKE 'history:%' AND owner NOT LIKE 'history:attempt:%') OR owner LIKE 'web:%' OR owner LIKE 'web-projection:%';
        DELETE FROM conversation_message_parts WHERE message_id NOT LIKE 'attempt:%'; UPDATE conversation_runs SET routing_active=0;
        UPDATE conversation_outbox SET delivered_at=COALESCE(delivered_at,strftime('%s','now')*1000);
        UPDATE conversation_control SET mode='canonical' WHERE singleton=1;`);
    });
    for (const event of ["INSERT","UPDATE","DELETE"]) {
      const record = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_revision_roots_${event.toLowerCase()} AFTER ${event} ON conversation_roots
        WHEN ${record}.owner LIKE 'web:%' OR ${record}.owner LIKE 'history:%'
        BEGIN UPDATE conversation_revision SET version=version+1 WHERE singleton=1; END`);
    }
    this.installSql();
    this.historyView();
  }
  private historyView(): void {
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!columns.length) return;
    const bodies = new Set(["content", "tool_trace_json", "activity_trace_json"]);
    const projection = columns.map(({ name }) => bodies.has(name)
      ? `CASE WHEN EXISTS(SELECT 1 FROM conversation_roots r WHERE r.owner='history:'||m.id AND r.slot='${name}')
        THEN conversation_read((SELECT hash FROM conversation_roots r WHERE r.owner='history:'||m.id AND r.slot='${name}')) ELSE m.${name} END AS ${name}` : `m.${name}`);
    this.db.exec(`DROP VIEW IF EXISTS conversation_history_messages; DROP VIEW IF EXISTS conversation_context_messages; DROP VIEW IF EXISTS conversation_messages;
      CREATE VIEW conversation_messages AS SELECT m.rowid AS rowid,${projection.join(",")} FROM messages m;`);
    const draft = columns.map(({name}) => {
      const expression = name === "id" ? "r.draft_id" : name === "message_id" ? "r.reply_id" : name === "session_id" ? "r.session_id"
        : name === "turn_id" ? "r.turn_id" : name === "role" ? "'assistant'" : name === "created_at" ? "r.created_at"
        : name === "content" ? "COALESCE(conversation_read((SELECT hash FROM conversation_roots cr WHERE cr.owner='history:'||r.draft_id AND cr.slot='content')),'')"
        : name === "activity_trace_json" || name === "tool_trace_json" ? `conversation_read((SELECT hash FROM conversation_roots cr WHERE cr.owner='history:'||r.draft_id AND cr.slot='${name}'))`
        : ["input_tokens","output_tokens","cached_input_tokens","cache_hit_tokens_reported"].includes(name) ? "0" : "NULL";
      return `${expression} AS ${name}`;
    });
    const committed = draft.map(value=>value.replaceAll('r.draft_id',"('committed:'||r.draft_id)"));
    const committedWhere = `r.routing_active=1 AND r.reply_id IS NOT NULL
      AND json_extract(r.id,'$[3]') IS NULL AND json_extract(r.id,'$[4]') IS NULL
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=r.draft_id)
      AND EXISTS(SELECT 1 FROM conversation_roots cr WHERE cr.owner='run:'||r.id AND cr.slot='committed')
      AND EXISTS(SELECT 1 FROM messages u WHERE u.session_id=r.session_id AND u.turn_id=r.turn_id AND u.role='user' AND u.deleted_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM conversation_visibility v WHERE v.session_id=r.session_id)`;
    const context = committed.map((value,index)=>columns[index]!.name === 'content' ? "'' AS content"
      : columns[index]!.name === 'tool_trace_json' ? 'conversation_context_trace(r.id) AS tool_trace_json' : value);
    this.db.exec(`CREATE VIEW conversation_context_messages AS SELECT m.* FROM conversation_messages m
      UNION ALL SELECT NULL AS rowid,${context.join(',')} FROM conversation_runs r WHERE ${committedWhere}`);
    this.db.exec(`CREATE VIEW conversation_history_messages AS
      SELECT m.* FROM conversation_messages m UNION ALL
      SELECT NULL AS rowid,${committed.join(',')} FROM conversation_runs r WHERE ${committedWhere} UNION ALL
      SELECT NULL AS rowid,${draft.join(",")} FROM conversation_runs r WHERE r.routing_active IN (1,2) AND r.reply_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=r.draft_id)
      AND EXISTS(SELECT 1 FROM messages u WHERE u.session_id=r.session_id AND u.turn_id=r.turn_id AND u.role='user' AND u.deleted_at IS NULL)
      UNION ALL SELECT NULL AS rowid,${draft.map(value=>value.replaceAll('r.draft_id',"('attempt:'||a.id)").replaceAll('r.created_at','a.started_at')).join(",")}
      FROM conversation_attempts a JOIN conversation_runs r ON r.id=a.run_id
      WHERE a.state IN ('failed','cancelled','suspended','interrupted')
      AND EXISTS(SELECT 1 FROM conversation_roots cr WHERE cr.owner='history:attempt:'||a.id AND cr.slot='content')
      AND (EXISTS(SELECT 1 FROM conversation_attempts newer WHERE newer.run_id=a.run_id AND newer.id>a.id)
        OR EXISTS(SELECT 1 FROM messages m WHERE m.id=r.draft_id)
        OR EXISTS(SELECT 1 FROM conversation_roots cr WHERE cr.owner='attempt:'||a.id AND cr.slot='output'))
      AND EXISTS(SELECT 1 FROM messages u WHERE u.session_id=r.session_id AND u.turn_id=r.turn_id AND u.role='user' AND u.deleted_at IS NULL);`);
  }
  /** Independently committed calls/results survive an incomplete enclosing assistant turn. */
  commitContext(runId: string, key: string, message: ModelConversationMessage, activity: readonly AgentActivityItem[] = []): void {
    sqliteTransaction(this.db,()=>{
      const run = prepareSql(this.db,"SELECT draft_id FROM conversation_runs WHERE id=? AND routing_active=1").get(runId) as {draft_id:string}|undefined;
      if (!run) return;
      const entries = (this.objects.read(`run:${runId}`,"committed") ?? []) as {key:string;message:ModelConversationMessage}[];
      if (entries.some(entry=>entry.key===key)) return;
      if (message.role === "assistant") {
        const calls = new Set(entries.flatMap(entry=>entry.message.role === "assistant" ? entry.message.toolCalls.map(call=>call.id) : []));
        message = {...message,toolCalls:message.toolCalls.filter(call=>!calls.has(call.id))};
        if (!message.text && !message.toolCalls.length && !message.reasoningContent && !message.nativeState && !message.searchEvidence && !activity.length) return;
      }
      entries.push({key,message});
      this.objects.set(`run:${runId}`,"committed",entries);
      const id = `committed:${run.draft_id}`;
      const previous = (this.objects.read(`history:${id}`,"activity_trace_json") ?? []) as AgentActivityItem[];
      const messages = entries.map(entry=>entry.message);
      this.history(id,messages.flatMap(entry=>entry.role === "assistant" && entry.text ? [entry.text] : []).join('\n\n'),messages,
        [...previous,...activity.map(item=>item.type==='thought' || item.type==='response' || item.type==='commentary' ? {...item,status:'completed' as const} : item)]);
      prepareSql(this.db,"UPDATE conversation_runs SET context_status=CASE WHEN context_status='eligible' THEN context_status ELSE 'partial' END,updated_at=? WHERE id=?")
        .run(Date.now(),runId);
    });
  }
  migrationState(state: "backfilling"|"complete"|"paused", errorCode?: string): void {
    prepareSql(this.db,"UPDATE conversation_migration_state SET state=?,updated_at=?,error_code=? WHERE singleton=1").run(state,Date.now(),errorCode??null);
  }
  hasBaseline(source: string): boolean { return Boolean(prepareSql(this.db,"SELECT 1 FROM conversation_storage_baselines WHERE source=?").get(source)); }
  baseline(source: string, metadata: unknown): void {
    prepareSql(this.db, "INSERT OR IGNORE INTO conversation_storage_baselines VALUES(?,?,?)").run(source, JSON.stringify(metadata), Date.now());
  }
  history(id: string, content: string, tool: unknown, activity: unknown): void {
    const owner = `history:${id}`;
    this.objects.set(owner, "content", content);
    if (tool != null) this.objects.set(owner, "tool_trace_json", tool);
    if (activity != null) this.objects.set(owner, "activity_trace_json", activity);
    const rows = prepareSql(this.db, `WITH base AS (SELECT ? AS id,'assistant' AS role,? AS content,? AS tool_trace_json,
      ? AS activity_trace_json,NULL AS question_answers_json) ${projectHistoryParts(["content","thoughts","tools","commentary"], {legacyOnly:true})}`)
      .all(id, content, tool == null ? null : JSON.stringify(tool), activity == null ? null : JSON.stringify(activity)) as
      { part_id: string; type: string; text: string; metadata: string; sort_key: string }[];
    prepareSql(this.db, "DELETE FROM conversation_message_parts WHERE message_id=?").run(id);
    for (const part of rows) {
      const match = /^activity:(\d+)$/.exec(part.part_id);
      const item = match && Array.isArray(activity) ? activity[Number(match[1])] : undefined;
      if (item && typeof item.id === "string") {
        part.part_id = `activity:${createHash("sha256").update(item.id).digest("hex")}`;
        part.metadata = JSON.stringify({...JSON.parse(part.metadata),activity_id:item.id});
      }
      const category = part.type === "content" ? "content" : part.type === "thought" ? "thoughts" : part.type === "commentary" ? "commentary" : "tools";
      const root = this.objects.set(owner, `part:${part.part_id}`, part.text);
      prepareSql(this.db, "INSERT INTO conversation_message_parts(message_id,part_id,category,ordinal,type,hash,metadata,revision) VALUES(?,?,?,?,?,?,?,?)")
        .run(id, part.part_id, category, part.sort_key, part.type, root.hash, part.metadata, root.revision);
    }
    prepareSql(this.db, `DELETE FROM conversation_roots WHERE owner=? AND slot LIKE 'part:%'
      AND slot NOT IN (SELECT 'part:'||json_extract(value,'$.part_id') FROM json_each(?))`).run(owner, JSON.stringify(rows));
    prepareSql(this.db, "INSERT OR IGNORE INTO conversation_identity(source,source_id,message_id,status) VALUES('history',?,?,'exact')").run(id, id);
  }
  captureAttempt(runId: string, message?: WebMessage): void {
    const run = prepareSql(this.db,"SELECT reply_id FROM conversation_runs WHERE id=?").get(runId) as {reply_id:string|null}|undefined;
    const attempt = prepareSql(this.db,"SELECT id,state FROM conversation_attempts WHERE run_id=? ORDER BY id DESC LIMIT 1").get(runId) as {id:number;state:string}|undefined;
    if (!run?.reply_id || !attempt || !["failed","cancelled","suspended","interrupted"].includes(attempt.state)) return;
    const output = this.objects.read(`attempt:${attempt.id}`,"output") as AgentRunSnapshot|undefined;
    const snapshot = output ? {text:output.answerDraft,snapshot:output} : message ?? this.objects.read(`web:${run.reply_id}`,"payload") as WebMessage|undefined;
    if (!snapshot) return;
    const previous = this.objects.root(`attempt:${attempt.id}`,"payload");
    const root = this.objects.set(`attempt:${attempt.id}`,"payload",snapshot);
    if (previous?.hash === root.hash) return;
    this.history(`attempt:${attempt.id}`,snapshot.text,output ? undefined : this.objects.read(`run:${runId}`,"trace"),snapshot.snapshot?.items);
    prepareSql(this.db,`UPDATE conversation_message_parts SET metadata=json_set(metadata,'$.output_status',?,'$.context_status','excluded','$.attempt_status',?) WHERE message_id=?`)
      .run(output ? 'incomplete' : 'legacy_snapshot',attempt.state,`attempt:${attempt.id}`);
  }
  /** Called in the generation/history transaction; transport work is a separate durable state. */
  generated(sessionId: string, turnId: number, messageId: string, content: string, activity: unknown): void {
    const runs = prepareSql(this.db, "SELECT id,reply_id FROM conversation_runs WHERE routing_active IN (1,2) AND session_id=? AND turn_id=? AND reply_id IS NOT NULL AND draft_id=?")
      .all(sessionId, turnId, messageId) as { id: string; reply_id: string }[];
    for (const run of runs) {
      prepareSql(this.db,"UPDATE conversation_runs SET context_status='eligible',updated_at=? WHERE id=?").run(Date.now(),run.id);
      const visible = this.objects.read(`web:${run.reply_id}`,"payload") as WebMessage | undefined;
      if (visible) this.web({...visible,text:content,snapshot:visible.snapshot ? {...visible.snapshot,answerDraft:content,
        items:Array.isArray(activity)?activity:visible.snapshot.items} : undefined});
      prepareSql(this.db, `INSERT INTO conversation_identity(source,source_id,message_id,run_id,status) VALUES('web',?,?,?,'exact')
        ON CONFLICT(source,source_id) DO UPDATE SET
          message_id=COALESCE(conversation_identity.message_id,excluded.message_id),
          run_id=COALESCE(conversation_identity.run_id,excluded.run_id),
          status=CASE WHEN (conversation_identity.message_id IS NOT NULL AND conversation_identity.message_id<>excluded.message_id)
            OR (conversation_identity.run_id IS NOT NULL AND conversation_identity.run_id<>excluded.run_id) THEN 'conflict' ELSE 'exact' END`)
        .run(run.reply_id, messageId, run.id);
    }
  }
  web(message: WebMessage): { hash: string; revision: number; seq: number } {
    return sqliteTransaction(this.db, () => {
      const root = this.objects.set(`web:${message.id}`, "payload", message);
      const run = prepareSql(this.db, "SELECT id FROM conversation_runs WHERE routing_active IN (1,2) AND reply_id=?").get(message.id) as { id: string } | undefined;
      const previous = prepareSql(this.db, "SELECT seq FROM conversation_outbox WHERE channel='web' AND message_id=? AND hash=? AND revision=? ORDER BY seq DESC LIMIT 1")
        .get(message.id, root.hash, root.revision) as { seq: number } | undefined;
      const seq = previous?.seq ?? Number(prepareSql(this.db,
        "INSERT INTO conversation_outbox(channel,message_id,run_id,hash,revision,created_at) VALUES('web',?,?,?,?,?)")
        .run(message.id, run?.id ?? null, root.hash, root.revision, Date.now()).lastInsertRowid);
      if (run) {
        const row = prepareSql(this.db, "SELECT draft_id,session_id,turn_id,context_status FROM conversation_runs WHERE id=?").get(run.id) as {draft_id:string;session_id:string;turn_id:number;context_status:string};
        if (row.context_status !== "eligible" && !prepareSql(this.db, "SELECT 1 FROM messages WHERE id=?").get(row.draft_id)) {
          const trace = this.objects.read(`run:${run.id}`, "trace");
          this.history(row.draft_id, message.text, trace, message.snapshot?.items);
        }
        if (message.snapshot?.status === "failed" || message.snapshot?.status === "cancelled") {
          const status = message.snapshot.status;
          prepareSql(this.db,`UPDATE conversation_runs SET stage=CASE WHEN generation_status='generated' THEN stage ELSE ? END,
            generation_status=CASE WHEN generation_status='generated' THEN generation_status ELSE ? END,
            delivery_status=CASE WHEN generation_status='generated' THEN 'failed' ELSE delivery_status END,updated_at=? WHERE id=?`)
            .run(status,status,Date.now(),run.id);
        }
        prepareSql(this.db, "UPDATE conversation_runs SET delivery_status='pending',updated_at=? WHERE id=? AND delivery_status NOT IN ('delivered','failed')").run(Date.now(), run.id);
        this.captureAttempt(run.id,message);
        prepareSql(this.db, "INSERT OR IGNORE INTO conversation_identity(source,source_id,run_id,status) VALUES('web',?,?,'exact')").run(message.id, run.id);
      }
      return { ...root, seq };
    });
  }
  stub(message: WebMessage, root: { hash: string; revision: number }): string {
    // A rebuildable transport index only. No conversation body, arguments, output or cards.
    return JSON.stringify({ id: message.id, conversationId: message.conversationId, role: message.role, createdAt: message.createdAt,
      replyTo: message.replyTo, assets: message.assets, snapshot: message.snapshot ? { status: message.snapshot.status } : undefined,
      interactions: message.interactions?.map(item => ({ kind: item.kind, status: item.status })), _conversation: root });
  }
  acknowledge(seq: number): void {
    const event = prepareSql(this.db,"SELECT message_id,hash,revision FROM conversation_outbox WHERE seq=? AND channel='web'").get(seq) as {message_id:string;hash:string;revision:number}|undefined;
    if (event) prepareSql(this.db,`INSERT INTO conversation_roots(owner,slot,hash,revision,updated_at) VALUES(?,'payload',?,?,?)
      ON CONFLICT(owner,slot) DO UPDATE SET hash=excluded.hash,revision=excluded.revision,updated_at=excluded.updated_at WHERE revision<=excluded.revision`)
      .run(`web-projection:${event.message_id}`,event.hash,event.revision,Date.now());
    prepareSql(this.db, "UPDATE conversation_outbox SET delivered_at=? WHERE seq=?").run(Date.now(), seq);
  }
  pendingWeb() {
    return prepareSql(this.db, `SELECT o.seq,o.message_id,o.hash,o.revision FROM conversation_outbox o
      WHERE o.channel='web' AND o.delivered_at IS NULL ORDER BY o.seq`).all() as { seq: number; message_id: string; hash: string; revision: number }[];
  }
  deleteConversation(sessionId: string, conversationId: string, deletedAt: number): number {
    return sqliteTransaction(this.db,()=>{
      const previous = prepareSql(this.db,"SELECT deleted_at FROM conversation_visibility WHERE session_id=?").get(sessionId);
      const root = this.objects.set(`visibility:${sessionId}`,"payload",{sessionId,conversationId,deletedAt:Number(previous?.deleted_at ?? deletedAt)});
      if (!previous) prepareSql(this.db,"INSERT INTO conversation_visibility VALUES(?,?,?)").run(sessionId,conversationId,deletedAt);
      const event = prepareSql(this.db,"SELECT seq FROM conversation_outbox WHERE channel='web-delete' AND message_id=? AND hash=? ORDER BY seq DESC LIMIT 1")
        .get(conversationId,root.hash) as {seq:number}|undefined;
      return event?.seq ?? Number(prepareSql(this.db,"INSERT INTO conversation_outbox(channel,message_id,hash,revision,created_at) VALUES('web-delete',?,?,?,?)")
        .run(conversationId,root.hash,root.revision,Date.now()).lastInsertRowid);
    });
  }
  pendingDeletes() {
    return prepareSql(this.db,"SELECT seq,hash FROM conversation_outbox WHERE channel='web-delete' AND delivered_at IS NULL ORDER BY seq")
      .all() as {seq:number;hash:string}[];
  }
  stableMessageId(runId: string): string { return `run:${createHash("sha256").update(runId).digest("hex")}`; }
}
