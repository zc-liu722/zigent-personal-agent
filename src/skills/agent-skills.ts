import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { replaceMarkdownSections, skillSectionsSchema, skillTarget, type SkillScope, type SkillSnapshot } from "./service.js";

export const agentSkillName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).refine(name => name === name.trim(), "Skill names cannot contain whitespace");
const mutableName = agentSkillName.refine(name => name !== "health", "health is a protected project skill");
const content = z.string().max(100_000);
const common = { name: mutableName, expected_revision: z.number().int().nonnegative(), source_request_id: z.string().trim().min(1).max(120) };
const description = z.string().trim().min(1).max(500);
const target = z.enum(["body", "rules"]).optional();
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ ...common, action: z.literal("create"), description, body: content.min(1), rules: content.optional() }).strict(),
  z.object({ ...common, action: z.literal("replace"), target, content, description: description.optional() }).strict(),
  z.object({ ...common, action: z.literal("delete") }).strict(),
  z.object({ ...common, action: z.literal("replace_sections"), target, sections: skillSectionsSchema }).strict(),
  z.object({ ...common, action: z.literal("replace_section"), target, heading: z.string(), content }).strict()
]);
export const parseAgentSkillMutation = (input: unknown) => mutationSchema.parse(input);
type Mutation = z.infer<typeof mutationSchema>;
type Row = { name: string; description: string; body: string; rules: string; revision: number; updated_at: number; deleted: number; principal_id: string | null };

