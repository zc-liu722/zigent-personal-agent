import { prepareSql, closeSqlite, sqliteTransaction } from "../sqlite.js";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import type { AgentRunSnapshot } from "../agent/transcript.js";
import type { WebMessageOperation } from "./message-operations.js";
import { compactMessage } from "./message-activity.js";
import type { Session } from "../memory/types.js";
import { selectGreeting } from "./greetings.js";
import type { ConversationDiagnostic } from "../audit/diagnostics.js";
import { AUTHORIZATION_SERVICES, authorizationInteraction, authorizationSetupRequiredText, type WebAuthorizationService, type WebInteraction } from "./interactions.js";

const derive = promisify(scrypt);
export const DEVICE_LIFETIME = 400 * 24 * 60 * 60 * 1000;
const DEVICE_RENEW_INTERVAL = 60 * 60 * 1000;
const HISTORY_REPAIR_VERSION = "web_history_repairs_v1";
const restartInteraction = (interaction: WebInteraction) => interaction.status === "pending"
  && !["browser", "task-proposal", "memory-proposal", "operation-confirmation"].includes(interaction.kind);
const restartPendingSql = (payload: string) => `CASE WHEN json_type(${payload},'$.interactions')='array' THEN EXISTS (
  SELECT 1 FROM json_each(${payload},'$.interactions') AS interaction
  WHERE json_extract(interaction.value,'$.status')='pending'
    AND COALESCE(json_extract(interaction.value,'$.kind'),'') NOT IN ('browser','task-proposal','memory-proposal','operation-confirmation')) ELSE 0 END`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function passwordHash(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256) throw new Error("密码需要 12–256 个字符。");
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password, salt, 64) as Buffer).toString("hex")}`;
}
export function validPasswordHash(value: string): boolean {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value);
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (password.length > 256 || !validPasswordHash(hash)) return false;
  const [, salt, expected] = hash.split(":");
  return timingSafeEqual(await derive(password, salt!, 64) as Buffer, Buffer.from(expected!, "hex"));
}

export type WebMessage = {
  id: string; conversationId: string; role: "user" | "assistant" | "notice";
  text: string; createdAt: number; snapshot?: AgentRunSnapshot;
  assets?: string[]; action?: unknown; interactions?: WebInteraction[];
  files?: Record<string, { name: string; mime: string; size: number }>;
  taskTitle?: string;
  replyTo?: string;
  /** Server acceptance of the user message through the reply's terminal state, including queue time. */
  replyDurationMs?: number;
  streamEpoch?: string;
  streamRevision?: number;
  activityDeferred?: boolean;
  activityRevision?: string;
  writingEdits?: Record<string, { original: string; content: string; title: string; updatedAt: number }>;
};
export type QueuedWebMessage = {
  id: string; conversationId: string; text: string; assets: string[]; createdAt: number;
  files?: WebMessage["files"];
  model: string; reasoningEfforts: Record<string, import("../config.js").ReasoningEffort>;
  status: "queued" | "dispatched" | "cancelled" | "failed";
  error?: string;
};
export function queuedMessageView(message: QueuedWebMessage) {
  const { id, text, assets, files, createdAt, status, error } = message;
  return { id, text, assets, files, createdAt, status, error };
}
type MessageRow = { seq: number; id: string; conversation_id: string; payload: string };
type ConversationRow = { id: string; chatId: string; sessionId: string | null; model: string | null };
type ConversationDraft = ConversationRow & { greeting: string };
type EditRequest = { request_id: string; conversation_id: string; message_id: string; session_id: string; from_turn: number; payload_key: string; completed: number };

/** Private transport history, assets and device tokens; independent of model memory. */
export class WebStore extends EventEmitter {
  private readonly drafts = new Map<string, ConversationDraft>();
  readonly streamEpoch = randomUUID();
  private streamRevision = 0;
  private historyCache?: { changes: number; version: number; page: ReturnType<WebStore["conversationPage"]> };
  private readonly liveMessages = new Map<string, { current: () => WebMessage; seq: number; revision: number }>();
  private liveMessage(id: string): (WebMessage & { seq: number }) | undefined {
    const live = this.liveMessages.get(id);
    if (!live) return;
    // A read flushes pending operations before assigning the snapshot's revision.
    const message = live.current();
    const latest = this.liveMessages.get(id);
    return { ...message, seq: live.seq, streamEpoch: this.streamEpoch, streamRevision: latest?.revision ?? message.streamRevision ?? live.revision };
  }
  private constructor(readonly db: DatabaseSync, readonly owner: string) { super(); }
  /** Controlled data maintenance only: attach an existing owner database without
   * running startup recovery against live conversations or migrating schemas. */
  static connectForMaintenance(path: string, owner: string): WebStore {
    const file=lstatSync(path);
    if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1)throw new Error("WEB_MAINTENANCE_FILE_INVALID");
    const db=new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      if(db.prepare("SELECT value FROM settings WHERE key='owner'").get()?.value!==owner)throw new Error("WEB_OWNER_MISMATCH");
      return new WebStore(db,owner);
    } catch(error) {closeSqlite(db);throw error;}
  }
  static async open(path: string, owner: string, initialHash?: string): Promise<WebStore> {
    await mkdir(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.function("history_title_matches", { deterministic: true }, (title, query) =>
      String(title).toLocaleLowerCase().includes(String(query).toLocaleLowerCase()) ? 1 : 0);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_expiry_limits (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at INTEGER NOT NULL, public_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS web_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS web_messages_conversation ON web_messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_documents (asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS asset_document_links (asset_id TEXT NOT NULL, conversation_id TEXT NOT NULL, PRIMARY KEY(asset_id,conversation_id));
      CREATE TABLE IF NOT EXISTS asset_document_versions (seq INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS asset_document_versions_asset ON asset_document_versions(asset_id,seq);
      CREATE TABLE IF NOT EXISTS asset_document_moves (asset_id TEXT PRIMARY KEY, project TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, moved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, resets_at INTEGER NOT NULL);`);
    db.exec(`CREATE TABLE IF NOT EXISTS web_message_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS web_message_queue_conversation ON web_message_queue(conversation_id,json_extract(payload,'$.status'),seq);
      CREATE INDEX IF NOT EXISTS web_message_queue_status ON web_message_queue(json_extract(payload,'$.status'),seq)`);
    db.exec("CREATE TABLE IF NOT EXISTS task_proposals(id TEXT PRIMARY KEY, proposal_key TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS memory_proposals(id TEXT PRIMARY KEY, proposal_key TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, payload TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS web_branches (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, message_id TEXT NOT NULL, target_id TEXT NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS web_edits (request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL, session_id TEXT NOT NULL, from_turn INTEGER NOT NULL, payload_key TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0)`);
    db.exec("CREATE TABLE IF NOT EXISTS web_rewound_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL)");
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_diagnostics (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, payload TEXT NOT NULL)`);
    const columns = db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[];
    if (!columns.some(column => column.name === "session_id")) db.exec("ALTER TABLE conversations ADD COLUMN session_id TEXT");
    if (!columns.some(column => column.name === "chat_id")) db.exec("ALTER TABLE conversations ADD COLUMN chat_id TEXT");
    if (!columns.some(column => column.name === "model")) db.exec("ALTER TABLE conversations ADD COLUMN model TEXT");
    if (!columns.some(column => column.name === "revision")) db.exec("ALTER TABLE conversations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
    if (!columns.some(column => column.name === "greeting")) db.exec("ALTER TABLE conversations ADD COLUMN greeting TEXT");
    if (!columns.some(column => column.name === "deleted_at")) db.exec("ALTER TABLE conversations ADD COLUMN deleted_at INTEGER");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversations_session ON conversations(session_id)");
    // Reverse scan also orders equal timestamps by descending rowid, matching the history list.
    db.exec("CREATE INDEX IF NOT EXISTS conversations_recent ON conversations(deleted_at,updated_at)");
    const messageColumns = db.prepare("PRAGMA table_info(web_messages)").all() as { name: string }[];
    if (!messageColumns.some(column => column.name === "deleted_at"))
      db.exec("ALTER TABLE web_messages ADD COLUMN deleted_at INTEGER");
    if (!messageColumns.some(column => column.name === "deleted_by_edit"))
      db.exec("ALTER TABLE web_messages ADD COLUMN deleted_by_edit TEXT");
    db.exec(`CREATE INDEX IF NOT EXISTS web_messages_active_conversation
      ON web_messages(conversation_id,seq) WHERE deleted_at IS NULL`);
    db.exec(`CREATE TABLE IF NOT EXISTS web_message_views (message_id TEXT PRIMARY KEY, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
      CREATE TRIGGER IF NOT EXISTS web_messages_view_invalidated AFTER UPDATE OF payload ON web_messages BEGIN
        DELETE FROM web_message_views WHERE message_id=NEW.id;
      END;
      CREATE TRIGGER IF NOT EXISTS web_messages_view_deleted AFTER DELETE ON web_messages BEGIN
        DELETE FROM web_message_views WHERE message_id=OLD.id;
      END`);
    const viewColumns = db.prepare("PRAGMA table_info(web_message_views)").all() as { name: string }[];
    if (!viewColumns.some(column => column.name === "version")) db.exec("ALTER TABLE web_message_views ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    if (!messageColumns.some(column => column.name === "restart_pending"))
      db.exec("ALTER TABLE web_messages ADD COLUMN restart_pending INTEGER NOT NULL DEFAULT 0");
    db.exec(`CREATE INDEX IF NOT EXISTS web_messages_running ON web_messages(seq)
      WHERE json_extract(payload,'$.snapshot.status')='running';
      CREATE INDEX IF NOT EXISTS web_messages_restart_pending ON web_messages(seq) WHERE restart_pending=1`);
    // Keep the recovery flag correct even if a previous release or maintenance writer
    // updates payload without knowing the new column. Current writes already set it.
    for (const [name, event] of [["insert", "INSERT"], ["update", "UPDATE OF payload"]]) {
      const pending = restartPendingSql("NEW.payload");
      db.exec(`CREATE TRIGGER IF NOT EXISTS web_messages_restart_${name} AFTER ${event} ON web_messages
        WHEN NEW.restart_pending<>(${pending}) BEGIN
          UPDATE web_messages SET restart_pending=(${pending}) WHERE seq=NEW.seq;
        END`);
    }
    const store = new WebStore(db, owner);
    const previous = store.setting("owner");
    if (previous && previous !== owner) { db.close(); throw new Error("WEB_OWNER_MISMATCH"); }
    if (!store.setting("password")) {
      if (!initialHash || !validPasswordHash(initialHash)) { db.close(); throw new Error("WEB_PASSWORD_HASH_REQUIRED"); }
      store.set("password", initialHash);
    }
    if (!previous) store.set("owner", owner);
    try {
      store.repairLegacyHistory();
      store.recoverInterruptedMessages();
      return store;
    } catch (error) { closeSqlite(db); throw error; }
  }
  private repairLegacyHistory(): void {
    if (this.setting(HISTORY_REPAIR_VERSION) === "1") return;
    sqliteTransaction(this.db, () => {
      this.db.exec("UPDATE conversations SET chat_id=id WHERE chat_id IS NULL");
      // Historical setup failures are repaired once; new failed operations already carry retry actions.
      const rows = prepareSql(this.db, `SELECT seq,id,conversation_id,payload FROM web_messages
        WHERE deleted_at IS NULL AND json_type(payload,'$.interactions')='array' AND EXISTS (
          SELECT 1 FROM json_each(web_messages.payload,'$.interactions') AS interaction
          WHERE json_extract(interaction.value,'$.kind')='authorization'
            AND json_extract(interaction.value,'$.status') IN ('failed','expired')
            AND json_array_length(interaction.value,'$.actions')=0)`).all() as MessageRow[];
      for (const row of rows) {
        const message = JSON.parse(row.payload) as WebMessage;
        let changed = false;
        const interactions = message.interactions!.map(interaction => {
          if (interaction.kind !== "authorization" || !interaction.service
            || !["failed", "expired"].includes(interaction.status) || interaction.actions.length) return interaction;
          changed = true;
          return authorizationInteraction(interaction.id, interaction.service, interaction.status as "failed" | "expired", undefined,
            interaction.statusMessage?.includes("授权入口尚未配置") ? authorizationSetupRequiredText(interaction.service) : interaction.statusMessage);
        });
        if (changed) this.save({ ...message, action: undefined, interactions }, false);
      }
      const actions = prepareSql(this.db, `SELECT seq,id,conversation_id,payload FROM web_messages
        WHERE deleted_at IS NULL AND json_extract(payload,'$.action.type') IN ('authorization','model-fallback')`).all() as MessageRow[];
      for (const row of actions) {
        const message = JSON.parse(row.payload) as WebMessage;
        const action = message.action as { type: string; expiresAt?: number };
        const services = (Object.keys(AUTHORIZATION_SERVICES) as WebAuthorizationService[]).filter(service => message.text.includes(AUTHORIZATION_SERVICES[service].label));
        const interaction: WebInteraction = action.type === "authorization" && services.length === 1
          ? authorizationInteraction(message.id, services[0]!, action.expiresAt && action.expiresAt <= Date.now() ? "expired" : "failed", undefined,
            "旧连接过程已中断，请重新连接。刚才的操作尚未执行。")
          : { id: message.id, kind: "actions", title: action.type === "authorization" ? "重新连接账号" : "模型切换确认", status: "failed",
            statusMessage: "服务已更新，这项操作已失效。请重新发送请求。", actions: [] };
        this.save({ ...message, text: "", action: undefined, interactions: message.interactions ?? [interaction] }, false);
      }
      // Seed the small recovery index once. Subsequent payload writes maintain it directly.
      this.db.exec(`UPDATE web_messages SET restart_pending=1 WHERE deleted_at IS NULL AND ${restartPendingSql("web_messages.payload")}`);
      this.set(HISTORY_REPAIR_VERSION, "1");
    });
  }
  private recoverInterruptedMessages(): void {
    for (const row of prepareSql(this.db, "SELECT seq,id,conversation_id,payload FROM web_messages WHERE deleted_at IS NULL AND json_extract(payload,'$.snapshot.status')='running'").all() as MessageRow[]) {
      const message = JSON.parse(row.payload) as WebMessage;
      this.save({ ...message, text: message.text || "连接中断了，请重新发送。",
        snapshot: { ...message.snapshot!, status: "failed", failureMessage: "服务已重启，请重新发送。" } }, false);
    }
    for (const row of prepareSql(this.db, "SELECT seq,id,conversation_id,payload FROM web_messages WHERE deleted_at IS NULL AND restart_pending=1").all() as MessageRow[]) {
      const message = JSON.parse(row.payload) as WebMessage;
      const interactions = message.interactions!.map(interaction => {
        if (!restartInteraction(interaction)) return interaction; // Durable consent survives restarts.
        if (interaction.actions.some(action => action.kind === "submit" && action.value.type === "audio-transcription"))
          return { ...interaction, status: "failed" as const, statusMessage: "转录已中断，请重试。" };
        if (interaction.kind === "user-question") return interaction.expiresAt && interaction.expiresAt > Date.now()
          ? { ...interaction, resumeAfterRestart: true }
          : { ...interaction, status: "expired" as const, statusMessage: "提问已过期。", actions: [] };
        if (interaction.kind !== "authorization" || !interaction.service) return { ...interaction, status: "failed" as const,
          statusMessage: "服务已重启，这项确认已失效。请重新发送请求。", actions: [] };
        return authorizationInteraction(interaction.id, interaction.service, interaction.expiresAt && interaction.expiresAt <= Date.now() ? "expired" : "failed",
          undefined, "连接过程已中断，请重新连接。刚才的操作尚未执行。");
      });
      this.save({ ...message, action: undefined, interactions }, false);
    }
  }
  recordDiagnostic(conversationId: string, messageId: string, event: ConversationDiagnostic): void {
    prepareSql(this.db, "INSERT INTO conversation_diagnostics(conversation_id,message_id,created_at,payload) VALUES(?,?,?,?)")
      .run(conversationId, messageId, Date.now(), JSON.stringify(event));
    this.db.exec("DELETE FROM conversation_diagnostics WHERE seq <= (SELECT MAX(seq)-10000 FROM conversation_diagnostics)");
  }
  saveDefaultModel(model: string): void { this.set("default_model", model); this.emit("change"); }
  modelReasoning(model: string): string | undefined { return this.setting(`model_reasoning:${model}`); }
  saveModelReasoning(model: string, effort: string): void {
    this.set(`model_reasoning:${model}`, effort);
    this.emit("change");
  }
  setting(key: string): string | undefined {
    return (prepareSql(this.db, "SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  private set(key: string, value: string): void { prepareSql(this.db, "INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, value); }
  allowLogin(key: string, now = Date.now()): boolean {
    prepareSql(this.db, "DELETE FROM login_attempts WHERE resets_at<=?").run(now);
    for (const bucket of ["global", digest(key)]) {
      const row = prepareSql(this.db, "SELECT count FROM login_attempts WHERE key=?").get(bucket) as { count: number } | undefined;
      if ((row?.count ?? 0) >= (bucket === "global" ? 60 : 10)) return false;
    }
    for (const bucket of ["global", digest(key)]) prepareSql(this.db, "INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1").run(bucket, now + 15 * 60_000);
    return true;
  }
  createDevice(now = Date.now()): string {
    prepareSql(this.db, "DELETE FROM devices WHERE expires_at<=?").run(now);
    const token = randomBytes(32).toString("base64url");
    prepareSql(this.db, "INSERT INTO devices VALUES (?,?)").run(digest(token), now + DEVICE_LIFETIME);
    return token;
  }
  authenticate(token: string, now = Date.now()): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const tokenHash = digest(token);
    const device = prepareSql(this.db, "SELECT expires_at FROM devices WHERE token_hash=?").get(tokenHash) as { expires_at: number } | undefined;
    const cap = prepareSql(this.db, "SELECT expires_at FROM device_expiry_limits WHERE token_hash=?").get(tokenHash) as { expires_at: number } | undefined;
    if (!device || device.expires_at <= now || cap && cap.expires_at <= now) return false;
    // Read every time so revocation is immediate; persist sliding renewal at most hourly.
    if (device.expires_at > now + DEVICE_LIFETIME - DEVICE_RENEW_INTERVAL) return true;
    return prepareSql(this.db, "UPDATE devices SET expires_at=MAX(expires_at,?) WHERE token_hash=? AND expires_at>?")
      .run(Math.min(now + DEVICE_LIFETIME, cap?.expires_at ?? now + DEVICE_LIFETIME), tokenHash, now).changes === 1;
  }
  revoke(token: string): void {
    const hash = digest(token);
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "DELETE FROM devices WHERE token_hash=?").run(hash);
      prepareSql(this.db, "DELETE FROM device_expiry_limits WHERE token_hash=?").run(hash);
    });
  }
  async changePassword(password: string): Promise<void> {
    this.set("password", await passwordHash(password));
    this.db.exec("DELETE FROM devices; DELETE FROM device_expiry_limits");
  }
  /** Empty chats live only in this process until a message or queued send is saved. */
  draftConversation(id: string): void {
    this.drafts.set(digest(id), { id, chatId: id, sessionId: null, model: null, greeting: selectGreeting() });
  }
  isDraft(id: string): boolean { return this.drafts.has(digest(id)); }
  conversation(id: string, title = "新的对话", updatedAt = Date.now(), sessionId?: string, chatId = id): void {
    const draft = this.drafts.get(digest(id));
    prepareSql(this.db, `INSERT INTO conversations(id,title,updated_at,public_id,session_id,chat_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_id=COALESCE(excluded.session_id,conversations.session_id)`)
      .run(id, [...title].slice(0,60).join(""), updatedAt, digest(id), sessionId ?? null, chatId);
    if (draft) {
      prepareSql(this.db, "UPDATE conversations SET model=?,greeting=? WHERE id=?").run(draft.model, draft.greeting, id);
      this.drafts.delete(digest(id));
    }
  }
  conversationInfo(id: string): ConversationRow | undefined {
    const draft = this.drafts.get(digest(id));
    if (draft) return { id, chatId: draft.chatId, sessionId: draft.sessionId, model: draft.model };
    return prepareSql(this.db, "SELECT id,chat_id AS chatId,session_id AS sessionId,model FROM conversations WHERE id=?").get(id) as ConversationRow | undefined;
  }
  conversationGreeting(id: string): string | undefined {
    const draft = this.drafts.get(digest(id));
    if (draft) return draft.greeting;
    const row = prepareSql(this.db, "SELECT greeting FROM conversations WHERE id=?").get(id) as { greeting: string | null } | undefined;
    if (!row) return undefined;
    if (row.greeting) return row.greeting;
    const greeting = selectGreeting();
    prepareSql(this.db, "UPDATE conversations SET greeting=? WHERE id=?").run(greeting, id);
    return greeting;
  }
  selectModel(id: string, model: string): void {
    const draft = this.drafts.get(digest(id));
    if (draft) draft.model = model;
    else prepareSql(this.db, "UPDATE conversations SET model=? WHERE id=?").run(model, id);
    this.emit("change");
  }
  touchConversation(id: string, now = Date.now()): void {
    prepareSql(this.db, "UPDATE conversations SET updated_at=MAX(updated_at,?) WHERE id=?").run(now, id);
  }
  conversationForChat(chatId: string): string {
    return (prepareSql(this.db, "SELECT id FROM conversations WHERE chat_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(chatId) as { id: string } | undefined)?.id ?? chatId;
  }
  conversationForSessionId(sessionId: string): string | undefined {
    return (prepareSql(this.db, "SELECT id FROM conversations WHERE session_id=?").get(sessionId) as { id: string } | undefined)?.id;
  }
  conversationForSession(session: Session): string {
    const existing = prepareSql(this.db, "SELECT id FROM conversations WHERE session_id=?").get(session.id) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = `session:${session.id}`;
    this.conversation(id, session.initialUserPreview || "新的对话", session.lastActiveAt, session.id, session.chatId);
    this.emit("change");
    return id;
  }
  resolveConversation(id: string): string | undefined { return this.drafts.get(id)?.id ?? (prepareSql(this.db, "SELECT id FROM conversations WHERE public_id=? AND deleted_at IS NULL").get(id) as { id: string } | undefined)?.id; }
  publicId(id: string): string { return digest(id); }
  hasConversation(id: string): boolean { return this.isDraft(id) || Boolean(prepareSql(this.db, "SELECT 1 FROM conversations WHERE id=?").get(id)); }
  conversations(): Array<{ id: string; title: string; updatedAt: number }> {
    return this.conversationPage().conversations;
  }
  conversationPage(query = "", cursor?: { updatedAt: number; rowid: number }, limit = 200): {
    conversations: Array<{ id: string; title: string; updatedAt: number }>; nextCursor?: string;
  } {
    const reusable = !this.db.isTransaction && !query && !cursor && limit === 200;
    const { changes } = prepareSql(this.db, "SELECT total_changes() AS changes").get() as { changes: number };
    const { data_version: version } = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    // Cover writes from this connection and committed changes from maintenance connections.
    if (reusable && this.historyCache?.changes === changes && this.historyCache.version === version) return this.historyCache.page;
    const rows = prepareSql(this.db, `SELECT public_id AS id,title,updated_at AS updatedAt,rowid FROM conversations WHERE deleted_at IS NULL
      ${query ? "AND history_title_matches(title,?)" : ""}
      ${cursor ? "AND (updated_at,rowid)<(?,?)" : ""}
      AND (EXISTS (SELECT 1 FROM web_messages WHERE deleted_at IS NULL AND conversation_id=conversations.id)
        OR EXISTS (SELECT 1 FROM web_message_queue WHERE conversation_id=conversations.id AND json_extract(payload,'$.status') IN ('queued','failed')))
      ORDER BY updated_at DESC,rowid DESC LIMIT ?`).all(...(query ? [query] : []),
        ...(cursor ? [cursor.updatedAt, cursor.rowid] : []), limit + 1) as Array<{ id: string; title: string; updatedAt: number; rowid: number }>;
    const selected = rows.slice(0, limit), last = selected.at(-1);
    const page = { conversations: selected.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      nextCursor: rows.length > limit && last ? `${last.updatedAt}:${last.rowid}` : undefined };
    if (reusable) this.historyCache = { changes, version, page };
    return page;
  }
  /** Keep the transcript/session intact and retain a tombstone across imports and late replies. */
  deleteConversation(publicId: string, now = Date.now()): boolean {
    if (this.drafts.delete(publicId)) { this.emit("change"); return true; }
    this.db.exec("BEGIN IMMEDIATE");
    let changed = false;
    try {
      const row = prepareSql(this.db, "SELECT id FROM conversations WHERE public_id=?").get(publicId) as { id: string } | undefined;
      if (row) {
        prepareSql(this.db, "UPDATE conversations SET deleted_at=COALESCE(deleted_at,?) WHERE id=?").run(now, row.id);
        for (const message of this.queuedMessages(row.id)) prepareSql(this.db, "UPDATE web_message_queue SET payload=? WHERE id=?")
          .run(JSON.stringify({ ...message, status: "cancelled" }), message.id);
        changed = true;
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (changed) this.emit("change");
    return changed;
  }
  private firstContentMessage(conversationId: string): WebMessage | undefined {
    const row = prepareSql(this.db, `SELECT payload FROM web_messages WHERE deleted_at IS NULL AND conversation_id=?
      AND json_extract(payload,'$.role') IN ('user','assistant') AND trim(json_extract(payload,'$.text'))<>'' ORDER BY seq LIMIT 1`)
      .get(conversationId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WebMessage : undefined;
  }
  private backgroundPreview(message: WebMessage): string {
    const text = [message.taskTitle?.trim(), message.text.trim().replace(/\s+/g, " ")].filter(Boolean).join(" · ");
    return [...text].slice(0, 60).join("");
  }
  /** Upgrade existing placeholder rows using trusted task metadata, without rewriting chat content. */
  repairBackgroundTitles(resolveTitle: (notificationId: string) => string | undefined): void {
    const rows = prepareSql(this.db, "SELECT id FROM conversations WHERE title IN ('主动任务','新的对话')").all() as { id: string }[];
    for (const { id } of rows) {
      const first = this.firstContentMessage(id);
      if (first?.role !== "assistant") continue;
      const taskTitle = first.taskTitle ?? (first.id.startsWith("background:") ? resolveTitle(first.id.slice("background:".length)) : undefined);
      if (taskTitle) this.save({ ...first, taskTitle });
      else prepareSql(this.db, "UPDATE conversations SET title=? WHERE id=?").run(this.backgroundPreview(first), id);
    }
  }
  queuedMessage(id: string): QueuedWebMessage | undefined {
    const row = prepareSql(this.db, "SELECT payload FROM web_message_queue WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as QueuedWebMessage : undefined;
  }
  queuedMessages(conversationId?: string): QueuedWebMessage[] {
    const rows = conversationId
      ? prepareSql(this.db, "SELECT payload FROM web_message_queue WHERE conversation_id=? AND json_extract(payload,'$.status') IN ('queued','failed') ORDER BY seq").all(conversationId)
      : prepareSql(this.db, "SELECT payload FROM web_message_queue WHERE json_extract(payload,'$.status')='queued' ORDER BY seq").all();
    return (rows as { payload: string }[]).map(row => JSON.parse(row.payload) as QueuedWebMessage);
  }
  saveQueuedMessage(message: QueuedWebMessage): void {
    message.files = this.documentMetadata(message.assets);
    if (this.isDraft(message.conversationId)) this.conversation(message.conversationId, message.text || "新的对话", message.createdAt);
    prepareSql(this.db, "INSERT INTO web_message_queue(id,conversation_id,payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(message.id, message.conversationId, JSON.stringify(message));
    this.emitQueue(message.conversationId);
  }
  /** Publish a recovered form receipt only after its continuation is durably queued. */
  completeRecoveredQuestion(message: WebMessage, continuation: QueuedWebMessage): void {
    const continuationJson = JSON.stringify(continuation), messageJson = JSON.stringify(message);
    sqliteTransaction(this.db, () => {
      if (!this.message(message.id)) throw new Error("Question message unavailable");
      prepareSql(this.db, "INSERT INTO web_message_queue(id,conversation_id,payload) VALUES (?,?,?)")
        .run(continuation.id, continuation.conversationId, continuationJson);
      prepareSql(this.db, "UPDATE web_messages SET payload=?,restart_pending=? WHERE id=? AND deleted_at IS NULL")
        .run(messageJson, message.interactions?.some(restartInteraction) ? 1 : 0, message.id);
    });
    const row = prepareSql(this.db, "SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=?").get(message.id) as { seq: number };
    this.emit("message", { ...message, seq: row.seq, conversationId: digest(message.conversationId) });
    this.emitQueue(message.conversationId);
  }
  startQueuedMessage(message: QueuedWebMessage): void {
    const dispatchedJson = JSON.stringify({ ...message, status: "dispatched" });
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "UPDATE web_message_queue SET payload=? WHERE id=?").run(dispatchedJson, message.id);
      this.save({ id: message.id, conversationId: message.conversationId, role: "user", text: message.text, assets: message.assets, createdAt: Date.now() });
    });
    this.emitQueue(message.conversationId);
  }
  private emitQueue(conversationId: string): void {
    this.emit("queue", { conversationId: this.publicId(conversationId), queued: this.queuedMessages(conversationId).map(queuedMessageView) });
    this.emit("change");
  }
  message(id: string): WebMessage | undefined {
    if (this.rewoundMessage(id)) return;
    const live = this.liveMessage(id);
    if (live) return live;
    const row = prepareSql(this.db, "SELECT payload FROM web_messages WHERE deleted_at IS NULL AND id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as WebMessage : undefined;
  }
  messages(conversationId: string, before = Number.MAX_SAFE_INTEGER, limit = 100, compact = false): Array<WebMessage & { seq: number }> {
    const sql = compact
      ? `SELECT message.seq,message.id,message.conversation_id,COALESCE(cached.payload,message.payload) AS payload,cached.message_id IS NOT NULL AS compact
        FROM web_messages AS message LEFT JOIN web_message_views AS cached ON cached.message_id=message.id AND cached.version=1
        WHERE message.deleted_at IS NULL AND message.conversation_id=? AND message.seq<? ORDER BY message.seq DESC LIMIT ?`
      : "SELECT seq,id,conversation_id,payload FROM web_messages WHERE deleted_at IS NULL AND conversation_id=? AND seq<? ORDER BY seq DESC LIMIT ?";
    return (prepareSql(this.db, sql).all(conversationId, before, limit) as Array<MessageRow & { compact?: number }>).reverse().map(row => {
      const live = this.liveMessage(row.id);
      if (live) return compact ? { ...compactMessage(live), seq: row.seq } : live;
      const message = JSON.parse(row.payload) as WebMessage;
      const view = compact ? compactMessage(message) : message;
      // Warm legacy history a page at a time, avoiding a startup-wide rewrite.
      if (compact && !row.compact && view.activityDeferred)
        prepareSql(this.db, "INSERT OR REPLACE INTO web_message_views(message_id,payload,version) VALUES (?,?,1)").run(row.id, JSON.stringify(view));
      return { ...view, seq: row.seq };
    });
  }
  hasPendingQuestion(conversationId: string): boolean {
    // Match messages()'s latest 100 active rows without materializing full activity snapshots.
    const rows = prepareSql(this.db, `SELECT id,json_extract(payload,'$.interactions') AS interactions
      FROM web_messages WHERE deleted_at IS NULL AND conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 100`)
      .all(conversationId, Number.MAX_SAFE_INTEGER) as Array<{ id: string; interactions: string | null }>;
    return rows.some(row => {
      const live = this.liveMessage(row.id);
      const interactions = live ? live.interactions : row.interactions ? JSON.parse(row.interactions) as WebMessage["interactions"] : undefined;
      return interactions?.some(item => item.kind === "user-question" && item.status === "pending") ?? false;
    });
  }
  hasMessagesBefore(conversationId: string, before: number): boolean {
    return !!prepareSql(this.db, "SELECT 1 FROM web_messages WHERE deleted_at IS NULL AND conversation_id=? AND seq<? LIMIT 1").get(conversationId, before);
  }
  messagesThrough(conversationId: string, messageId: string): WebMessage[] {
    return (prepareSql(this.db, `SELECT payload FROM web_messages WHERE deleted_at IS NULL AND conversation_id=?
      AND seq<=(SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=? AND conversation_id=?) ORDER BY seq`)
      .all(conversationId,messageId,conversationId) as { payload: string }[]).map(row => JSON.parse(row.payload) as WebMessage);
  }
  branchRequest(requestId: string): { source_id: string; message_id: string; target_id: string } | undefined {
    return prepareSql(this.db, "SELECT * FROM web_branches WHERE request_id=?").get(requestId) as ReturnType<WebStore["branchRequest"]>;
  }
  conversationRevision(id: string): number {
    if (this.isDraft(id)) return 0;
    return (prepareSql(this.db, "SELECT revision FROM conversations WHERE id=?").get(id) as { revision: number }).revision;
  }
  editRequest(requestId: string): EditRequest | undefined {
    return prepareSql(this.db, "SELECT * FROM web_edits WHERE request_id=?").get(requestId) as EditRequest | undefined;
  }
  rewoundMessage(id: string): { conversation_id: string } | undefined {
    return prepareSql(this.db, "SELECT conversation_id FROM web_rewound_messages WHERE id=?").get(id) as { conversation_id: string } | undefined;
  }
  updatePendingEdit(requestId: string, payloadKey: string, nextRequestId = requestId): void {
    prepareSql(this.db, "UPDATE web_edits SET request_id=?,payload_key=? WHERE request_id=? AND completed=0").run(nextRequestId,payloadKey,requestId);
  }
  pendingEdit(chatId: string): EditRequest | undefined {
    return prepareSql(this.db, `SELECT web_edits.* FROM web_edits JOIN conversations ON conversations.id=conversation_id
      WHERE conversations.chat_id=? AND completed=0 LIMIT 1`).get(chatId) as EditRequest | undefined;
  }
  prepareEdit(requestId: string, conversationId: string, messageId: string, sessionId: string, fromTurn: number, payloadKey: string): void {
    prepareSql(this.db, "INSERT INTO web_edits(request_id,conversation_id,message_id,session_id,from_turn,payload_key) VALUES (?,?,?,?,?,?)")
      .run(requestId,conversationId,messageId,sessionId,fromTurn,payloadKey);
  }
  saveEdit(message: WebMessage): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.editRequest(message.id);
      if (!request || request.completed || request.conversation_id !== message.conversationId) throw new Error("Edit unavailable");
      const target = prepareSql(this.db, "SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=? AND conversation_id=?")
        .get(request.message_id, message.conversationId) as { seq: number } | undefined;
      if (!target) throw new Error("Edit point unavailable");
      prepareSql(this.db, `INSERT INTO web_rewound_messages SELECT id,conversation_id FROM web_messages
        WHERE deleted_at IS NULL AND conversation_id=? AND seq>=?`).run(message.conversationId,target.seq);
      prepareSql(this.db, `UPDATE web_messages SET deleted_at=?,deleted_by_edit=?
        WHERE deleted_at IS NULL AND conversation_id=? AND seq>=?`)
        .run(message.createdAt,message.id,message.conversationId,target.seq);
      const first = this.firstContentMessage(message.conversationId);
      prepareSql(this.db, "UPDATE conversations SET revision=revision+1,title=CASE WHEN ? THEN ? ELSE title END WHERE id=?")
        .run(first ? 0 : 1,message.text.slice(0,60) || "新的对话",message.conversationId);
      this.save(message);
      prepareSql(this.db, "UPDATE web_edits SET completed=1 WHERE request_id=?").run(message.id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    for (const [id] of this.liveMessages) if (this.rewoundMessage(id)) this.liveMessages.delete(id);
    this.emit("change");
  }
  branchOrigin(targetId: string): { conversationId: string; messageId: string } | undefined {
    const row = prepareSql(this.db, "SELECT source_id,message_id FROM web_branches WHERE target_id=?").get(targetId) as { source_id: string; message_id: string } | undefined;
    return row && { conversationId: this.publicId(row.source_id), messageId: row.message_id };
  }
  saveBranch(requestId: string, sourceId: string, messageId: string, targetId: string, sessionId: string,
    messages: WebMessage[], messageIds: Record<string, string>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const source = prepareSql(this.db, "SELECT title,model FROM conversations WHERE id=?").get(sourceId) as { title: string; model: string | null };
      this.conversation(targetId, `${source.title.slice(0,54)} · 分支`, Date.now(), sessionId);
      prepareSql(this.db, "UPDATE conversations SET model=? WHERE id=?").run(source.model,targetId);
      for (const message of messages) {
        // Consent and OAuth operations belong to their original conversation. Keep only passive output cards.
        const interactions = message.interactions?.filter(item => item.kind === "output");
        this.save({ ...message, id: messageIds[message.id]!, conversationId: targetId, action: undefined, interactions,
          replyTo: message.replyTo ? messageIds[message.replyTo] : undefined,
          text: message.text || (!interactions?.length ? message.interactions?.map(item => `历史操作：${item.title}`).join("\n") ?? "" : "") });
      }
      prepareSql(this.db, "INSERT INTO web_branches VALUES (?,?,?,?)").run(requestId,sourceId,messageId,targetId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.emit("change");
  }
  /** Retain a lazy complete view; ordinary SSE delivery never materializes it. */
  publishOperations(message: WebMessage, operations: readonly WebMessageOperation[], current: () => WebMessage): void {
    if (this.rewoundMessage(message.id)) { this.liveMessages.delete(message.id); return; }
    const seq = this.liveMessages.get(message.id)?.seq
      ?? (prepareSql(this.db, "SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=?").get(message.id) as { seq: number } | undefined)?.seq;
    if (seq === undefined) throw new Error("Activity must be opened before publishing operations");
    const baseRevision = this.liveMessages.get(message.id)?.revision ?? message.streamRevision;
    if (baseRevision === undefined || message.streamEpoch !== this.streamEpoch) throw new Error("Activity revision is unavailable");
    const revision = ++this.streamRevision;
    message.streamEpoch = this.streamEpoch; message.streamRevision = revision;
    this.liveMessages.set(message.id, { current, seq, revision });
    this.emit("message-operations", { id: message.id, conversationId: digest(message.conversationId), seq,
      streamEpoch: this.streamEpoch, baseRevision, streamRevision: revision, operations }, () => { const value = this.liveMessage(message.id); return value && { ...value, conversationId: digest(value.conversationId) }; });
  }
  publish(message: WebMessage): void {
    if (this.rewoundMessage(message.id)) { this.liveMessages.delete(message.id); return; }
    const seq = this.liveMessages.get(message.id)?.seq
      ?? (prepareSql(this.db, "SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=?").get(message.id) as { seq: number } | undefined)?.seq;
    if (seq === undefined) { this.save(message); return; }
    message.streamEpoch = this.streamEpoch; message.streamRevision = ++this.streamRevision;
    this.liveMessages.set(message.id, { current: () => message, seq, revision: message.streamRevision });
    this.emit("message", { ...message, seq, conversationId: digest(message.conversationId) });
  }
  save(message: WebMessage, publish = true): void {
    if (message.assets?.length) message.files = this.documentMetadata(message.assets);
    // Delayed OAuth or action results from a discarded turn cannot restore that turn.
    if (this.rewoundMessage(message.id)) { this.liveMessages.delete(message.id); return; }
    if (publish) { message.streamEpoch = this.streamEpoch; message.streamRevision = ++this.streamRevision; }
    const payload = JSON.stringify(message);
    const view = compactMessage(message);
    const viewPayload = view === message ? null : JSON.stringify(view);
    const draft = this.drafts.get(digest(message.conversationId));
    let changed = false;
    let seq: number;
    try {
      seq = sqliteTransaction(this.db, () => {
        this.conversation(message.conversationId, message.taskTitle ? this.backgroundPreview(message) : message.text || "新的对话", message.createdAt);
        prepareSql(this.db, `INSERT INTO web_messages(id,conversation_id,payload,restart_pending) VALUES (?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET conversation_id=excluded.conversation_id,payload=excluded.payload,restart_pending=excluded.restart_pending`)
          .run(message.id, message.conversationId, payload, message.interactions?.some(restartInteraction) ? 1 : 0);
        if (viewPayload !== null) prepareSql(this.db, "INSERT OR REPLACE INTO web_message_views(message_id,payload,version) VALUES (?,?,1)").run(message.id, viewPayload);
        prepareSql(this.db, "UPDATE conversations SET updated_at=MAX(updated_at,?) WHERE id=?").run(message.createdAt, message.conversationId);
        if (message.role === "user" && message.text) prepareSql(this.db, "UPDATE conversations SET title=? WHERE id=? AND title='新的对话'").run(message.text.slice(0,60), message.conversationId);
        if (message.role === "assistant" && message.taskTitle && message.text.trim() && this.firstContentMessage(message.conversationId)?.id === message.id) {
          const updated = prepareSql(this.db, "UPDATE conversations SET title=? WHERE id=? AND title IN ('主动任务','新的对话')")
            .run(this.backgroundPreview(message), message.conversationId);
          changed = Boolean(updated.changes);
        }
        const row = prepareSql(this.db, "SELECT seq FROM web_messages WHERE deleted_at IS NULL AND id=?").get(message.id) as { seq: number };
        return row.seq;
      }, "savepoint");
    } catch (error) {
      if (draft) this.drafts.set(digest(message.conversationId), draft);
      throw error;
    }
    this.liveMessages.delete(message.id);
    if (changed) this.emit("change");
    if (publish) this.emit("message", { ...message, seq, conversationId: digest(message.conversationId) });
  }
  addAsset(bytes: Buffer, mime: string, name?: string): string {
    const id = randomUUID();
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "INSERT INTO assets VALUES (?,?,?,?)").run(id, mime, bytes, Date.now());
      if (name && !mime.startsWith("image/")) prepareSql(this.db, "INSERT INTO asset_documents VALUES (?,?,?)")
        .run(id, name, createHash("sha256").update(bytes).digest("hex"));
    });
    return id;
  }
  documentMetadata(ids: string[]): Record<string, { name: string; mime: string; size: number; sha256: string }> {
    return Object.fromEntries(ids.flatMap(id => {
      const value = prepareSql(this.db, "SELECT d.name,d.sha256,a.mime,length(a.bytes) AS size FROM asset_documents d JOIN assets a ON a.id=d.asset_id WHERE a.id=?").get(id) as { name: string; mime: string; size: number; sha256: string } | undefined;
      return value ? [[id, value]] : [];
    }));
  }
  sharedDocuments(conversationId?: string, offset = 0, limit = 100) {
    const scoped = conversationId != null;
    return prepareSql(this.db, `WITH shared(id) AS (
      SELECT j.value FROM web_messages m JOIN conversations c ON c.id=m.conversation_id, json_each(json_extract(m.payload,'$.assets')) j
      WHERE m.deleted_at IS NULL AND c.deleted_at IS NULL AND json_extract(m.payload,'$.role')='user'
        ${scoped ? "AND m.conversation_id=?" : ""}
      UNION
      SELECT l.asset_id FROM asset_document_links l JOIN conversations c ON c.id=l.conversation_id
      WHERE c.deleted_at IS NULL ${scoped ? "AND l.conversation_id=?" : ""}
    ) SELECT a.id,d.name,d.sha256,a.mime,length(a.bytes) AS size FROM shared s
      JOIN assets a ON a.id=s.id JOIN asset_documents d ON d.asset_id=a.id
      WHERE a.mime NOT LIKE 'audio/%' AND NOT EXISTS (SELECT 1 FROM asset_document_moves moved WHERE moved.asset_id=a.id)
      ORDER BY a.created_at DESC,a.id LIMIT ? OFFSET ?`).all(...(scoped ? [conversationId, conversationId] : []), limit, offset) as unknown as Array<{ id: string; name: string; sha256: string; mime: string; size: number }>;
  }
  sharedDocumentMetadata(id: string) {
    const allowed = prepareSql(this.db, `SELECT 1 FROM asset_documents d WHERE d.asset_id=? AND (
      EXISTS (SELECT 1 FROM web_messages m JOIN conversations c ON c.id=m.conversation_id,json_each(json_extract(m.payload,'$.assets')) j WHERE j.value=d.asset_id AND m.deleted_at IS NULL AND c.deleted_at IS NULL AND json_extract(m.payload,'$.role')='user')
      OR EXISTS (SELECT 1 FROM asset_document_links l JOIN conversations c ON c.id=l.conversation_id WHERE l.asset_id=d.asset_id AND c.deleted_at IS NULL))`).get(id);
    if (!allowed) throw new Error("文档不存在或尚未发送。");
    const saved = prepareSql(this.db, "SELECT sha256 FROM asset_documents WHERE asset_id=?").get(id) as { sha256: string };
    const movedTo = prepareSql(this.db, "SELECT project,path,sha256 FROM asset_document_moves WHERE asset_id=?").get(id) as { project: string; path: string; sha256: string } | undefined;
    return { id, ...this.documentMetadata([id])[id]!, sha256: saved.sha256, ...(movedTo ? { movedTo } : {}) };
  }
  sharedDocument(id: string) {
    const metadata = this.sharedDocumentMetadata(id), asset = this.asset(id)!;
    if (createHash("sha256").update(asset.bytes).digest("hex") !== metadata.sha256) throw new Error("文档版本校验失败，请重新上传。");
    return { ...metadata, bytes: Buffer.from(asset.bytes) };
  }
  linkDocument(id: string, conversationId: string) {
    if (!this.conversationInfo(conversationId) || !this.documentMetadata([id])[id]) throw new Error("文档目标无效。");
    prepareSql(this.db, "INSERT OR IGNORE INTO asset_document_links VALUES (?,?)").run(id, conversationId);
  }
  asset(id: string): { mime: string; bytes: Uint8Array } | undefined {
    return prepareSql(this.db, "SELECT mime,bytes FROM assets WHERE id=?").get(id) as { mime: string; bytes: Uint8Array } | undefined;
  }
  assetMetadata(id: string): { mime: string; size: number } | undefined {
    return prepareSql(this.db, "SELECT mime,length(bytes) AS size FROM assets WHERE id=?").get(id) as { mime: string; size: number } | undefined;
  }
  assetBytes(id: string, start: number, length: number): Uint8Array | undefined {
    return (prepareSql(this.db, "SELECT substr(bytes,?,?) AS bytes FROM assets WHERE id=?").get(start + 1, length, id) as { bytes: Uint8Array } | undefined)?.bytes;
  }
  assetMime(id: string): string | undefined {
    return (prepareSql(this.db, "SELECT mime FROM assets WHERE id=?").get(id) as { mime: string } | undefined)?.mime;
  }
  hasAsset(id: string): boolean {
    return Boolean(prepareSql(this.db, "SELECT 1 FROM assets WHERE id=?").get(id));
  }
  close(): void {
    for (const id of this.liveMessages.keys()) { const message = this.liveMessage(id); if (message) this.save(message, false); }
    this.liveMessages.clear(); this.drafts.clear(); this.removeAllListeners(); closeSqlite(this.db);
  }
}
