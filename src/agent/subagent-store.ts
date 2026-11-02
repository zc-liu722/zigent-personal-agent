import { DatabaseSync, type StatementSync } from "node:sqlite";
import { closeSqlite, prepareSql } from "../sqlite.js";
import type { ToolExecutionContext } from "../tools/tool-contracts.js";
import type { AgentRunSnapshot, SubagentActivityItem } from "./transcript.js";

/** Private audit records in the existing Agent-owned database; never a new chat or delivery. */
export class SubagentStore {
  private readonly db: DatabaseSync;
  private readonly saveRun: StatementSync;
  constructor(path: string, agentId: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    const owner = prepareSql(this.db, "SELECT agent_id FROM agent_metadata WHERE singleton=1").get();
    if (owner?.agent_id !== agentId) { closeSqlite(this.db); throw new Error("Subagent database owner mismatch"); }
    this.db.exec(`CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT NOT NULL, generation INTEGER NOT NULL, team_id TEXT NOT NULL, user_id TEXT NOT NULL,
      session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, title TEXT NOT NULL, model TEXT NOT NULL,
      state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, record_json TEXT NOT NULL,
      PRIMARY KEY(id,generation));
      CREATE INDEX IF NOT EXISTS subagent_runs_session ON subagent_runs(session_id,turn_id);
      CREATE TRIGGER IF NOT EXISTS subagent_delete_session AFTER DELETE ON sessions BEGIN
        DELETE FROM subagent_runs WHERE session_id=old.session_id;
      END;
      DELETE FROM subagent_runs WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.session_id=subagent_runs.session_id);
      UPDATE subagent_runs SET state='interrupted' WHERE state='running';`);
    // Prepare against the real schema at startup, so an invalid write cannot pass service readiness.
    this.saveRun = prepareSql(this.db, `INSERT INTO subagent_runs
      (id,generation,team_id,user_id,session_id,turn_id,title,model,state,started_at,updated_at,record_json)
      SELECT $id,$generation,$team,$user,$session,$turn,$title,$model,$state,$started,$updated,$record
      WHERE EXISTS (SELECT 1 FROM sessions WHERE session_id=$session)
      ON CONFLICT(id,generation) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,record_json=excluded.record_json`);
  }
  save(scope: ToolExecutionContext, team: string, run: { id: string; generation: number; title: string; model: string; state: string; startedAt: number }, record: unknown): void {
    this.saveRun.run({
      $id: run.id, $generation: run.generation, $team: team, $user: scope.userId,
      $session: scope.sessionId, $turn: scope.turnId, $title: run.title, $model: run.model,
      $state: run.state, $started: run.startedAt, $updated: Date.now(), $record: JSON.stringify(record)
    });
  }
  /** Restore legacy child reports only through IDs already present in this owner's session message. */
  restoreActivity(snapshot: AgentRunSnapshot, userId: string, sessionId: string): AgentRunSnapshot {
    const restored = new Map<string, SubagentActivityItem>();
    for (const item of snapshot.items) {
      const match = item.type === "tool" && /^subagent:([^:]+):(\d+)$/.exec(item.id);
      if (!match) continue;
      const row = prepareSql(this.db, `SELECT title,model,state,started_at,updated_at,record_json FROM subagent_runs
        WHERE id=? AND generation=? AND user_id=? AND session_id=?`).get(match[1]!, Number(match[2]), userId, sessionId) as {
          title: string; model: string; state: string; started_at: number; updated_at: number; record_json: string;
        } | undefined;
      if (!row) continue;
      const record = JSON.parse(row.record_json) as { name?: string; profession?: string; task?: string; text?: string; error?: string };
      const status = row.state === "completed" ? "completed" : row.state === "failed" ? "failed" : "cancelled";
      const tools = snapshot.items.filter(child => child.type === "tool" && child.id.startsWith(`${item.id}:`))
        .map(child => child.type === "tool" ? { ...child, presentation: { ...child.presentation,
          title: child.presentation.title?.replace(`${row.title} · `, "") } } : child);
      restored.set(item.id, { id: item.id, type: "subagent", agentId: match[1]!, generation: Number(match[2]),
        title: row.title, name: record.name ?? row.title, profession: record.profession ?? "",
        model: row.model, task: record.task ?? "", startedAt: row.started_at, status,
        durationMs: item.durationMs ?? Math.max(0, row.updated_at - row.started_at),
        snapshot: { status, items: tools, answerDraft: record.text ?? "", failureMessage: record.error } });
    }
    if (!restored.size) return snapshot;
    return { ...snapshot, items: snapshot.items.flatMap(item => {
      const child = restored.get(item.id);
      if (child) return [child];
      if (item.type === "tool" && [...restored.keys()].some(id => item.id.startsWith(`${id}:`))) return [];
      return [item];
    }) };
  }
  close(): void { closeSqlite(this.db); }
}