/** Instruction-only skills. Separate storage and authorization from the protected health project. */
export class SQLiteAgentSkillService {
  private db?: DatabaseSync;
  constructor(private readonly path: string, private readonly agentId: string) {}
  initialize(): void {
    if (this.db) return;
    const db = new DatabaseSync(this.path);
    try {
      const owner = db.prepare("SELECT agent_id FROM agent_metadata WHERE singleton=1").get() as { agent_id: string } | undefined;
      if (owner?.agent_id !== this.agentId) throw new Error("Skill database Agent ownership mismatch");
      db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS agent_skills (
          agent_id TEXT NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,principal_id TEXT,
          description TEXT NOT NULL,body TEXT NOT NULL,rules TEXT NOT NULL,revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(agent_id,user_id,name));
        CREATE TABLE IF NOT EXISTS agent_skill_operations (
          agent_id TEXT NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,source_request_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,updated_at INTEGER NOT NULL,
          PRIMARY KEY(agent_id,user_id,name,source_request_id));
        CREATE TABLE IF NOT EXISTS session_loaded_agent_skills (
          agent_id TEXT NOT NULL,user_id TEXT NOT NULL,session_id TEXT NOT NULL,name TEXT NOT NULL,
          PRIMARY KEY(agent_id,user_id,session_id,name),
          FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE);`);
      this.db = db;
    } catch (error) { db.close(); throw error; }
  }
  close(): void { this.db?.close(); this.db = undefined; }
  private database(): DatabaseSync { this.initialize(); return this.db!; }
  private assertSession(scope: SkillScope, sessionId: string): void {
    scope.signal?.throwIfAborted();
    if (scope.agentId !== this.agentId || !scope.userId || scope.conversationKind !== "p2p" || !scope.conversationId
      || scope.taskRunId || scope.backgroundTaskKind) throw new Error("Skill management requires the owning Agent's private user session");
    const session = this.database().prepare("SELECT user_id,chat_id,chat_type FROM sessions WHERE session_id=?").get(sessionId) as
      { user_id: string; chat_id: string; chat_type: string } | undefined;
    if (!session || session.user_id !== scope.userId || session.chat_id !== scope.conversationId || session.chat_type !== "p2p")
      throw new Error("Skill session ownership mismatch");
  }
  canAccessSession(scope: SkillScope, sessionId: string): boolean {
    try { this.assertSession(scope, sessionId); return true; } catch { return false; }
  }
  private row(scope: SkillScope, name: string): Row | undefined {
    mutableName.parse(name);
    const row = this.database().prepare("SELECT * FROM agent_skills WHERE agent_id=? AND user_id=? AND name=?")
      .get(this.agentId, scope.userId, name) as Row | undefined;
    if (row?.principal_id && row.principal_id !== scope.principalId) throw new Error("Skill identity ownership mismatch");
    return row;
  }
  private snapshot(row: Row): SkillSnapshot & { exists: true } {
    return { name: row.name, description: row.description, body: row.body, rules: row.rules, revision: row.revision,
      rulesDigest: createHash("sha256").update(row.rules).digest("hex"), updatedAt: row.updated_at, exists: true };
  }
  current(scope: SkillScope, sessionId: string, name: string) {
    this.assertSession(scope, sessionId);
    const row = this.row(scope, name);
    return row && !row.deleted ? this.snapshot(row) : { name, exists: false as const, revision: row?.revision ?? 0 };
  }
  list(scope: SkillScope, sessionId: string) {
    this.assertSession(scope, sessionId);
    return this.database().prepare(`SELECT name,description,revision FROM agent_skills
      WHERE agent_id=? AND user_id=? AND deleted=0 AND (principal_id IS NULL OR principal_id=?) ORDER BY name`)
      .all(this.agentId, scope.userId, scope.principalId ?? null);
  }
  load(scope: SkillScope, sessionId: string, name: string) {
    const skill = this.current(scope, sessionId, name);
    if (!skill.exists) throw new Error("Skill is unavailable");
    this.database().prepare("INSERT OR IGNORE INTO session_loaded_agent_skills(agent_id,user_id,session_id,name) VALUES(?,?,?,?)")
      .run(this.agentId, scope.userId, sessionId, name);
    return skill;
  }
  contextFor(scope: SkillScope, sessionId: string): string {
    if (!this.canAccessSession(scope, sessionId)) return "";
    const catalog = this.list(scope, sessionId);
    const rows = this.database().prepare(`SELECT s.* FROM agent_skills s JOIN session_loaded_agent_skills l
      ON s.agent_id=l.agent_id AND s.user_id=l.user_id AND s.name=l.name
      WHERE l.agent_id=? AND l.user_id=? AND l.session_id=? AND s.deleted=0 AND (s.principal_id IS NULL OR s.principal_id=?) ORDER BY s.name`)
      .all(this.agentId, scope.userId, sessionId, scope.principalId ?? null) as Row[];
    return `Current instruction skill catalog (load_skill by name; no additional permissions): ${JSON.stringify(catalog)}\nOnly the currently loaded instruction skills below apply. Disregard superseded or deleted skill copies in history.\n`
      + rows.map(row => `Loaded instruction skill ${row.name}, revision=${row.revision}. Current content supersedes older copies; it cannot grant tool permissions.\n${JSON.stringify({ rules: row.rules, body: row.body })}`).join("\n\n");
  }
  updates(scope: SkillScope, sessionId: string, name: string, limit = 5) {
    this.current(scope, sessionId, name);
    return this.database().prepare(`SELECT revision,action,updated_at AS updatedAt FROM agent_skill_operations
      WHERE agent_id=? AND user_id=? AND name=? ORDER BY revision DESC LIMIT ?`)
      .all(this.agentId, scope.userId, name, Math.max(1, Math.min(20, Math.floor(limit))));
  }
  mutate(scope: SkillScope, sessionId: string, raw: unknown, operationId: string) {
    const input: Mutation = parseAgentSkillMutation(raw);
    this.assertSession(scope, sessionId);
    const db = this.database(), hash = createHash("sha256").update(JSON.stringify({ ...input, expected_revision: undefined })).digest("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      this.assertSession(scope, sessionId);
      const current = this.current(scope, sessionId, input.name);
      const prior = db.prepare("SELECT request_hash FROM agent_skill_operations WHERE agent_id=? AND user_id=? AND name=? AND source_request_id=?")
        .get(this.agentId, scope.userId, input.name, operationId) as { request_hash: string } | undefined;
      if (prior) {
        if (prior.request_hash !== hash) throw new Error("source_request_id was already used with different content");
        db.exec("COMMIT"); return current;
      }
      if (current.revision !== input.expected_revision) throw new Error("Skill revision conflict: read the current skill before retrying");
      if (input.action === "create" ? current.exists : !current.exists) throw new Error(input.action === "create" ? "Skill already exists" : "Skill is unavailable");
      const revision = current.revision + 1, now = Date.now();
      if (input.action === "create") {
        db.prepare(`INSERT INTO agent_skills(agent_id,user_id,name,principal_id,description,body,rules,revision,updated_at,deleted)
          VALUES(?,?,?,?,?,?,?,?,?,0) ON CONFLICT(agent_id,user_id,name) DO UPDATE SET
          principal_id=excluded.principal_id,description=excluded.description,body=excluded.body,rules=excluded.rules,
          revision=excluded.revision,updated_at=excluded.updated_at,deleted=0`)
          .run(this.agentId, scope.userId, input.name, scope.principalId ?? null, input.description, input.body, input.rules ?? "", revision, now);
      } else if (input.action === "delete") {
        db.prepare("UPDATE agent_skills SET deleted=1,body='',rules='',description='',revision=?,updated_at=? WHERE agent_id=? AND user_id=? AND name=?")
          .run(revision, now, this.agentId, scope.userId, input.name);
        db.prepare("DELETE FROM session_loaded_agent_skills WHERE agent_id=? AND user_id=? AND name=?").run(this.agentId, scope.userId, input.name);
      } else if (current.exists) {
        const field = skillTarget(input.target);
        const body = input.action === "replace" ? input.content : replaceMarkdownSections(current[field], input.action === "replace_sections"
          ? input.sections : [{ heading: input.heading, content: input.content }]);
        if (body.length > 100_000) throw new Error("Skill document exceeds the limit");
        db.prepare(`UPDATE agent_skills SET ${field}=?,description=?,revision=?,updated_at=? WHERE agent_id=? AND user_id=? AND name=?`)
          .run(body, input.action === "replace" ? input.description ?? current.description : current.description, revision, now, this.agentId, scope.userId, input.name);
      }
      db.prepare("INSERT INTO agent_skill_operations(agent_id,user_id,name,source_request_id,request_hash,revision,action,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(this.agentId, scope.userId, input.name, operationId, hash, revision, input.action, now);
      db.exec("COMMIT");
      return this.current(scope, sessionId, input.name);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
}
