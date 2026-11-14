import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SkillCatalog } from "./catalog.js";
import { replaceMarkdownSections, skillTarget, type SkillScope, type SkillSnapshot } from "./service.js";
import { agentSkillName, parseAgentSkillMutation, skillMutationDigest, type SkillMutation } from "./mutations.js";
export { agentSkillName, parseAgentSkillMutation } from "./mutations.js";
const mutableName = agentSkillName.refine(name => name !== "health", "This name requires the configured health data owner");
type Row = { name: string; description: string; body: string; rules: string; revision: number; updated_at: number; deleted: number; principal_id: string | null };

/** Persistent skills; their origin does not change their maintenance contract. */
export class SQLiteAgentSkillService {
  private db?: DatabaseSync;
  private packaged?: () => SkillCatalog;
  connectCatalog(source: () => SkillCatalog): void { this.packaged = source; }
  catalog(scope: SkillScope): SkillCatalog | undefined { return scope.skillCatalog ?? this.packaged?.(); }
  constructor(private readonly path: string, private readonly agentId: string,
    private readonly verifyTaskRun?: (scope: SkillScope) => boolean) {}
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
  /** Import installation defaults once. Existing edits and deletion tombstones always win. */
  seedSkills(owner: { userId: string; principalId?: string }, seeds: Array<{ name: string; description: string; body: string; rules?: string }>): void {
    if (!owner.userId) throw new Error("Skill ownership must be configured");
    const inputs = seeds.map(seed => parseAgentSkillMutation({ ...seed, action: "create", expected_revision: 0, source_request_id: "initial-seed" }));
    for (const input of inputs) mutableName.parse(input.name);
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const legacy = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_loaded_project_skills'").get());
      for (const input of inputs) {
        if (input.action !== "create") continue;
        const now = Date.now();
        const inserted = db.prepare(`INSERT OR IGNORE INTO agent_skills(agent_id,user_id,name,principal_id,description,body,rules,revision,updated_at,deleted)
          VALUES(?,?,?,?,?,?,?,1,?,0)`).run(this.agentId, owner.userId, input.name, owner.principalId ?? null, input.description, input.body, input.rules ?? "", now);
        if (inserted.changes) db.prepare(`INSERT INTO agent_skill_operations(agent_id,user_id,name,source_request_id,request_hash,revision,action,updated_at)
          VALUES(?,?,?,?,?,1,'create',?)`).run(this.agentId, owner.userId, input.name, "initial-seed", "", now);
        if (legacy) db.prepare(`INSERT OR IGNORE INTO session_loaded_agent_skills(agent_id,user_id,session_id,name)
          SELECT l.agent_id,l.user_id,l.session_id,l.name FROM session_loaded_project_skills l
          JOIN agent_skills s ON s.agent_id=l.agent_id AND s.user_id=l.user_id AND s.name=l.name
          JOIN sessions c ON c.session_id=l.session_id AND c.user_id=l.user_id AND c.chat_type='p2p'
          WHERE l.agent_id=? AND l.user_id=? AND l.name=? AND s.deleted=0 AND (s.principal_id IS NULL OR s.principal_id=?)`)
          .run(this.agentId, owner.userId, input.name, owner.principalId ?? null);
      }
      if (legacy) db.exec("DROP TABLE session_loaded_project_skills");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  /** Release-owned exact text migration: never replace a whole edited skill or revive deletion. */
  migrateText(owner: { userId: string; principalId?: string }, name: string, migration: string, before: string, after: string): void {
    mutableName.parse(name);
    if (!owner.userId || !before || !migration) throw new Error("Skill migration requires an owner and exact source text");
    const db = this.database(), source = `migration:${migration}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db.prepare("SELECT * FROM agent_skills WHERE agent_id=? AND user_id=? AND name=?").get(this.agentId, owner.userId, name) as Row | undefined;
      const applied = db.prepare("SELECT 1 FROM agent_skill_operations WHERE agent_id=? AND user_id=? AND name=? AND source_request_id=?").get(this.agentId, owner.userId, name, source);
      if (!applied && row && !row.deleted && (!row.principal_id || row.principal_id === owner.principalId)
        && row.body.split(before).length === 2) {
        const body = row.body.replace(before, after), revision = row.revision + 1, now = Date.now();
        if (body.length > 100_000) throw new Error("Skill migration exceeds the content limit");
        db.prepare("UPDATE agent_skills SET body=?,revision=?,updated_at=? WHERE agent_id=? AND user_id=? AND name=?")
          .run(body, revision, now, this.agentId, owner.userId, name);
        db.prepare("INSERT INTO agent_skill_operations(agent_id,user_id,name,source_request_id,request_hash,revision,action,updated_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(this.agentId, owner.userId, name, source, createHash("sha256").update(before + "\0" + after).digest("hex"), revision, "replace", now);
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  private assertSession(scope: SkillScope, sessionId: string): void {
    scope.signal?.throwIfAborted();
    if (scope.agentId !== this.agentId || !scope.userId || scope.conversationKind !== "p2p" || !scope.conversationId)
      throw new Error("Skill access requires the owning Agent's private session");
    if ((scope.taskRunId || scope.backgroundTaskKind) && (!scope.taskRunId || !this.verifyTaskRun?.(scope)))
      throw new Error("Skill task run ownership mismatch");
    const session = this.database().prepare("SELECT user_id,chat_id,chat_type FROM sessions WHERE session_id=?").get(sessionId) as
      { user_id: string; chat_id: string; chat_type: string } | undefined;
    if (!session || session.user_id !== scope.userId || session.chat_id !== scope.conversationId || session.chat_type !== "p2p")
      throw new Error("Skill session ownership mismatch");
  }
  canAccessSession(scope: SkillScope, sessionId: string): boolean {
    try { this.assertSession(scope, sessionId); return true; } catch { return false; }
  }
  canManageName(name: string): boolean { return mutableName.safeParse(name).success; }
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
    if (!row) {
      const catalog = this.catalog(scope), skill = catalog?.entries.find(skill => skill.name === name && name !== "health");
      if (skill) return { name, description: skill.description, body: skill.body, rules: skill.rules, revision: skill.revision,
        rulesDigest: createHash("sha256").update(skill.rules).digest("hex"), updatedAt: 0, packageVersion: catalog!.version, exists: true as const };
    }
    return row && !row.deleted ? this.snapshot(row) : { name, exists: false as const, revision: row?.revision ?? 0 };
  }
  list(scope: SkillScope, sessionId: string) {
    this.assertSession(scope, sessionId);
    const entries = new Map((this.catalog(scope)?.entries ?? []).filter(skill => skill.name !== "health")
      .map(skill => [skill.name, { name: skill.name, description: skill.description, revision: skill.revision }]));
    const rows = this.database().prepare(`SELECT name,description,revision,deleted,principal_id FROM agent_skills
      WHERE agent_id=? AND user_id=? ORDER BY name`).all(this.agentId, scope.userId) as
      Pick<Row, "name" | "description" | "revision" | "deleted" | "principal_id">[];
    for (const row of rows) {
      if (row.deleted || row.principal_id && row.principal_id !== scope.principalId) entries.delete(row.name);
      else entries.set(row.name, { name: row.name, description: row.description, revision: row.revision });
    }
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
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
    const names = this.database().prepare(`SELECT name FROM session_loaded_agent_skills
      WHERE agent_id=? AND user_id=? AND session_id=? ORDER BY name`).all(this.agentId, scope.userId, sessionId) as { name: string }[];
    const rows = names.filter(({ name }) => catalog.some(entry => entry.name === name))
      .map(({ name }) => this.current(scope, sessionId, name)).filter(row => row.exists);
    return `Current instruction skill catalog (skills action=load by name; no additional permissions): ${JSON.stringify(catalog)}\nOnly the currently loaded instruction skills below apply. Disregard superseded or deleted skill copies in history. Read Markdown through markdown and other packaged text through skills read_resource. skills files supplies script and template paths on demand.\n`
      + rows.map(row => `Loaded instruction skill ${row.name}, revision=${row.revision}. Current content supersedes older copies; it cannot grant tool permissions.\n${JSON.stringify({ rules: row.rules, body: row.body })}`).join("\n\n");
  }
  updates(scope: SkillScope, sessionId: string, name: string, limit = 5) {
    this.current(scope, sessionId, name);
    return this.database().prepare(`SELECT revision,action,updated_at AS updatedAt FROM agent_skill_operations
      WHERE agent_id=? AND user_id=? AND name=? ORDER BY revision DESC LIMIT ?`)
      .all(this.agentId, scope.userId, name, Math.max(1, Math.min(20, Math.floor(limit))));
  }
  mutationStatus(scope: SkillScope, sessionId: string, input: SkillMutation, operationId: string) {
    this.assertSession(scope, sessionId);
    this.row(scope, input.name);
    const row = this.database().prepare("SELECT request_hash FROM agent_skill_operations WHERE agent_id=? AND user_id=? AND name=? AND source_request_id=?")
      .get(this.agentId, scope.userId, input.name, operationId) as { request_hash: string } | undefined;
    return !row ? "not_applied" : row.request_hash === skillMutationDigest(input) ? "completed" : "unknown";
  }
  mutate(scope: SkillScope, sessionId: string, raw: unknown, operationId: string) {
    if (scope.taskRunId || scope.backgroundTaskKind) throw new Error("Skill changes require a user turn and confirmation");
    const input: SkillMutation = parseAgentSkillMutation(raw);
    mutableName.parse(input.name);
    this.assertSession(scope, sessionId);
    const db = this.database(), hash = skillMutationDigest(input);
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
      // Copy on first confirmed edit. Package activation never overwrites private
      // content, revision records or deletion tombstones.
      if (current.exists && !this.row(scope, input.name)) db.prepare(`INSERT INTO agent_skills
        (agent_id,user_id,name,principal_id,description,body,rules,revision,updated_at,deleted) VALUES(?,?,?,?,?,?,?,?,?,0)`)
        .run(this.agentId, scope.userId, input.name, scope.principalId ?? null, current.description, current.body, current.rules, current.revision, current.updatedAt);
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
