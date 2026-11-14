import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { installConversationReader } from "./reader.js";

const encode = (value: unknown): string => JSON.stringify(value, function(key,value) {
  const bytes = this[key] instanceof Uint8Array ? this[key] : value;
  return bytes instanceof Uint8Array ? {_zigentBytes:Buffer.from(bytes).toString("base64")} : value;
});

/** Offline release/rollback only, after workloads stop. Includes data created after cutover.
 * Each source is committed before the legacy-mode receipt; interruption leaves safe duplicates.
 */
export async function hydrateLegacyConversations(manifestPath: string, targetRelease: string): Promise<void> {
  const targetReader = join(targetRelease,"dist","conversation","reader.js");
  if (existsSync(targetReader) && /CONVERSATION_STORAGE_FORMAT\s*=\s*1\b/.test(readFileSync(targetReader,"utf8"))) return;
  const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
  for (const agent of manifest.agents ?? []) {
    const path = agent.storage?.sqlite;
    if (typeof path !== "string" || !existsSync(path)) continue;
    const db = new DatabaseSync(path);
    let web: DatabaseSync | undefined, journal: DatabaseSync | undefined;
    try {
      db.exec("PRAGMA busy_timeout=5000");
      if (prepareSql(db,"SELECT agent_id FROM agent_metadata WHERE singleton=1").get()?.agent_id !== agent.id) throw new Error("CONVERSATION_AGENT_MISMATCH");
      const reader = installConversationReader(db); if (!reader) continue;
      if (prepareSql(db,"SELECT mode FROM conversation_control WHERE singleton=1").get()?.mode === "legacy") continue;
      if (agent.web?.storage && existsSync(agent.web.storage)) {
        web = new DatabaseSync(agent.web.storage); web.exec("PRAGMA busy_timeout=5000");
        sqliteTransaction(web, () => {
          // Pending deliveries may not have reached the projection before the rollback.
          for (const event of prepareSql(db,"SELECT channel,message_id,hash FROM conversation_outbox WHERE delivered_at IS NULL ORDER BY seq").all()) {
            if (event.channel === "web-delete") {
              const state = reader.objects.get(String(event.hash)) as {conversationId:string;deletedAt:number};
              web!.prepare("UPDATE conversations SET deleted_at=COALESCE(deleted_at,?) WHERE id=?").run(state.deletedAt,state.conversationId);
              continue;
            }
            const message = reader.objects.get(String(event.hash)) as {id:string;conversationId:string;text:string;createdAt:number};
            const row = web!.prepare("SELECT deleted_at FROM conversations WHERE id=?").get(message.conversationId);
            if (row?.deleted_at != null || web!.prepare("SELECT 1 FROM web_rewound_messages WHERE id=?").get(message.id)) continue;
            web!.prepare(`INSERT OR IGNORE INTO conversations(id,title,updated_at,public_id,chat_id) VALUES(?,?,?,?,?)`)
              .run(message.conversationId,message.text.slice(0,60)||"新的对话",message.createdAt,
                createHash("sha256").update(message.conversationId).digest("hex"),message.conversationId);
            web!.prepare(`INSERT INTO web_messages(id,conversation_id,payload) VALUES(?,?,?)
              ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE web_messages.deleted_at IS NULL`)
              .run(message.id,message.conversationId,JSON.stringify(message));
          }
          for (const row of web!.prepare("SELECT id,payload FROM web_messages WHERE json_type(payload,'$._conversation') IS NOT NULL").all()) {
            const stub = JSON.parse(String(row.payload));
            web!.prepare("UPDATE web_messages SET payload=? WHERE id=?").run(JSON.stringify(reader.objects.get(stub._conversation.hash)),row.id);
          }
          web!.exec("DELETE FROM web_message_views");
        });
      }
      journal = new DatabaseSync(path+".execution.sqlite");
      journal.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS execution_runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS execution_tools(run_id TEXT NOT NULL,call_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,call_id));`);
      sqliteTransaction(journal, () => {
        for (const run of prepareSql(db,"SELECT * FROM conversation_runs WHERE routing_active=1").all()) {
          const id = String(run.id);
          journal!.prepare("INSERT INTO execution_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id,encode({
            id,sessionId:run.session_id,turnId:run.turn_id,replyId:run.reply_id ?? undefined,versions:JSON.parse(String(run.versions)),
            stage:run.stage === "failed" ? "running" : run.stage,updatedAt:run.updated_at,
            checkpoint:reader.objects.read(`run:${id}`,"checkpoint"),reply:reader.objects.read(`run:${id}`,"reply")
          }));
          for (const tool of prepareSql(db,"SELECT * FROM conversation_tool_operations WHERE run_id=?").all(id)) {
            journal!.prepare("INSERT INTO execution_tools VALUES(?,?,?) ON CONFLICT(run_id,call_id) DO UPDATE SET payload=excluded.payload").run(id,tool.call_id,encode({
              call:reader.objects.get(String(tool.call_hash)),state:tool.state,operationId:tool.operation_id,
              result:tool.result_hash ? reader.objects.get(String(tool.result_hash)) : undefined
            }));
          }
        }
      });
      sqliteTransaction(db, () => {
        for (const row of prepareSql(db,"SELECT id,content,tool_trace_json,activity_trace_json FROM conversation_messages").all()) {
          prepareSql(db,"UPDATE messages SET content=?,tool_trace_json=?,activity_trace_json=? WHERE id=?")
            .run(row.content,row.tool_trace_json,row.activity_trace_json,row.id);
        }
        prepareSql(db,"UPDATE conversation_control SET mode='legacy' WHERE singleton=1").run();
      });
      console.info(`CONVERSATION_LEGACY_HYDRATED agent=${agent.id} format=1`);
    } finally { if (web) closeSqlite(web); if (journal) closeSqlite(journal); closeSqlite(db); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [operation,manifest,target] = process.argv.slice(2);
    if (operation !== "hydrate-legacy" || !manifest || !target) throw new Error("CONVERSATION_MAINTENANCE_ARGUMENTS");
    await hydrateLegacyConversations(manifest,target);
  } catch { console.error("CONVERSATION_LEGACY_HYDRATION_FAILED"); process.exitCode=1; }
}
