import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

/** Counts/hashes only. Never returns content, tool parameters, IDs, tokens or file names. */
export function conversationInventory(history: DatabaseSync, web?: DatabaseSync, journal?: DatabaseSync) {
  const exists = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const bytes = (db: DatabaseSync, table: string, expression: string) => db.prepare(
    `SELECT count(*) AS records,COALESCE(sum(${expression}),0) AS bytes FROM ${table}`).get();
  const legacy = {
    history: bytes(history, "messages", "length(CAST(content AS BLOB))+COALESCE(length(CAST(tool_trace_json AS BLOB)),0)+COALESCE(length(CAST(activity_trace_json AS BLOB)),0)"),
    web: web ? bytes(web, "web_messages", "length(CAST(payload AS BLOB))") : null,
    runs: journal && exists(journal,"execution_runs") ? bytes(journal,"execution_runs","length(CAST(payload AS BLOB))") : null,
    tools: journal && exists(journal,"execution_tools") ? bytes(journal,"execution_tools","length(CAST(payload AS BLOB))") : null,
    startedTools: journal && exists(journal,"execution_tools") ? journal.prepare("SELECT count(*) AS records FROM execution_tools WHERE json_extract(payload,'$.state')='started'").get() : null,
    completedCheckpoints: journal && exists(journal,"execution_runs") ? journal.prepare(`SELECT count(*) AS records,
      COALESCE(sum(length(CAST(payload->'$.checkpoint' AS BLOB))),0) AS bytes FROM execution_runs
      WHERE json_valid(payload) AND json_extract(payload,'$.stage')='completed' AND json_type(payload,'$.checkpoint') IS NOT NULL`).get() : null
  };
  // Exact byte equality of strings >=128 characters inside the named conversation fields.
  // This is a scoped logical-content measure, not SQLite allocated pages or a savings estimate.
  const seen = new Map<string, {bytes:number;count:number}>();
  const visit = (value: unknown): void => {
    if (typeof value === "string" && value.length >= 128) {
      const hash = createHash("sha256").update(value).digest("hex"), entry = seen.get(hash);
      if (entry) entry.count++; else seen.set(hash,{bytes:Buffer.byteLength(value),count:1});
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  const inspect = (value: unknown, json = false) => { if (json && typeof value === "string") { try { visit(JSON.parse(value)); } catch { /* corrupt legacy JSON is counted in physical bytes only */ } } else visit(value); };
  for (const row of history.prepare("SELECT content,tool_trace_json,activity_trace_json FROM messages").iterate()) {
    inspect(row.content); inspect(row.tool_trace_json,true); inspect(row.activity_trace_json,true);
  }
  if (web) for (const row of web.prepare("SELECT payload FROM web_messages WHERE json_valid(payload) AND json_type(payload,'$._conversation') IS NULL").iterate()) inspect(row.payload,true);
  if (journal) for (const table of ["execution_runs","execution_tools"]) if (exists(journal,table)) {
    for (const row of journal.prepare(`SELECT payload FROM ${table}`).iterate()) inspect(row.payload,true);
  }
  const duplicates = [...seen.values()].reduce((result,entry) => ({
    uniqueBytes:result.uniqueBytes+entry.bytes,occurrences:result.occurrences+entry.count,
    duplicateBytes:result.duplicateBytes+entry.bytes*(entry.count-1)
  }), {uniqueBytes:0,occurrences:0,duplicateBytes:0});
  const projection = {legacyInline:0,staleReferences:0,missingObjects:0};
  if (web && exists(history,"conversation_objects")) for (const row of web.prepare("SELECT id,payload FROM web_messages").iterate()) {
    const stub = JSON.parse(String(row.payload));
    if (!stub._conversation) { projection.legacyInline++; continue; }
    const root = history.prepare("SELECT hash FROM conversation_roots WHERE owner=? AND slot='payload'").get(`web:${row.id}`);
    if (root?.hash !== stub._conversation.hash) projection.staleReferences++;
    if (!history.prepare("SELECT 1 FROM conversation_objects WHERE hash=?").get(stub._conversation.hash)) projection.missingObjects++;
  }
  const canonical = exists(history,"conversation_objects") ? {
    migration: history.prepare("SELECT state,updated_at,error_code FROM conversation_migration_state WHERE singleton=1").get(),
    pendingHistory: history.prepare("SELECT count(*) AS records FROM messages m WHERE NOT EXISTS(SELECT 1 FROM conversation_roots r WHERE r.owner='history:'||m.id AND r.slot='content')").get(),
    objects: bytes(history,"conversation_objects","bytes"),
    projection,
    tombstones: history.prepare("SELECT count(*) AS records FROM conversation_visibility").get(),
    roots: history.prepare("SELECT count(*) AS records FROM conversation_roots").get(),
    unreachable: history.prepare(`WITH RECURSIVE live(hash) AS (
      SELECT hash FROM conversation_roots UNION SELECT hash FROM conversation_outbox WHERE delivered_at IS NULL
      UNION SELECT e.child FROM conversation_object_edges e JOIN live ON e.parent=live.hash)
      SELECT count(*) AS records,COALESCE(sum(bytes),0) AS bytes FROM conversation_objects WHERE hash NOT IN (SELECT hash FROM live)`).get(),
    brokenRoots: history.prepare("SELECT count(*) AS records FROM conversation_roots r LEFT JOIN conversation_objects o ON o.hash=r.hash WHERE o.hash IS NULL").get(),
    brokenEdges: history.prepare("SELECT count(*) AS records FROM conversation_object_edges e LEFT JOIN conversation_objects o ON o.hash=e.child WHERE o.hash IS NULL").get(),
    runs: history.prepare("SELECT generation_status,delivery_status,context_status,count(*) AS records FROM conversation_runs GROUP BY 1,2,3").all(),
    uncertainTools: history.prepare("SELECT count(*) AS records FROM conversation_tool_operations WHERE state='started' OR outcome='uncertain'").get(),
    pendingOutbox: history.prepare("SELECT count(*) AS records FROM conversation_outbox WHERE delivered_at IS NULL").get(),
    baselines: history.prepare("SELECT source,metadata,created_at FROM conversation_storage_baselines ORDER BY source").all(),
    identityConflicts: history.prepare("SELECT status,count(*) AS records FROM conversation_identity GROUP BY status").all()
  } : null;
  return { legacy, canonical, exactRepeatedStrings: duplicates,
    scope: "Persisted physical legacy fields; exact repeated UTF-8 strings of at least 128 characters. Immutable objects counted separately. No body exported. Separate SQLite read snapshots; not a monetary or disk savings estimate." };
}
