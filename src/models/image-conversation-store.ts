import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentConfig } from "../config.js";
import type { ImageConversationRequest } from "../image-generation.js";
import type { TokenUsage } from "../memory/types.js";
import { closeSqlite, prepareSql } from "../sqlite.js";

export type OfficialImageConversation = { threadId: string; throughTurn: number; historyHash: string; totalUsage?: TokenUsage };
const queues = new Map<string, Promise<void>>();

/** Revision identity only: no prompt rewriting, intent classification, or reference selection. */
export function imageHistoryHash(request: ImageConversationRequest, throughTurn: number): string {
  return createHash("sha256").update(JSON.stringify(request.messages.filter(message => message.turnId < throughTurn
    || message.turnId === throughTurn && message.role === "user")
    .map(message => [message.id, message.turnId, message.role, message.text, message.imageIds]))).digest("hex");
}

/** Agent-owned mutable state; survives service releases and never goes through Git. */
export async function withImageConversation<T>(config: AgentConfig, request: ImageConversationRequest,
  operation: (previous: OfficialImageConversation | undefined, save: (state: OfficialImageConversation) => void) => Promise<T>): Promise<T> {
  const route = config.imageGeneration!, driver = route.driver!;
  // A driver switch is a per-turn model override of the same official thread.
  // Keep the supplier/image route isolated, but serialize across text drivers.
  const identity = [request.sessionId, route.modelName ?? route.model, route.supplier!];
  const key = JSON.stringify([config.memoryStoragePath, ...identity]);
  const previousLock = queues.get(key);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // Keep the predecessor in the queue even if this waiter is cancelled. Later
  // requests must never overtake a still-running supplier turn.
  const lock = Promise.resolve(previousLock).then(() => held);
  queues.set(key, lock);
  void lock.then(() => { if (queues.get(key) === lock) queues.delete(key); });
  let db: DatabaseSync | undefined;
  let abortWait: (() => void) | undefined;
  try {
    if (request.signal) {
      request.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        abortWait = () => reject(request.signal!.reason);
        request.signal!.addEventListener("abort", abortWait, { once: true });
      });
      try { await Promise.race([previousLock, cancelled]); }
      finally { request.signal.removeEventListener("abort", abortWait!); }
    } else await previousLock;
    request.signal?.throwIfAborted();
    db = new DatabaseSync(config.memoryStoragePath);
    db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
    const owner = prepareSql(db, "SELECT agent_id FROM agent_metadata WHERE singleton=1").get();
    const session = prepareSql(db, "SELECT user_id FROM sessions WHERE session_id=?").get(request.sessionId);
    if (owner?.agent_id !== config.id || session?.user_id !== request.userId) throw new Error("Image conversation owner mismatch");
    db.exec(`CREATE TABLE IF NOT EXISTS official_image_conversations (
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      model TEXT NOT NULL, supplier TEXT NOT NULL, driver TEXT NOT NULL, owner_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, through_turn INTEGER NOT NULL, history_hash TEXT NOT NULL, total_usage_json TEXT,
      PRIMARY KEY(session_id,model,supplier,driver))`);
    const remove = () => prepareSql(db!, "DELETE FROM official_image_conversations WHERE session_id=? AND model=? AND supplier=?").run(...identity);
    const row = prepareSql(db, `SELECT * FROM official_image_conversations WHERE session_id=? AND model=? AND supplier=?
      ORDER BY through_turn DESC LIMIT 1`).get(...identity);
    let previous: OfficialImageConversation | undefined;
    if (row && row.owner_id === request.userId && row.history_hash === imageHistoryHash(request, Number(row.through_turn))) {
      previous = { threadId: String(row.thread_id), throughTurn: Number(row.through_turn), historyHash: String(row.history_hash),
        ...(row.total_usage_json ? { totalUsage: JSON.parse(String(row.total_usage_json)) as TokenUsage } : {}) };
      if (request.turnId <= previous.throughTurn) throw new Error("这轮图片请求已处理，请发送下一条修改意见。");
    } else if (row) remove();
    try {
      return await operation(previous, state => {
        // Collapse legacy per-driver pointers into one current thread pointer.
        db!.exec("BEGIN IMMEDIATE");
        try {
          remove();
          prepareSql(db!, `INSERT INTO official_image_conversations
            (session_id,model,supplier,driver,owner_id,thread_id,through_turn,history_hash,total_usage_json) VALUES (?,?,?,?,?,?,?,?,?)`)
            .run(...identity, driver.name, request.userId, state.threadId, state.throughTurn, state.historyHash,
              state.totalUsage ? JSON.stringify(state.totalUsage) : null);
          db!.exec("COMMIT");
        } catch (error) { db!.exec("ROLLBACK"); throw error; }
      });
    } catch (error) {
      // A failed/aborted supplier turn may have changed its history. Never silently
      // reuse that uncertain state; a subsequent user request bootstraps raw history.
      remove();
      throw error;
    }
  } finally {
    if (db) closeSqlite(db);
    release();
  }
}
