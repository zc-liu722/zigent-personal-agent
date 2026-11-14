import { conversationInventory } from "../conversation/inventory.js";
import { isMissingConversationObject } from "../conversation/objects.js";
import type { ConversationStore } from "../conversation/store.js";
import { DatabaseSync } from "node:sqlite";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import type { ModelToolCall, ModelConversationMessage, ModelRoundUpdate } from "../models/types.js";
import { AgentTranscript } from "./transcript.js";
import type { ToolExecutionContext } from "../tools/tool-contracts.js";

export type SavedExecution = { id: string; sessionId: string; turnId: number; replyId?: string; versions: Record<string, string>;
  stage: "running" | "generated" | "completed" | "cancelled" | "suspended" | "failed";
  checkpoint?: unknown; reply?: unknown; updatedAt: number };
export type SavedTool = { call: ModelToolCall; state: "started" | "completed"; result?: unknown; operationId: string };
// JSON invokes Buffer.toJSON before the replacer. Inspect the holder as well so
// new Buffer and Uint8Array data share the compact encoding; legacy arrays still decode.
const encode = (value: unknown): string => JSON.stringify(value, function (key, value) {
  const bytes = this[key] instanceof Uint8Array ? this[key] : value;
  return bytes instanceof Uint8Array ? { _zigentBytes: Buffer.from(bytes).toString("base64") } : value;
});
const runFields = new Set(["sessionId", "turnId", "replyId", "versions", "stage", "checkpoint", "reply", "updatedAt", "id"]);
const decode = <T>(value: string): T => JSON.parse(value, (_key, value) => value && typeof value === "object"
  ? typeof value._zigentBytes === "string" ? Buffer.from(value._zigentBytes, "base64")
    : value.type === "Buffer" && Array.isArray(value.data) ? Buffer.from(value.data) : value : value);

