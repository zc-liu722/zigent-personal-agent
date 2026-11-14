export const CONVERSATION_STORAGE_FORMAT = 1;
import type { DatabaseSync } from "node:sqlite";
import { ConversationObjects, isMissingConversationObject } from "./objects.js";
import { prepareSql } from "../sqlite.js";
import type { ModelConversationMessage } from "../models/types.js";

/** Shared source/codec for context, history, web delivery and controlled read-only diagnostics.
 * Authorization stays at each authenticated boundary, before supplying an owner/message ID.
 * No public API accepts object hashes as a resource grant.
 */
export class ConversationReader {
  readonly objects: ConversationObjects;
  constructor(readonly db: DatabaseSync) { this.objects = new ConversationObjects(db); }
  installSql(target: DatabaseSync = this.db): void {
    target.function("conversation_read", hash => {
      if (hash === null) return null;
      const value = this.objects.get(String(hash));
      return typeof value === "string" ? value : JSON.stringify(value);
    });
    target.function("conversation_web_payload", payload => this.webPayload(String(payload), false));
    target.function("conversation_web_display", payload => this.webPayload(String(payload), true));
    target.function("conversation_context_trace", runId => JSON.stringify(this.contextTrace(String(runId))));
  }
  private webPayload(payload: string, display: boolean): string {
    const stub = JSON.parse(payload);
    if (!stub._conversation) return payload;
    const { hash } = stub._conversation;
    try { return JSON.stringify(this.objects.get(hash)); }
    catch (error) {
      if (!display || !isMissingConversationObject(error)) throw error;
      let text: unknown;
      try { text = this.objects.field(hash, "text"); }
      catch (fieldError) { if (!isMissingConversationObject(fieldError)) throw fieldError; }
      // A read-only notice can retain saved text but cannot expose incomplete actions or activity.
      return JSON.stringify({ id: stub.id, conversationId: stub.conversationId, createdAt: stub.createdAt,
        role: "notice", text: typeof text === "string" && text ? `${text}\n\n部分内容暂不可用。` : "这条消息暂不可用。",
        storageUnavailable: true });
    }
  }
  /** A missing result is execution evidence, never permission to replay the call. */
  contextTrace(runId: string): ModelConversationMessage[] {
    const saved = this.objects.read(`run:${runId}`, "committed") as { key: string; message: ModelConversationMessage }[] | undefined;
    const messages = (saved ?? []).map(entry => entry.message).filter(message=>message.role!=='assistant'
      || message.text || message.toolCalls.length || message.reasoningContent || message.nativeState || message.searchEvidence);
    const answers = new Map(messages.flatMap(message => message.role === "tool" ? [[message.toolCallId,message] as const] : []));
    const result: ModelConversationMessage[] = [];
    for (const message of messages) {
      if (message.role === 'tool') continue;
      result.push(message);
      if (message.role !== 'assistant') continue;
      // Adapter-owned parallel calls may commit results in a different order.
      // Replay each recorded pair together, without leaving orphan protocol messages.
      for (const call of message.toolCalls) {
        const id=call.id, answer=answers.get(id);
        if (answer) {result.push(answer);continue;}
        const operation = prepareSql(this.db,"SELECT operation_id,state FROM conversation_tool_operations WHERE run_id=? AND call_id=?")
          .get(runId,id) as {operation_id:string;state:string}|undefined;
        result.push({role:"tool",toolCallId:id,failed:true,value:JSON.stringify({
          status:operation ? "outcome_uncertain" : "not_executed",operation_id:operation?.operation_id,
          message:operation ? "No portable result was committed. Reconcile the saved operation or remote target before another write; do not blindly repeat it."
            : "Execution ended before this tool was started. No result is available."
        })});
      }
    }
    return result;
  }
  messageMetadata(messageId: string) {
    const run=prepareSql(this.db,`SELECT r.id,r.generation_status,r.delivery_status,r.context_status FROM conversation_runs r
      WHERE r.draft_id=? OR 'committed:'||r.draft_id=? OR EXISTS(SELECT 1 FROM conversation_attempts a WHERE a.run_id=r.id AND 'attempt:'||a.id=?)`)
      .get(messageId,messageId,messageId) as {id:string;generation_status:string;delivery_status:string;context_status:string}|undefined;
    if (!run) return {outputStatus:'complete',contextStatus:'eligible'};
    const attempt=messageId.startsWith('attempt:') ? prepareSql(this.db,"SELECT id,state FROM conversation_attempts WHERE 'attempt:'||id=? AND run_id=?")
      .get(messageId,run.id) as {id:number;state:string}|undefined : undefined;
    const committed=messageId.startsWith('committed:');
    return {generationStatus:run.generation_status,deliveryStatus:run.delivery_status,
      outputStatus:attempt ? this.objects.root(`attempt:${attempt.id}`,'output') ? 'incomplete' : 'legacy_snapshot'
        : committed || run.context_status==='eligible' ? 'complete' : 'mixed',
      contextStatus:attempt ? 'excluded' : committed ? 'eligible' : run.context_status,
      attemptId:attempt?.id,attemptStatus:attempt?.state};
  }
  attemptMetadata(sessionId: string) {
    const rows = prepareSql(this.db,`SELECT a.id,a.run_id,a.model,a.supplier,a.state,a.failure_kind,a.retry_attempt,a.model_round,a.started_at,a.finished_at
      FROM conversation_attempts a JOIN conversation_runs r ON r.id=a.run_id WHERE r.session_id=? ORDER BY a.id LIMIT 501`).all(sessionId);
    return {rows:rows.slice(0,500),complete:rows.length<=500};
  }
  runMetadata(sessionId: string) {
    return prepareSql(this.db, `SELECT id,session_id,turn_id,reply_id,stage,generation_status,delivery_status,context_status,updated_at,
      (SELECT model FROM conversation_attempts a WHERE a.run_id=r.id ORDER BY a.id DESC LIMIT 1) AS actual_model,
      (SELECT supplier FROM conversation_attempts a WHERE a.run_id=r.id ORDER BY a.id DESC LIMIT 1) AS supplier,
      (SELECT failure_kind FROM conversation_attempts a WHERE a.run_id=r.id ORDER BY a.id DESC LIMIT 1) AS failure_kind,
      (SELECT count(*) FROM conversation_attempts a WHERE a.run_id=r.id) AS attempts,
      (SELECT count(*) FROM conversation_tool_operations t WHERE t.run_id=r.id AND (t.state='started' OR t.outcome='uncertain')) AS uncertain_tools,
      (SELECT count(*) FROM conversation_outbox o WHERE o.run_id=r.id AND o.delivered_at IS NULL) AS pending_deliveries
      FROM conversation_runs r WHERE routing_active IN (1,2) AND session_id=? ORDER BY updated_at,id`).all(sessionId);
  }
}

/** Existing schemas remain readable without creating tables or mutating a diagnostic snapshot. */
export function installConversationReader(db: DatabaseSync): ConversationReader | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_objects' AND type='table'").get()) return;
  const reader = new ConversationReader(db); reader.installSql(); return reader;
}

export function installWebConversationReader(web: DatabaseSync, reader?: ConversationReader): void {
  if (reader) reader.installSql(web);
  else for (const name of ["conversation_web_payload", "conversation_web_display"]) web.function(name, payload => String(payload));
  const columns = web.prepare("PRAGMA table_info(web_messages)").all() as { name: string }[];
  if (!columns.length) return;
  for (const [view, decode] of [["web_message_records", "conversation_web_payload"], ["web_message_display_records", "conversation_web_display"]])
    web.exec(`CREATE TEMP VIEW IF NOT EXISTS ${view} AS SELECT ${columns.map(({name}) =>
      name === "payload" ? `${decode}(payload) AS payload` : name).join(",")} FROM web_messages`);
}
