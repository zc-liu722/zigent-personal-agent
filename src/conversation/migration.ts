import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { ConversationStore } from "./store.js";

/** Per-message transactions preserve IDs/FKs/deletion markers; only verified body copies are removed. */
export function migrateHistoryBatch(store: ConversationStore, limit = 8): number {
  const rows = prepareSql(store.db, `SELECT id,content,tool_trace_json,activity_trace_json FROM messages
    WHERE NOT EXISTS(SELECT 1 FROM conversation_roots r WHERE r.owner='history:'||messages.id AND r.slot='content')
    ORDER BY rowid LIMIT ?`).all(limit) as {id:string;content:string;tool_trace_json:string|null;activity_trace_json:string|null}[];
  for (const row of rows) sqliteTransaction(store.db, () => {
    const tool = row.tool_trace_json == null ? undefined : JSON.parse(row.tool_trace_json);
    const activity = row.activity_trace_json == null ? undefined : JSON.parse(row.activity_trace_json);
    store.history(row.id, row.content, tool, activity);
    const read = store.objects;
    if (read.read(`history:${row.id}`,"content") !== row.content
      || row.tool_trace_json != null && JSON.stringify(read.read(`history:${row.id}`,"tool_trace_json")) !== JSON.stringify(tool)
      || row.activity_trace_json != null && JSON.stringify(read.read(`history:${row.id}`,"activity_trace_json")) !== JSON.stringify(activity)) {
      throw new Error("CONVERSATION_BACKFILL_HASH_MISMATCH");
    }
    prepareSql(store.db, "UPDATE messages SET content='',tool_trace_json=NULL,activity_trace_json=NULL WHERE id=?").run(row.id);
  });
  return rows.length;
}

/** Reachability, never age alone. Tool operations, final results and pending outbox remain rooted. */
export function reclaimConversationObjects(store: ConversationStore, limit = 256): number {
  return sqliteTransaction(store.db, () => {
    const hashes = prepareSql(store.db, `WITH RECURSIVE live(hash) AS (
      SELECT hash FROM conversation_roots UNION SELECT hash FROM conversation_outbox WHERE delivered_at IS NULL
      UNION SELECT hash FROM conversation_message_parts
      UNION SELECT call_hash FROM conversation_tool_operations UNION SELECT result_hash FROM conversation_tool_operations WHERE result_hash IS NOT NULL
      UNION SELECT e.child FROM conversation_object_edges e JOIN live ON live.hash=e.parent)
      SELECT hash FROM conversation_objects WHERE hash NOT IN (SELECT hash FROM live) LIMIT ?`).all(limit) as {hash:string}[];
    for (const {hash} of hashes) {
      prepareSql(store.db,"DELETE FROM conversation_object_edges WHERE parent=? OR child=?").run(hash,hash);
      prepareSql(store.db,"DELETE FROM conversation_objects WHERE hash=?").run(hash);
    }
    return hashes.length;
  });
}