/** Host-owned durable execution data. Never includes the ToolExecutionContext credentials/callbacks. */
export class ExecutionJournal {
  private readonly db: DatabaseSync;
  private readonly outputs = new Map<string,{attemptId:number; segment:number; transcript:AgentTranscript;flushedAt:number}>();
  constructor(path: string, readonly conversations?: ConversationStore) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS execution_runs(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_tools(run_id TEXT NOT NULL,call_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,call_id));
      CREATE TABLE IF NOT EXISTS execution_native_prompts(run_id TEXT PRIMARY KEY);`);
    if (conversations) {
      if (!conversations.hasBaseline("execution")) conversations.baseline("execution",this.db.prepare(`SELECT count(*) AS records,COALESCE(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM execution_runs`).get());
      // Adapt metadata only; existing executors still own their original bodies and version leases.
      for (const row of this.db.prepare(`SELECT id,json_remove(payload,'$.checkpoint','$.reply') AS payload FROM execution_runs WHERE json_valid(payload)`).all()) {
        this.adaptLegacy(decode<SavedExecution>(String(row.payload)));
      }
    }
  }
  private adaptLegacy(saved: SavedExecution): void {
    const core = this.conversations; if (!core || this.core(saved.id,"none")) return;
    let scope: unknown;
    try { scope = JSON.parse(saved.id); } catch { return; }
    if (!Array.isArray(scope) || scope[0] !== prepareSql(core.db,"SELECT agent_id FROM agent_metadata WHERE singleton=1").get()?.agent_id
      || scope[1] !== saved.sessionId || scope[2] !== saved.turnId) return;
    const assistants = saved.stage === "completed" ? prepareSql(core.db,"SELECT id FROM messages WHERE session_id=? AND turn_id=? AND role='assistant'")
      .all(saved.sessionId,saved.turnId) as {id:string}[] : [];
    prepareSql(core.db,`INSERT INTO conversation_runs(id,session_id,turn_id,reply_id,draft_id,versions,stage,generation_status,delivery_status,context_status,updated_at,created_at,routing_active)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,2) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,generation_status=excluded.generation_status,
      delivery_status=excluded.delivery_status,updated_at=excluded.updated_at,draft_id=excluded.draft_id,routing_active=2 WHERE routing_active IN (0,2)`)
      .run(saved.id,saved.sessionId,saved.turnId,saved.replyId ?? null,assistants.length===1?assistants[0]!.id:core.stableMessageId(saved.id),
        JSON.stringify(saved.versions),saved.stage,["completed","generated"].includes(saved.stage)?"generated":saved.stage,
        saved.stage==="completed"?"delivered":"pending",assistants.length===1?"eligible":"excluded",saved.updatedAt,saved.updatedAt);
  }
  inventory(web?: DatabaseSync) { return conversationInventory(this.conversations?.db ?? this.db, web, this.db); }
  /** Only terminal old work moves. Running/generated/suspended leases keep the legacy adapter. */
  migrateCompleted(limit = 4): number {
    const core = this.conversations; if (!core) return 0;
    const rows = prepareSql(this.db, `SELECT id,payload FROM execution_runs WHERE json_valid(payload)
      AND json_extract(payload,'$.stage')='completed' AND (json_type(payload,'$.checkpoint') IS NOT NULL OR json_type(payload,'$.reply') IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM execution_tools t WHERE t.run_id=execution_runs.id AND json_extract(t.payload,'$.state')='started') LIMIT ?`).all(limit) as {id:string;payload:string}[];
    for (const row of rows) {
      const saved = decode<SavedExecution>(row.payload);
      const scope = JSON.parse(saved.id) as unknown[];
      const agent = prepareSql(core.db,"SELECT agent_id FROM agent_metadata WHERE singleton=1").get()?.agent_id;
      if (!Array.isArray(scope) || scope[0] !== agent || scope[1] !== saved.sessionId || scope[2] !== saved.turnId) throw new Error("CONVERSATION_LEGACY_IDENTITY_CONFLICT");
      const tools = this.tools(saved.id);
      if (tools.some(tool => tool.state === "started")) continue;
      sqliteTransaction(core.db, () => {
        const assistants = prepareSql(core.db,"SELECT id FROM messages WHERE session_id=? AND turn_id=? AND role='assistant'").all(saved.sessionId,saved.turnId) as {id:string}[];
        const messageId = assistants.length === 1 ? assistants[0]!.id : core.stableMessageId(saved.id);
        prepareSql(core.db, `INSERT OR IGNORE INTO conversation_runs(id,session_id,turn_id,reply_id,draft_id,versions,stage,generation_status,delivery_status,context_status,updated_at,created_at)
          VALUES(?,?,?,?,?,?,'completed','generated','delivered',?,?,?)`).run(saved.id,saved.sessionId,saved.turnId,saved.replyId ?? null,messageId,
            JSON.stringify(saved.versions),assistants.length===1?"eligible":"excluded",saved.updatedAt,saved.updatedAt);
        prepareSql(core.db,"UPDATE conversation_runs SET routing_active=1 WHERE id=? AND routing_active IN (0,2)").run(saved.id);
        prepareSql(core.db,"DELETE FROM conversation_roots WHERE owner=? AND slot IN ('checkpoint','trace')").run(`run:${saved.id}`);
        if (saved.reply !== undefined) core.objects.set(`run:${saved.id}`,"reply",saved.reply);
        for (const tool of tools) {
          const call = core.objects.set(`tool:${tool.operationId}`,"call",tool.call).hash;
          const result = tool.result === undefined ? null : core.objects.set(`tool:${tool.operationId}`,"result",tool.result).hash;
          prepareSql(core.db, `INSERT OR IGNORE INTO conversation_tool_operations(run_id,call_id,operation_id,state,call_hash,result_hash,updated_at,outcome) VALUES(?,?,?,?,?,?,?,?)`)
            .run(saved.id,tool.call.id,tool.operationId,tool.state,call,result,saved.updatedAt,(tool.result as {result?:{status?:unknown}})?.result?.status==="outcome_uncertain"?"uncertain":"committed");
        }
        if (saved.replyId) prepareSql(core.db,`INSERT OR IGNORE INTO conversation_identity VALUES('web',?,?,?,?)`)
          .run(saved.replyId,assistants.length===1?messageId:null,saved.id,assistants.length===1?"exact":"unresolved");
      });
      // Source removal follows the canonical commit; a crash leaves a safe duplicate.
      sqliteTransaction(this.db, () => {
        const {checkpoint,reply,...metadata} = saved;
        const updated = prepareSql(this.db,"UPDATE execution_runs SET payload=? WHERE id=? AND payload=?").run(encode(metadata),saved.id,row.payload);
        if (updated.changes) for (const tool of tools) prepareSql(this.db,"UPDATE execution_tools SET payload=? WHERE run_id=? AND call_id=?")
          .run(encode({state:tool.state,operationId:tool.operationId,conversationReference:true}),saved.id,tool.call.id);
      });
    }
    return rows.length;
  }
  key(scope: Pick<ToolExecutionContext, "agentId" | "sessionId" | "turnId" | "taskRunId" | "executionId">): string {
    return JSON.stringify([scope.agentId, scope.sessionId, scope.turnId, scope.taskRunId ?? null, scope.executionId ?? null]);
  }
  /** Read the original generated task answer without expanding the tool trace or recovery checkpoint. */
  taskReplyText(agentId: string, sessionId: string, taskRunId: string): string | undefined {
    const id = this.key({ agentId, sessionId, turnId: 0, taskRunId });
    const objects = this.conversations?.objects;
    const root = objects?.root(`run:${id}`, "reply");
    if (root && objects) {
      try {
        const text = objects.field(root.hash, "text");
        if (typeof text === "string") return text;
      } catch (error) { if (!isMissingConversationObject(error)) throw error; }
    }
    const row = prepareSql(this.db, "SELECT json_extract(payload,'$.reply.text') AS text FROM execution_runs WHERE id=? AND json_valid(payload)")
      .get(id);
    return typeof row?.text === "string" ? row.text : undefined;
  }
  private core(id: string, bodies: "all" | "resume" | "none" = "all"): SavedExecution | undefined {
    if (!this.conversations) return;
    const row = prepareSql(this.conversations.db, "SELECT * FROM conversation_runs WHERE routing_active=1 AND id=?").get(id) as
      { id: string; session_id: string; turn_id: number; reply_id: string | null; versions: string; stage: SavedExecution["stage"]; updated_at: number } | undefined;
    if (!row) return;
    return { id, sessionId: row.session_id, turnId: row.turn_id, replyId: row.reply_id ?? undefined,
      versions: JSON.parse(row.versions), stage: row.stage, updatedAt: row.updated_at,
      ...(bodies === "all" ? { checkpoint: this.conversations.objects.read(`run:${id}`, "checkpoint") } : {}),
      ...(bodies === "all" || bodies === "resume" && ["generated", "completed"].includes(row.stage)
        ? { reply: this.conversations.objects.read(`run:${id}`, "reply") } : {}) };
  }
  get(id: string): SavedExecution | undefined {
    const core = this.core(id); if (core) return core;
    const row = prepareSql(this.db, "SELECT payload FROM execution_runs WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? decode(row.payload) : undefined;
  }
  forReply(replyId: string): SavedExecution | undefined {
    const core = this.conversations && prepareSql(this.conversations.db, "SELECT id FROM conversation_runs WHERE routing_active=1 AND reply_id=? ORDER BY created_at DESC LIMIT 1").get(replyId) as { id: string } | undefined;
    if (core) return this.core(core.id);
    const row = prepareSql(this.db, "SELECT payload FROM execution_runs WHERE json_extract(payload,'$.replyId')=? LIMIT 1").get(replyId) as { payload: string } | undefined;
    return row ? decode(row.payload) : undefined;
  }
  nativePromptPending(id: string): boolean {
    return Boolean(prepareSql(this.db, "SELECT 1 FROM execution_native_prompts WHERE run_id=?").get(id));
  }

  markNativePromptPending(id: string, pending: boolean): void {
    if (pending) prepareSql(this.db, "INSERT OR IGNORE INTO execution_native_prompts VALUES (?)").run(id);
    else prepareSql(this.db, "DELETE FROM execution_native_prompts WHERE run_id=?").run(id);
  }

  /** Admission needs pinned versions and a terminal reply, never the recovery checkpoint. */
  resume(id: string): SavedExecution | undefined {
    const core = this.core(id, "resume"); if (core) return core;
    const row = prepareSql(this.db, `SELECT CASE WHEN NOT json_valid(payload) THEN payload WHEN json_extract(payload,'$.stage') IN ('generated','completed')
      THEN json_remove(payload,'$.checkpoint') ELSE json_remove(payload,'$.checkpoint','$.reply') END AS payload
      FROM execution_runs WHERE id=?`).get(id) as { payload: string } | undefined;
    return row ? decode(row.payload) : undefined;
  }
  checkpoint(id: string): unknown {
    if (this.core(id, "none")) return this.conversations!.objects.read(`run:${id}`, "checkpoint");
    const row = prepareSql(this.db, "SELECT CASE WHEN json_valid(payload) THEN payload->'$.checkpoint' ELSE payload END AS value FROM execution_runs WHERE id=?")
      .get(id) as { value: string | null } | undefined;
    return row?.value == null ? undefined : decode(row.value);
  }
  replyStage(replyId: string): SavedExecution["stage"] | undefined {
    const core = this.conversations && prepareSql(this.conversations.db, "SELECT stage FROM conversation_runs WHERE routing_active=1 AND reply_id=? ORDER BY created_at DESC LIMIT 1")
      .get(replyId) as { stage: SavedExecution["stage"] } | undefined;
    if (core) return core.stage;
    const row = prepareSql(this.db, "SELECT json_extract(payload,'$.stage') AS stage FROM execution_runs WHERE json_extract(payload,'$.replyId')=? LIMIT 1")
      .get(replyId) as { stage: SavedExecution["stage"] | null } | undefined;
    return row?.stage ?? undefined;
  }
  canResumeReply(replyId: string): boolean {
    const stage = this.replyStage(replyId);
    return Boolean(stage && stage !== "cancelled");
  }
  begin(scope: ToolExecutionContext, versions: Readonly<Record<string, string>>, options: { includeBodies?: boolean } = {}): SavedExecution {
    const id = this.key(scope), saved = options.includeBodies === false ? this.resume(id) : this.get(id);
    if (saved && saved.stage !== "cancelled") return saved;
    const next: SavedExecution = { id, sessionId: scope.sessionId, turnId: scope.turnId, replyId: scope.replyId,
      versions: { ...versions }, stage: "running", updatedAt: Date.now() };
    if (this.conversations && !saved) {
      const core = this.conversations;
      sqliteTransaction(core.db, () => {
        prepareSql(core.db, `INSERT INTO conversation_runs(id,session_id,turn_id,reply_id,draft_id,versions,stage,generation_status,delivery_status,context_status,updated_at,created_at)
          VALUES(?,?,?,?,?,?,'running','running','pending','excluded',?,?)`).run(id, scope.sessionId, scope.turnId, scope.replyId ?? null,
            core.stableMessageId(id), JSON.stringify(versions), next.updatedAt, next.updatedAt);
      });
      return next;
    }
    prepareSql(this.db, "INSERT INTO execution_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id, encode(next));
    this.adaptLegacy(next);
    return next;
  }
  update(id: string, patch: Partial<Omit<SavedExecution, "id">>): void {
    if (this.core(id, "none")) {
      const core = this.conversations!;
      sqliteTransaction(core.db, () => {
        for (const slot of ["checkpoint", "reply"] as const) if (Object.hasOwn(patch, slot)) {
          if (patch[slot] === undefined) prepareSql(core.db, "DELETE FROM conversation_roots WHERE owner=? AND slot=?").run(`run:${id}`, slot);
          else core.objects.set(`run:${id}`, slot, patch[slot]);
          if (slot === "checkpoint" && patch.checkpoint && typeof patch.checkpoint === "object" && "toolTrace" in patch.checkpoint) {
            core.objects.set(`run:${id}`, "trace", (patch.checkpoint as {toolTrace:unknown}).toolTrace);
          }
        }
        if (patch.stage) {
          const generation = patch.stage === "completed" || patch.stage === "generated" ? "generated" : patch.stage;
          prepareSql(core.db, "UPDATE conversation_runs SET stage=?,generation_status=?,updated_at=? WHERE id=?").run(patch.stage, generation, Date.now(), id);
          if (["generated", "cancelled", "failed", "suspended"].includes(patch.stage)) {
            this.flushOutput(id);
            prepareSql(core.db,"UPDATE conversation_attempts SET state=?,finished_at=? WHERE run_id=? AND finished_at IS NULL").run(patch.stage, Date.now(), id);
            if (patch.stage === "generated") prepareSql(core.db,"UPDATE conversation_attempts SET state='generated' WHERE id=(SELECT max(id) FROM conversation_attempts WHERE run_id=?) AND state='round_completed'").run(id);
            core.captureAttempt(id);
            this.outputs.delete(id);
          }
        } else prepareSql(core.db, "UPDATE conversation_runs SET updated_at=? WHERE id=?").run(Date.now(), id);
      });
      if (patch.stage === "generated" || patch.stage === "completed") this.markNativePromptPending(id, false);
      return;
    }
    const row = prepareSql(this.db, "SELECT CASE WHEN json_valid(payload) THEN json_type(payload)='object' ELSE 0 END AS object FROM execution_runs WHERE id=?")
      .get(id) as { object: number } | undefined;
    if (!row) return;
    // Retain the legacy merge/error behavior for non-record data or extension keys.
    // Normal journal writes replace top-level fields; they must not decode retained
    // image/tool bodies (or recursively merge a replacement checkpoint).
    if (!row.object || Object.keys(patch).some(key => !runFields.has(key))) {
      const saved = this.get(id); if (!saved) return;
      prepareSql(this.db, "UPDATE execution_runs SET payload=? WHERE id=?")
        .run(encode({ ...saved, ...patch, id, updatedAt: Date.now() }), id);
      this.adaptLegacy({...saved,...patch,id,updatedAt:Date.now()});
      if (patch.stage === "generated" || patch.stage === "completed") this.markNativePromptPending(id, false);
      return;
    }
    const fields: string[] = [], values: string[] = [], removed: string[] = [];
    for (const [key, value] of Object.entries({ ...patch, id, updatedAt: Date.now() })) {
      // Serialize in a holder so toJSON receives its original key. Whitelisted
      // keys need no JSON escaping; remove only that holder, never parse the body.
      const encoded = encode({ [key]: value });
      if (encoded === "{}") removed.push(key);
      else { fields.push(key); values.push(encoded.slice(key.length + 4, -1)); }
    }
    const base = removed.length ? `json_remove(payload,${removed.map(key => "'$." + key + "'").join(",")})` : "payload";
    prepareSql(this.db, `UPDATE execution_runs SET payload=json_set(${base},${fields.map(key =>
      "'$." + key + "',json(?)").join(",")}) WHERE id=?`).run(...values, id);
    const metadata = this.resume(id); if (metadata) this.adaptLegacy(metadata);
    if (patch.stage === "generated" || patch.stage === "completed") this.markNativePromptPending(id, false);
  }
  attempt(id: string, model: string): void {
    if (!this.core(id, "none")) return;
    const db = this.conversations!.db;
    sqliteTransaction(db, () => {
      this.flushOutput(id);
      prepareSql(db, "UPDATE conversation_attempts SET state='interrupted',finished_at=? WHERE run_id=? AND finished_at IS NULL").run(Date.now(), id);
      this.conversations!.captureAttempt(id);
      const inserted = prepareSql(db, "INSERT INTO conversation_attempts(run_id,model,state,started_at) VALUES(?,?,'running',?)").run(id, model, Date.now());
      this.outputs.set(id,{attemptId:Number(inserted.lastInsertRowid),segment:0,transcript:new AgentTranscript(false,undefined,true),flushedAt:0});
    });
  }
  route(id: string, update: {name:string;supplier:string;status:string;failureKind?:string;retryAttempt?:number}, round: number): void {
    if (!this.core(id,"none")) return;
    const core = this.conversations!;
    sqliteTransaction(core.db,()=>{
      if (update.status === "connecting") this.attempt(id,update.name);
      prepareSql(core.db,`UPDATE conversation_attempts SET supplier=?,model_round=?,retry_attempt=COALESCE(?,retry_attempt),
        failure_kind=COALESCE(?,failure_kind) WHERE id=(SELECT max(id) FROM conversation_attempts WHERE run_id=?) AND model=?`)
        .run(update.supplier,round,update.retryAttempt??null,update.failureKind??null,id,update.name);
      if (update.status === "failed" || update.status === "retrying") {
        this.flushOutput(id);
        prepareSql(core.db,"UPDATE conversation_attempts SET state='failed',finished_at=? WHERE run_id=? AND finished_at IS NULL").run(Date.now(),id);
        core.captureAttempt(id);
        this.outputs.delete(id);
      }
    });
  }
  /** Capture this invocation's output independently of the coalesced web snapshot/reset. */
  output(id: string, update: ModelRoundUpdate, round: number): void {
    if (update.type==='attempt.reset' && this.core(id,'none')) {
      const core=this.conversations!;
      sqliteTransaction(core.db,()=>{
        this.flushOutput(id);
        prepareSql(core.db,"UPDATE conversation_attempts SET state='interrupted',finished_at=? WHERE run_id=? AND finished_at IS NULL").run(Date.now(),id);
        core.captureAttempt(id);
        this.outputs.delete(id);
      });
      return;
    }
    if (update.type !== 'thought.delta' && update.type !== 'assistant_text.delta') return;
    // Adapter-local retries can start another invocation without a connecting event.
    if (!this.outputs.has(id)) this.route(id,{...update,status:'connecting'},round);
    const current = this.outputs.get(id); if (!current) return;
    const prefix=`attempt:${current.attemptId}:${current.segment}`;
    if (update.type === 'thought.delta') current.transcript.advance({type:'thought.delta',itemId:`${prefix}:thought:${update.itemId ?? 'default'}`,text:update.text,source:update.source});
    else if (update.type === 'assistant_text.delta') current.transcript.advance({type:'response.delta',itemId:`${prefix}:response:${update.itemId ?? 'default'}`,text:update.text,
      role:update.phase === 'commentary' ? 'commentary' : 'answer'});
    else return;
    if (Date.now()-current.flushedAt>=250) this.flushOutput(id);
  }
  private flushOutput(id: string): void {
    const current = this.outputs.get(id); if (!current || !this.conversations) return;
    this.conversations.objects.set(`attempt:${current.attemptId}`,'output',current.transcript.snapshot());
    current.flushedAt=Date.now();
  }
  commitMessage(id: string, key: string, message: ModelConversationMessage): void {
    if (this.core(id,'none')) this.conversations!.commitContext(id,key,message);
  }
  adapterBoundary(id: string, callId: string): void {
    const current=this.outputs.get(id); if (!current || !this.conversations) return;
    const snapshot=current.transcript.snapshot();
    const text=snapshot.items.flatMap(item=>(item.type==='response' || item.type==='commentary') && item.text ? [item.text] : []).join('\n\n');
    this.conversations.commitContext(id,`adapter-output:${current.attemptId}:${callId}`,{role:'assistant',text,toolCalls:[]},snapshot.items);
    current.transcript=new AgentTranscript(false,undefined,true);
    current.segment+=1;
    this.flushOutput(id);
  }
  roundComplete(id: string, round: number, message: ModelConversationMessage): void {
    if (!this.core(id,"none")) return;
    const core=this.conversations!;
    sqliteTransaction(core.db,()=>{
      if (!this.outputs.has(id) && message.role==='assistant' && message.provider) {
        this.attempt(id,message.provider);
        prepareSql(core.db,"UPDATE conversation_attempts SET model_round=? WHERE id=(SELECT max(id) FROM conversation_attempts WHERE run_id=?)").run(round,id);
      }
      this.flushOutput(id);
      const current=this.outputs.get(id);
      if (current && message.role==='assistant') {
        const entries=(core.objects.read(`run:${id}`,'committed') ?? []) as {key:string;message:ModelConversationMessage}[];
        for (const entry of entries.filter(entry=>entry.key.startsWith(`adapter-output:${current.attemptId}:`))) {
          if (entry.message.role==='assistant' && entry.message.text && message.text.trimStart().startsWith(entry.message.text)) {
            message={...message,text:message.text.trimStart().slice(entry.message.text.length).trimStart()};
          }
        }
      }
      core.commitContext(id,`round:${round}`,message,current?.transcript.snapshot().items);
      prepareSql(core.db,"UPDATE conversation_attempts SET state='round_completed',finished_at=? WHERE run_id=? AND finished_at IS NULL").run(Date.now(),id);
      this.outputs.delete(id);
    });
  }
  startTool(id: string, call: ModelToolCall): string {
    if (this.core(id, "none")) {
      const core = this.conversations!, operationId = `${id}:${call.id}`;
      sqliteTransaction(core.db, () => {
        core.commitContext(id,`call:${call.id}`,{role:'assistant',text:'',toolCalls:[call]});
        const hash = core.objects.set(`tool:${operationId}`, "call", call).hash;
        const inserted = prepareSql(core.db, `INSERT OR IGNORE INTO conversation_tool_operations(run_id,call_id,operation_id,state,call_hash,updated_at)
          VALUES(?,?,?,'started',?,?)`).run(id, call.id, operationId, hash, Date.now());
        if (!inserted.changes) throw new Error("TOOL_OPERATION_ALREADY_CLAIMED");
      });
      return operationId;
    }
    const operationId = `${id}:${call.id}`;
    const result = prepareSql(this.db, "INSERT OR IGNORE INTO execution_tools VALUES (?,?,?)").run(id, call.id, encode({ call, state: "started", operationId }));
    if (!result.changes) throw new Error("TOOL_OPERATION_ALREADY_CLAIMED");
    return operationId;
  }
  completeTool(id: string, call: ModelToolCall, result: unknown, context?: ModelConversationMessage): void {
    if (this.core(id, "none")) {
      const core = this.conversations!;
      sqliteTransaction(core.db, () => {
        core.commitContext(id,`call:${call.id}`,{role:'assistant',text:'',toolCalls:[call]});
        const hash = core.objects.set(`tool:${id}:${call.id}`, "result", result).hash;
        const updated = prepareSql(core.db, "UPDATE conversation_tool_operations SET state='completed',result_hash=?,outcome=?,updated_at=? WHERE run_id=? AND call_id=?")
          .run(hash,(result as {result?:{status?:unknown}})?.result?.status==="outcome_uncertain"?"uncertain":"committed", Date.now(), id, call.id);
        if (!updated.changes) throw new Error("TOOL_OPERATION_NOT_CLAIMED");
        if (context) core.commitContext(id,`tool:${call.id}`,context);
      });
      return;
    }
    prepareSql(this.db, "UPDATE execution_tools SET payload=? WHERE run_id=? AND call_id=?")
      .run(encode({ call, state: "completed", result, operationId: `${id}:${call.id}` }), id, call.id);
  }
  tools(id: string): SavedTool[] {
    if (this.core(id, "none")) return (prepareSql(this.conversations!.db, "SELECT call_id FROM conversation_tool_operations WHERE run_id=? ORDER BY rowid")
      .all(id) as { call_id: string }[]).map(row => this.tool(id, row.call_id)!);
    return (prepareSql(this.db, "SELECT payload FROM execution_tools WHERE run_id=? ORDER BY rowid").all(id) as { payload: string }[]).map(row => decode(row.payload));
  }
  /** Recovery discovers calls in durable order; results are loaded only for reuse. */
  toolCalls(id: string): ModelToolCall[] {
    if (this.core(id, "none")) return (prepareSql(this.conversations!.db, "SELECT call_hash FROM conversation_tool_operations WHERE run_id=? ORDER BY rowid")
      .all(id) as { call_hash: string }[]).map(row => this.conversations!.objects.get(row.call_hash) as ModelToolCall);
    return (prepareSql(this.db, "SELECT CASE WHEN json_valid(payload) THEN payload->'$.call' ELSE payload END AS value FROM execution_tools WHERE run_id=? ORDER BY rowid")
      .all(id) as { value: string | null }[]).map(row => row.value === null ? undefined! : decode<ModelToolCall>(row.value));
  }
  tool(id: string, callId: string): SavedTool | undefined {
    if (this.core(id, "none")) {
      const core = this.conversations!;
      const row = prepareSql(core.db, "SELECT state,operation_id,call_hash,result_hash FROM conversation_tool_operations WHERE run_id=? AND call_id=?")
        .get(id, callId) as { state: SavedTool["state"]; operation_id: string; call_hash: string; result_hash: string | null } | undefined;
      return row ? { state: row.state, operationId: row.operation_id, call: core.objects.get(row.call_hash) as ModelToolCall,
        result: row.result_hash ? core.objects.get(row.result_hash) : undefined } : undefined;
    }
    const row = prepareSql(this.db, "SELECT payload FROM execution_tools WHERE run_id=? AND call_id=?").get(id, callId) as { payload: string } | undefined;
    return row ? decode(row.payload) : undefined;
  }
  cancel(scope: ToolExecutionContext): void { this.update(this.key(scope), { stage: "cancelled" }); }
  complete(scope: Pick<ToolExecutionContext, "agentId" | "sessionId" | "turnId"> & Partial<Pick<ToolExecutionContext,"taskRunId"|"executionId">>): void {
    const id = this.key(scope as ToolExecutionContext);
    if (this.core(id, "none")) {
      const core = this.conversations!;
      sqliteTransaction(core.db, () => {
        this.update(id, { stage: "completed" });
        prepareSql(core.db, "UPDATE conversation_runs SET delivery_status='delivered',updated_at=? WHERE id=?").run(Date.now(), id);
        // Tool operation credentials and uncertain results deliberately outlive recovery state.
        prepareSql(core.db, "DELETE FROM conversation_roots WHERE owner=? AND slot IN ('checkpoint','trace')").run(`run:${id}`);
      });
    } else sqliteTransaction(this.db, () => { this.update(id, { stage: "completed" }); });
  }
  completeTask(taskRunId: string, delivery: "delivered"|"not_required"|"cancelled" = "delivered"): void {
    if (!this.conversations) return;
    const rows = prepareSql(this.conversations.db,"SELECT id FROM conversation_runs WHERE routing_active IN (1,2) AND json_extract(id,'$[3]')=? AND generation_status='generated'")
      .all(taskRunId) as {id:string}[];
    for (const {id} of rows) {
      const [agentId,sessionId,turnId,taskRunId,executionId] = JSON.parse(id);
      this.complete({agentId,sessionId,turnId,taskRunId:taskRunId??undefined,executionId:executionId??undefined});
      prepareSql(this.conversations.db,"UPDATE conversation_runs SET delivery_status=? WHERE id=?").run(delivery,id);
    }
  }
  close(): void { for (const id of this.outputs.keys()) this.flushOutput(id); this.outputs.clear(); closeSqlite(this.db); }
}
