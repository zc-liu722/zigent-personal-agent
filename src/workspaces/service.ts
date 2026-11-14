import { CodePointText } from "../text/code-points.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactBlobStore, contentHash } from "../artifacts/blob-store.js";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { ordinaryPath, snapshotFile, snapshotFileRange, workspaceName, workspacePath, type FileIdentity } from "./paths.js";
import type { ArtifactVersion, FileInput, FilePage, PublishOptions, ShareAuthorization, ShareGrant, ShareTarget, TextEdit, Workspace, WorkspaceEvent, WorkspaceFile, WorkspaceOptions, WorkspaceRead, WorkspaceLifetime } from "./types.js";
export type * from "./types.js";

type WorkspaceRow = { id: string; name: string; created_at: number; updated_at: number; scope: string };
type Lifecycle = { kind: WorkspaceLifetime; session_id: string | null; expires_at: number | null; state: "active" | "deleting" | "deleted" };
type VersionRow = { id: string; file_id: string; workspace_id: string; name: string; title: string; mime: string; size: number; sha256: string; created_at: number; parent_version_id: string | null; kind: "original" | "artifact"; source_path: string; scope: string };
type FileRow = { id: string; current_version: string; workspace_id: string; scope: string; source_path: string; kind: string };
type GrantRow = { id: string; kind: "version" | "workspace"; resource_id: string; target_agent: string; target_scope: string; scope: string; created_at: number; revoked_at: number | null };
const queues = new Map<string, Promise<unknown>>();
const id = (value: string) => { if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error("工作区或文件标识无效。"); return value; };
const scopeFor = (agent: string, owner: string) => createHash("sha256").update(JSON.stringify([agent, owner])).digest("hex");
const internalPath = (path: string) => [".zigent-project-metadata.json", ".zigent-transfer-manifest.json"].includes(path.toLowerCase());
const bounded = (value: number, max: number, fallback: number) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
function label(value: string, fallback: string, max = 160) { const text = value.trim(); if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`${fallback}无效。`); return text; }
export const workspaceMime = (name: string) => ({ ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".zip": "application/zip", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8", ".json": "application/json", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8" } as Record<string, string>)[extname(name).toLowerCase()] ?? "application/octet-stream";
function version(row: VersionRow, shared = false): ArtifactVersion {
  return { id: row.id, versionId: row.id, fileId: row.file_id, workspaceId: row.workspace_id, name: row.name, title: row.title, mime: row.mime, size: row.size, sha256: row.sha256, createdAt: row.created_at, kind: row.kind, sourcePath: row.source_path, ...(row.parent_version_id ? { parentVersionId: row.parent_version_id } : {}), ...(shared ? { shared: true } : {}) };
}

/** One authenticated Agent/owner scope. No caller-supplied owner selectors. */
export class WorkspaceService {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly stateDirectory: string;
  private readonly db: DatabaseSync;
  private readonly scope: string;
  private readonly blobStore: ArtifactBlobStore;
  private readonly maxBytes: number;
  private initializeDirectory?: (workspaceId: string) => Promise<unknown>;
  private assertWritable?: (workspaceId: string) => void;
  private initializeSharedDirectory?: (workspaceId: string,scope: string) => Promise<unknown>;
  /** Full-file digests reused for range reads while inode, size and timestamps still match. */
  private readonly rangeHashes = new Map<string, { identity: FileIdentity; sha256: string }>();

  constructor(options: WorkspaceOptions) {
    if (!options.agentId || !options.ownerUserId) throw new Error("工作区需要明确的 Agent 和所有者。");
    this.agentId = options.agentId; this.ownerUserId = options.ownerUserId;
    mkdirSync(resolve(options.stateDirectory), { recursive: true, mode: 0o700 });
    this.stateDirectory = realpathSync(resolve(options.stateDirectory));
    this.scope = scopeFor(this.agentId, this.ownerUserId);
    this.maxBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 2 * 1024 * 1024 * 1024) throw new Error("文件大小配置无效。");
    for (const name of ["blobs", "locks", `workspaces/${this.scope}`]) mkdirSync(join(this.stateDirectory, name), { recursive: true, mode: 0o700 });
    this.blobStore = new ArtifactBlobStore(join(this.stateDirectory, "blobs"), this.maxBytes);
    this.db = new DatabaseSync(join(this.stateDirectory, "workspaces.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS workspace_projects(id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_projects_owner ON workspace_projects(scope,updated_at);
      CREATE TABLE IF NOT EXISTS workspace_files(id TEXT PRIMARY KEY, scope TEXT NOT NULL, workspace_id TEXT NOT NULL, source_path TEXT NOT NULL, kind TEXT NOT NULL, current_version TEXT NOT NULL);
      DROP INDEX IF EXISTS workspace_files_path;
      CREATE INDEX IF NOT EXISTS workspace_files_source ON workspace_files(scope,workspace_id,source_path,kind);
      CREATE TABLE IF NOT EXISTS workspace_artifact_keys(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,logical_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(scope,workspace_id,logical_id));
      CREATE TABLE IF NOT EXISTS workspace_versions(id TEXT PRIMARY KEY, scope TEXT NOT NULL, file_id TEXT NOT NULL, workspace_id TEXT NOT NULL, source_path TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, parent_version_id TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_versions_file ON workspace_versions(scope,file_id,created_at);
      CREATE TABLE IF NOT EXISTS workspace_inputs(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,source_id TEXT NOT NULL,sha256 TEXT NOT NULL,path TEXT NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(scope,workspace_id,source_id,sha256));
      CREATE TABLE IF NOT EXISTS workspace_grants(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,target_scope TEXT NOT NULL,target_agent TEXT NOT NULL,operation_id TEXT NOT NULL,created_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS workspace_grants_target ON workspace_grants(target_scope,resource_id,revoked_at);
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_grants_operation ON workspace_grants(scope,operation_id);
      CREATE TABLE IF NOT EXISTS workspace_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,workspace_id TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_events_owner ON workspace_events(scope,sequence);
      CREATE TABLE IF NOT EXISTS workspace_leases(id TEXT PRIMARY KEY,scope TEXT NOT NULL,workspace_id TEXT NOT NULL,job_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_write_locks(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,token TEXT NOT NULL,pid INTEGER NOT NULL,PRIMARY KEY(scope,workspace_id));
      CREATE TABLE IF NOT EXISTS workspace_replacements(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,stage TEXT NOT NULL,backup TEXT NOT NULL,PRIMARY KEY(scope,workspace_id));
      CREATE TABLE IF NOT EXISTS workspace_directories(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(scope,workspace_id));
      CREATE TABLE IF NOT EXISTS workspace_derived(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,source_version TEXT NOT NULL,recipe TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,workspace_id,path));
      CREATE TABLE IF NOT EXISTS workspace_lifecycles(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,kind TEXT NOT NULL,session_id TEXT,expires_at INTEGER,state TEXT NOT NULL DEFAULT 'active',PRIMARY KEY(scope,workspace_id));
      CREATE INDEX IF NOT EXISTS workspace_expiry ON workspace_lifecycles(scope,kind,state,expires_at);
      CREATE TABLE IF NOT EXISTS session_directories(scope TEXT NOT NULL,session_id TEXT NOT NULL,workspace_id TEXT NOT NULL,PRIMARY KEY(scope,session_id));`);
    if (!this.db.prepare("PRAGMA table_info(workspace_lifecycles)").all().some(column => column.name === "reclaim_after"))
      this.db.exec("ALTER TABLE workspace_lifecycles ADD COLUMN reclaim_after INTEGER");
    // Ad-hoc session directories are temporary. A directory already past its old
    // deadline stays available for 24 hours after this startup.
    const grace = Date.now() + 86_400_000;
    prepareSql(this.db, `UPDATE workspace_lifecycles SET kind='temporary',
      expires_at=MAX(COALESCE(expires_at,(SELECT created_at+86400000 FROM workspace_projects p
        WHERE p.scope=workspace_lifecycles.scope AND p.id=workspace_lifecycles.workspace_id),?),?)
      WHERE scope=? AND kind='session' AND state!='deleted'`).run(grace, grace, this.scope);
    // Pre-upgrade provenance is incomplete. Hide unclassified directories without
    // guessing which user data can be deleted; registered projects are adopted below.
    prepareSql(this.db, "INSERT OR IGNORE INTO workspace_lifecycles(scope,workspace_id,kind) SELECT scope,id,'legacy' FROM workspace_projects WHERE scope=?").run(this.scope);
  }

  close(): void { closeSqlite(this.db); }
  private row(workspaceId: string): WorkspaceRow {
    const row = prepareSql(this.db, "SELECT * FROM workspace_projects WHERE id=? AND scope=?").get(id(workspaceId), this.scope) as WorkspaceRow | undefined;
    if (!row || this.lifecycle(workspaceId).state === "deleted") throw new Error("工作区不存在、已清理或无权访问。");
    return row;
  }
  private lifecycle(workspaceId: string): Lifecycle {
    const row = prepareSql(this.db, "SELECT kind,session_id,expires_at,state FROM workspace_lifecycles WHERE scope=? AND workspace_id=?").get(this.scope, workspaceId) as Lifecycle | undefined;
    if (!row) throw new Error("工作区生命周期记录不存在。");
    return row;
  }
  private describeWorkspace(row: WorkspaceRow): Workspace {
    const life = this.lifecycle(row.id);
    const historical = life.kind === "session" && life.expires_at !== null;
    return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at, lifetime: historical ? "temporary" : life.kind,
      ...(life.session_id ? { sessionId: life.session_id } : {}), ...(life.expires_at !== null ? { expiresAt: life.expires_at } : {}) };
  }
  private directorySessionOwned(owner: string | null, sessionId?: string): boolean {
    return Boolean(owner && sessionId === owner);
  }
  assertSessionAccess(workspaceId: string, sessionId?: string) {
    this.row(workspaceId);
    const life = this.lifecycle(workspaceId);
    if (life.state !== "active" || (life.kind === "session" || life.kind === "temporary") && !this.directorySessionOwned(life.session_id, sessionId))
      throw new Error("此文件目录只供所属会话使用。");
    if (life.kind === "temporary" && !(typeof life.expires_at === "number" && life.expires_at > Date.now()))
      throw new Error("临时工作区已超过 24 小时。需要保留时请转为持久项目，否则请使用新的临时目录。");
  }
  assertPersistentProject(workspaceId: string) {
    this.row(workspaceId);
    const life = this.lifecycle(workspaceId);
    if (life.kind !== "persistent" || life.state !== "active") throw new Error("只允许访问持久项目。");
  }
  /** Trusted upload/default storage is never a visible project or an expiring task. */
  markSystem(workspaceId: string) {
    this.row(workspaceId);
    prepareSql(this.db, "UPDATE workspace_lifecycles SET kind='system',session_id=NULL,expires_at=NULL WHERE scope=? AND workspace_id=? AND state='active' AND kind='legacy'").run(this.scope, workspaceId);
  }
  promoteWorkspace(workspaceId: string, sessionId: string): Workspace {
    this.assertSessionAccess(workspaceId, sessionId);
    const life = this.lifecycle(workspaceId);
    if (life.kind === "system") throw new Error("原件存储不能转为项目。");
    if (life.kind === "temporary" && life.session_id !== sessionId) throw new Error("临时工作区只能由原会话转为项目。");
    if (life.kind !== "legacy" && life.kind !== "temporary") throw new Error("只有原会话可以保留此历史目录。");
    const changed = prepareSql(this.db, "UPDATE workspace_lifecycles SET kind='persistent',session_id=NULL,expires_at=NULL WHERE scope=? AND workspace_id=? AND state='active' AND (kind='legacy' OR (kind='temporary' AND session_id=? AND expires_at>?))")
      .run(this.scope, workspaceId, sessionId, Date.now());
    if (!changed.changes) throw new Error("工作区已到期或状态已变化，请重新核对。");
    this.emit(workspaceId, "workspace.promoted", {});
    return this.workspace(workspaceId);
  }
  private directory(row: WorkspaceRow) {
    return (prepareSql(this.db,"SELECT path FROM workspace_directories WHERE scope=? AND workspace_id=?").get(row.scope,row.id) as {path:string}|undefined)?.path
      ?? join(this.stateDirectory, "workspaces", row.scope, row.id);
  }
  configureWorkingDirectory(initialize: (workspaceId: string)=>Promise<unknown>, writable: (workspaceId: string)=>void) {
    this.initializeDirectory=initialize; this.assertWritable=writable;
  }
  configureSharedDirectory(initialize: (workspaceId: string,scope: string)=>Promise<unknown>) { this.initializeSharedDirectory=initialize; }
  executionDirectory(workspaceId: string): string | undefined {
    this.row(workspaceId);
    return (prepareSql(this.db,"SELECT path FROM workspace_directories WHERE scope=? AND workspace_id=? AND kind='execution'").get(this.scope,workspaceId) as {path:string}|undefined)?.path;
  }
  /** Called only by the trusted same-host migration, while holding the directory lock. */
  bindExecutionDirectory(workspaceId: string, path: string) {
    this.row(workspaceId);
    prepareSql(this.db,"INSERT OR REPLACE INTO workspace_directories VALUES (?,?,?,'execution')").run(this.scope,workspaceId,resolve(path));
    this.emit(workspaceId,"workspace.execution_attached",{});
  }
  async withMigrationLock<T>(workspaceId: string, action: (directory: string)=>Promise<T>) {
    return this.locked(workspaceId,()=>action(this.directory(this.row(workspaceId))),false);
  }
  async retainLegacyDirectory(workspaceId: string): Promise<Workspace> {
    const source=this.row(workspaceId),path=this.directory(source);
    const recovered=await this.createWorkspace({name:`${source.name.slice(0,100)} · 迁移恢复`, lifetime: "system"});
    prepareSql(this.db,"INSERT INTO workspace_directories VALUES (?,?,?,'legacy')").run(this.scope,recovered.id,path);
    this.emit(workspaceId,"workspace.migration_recovery",{workspaceId:recovered.id});
    return recovered;
  }
  private emit(workspaceId: string, type: string, data: Record<string, unknown>): void {
    prepareSql(this.db, "INSERT INTO workspace_events(scope,workspace_id,type,data,created_at) VALUES (?,?,?,?,?)").run(this.scope, workspaceId, type, JSON.stringify(data), Date.now());
  }
  private touch(workspaceId: string): void { prepareSql(this.db, "UPDATE workspace_projects SET updated_at=? WHERE id=? AND scope=?").run(Date.now(), workspaceId, this.scope); }

  async createWorkspace(input: { name?: string; lifetime?: "persistent" | "system" } = {}): Promise<Workspace> {
    const name = label(input.name ?? "新项目", "项目名称"), workspaceId = randomUUID();
    await mkdir(this.directory({ id: workspaceId, scope: this.scope } as WorkspaceRow), { recursive: false, mode: 0o700 });
    sqliteTransaction(this.db, () => this.insertDirectory(workspaceId, name, input.lifetime ?? "persistent"));
    return this.workspace(workspaceId);
  }
  private insertDirectory(workspaceId: string, name: string, kind: WorkspaceLifetime, sessionId?: string, expiresAt?: number) {
    const now = Date.now();
    prepareSql(this.db, "INSERT INTO workspace_projects VALUES (?,?,?,?,?)").run(workspaceId, this.scope, name, now, now);
    prepareSql(this.db, "INSERT INTO workspace_lifecycles(scope,workspace_id,kind,session_id,expires_at) VALUES (?,?,?,?,?)")
      .run(this.scope, workspaceId, kind, sessionId ?? null, expiresAt ?? null);
    this.emit(workspaceId, "workspace.created", { name, lifetime: kind });
  }
  private reusableTemporary(workspaceId: string, sessionId: string) {
    try {
      this.assertSessionAccess(workspaceId, sessionId);
      const life = this.lifecycle(workspaceId);
      return life.kind === "temporary" && life.expires_at !== null && life.expires_at > Date.now();
    } catch { return false; }
  }
  existingSessionDirectory(sessionId: string): string | undefined {
    const saved = prepareSql(this.db, "SELECT workspace_id FROM session_directories WHERE scope=? AND session_id=?")
      .get(this.scope, sessionId) as { workspace_id: string } | undefined;
    if (saved && this.reusableTemporary(saved.workspace_id, sessionId)) return saved.workspace_id;
    const legacy = prepareSql(this.db, `SELECT l.workspace_id FROM workspace_lifecycles l JOIN workspace_projects p ON p.id=l.workspace_id
      WHERE l.scope=? AND l.session_id=? AND l.kind='temporary' AND l.state='active' AND l.expires_at>? ORDER BY p.updated_at DESC,p.id LIMIT 1`)
      .get(this.scope, sessionId, Date.now()) as { workspace_id: string } | undefined;
    return legacy && this.reusableTemporary(legacy.workspace_id, sessionId) ? legacy.workspace_id : undefined;
  }
  /** Allocate only on a file-producing or execution operation. The database
   * serializes first use across callers and service processes. */
  sessionDirectory(sessionId: string, historical?: string): string {
    if (!sessionId) throw new Error("文件目录需要所属会话。");
    return sqliteTransaction(this.db, () => {
      if (historical) {
        this.assertSessionAccess(historical, sessionId);
        return historical;
      }
      const existing = this.existingSessionDirectory(sessionId);
      if (existing) return existing;
      // A crash between mkdir and COMMIT reuses the same directory on retry.
      const key = createHash("sha256").update(JSON.stringify(["session-directory-v1", this.scope, sessionId])).digest("hex");
      let workspaceId = `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`;
      if (prepareSql(this.db, "SELECT 1 FROM workspace_projects WHERE id=?").get(workspaceId)) workspaceId = randomUUID();
      mkdirSync(this.directory({ id: workspaceId, scope: this.scope } as WorkspaceRow), { recursive: true, mode: 0o700 });
      this.insertDirectory(workspaceId, "会话文件", "temporary", sessionId, Date.now() + 86_400_000);
      prepareSql(this.db, `INSERT INTO session_directories VALUES (?,?,?)
        ON CONFLICT(scope,session_id) DO UPDATE SET workspace_id=excluded.workspace_id`).run(this.scope, sessionId, workspaceId);
      return workspaceId;
    });
  }
  /** Register an authorized live directory; never copy or replace existing project files. */
  async registerDirectory(workspaceId: string, name: string, directory: string): Promise<Workspace> {
    id(workspaceId); name = label(name, "项目名称");
    await ordinaryPath(directory);
    if (!(await stat(directory)).isDirectory()) throw new Error("已授权项目目录不可用。");
    const existing = prepareSql(this.db, "SELECT path,kind FROM workspace_directories WHERE scope=? AND workspace_id=?").get(this.scope, workspaceId) as {path:string;kind:string}|undefined;
    if (existing && (!["registered", "execution"].includes(existing.kind) || resolve(existing.path).toLowerCase() !== resolve(directory).toLowerCase()))
      throw new Error("登记项目目录已变化，请先显式迁移；未移动或覆盖文件。");
    sqliteTransaction(this.db, () => {
      const now = Date.now();
      prepareSql(this.db, "INSERT OR IGNORE INTO workspace_projects VALUES (?,?,?,?,?)").run(workspaceId,this.scope,name,now,now);
      prepareSql(this.db, "INSERT INTO workspace_lifecycles(scope,workspace_id,kind) VALUES (?,?,'persistent') ON CONFLICT(scope,workspace_id) DO UPDATE SET kind='persistent',session_id=NULL,expires_at=NULL,state='active'").run(this.scope,workspaceId);
      // Adopt an already bound execution directory in place, preserving workspace identity and bytes.
      if (existing?.kind === "execution") prepareSql(this.db, "UPDATE workspace_directories SET kind='registered' WHERE scope=? AND workspace_id=? AND kind='execution'").run(this.scope,workspaceId);
      else prepareSql(this.db, "INSERT OR IGNORE INTO workspace_directories VALUES (?,?,?,'registered')").run(this.scope,workspaceId,resolve(directory));
    });
    return this.workspace(workspaceId);
  }
  registeredDirectory(workspaceId: string): string | undefined {
    this.row(workspaceId);
    return (prepareSql(this.db,"SELECT path FROM workspace_directories WHERE scope=? AND workspace_id=? AND kind='registered'").get(this.scope,workspaceId) as {path:string}|undefined)?.path;
  }
  listWorkspaces(): Workspace[] {
    return (prepareSql(this.db, `SELECT p.* FROM workspace_projects p JOIN workspace_lifecycles l ON l.scope=p.scope AND l.workspace_id=p.id
      WHERE p.scope=? AND l.state='active' AND l.kind='persistent' ORDER BY p.updated_at DESC,p.id`).all(this.scope) as WorkspaceRow[])
      .map(row => this.describeWorkspace(row));
  }
  workspace(workspaceId: string): Workspace { return this.describeWorkspace(this.row(workspaceId)); }
  async workspaceDirectory(workspaceId: string, initialize = true): Promise<string> {
    if (initialize) await this.initializeDirectory?.(workspaceId);
    const root = this.directory(this.row(workspaceId));
    try { const path = await ordinaryPath(root); if (!(await stat(path)).isDirectory()) throw new Error("项目目录不可用。"); return path; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.locked(workspaceId, async () => {}, initialize);
      const path = await ordinaryPath(root); if (!(await stat(path)).isDirectory()) throw new Error("项目目录不可用。"); return path;
    }
  }
  async resolvePath(workspaceId: string, path = ".", options: { allowMissing?: boolean; directory?: boolean; initialize?: boolean } = {}): Promise<string> {
    const target = await ordinaryPath(await this.workspaceDirectory(workspaceId, options.initialize), path, options.allowMissing);
    if (options.directory) {
      try { if (!(await stat(target)).isDirectory()) throw new Error("请选择工作区目录。"); }
      catch (error) { if (!(options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
    }
    return target;
  }

  /** SQLite coordinates broker writers across Agent processes; a dead holder can be reclaimed. */
  private async locked<T>(workspaceId: string, action: () => Promise<T>, initialize = true): Promise<T> {
    this.row(workspaceId);
    if(initialize)await this.initializeDirectory?.(workspaceId);
    const key = `${this.stateDirectory}:${this.scope}:${workspaceId}`;
    const previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const token = randomUUID();
      sqliteTransaction(this.db, () => {
        const holder = prepareSql(this.db, "SELECT pid FROM workspace_write_locks WHERE scope=? AND workspace_id=?").get(this.scope, workspaceId) as { pid: number } | undefined;
        if (holder) {
          let alive = true;
          try { process.kill(holder.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
          if (alive) throw new Error("工作区正被另一操作修改，请稍后重试。");
        }
        prepareSql(this.db, "INSERT OR REPLACE INTO workspace_write_locks VALUES (?,?,?,?)").run(this.scope, workspaceId, token, process.pid);
      });
      try { await this.recoverDirectoryReplacement(workspaceId); return await action(); }
      finally { prepareSql(this.db, "DELETE FROM workspace_write_locks WHERE scope=? AND workspace_id=? AND token=?").run(this.scope, workspaceId, token); }
    });
    queues.set(key, operation);
    try { return await operation; } finally { if (queues.get(key) === operation) queues.delete(key); }
  }
  /** Trusted worker reconciliation only. Nested writeFile/patchFile calls would reacquire this lock. */
  withWriteLock<T>(workspaceId: string, action: () => Promise<T>): Promise<T> { return this.locked(workspaceId, action); }
  /** Called while holding withWriteLock, after staging all bytes and before the first rename. */
  beginDirectoryReplacement(workspaceId: string, stage: string, backup: string): void {
    const root = this.directory(this.row(workspaceId)), parent = dirname(root);
    if (dirname(stage) !== parent || dirname(backup) !== parent || !basename(stage).startsWith(`.zigent-stage-${workspaceId}-`) || !basename(backup).startsWith(`.zigent-backup-${workspaceId}-`)) throw new Error("项目切换路径无效。");
    prepareSql(this.db, "INSERT OR REPLACE INTO workspace_replacements VALUES (?,?,?,?)").run(this.scope, workspaceId, stage, backup);
  }
  finishDirectoryReplacement(workspaceId: string): void { prepareSql(this.db, "DELETE FROM workspace_replacements WHERE scope=? AND workspace_id=?").run(this.scope, workspaceId); }
  private async recoverDirectoryReplacement(workspaceId: string): Promise<void> {
    const saved = prepareSql(this.db, "SELECT stage,backup FROM workspace_replacements WHERE scope=? AND workspace_id=?").get(this.scope, workspaceId) as { stage: string; backup: string } | undefined;
    if (!saved) return;
    const root = this.directory(this.row(workspaceId)), parent = dirname(root);
    if (dirname(saved.stage) !== parent || dirname(saved.backup) !== parent || !basename(saved.stage).startsWith(`.zigent-stage-${workspaceId}-`) || !basename(saved.backup).startsWith(`.zigent-backup-${workspaceId}-`)) throw new Error("项目恢复记录无效。");
    const exists = async (path: string) => { try { await ordinaryPath(parent, basename(path)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
    let recovered = false;
    if (!await exists(root)) {
      const source = await exists(saved.stage) ? saved.stage : await exists(saved.backup) ? saved.backup : undefined;
      if (!source) throw new Error("项目切换中断，恢复目录不可用，请保留数据并恢复备份。");
      await rename(source, root); recovered = true;
    }
    await ordinaryPath(root);
    if (!(await stat(root)).isDirectory()) throw new Error("项目恢复目标不是目录，已保留恢复数据。");
    // Stage and backup are broker-created copies. A valid live directory wins
    // after restart; durable job snapshots support a later result reconciliation.
    let cleaned = true;
    for (const path of [saved.stage, saved.backup]) if (await exists(path)) {
      try { await rm(path, { recursive: true }); } catch { cleaned = false; }
    }
    if (cleaned) this.finishDirectoryReplacement(workspaceId);
    if (recovered) this.emit(workspaceId, "workspace.recovered", {});
  }

  async listFiles(workspaceId: string, path = ".", offset = 0, limit = 100, allowPath?: (path: string) => boolean, initialize = true): Promise<FilePage> {
    path = workspacePath(path); const directory = await this.resolvePath(workspaceId, path, { directory: true, initialize });
    offset = bounded(offset, 1_000_000, 0); limit = Math.max(1, bounded(limit, 200, 100));
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => (path !== "." || !internalPath(entry.name)) && (!allowPath || allowPath(path === "." ? entry.name : `${path}/${entry.name}`)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const files: WorkspaceFile[] = [];
    for (const entry of entries.slice(offset, offset + limit)) {
      const relative = path === "." ? entry.name : `${path}/${entry.name}`;
      // Unsafe names/links remain unavailable; they are never silently followed.
      try {
        const target = await this.resolvePath(workspaceId, relative, { initialize }), info = await lstat(target);
        files.push({ path: relative, name: entry.name, type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtimeMs });
      } catch { files.push({ path: relative, name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: 0, modifiedAt: 0 }); }
    }
    return { workspaceId, path, files, ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}) };
  }
  async readFileBytes(workspaceId: string, path: string, maxBytes = this.maxBytes, initialize = true): Promise<{ bytes: Buffer; path: string; name: string; mime: string; size: number; sha256: string }> {
    path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能直接读取执行器内部元数据。");
    const { bytes } = await snapshotFile(await this.workspaceDirectory(workspaceId, initialize), path, Math.min(this.maxBytes, maxBytes));
    return { bytes, path, name: basename(path), mime: workspaceMime(path), size: bytes.length, sha256: contentHash(bytes) };
  }
  private rememberRange(key: string, identity: FileIdentity, sha256: string) {
    this.rangeHashes.delete(key);
    this.rangeHashes.set(key, { identity, sha256 });
    while (this.rangeHashes.size > 64) {
      const oldest = this.rangeHashes.keys().next().value;
      if (oldest === undefined) break;
      this.rangeHashes.delete(oldest);
    }
  }
  /** Byte-range read. `sha256` is the whole file; later pages reuse it until the file identity changes. Writes keep hashing the bytes they replace. */
  async readFileRange(workspaceId: string, path: string, offset = 0, length = 1_048_576, maxBytes = this.maxBytes): Promise<{ bytes: Buffer; path: string; name: string; mime: string; size: number; sha256: string; examined: number }> {
    path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能直接读取执行器内部元数据。");
    const limit = Math.min(this.maxBytes, maxBytes);
    const key = `${workspaceId}\0${process.platform === "win32" ? path.toLowerCase() : path}`;
    const snapshot = await snapshotFileRange(await this.workspaceDirectory(workspaceId), path, limit, offset, Math.min(Math.max(0, length), limit), this.rangeHashes.get(key));
    this.rememberRange(key, snapshot.identity, snapshot.sha256);
    return { bytes: snapshot.bytes, path, name: basename(path), mime: workspaceMime(path), size: snapshot.size, sha256: snapshot.sha256, examined: snapshot.examined };
  }
  async readFile(workspaceId: string, path: string, offset = 0, limit = 24_000): Promise<WorkspaceRead> {
    const result = await this.readFileBytes(workspaceId, path);
    if (result.size > 8 * 1024 * 1024) throw new Error("文本文件较大，请通过执行环境分段处理。");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { throw new Error("文件是二进制内容，请使用文档或图像处理能力。"); }
    if (text.includes("\0")) throw new Error("文件是二进制内容，请使用文档或图像处理能力。");
    const characters = new CodePointText(text); offset = bounded(offset, characters.length, 0); limit = Math.max(1, bounded(limit, 100_000, 24_000));
    const { bytes: _bytes, ...metadata } = result;
    return { ...metadata, workspaceId, text: characters.slice(offset, offset + limit), offset, ...(offset + limit < characters.length ? { nextOffset: offset + limit } : {}) };
  }

  private async writeUnlocked(workspaceId: string, path: string, bytes: Buffer, expectedHash?: string): Promise<WorkspaceFile & { sha256: string }> {
    this.assertWritable?.(workspaceId);
    path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能覆盖执行器内部元数据。");
    if (bytes.length > this.maxBytes) throw new Error("文件超过工作区大小限制。");
    const target = await this.resolvePath(workspaceId, path, { allowMissing: true });
    let existing: { sha256: string } | undefined;
    try { existing = await this.readFileBytes(workspaceId, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing && (!expectedHash || existing.sha256 !== expectedHash) || !existing && expectedHash !== undefined) throw new Error("文件版本已变化，请重新读取后修改；创建新文件时不要传 expectedHash。");
    // Keep immutable bytes before a destructive edit; they remain recoverable
    // without taking a complete project snapshot for every command.
    if(existing)await this.snapshotVersion(workspaceId,path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await ordinaryPath(this.directory(this.row(workspaceId)), path, true);
    const temporary = join(dirname(target), `.zigent-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await handle.close(); await rm(temporary, { force: true }); throw error; }
    await handle.close();
    try {
      if (existing) { const current = await this.readFileBytes(workspaceId, path); if (current.sha256 !== expectedHash) throw new Error("文件版本已变化，请重新读取后修改。"); }
      else { try { await lstat(target); throw new Error("目标文件已存在，请重新读取后修改。"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
      await ordinaryPath(this.directory(this.row(workspaceId)), path, true);
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    const sha256 = contentHash(bytes), info = await lstat(target);
    this.touch(workspaceId); this.emit(workspaceId, "file.written", { path, sha256, size: bytes.length });
    return { path, name: basename(path), type: "file", size: bytes.length, modifiedAt: info.mtimeMs, sha256 };
  }
  async writeFile(workspaceId: string, path: string, bytes: Buffer, expectedHash?: string) { return this.locked(workspaceId, () => this.writeUnlocked(workspaceId, path, bytes, expectedHash)); }
  async patchFile(workspaceId: string, path: string, edits: readonly TextEdit[], expectedHash: string, maxBytes = this.maxBytes) {
    return this.locked(workspaceId, async () => {
      const current = await this.readFileBytes(workspaceId, path, maxBytes);
      if (current.sha256 !== expectedHash) throw new Error("文件版本已变化，请重新读取后修改。");
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(current.bytes);
      if (text.includes("\0") || !edits.length || edits.length > 100) throw new Error("请选择文本文件并提供有效修改。");
      const replacements = edits.map(edit => {
        if (!edit.oldText || edit.oldText.length > 1_000_000 || edit.newText.length > 1_000_000) throw new Error("修改片段无效。");
        const start = text.indexOf(edit.oldText);
        if (start < 0 || text.indexOf(edit.oldText, start + 1) !== -1) throw new Error("修改内容必须在原文件中唯一匹配。");
        return { start, end: start + edit.oldText.length, value: edit.newText };
      }).sort((a, b) => a.start - b.start);
      for (let i = 1; i < replacements.length; i++) if (replacements[i]!.start < replacements[i - 1]!.end) throw new Error("修改片段不能互相重叠。");
      let next = text;
      for (const replacement of replacements.reverse()) next = next.slice(0, replacement.start) + replacement.value + next.slice(replacement.end);
      const bytes = Buffer.from(next);
      if (bytes.length > maxBytes) throw new Error("文件超过工作区大小限制。");
      return this.writeUnlocked(workspaceId, path, bytes, expectedHash);
    });
  }
  async moveFile(workspaceId: string, source: string, destination: string, expectedHash: string) {
    source = workspacePath(source, false); destination = workspacePath(destination, false);
    return this.locked(workspaceId, async () => {
      const current = await this.readFileBytes(workspaceId, source);
      if (current.sha256 !== expectedHash) throw new Error("文件版本已变化，请重新读取后移动。");
      if (source === destination) return { source, destination, sha256: current.sha256 };
      const result = await this.writeUnlocked(workspaceId, destination, current.bytes);
      const latest = await this.readFileBytes(workspaceId, source);
      if (latest.sha256 !== expectedHash) throw new Error("已复制到目标位置，来源发生变化并已保留，请核对后再移动。");
      await rm(await this.resolvePath(workspaceId, source));
      this.emit(workspaceId, "file.moved", { source, destination, sha256: result.sha256 });
      return { source, destination, sha256: result.sha256 };
    });
  }

  async searchFiles(workspaceId: string, query: string, options: { path?: string; limit?: number; includeContent?: boolean; allowPath?: (path: string) => boolean; signal?: AbortSignal } = {}) {
    if (!query || query.length > 500) throw new Error("检索内容无效。");
    const start = workspacePath(options.path ?? "."), limit = Math.max(1, bounded(options.limit ?? 50, 100, 50));
    const matches: Array<{ path: string; line?: number; text?: string }> = [], queue = [start];
    let visited = 0;
    while (queue.length && matches.length < limit && visited < 10_000) {
      const path = queue.shift()!, directory = await this.resolvePath(workspaceId, path, { directory: true });
      for (const item of await readdir(directory, { withFileTypes: true })) {
        options.signal?.throwIfAborted();
        if (++visited > 10_000 || matches.length >= limit) break;
        if (path === "." && internalPath(item.name)) continue;
        if (["node_modules", ".git", ".venv", "__pycache__", ".cache", ".scratch"].includes(item.name)) continue;
        const relative = path === "." ? item.name : `${path}/${item.name}`;
        if (options.allowPath && !options.allowPath(relative)) continue;
        try {
          const target = await this.resolvePath(workspaceId, relative), info = await lstat(target);
          if (info.isDirectory()) { queue.push(relative); continue; }
          if (relative.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path: relative });
          if (matches.length >= limit || !options.includeContent || info.size > 1024 * 1024) continue;
          const { text } = await this.readFile(workspaceId, relative, 0, 100_000);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < limit; i++) if (lines[i]!.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ path: relative, line: i + 1, text: lines[i]!.slice(0, 500) });
        } catch { /* Unsupported/binary/linked files are not searched. */ }
      }
    }
    return { workspaceId, query, matches, truncated: queue.length > 0 || matches.length >= limit || visited >= 10_000 };
  }

  retainedInput(workspaceId: string, sourceId: string, sha256: string): ArtifactVersion | undefined {
    this.row(workspaceId);
    const known = prepareSql(this.db, "SELECT version_id FROM workspace_inputs WHERE scope=? AND workspace_id=? AND source_id=? AND sha256=?")
      .get(this.scope, workspaceId, sourceId, sha256) as { version_id: string } | undefined;
    return known ? this.artifactVersion(known.version_id) : undefined;
  }

  async retainInput(workspaceId: string, input: FileInput) {
    if (this.workspace(workspaceId).lifetime !== "system") throw new Error("原件存储归属无效。");
    return this.saveInput(workspaceId, input, false);
  }
  async materializeInput(workspaceId: string, input: FileInput) {
    return this.saveInput(workspaceId, input, true);
  }
  private async saveInput(workspaceId: string, input: FileInput, workingCopy: boolean): Promise<ArtifactVersion & { path: string }> {
    this.row(workspaceId); const name = workspaceName(input.name);
    if (!input.id || input.id.length > 500 || contentHash(input.bytes) !== input.sha256) throw new Error("上传原件校验失败。");
    const hash = await this.blobStore.put(input.bytes);
    return this.locked(workspaceId, async () => {
      const known = prepareSql(this.db, "SELECT path,version_id FROM workspace_inputs WHERE scope=? AND workspace_id=? AND source_id=? AND sha256=?").get(this.scope, workspaceId, input.id, hash) as { path: string; version_id: string } | undefined;
      if (known) return { ...this.artifactVersion(known.version_id), path: known.path };
      const sourceKey = createHash("sha256").update(`${input.id}\0${hash}`).digest("hex").slice(0, 24), path = `inputs/${sourceKey}/${name}`;
      // A process can stop after writing the deterministic working copy but
      // before committing its receipt. Adopt only exactly matching bytes.
      if (workingCopy) {
        try {
          const existing = await this.readFileBytes(workspaceId, path);
          if (existing.sha256 !== hash) throw new Error("原件的工作副本已变化，请保留该文件。");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.writeUnlocked(workspaceId, path, input.bytes);
        }
      }
      const fileId = randomUUID(), versionId = randomUUID(), now = Date.now();
      sqliteTransaction(this.db, () => {
        prepareSql(this.db, "INSERT INTO workspace_files VALUES (?,?,?,?,?,?)").run(fileId, this.scope, workspaceId, path, "original", versionId);
        prepareSql(this.db, "INSERT INTO workspace_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(versionId, this.scope, fileId, workspaceId, path, "original", name, name, input.mime, input.bytes.length, hash, null, now);
        prepareSql(this.db, "INSERT INTO workspace_inputs VALUES (?,?,?,?,?,?)").run(this.scope, workspaceId, input.id, hash, path, versionId);
        this.emit(workspaceId, "input.saved", { versionId, fileId, path, sha256: hash, name });
      });
      return { ...this.artifactVersion(versionId), path };
    }, workingCopy);
  }

  /** Pin bytes without modifying the live project or waiting for a long-running editor. */
  async snapshotVersion(workspaceId: string, path: string, bytes?:Buffer): Promise<ArtifactVersion> {
    path=workspacePath(path,false);this.row(workspaceId);
    if(bytes && bytes.length>this.maxBytes)throw new Error("文件超过工作区限制。");
    const source = bytes ? {bytes,name:basename(path),mime:workspaceMime(path),size:bytes.length} : await this.readFileBytes(workspaceId, path);
    const hash = await this.blobStore.put(source.bytes);
    const existing = prepareSql(this.db, "SELECT * FROM workspace_versions WHERE scope=? AND workspace_id=? AND source_path=? AND sha256=? LIMIT 1")
      .get(this.scope, workspaceId, path, hash) as VersionRow | undefined;
    if (existing) return version(existing);
    const fileId = randomUUID(), versionId = randomUUID(), now = Date.now();
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "INSERT INTO workspace_files VALUES (?,?,?,?,?,?)").run(fileId, this.scope, workspaceId, path, "original", versionId);
      prepareSql(this.db, "INSERT INTO workspace_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(versionId, this.scope, fileId, workspaceId, path, "original", source.name, source.name, source.mime, source.size, hash, null, now);
    });
    return this.artifactVersion(versionId);
  }

  /** Private derivative jobs are siblings of projects, with the same owner ACL. */
  async derivativeRoot(): Promise<string> { return join(this.stateDirectory, "workspaces", this.scope); }

  async publish(workspaceId: string, path: string, options: PublishOptions = {}, bytes?:Buffer): Promise<ArtifactVersion> {
    path = workspacePath(path, false);
    return this.locked(workspaceId, async () => {
      if(bytes && bytes.length>this.maxBytes)throw new Error("文件超过工作区限制。");
      const source = bytes ? {bytes,name:basename(path),mime:workspaceMime(path),size:bytes.length} : await this.readFileBytes(workspaceId,path), hash = await this.blobStore.put(source.bytes);
      if (options.expectedHash && options.expectedHash !== hash) throw new Error("工作文件已变化，请检查最新文件后保存。");
      const logicalId = options.logicalId ? label(options.logicalId, "成果标识", 120) : undefined;
      const binding = logicalId ? prepareSql(this.db, "SELECT file_id FROM workspace_artifact_keys WHERE scope=? AND workspace_id=? AND logical_id=?").get(this.scope,workspaceId,logicalId) as {file_id:string}|undefined : undefined;
      if (binding && options.fileId && binding.file_id !== options.fileId) throw new Error("成果标识已绑定另一个文件。");
      const selectedId = options.fileId ?? binding?.file_id;
      const pathMatches = !selectedId && !logicalId ? prepareSql(this.db,"SELECT * FROM workspace_files WHERE source_path=? AND scope=? AND workspace_id=? AND kind='artifact' LIMIT 2").all(path,this.scope,workspaceId) as FileRow[] : [];
      if(pathMatches.length>1)throw new Error("该工作路径对应多个独立文件，请明确选择文件编号。");
      const existing = (selectedId
        ? prepareSql(this.db, "SELECT * FROM workspace_files WHERE id=? AND scope=? AND workspace_id=? AND kind='artifact'").get(id(selectedId), this.scope, workspaceId)
        : pathMatches[0]) as FileRow | undefined;
      if (options.fileId && !existing) throw new Error("交付文件不存在或无权访问。");
      const previous = existing ? this.artifactVersion(existing.current_version) : undefined;
      const title = label(options.title ?? Array.from(source.name).slice(0, 160).join(""), "文件标题"), mime = options.mime ?? source.mime;
      if (!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:; charset=utf-8)?$/.test(mime)) throw new Error("文件媒体类型无效。");
      if (previous && previous.sha256 === hash && previous.title === title && previous.name === source.name && previous.mime === mime) {
        if(logicalId) prepareSql(this.db,"INSERT OR IGNORE INTO workspace_artifact_keys VALUES (?,?,?,?)").run(this.scope,workspaceId,logicalId,previous.fileId);
        return previous;
      }
      if (existing && (!options.expectedVersion || options.expectedVersion !== existing.current_version) || !existing && options.expectedVersion) throw new Error("保存版本已变化，请读取当前版本后重试。");
      const fileId = existing?.id ?? randomUUID(), versionId = randomUUID(), now = Date.now();
      sqliteTransaction(this.db, () => {
        if (existing) prepareSql(this.db, "UPDATE workspace_files SET current_version=?,source_path=? WHERE id=? AND scope=? AND current_version=?").run(versionId, path, fileId, this.scope, existing.current_version);
        else prepareSql(this.db, "INSERT INTO workspace_files VALUES (?,?,?,?,?,?)").run(fileId, this.scope, workspaceId, path, "artifact", versionId);
        prepareSql(this.db, "INSERT INTO workspace_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(versionId, this.scope, fileId, workspaceId, path, "artifact", source.name, title, mime, source.size, hash, existing?.current_version ?? null, now);
        if (logicalId) prepareSql(this.db, "INSERT OR IGNORE INTO workspace_artifact_keys VALUES (?,?,?,?)").run(this.scope,workspaceId,logicalId,fileId);
        this.touch(workspaceId); this.emit(workspaceId, "artifact.published", { versionId, fileId, name: source.name, sha256: hash, size: source.size });
      });
      return this.artifactVersion(versionId);
    });
  }
  artifactVersion(versionId: string): ArtifactVersion {
    const row = prepareSql(this.db, `SELECT v.* FROM workspace_versions v WHERE v.id=? AND (v.scope=? OR EXISTS (SELECT 1 FROM workspace_grants g WHERE g.kind='version' AND g.resource_id=v.id AND g.target_scope=? AND g.revoked_at IS NULL))`).get(id(versionId), this.scope, this.scope) as VersionRow | undefined;
    if (!row) throw new Error("文件版本不存在或无权访问。");
    return version(row, row.scope !== this.scope);
  }
  async readArtifactVersion(versionId: string): Promise<ArtifactVersion & { bytes: Buffer }> { const metadata = this.artifactVersion(versionId); return { ...metadata, bytes: await this.blobStore.read(metadata.sha256) }; }
  listVersions(fileId: string): ArtifactVersion[] {
    const file = prepareSql(this.db, "SELECT id FROM workspace_files WHERE id=? AND scope=?").get(id(fileId), this.scope);
    if (!file) throw new Error("文件不存在或无权访问。");
    return (prepareSql(this.db, "SELECT * FROM workspace_versions WHERE file_id=? AND scope=? ORDER BY created_at DESC,rowid DESC LIMIT 500").all(fileId, this.scope) as VersionRow[]).map(row => version(row));
  }
  listArtifacts(workspaceId?: string, kind: "artifact" | "original" | "all" = "artifact", offset = 0, limit = 500): ArtifactVersion[] {
    return this.listArtifactPage(workspaceId,kind,offset,limit).artifacts;
  }
  listArtifactPage(workspaceId?: string, kind: "artifact" | "original" | "all" = "artifact", offset = 0, limit = 100): { artifacts: ArtifactVersion[]; nextOffset?: number } {
    if (workspaceId) this.row(workspaceId);
    if (!["artifact","original","all"].includes(kind)) throw new Error("文件类型无效。");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("文件分页范围无效。");
    const rows=prepareSql(this.db, `SELECT v.* FROM workspace_files f JOIN workspace_versions v ON v.id=f.current_version WHERE f.scope=?${kind === "all" ? "" : " AND f.kind=?"}${workspaceId ? " AND f.workspace_id=?" : ""} ORDER BY v.created_at DESC,v.rowid DESC LIMIT ? OFFSET ?`)
      .all(this.scope, ...(kind === "all" ? [] : [kind]), ...(workspaceId ? [workspaceId] : []),limit+1,offset) as VersionRow[];
    return {artifacts:rows.slice(0,limit).map(row=>version(row)),...(rows.length>limit?{nextOffset:offset+limit}:{})};
  }

  /** Call only from authenticated operation confirmation, never a model tool's raw arguments. */
  shareVersion(versionId: string, target: ShareTarget, authorization: ShareAuthorization): ShareGrant {
    const metadata = this.artifactVersion(versionId);
    if (metadata.shared) throw new Error("只能分享自己拥有的文件版本。");
    return this.grant("version", versionId, metadata.workspaceId, target, authorization);
  }
  shareWorkspace(workspaceId: string, target: ShareTarget, authorization: ShareAuthorization): ShareGrant {
    this.row(workspaceId);
    if (this.lifecycle(workspaceId).kind !== "persistent") throw new Error("请先确认将工作区转为持久项目，再共享项目目录。");
    return this.grant("workspace", workspaceId, workspaceId, target, authorization);
  }
  private grant(kind: "version" | "workspace", resourceId: string, workspaceId: string, target: ShareTarget, authorization: ShareAuthorization): ShareGrant {
    if (authorization.actorUserId !== this.ownerUserId || !authorization.operationId || authorization.operationId.length > 200 || !target.agentId || !target.ownerUserId) throw new Error("分享需要当前所有者的明确授权。");
    const targetScope = scopeFor(target.agentId, target.ownerUserId);
    if (targetScope === this.scope) throw new Error("目标 Agent 已经拥有该资源。");
    return sqliteTransaction(this.db, () => {
      const previous = prepareSql(this.db, "SELECT * FROM workspace_grants WHERE scope=? AND operation_id=?").get(this.scope, authorization.operationId) as GrantRow | undefined;
      if (previous) {
        if (previous.kind !== kind || previous.resource_id !== resourceId || previous.target_scope !== targetScope || previous.revoked_at !== null) throw new Error("分享授权已使用或已撤销，请重新授权。");
        return { id: previous.id, kind, resourceId, targetAgentId: target.agentId, createdAt: previous.created_at };
      }
      const grantId = randomUUID(), now = Date.now();
      prepareSql(this.db, "INSERT INTO workspace_grants VALUES (?,?,?,?,?,?,?,?,NULL)").run(grantId, this.scope, kind, resourceId, targetScope, target.agentId, authorization.operationId, now);
      this.emit(workspaceId, "share.granted", { grantId, kind, resourceId, targetAgentId: target.agentId });
      return { id: grantId, kind, resourceId, targetAgentId: target.agentId, createdAt: now };
    });
  }
  listShares(): ShareGrant[] {
    return (prepareSql(this.db, "SELECT * FROM workspace_grants WHERE (scope=? OR target_scope=?) AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 500").all(this.scope, this.scope) as GrantRow[])
      .map(row => ({ id: row.id, kind: row.kind, resourceId: row.resource_id, targetAgentId: row.target_agent, createdAt: row.created_at }));
  }
  revokeShare(grantId: string, actorUserId: string): void {
    if (actorUserId !== this.ownerUserId) throw new Error("只有资源所有者可以撤销分享。");
    prepareSql(this.db, "UPDATE workspace_grants SET revoked_at=? WHERE id=? AND scope=? AND revoked_at IS NULL").run(Date.now(), id(grantId), this.scope);
  }
  async copySharedVersion(grantId: string, workspaceId: string): Promise<ArtifactVersion & { path: string }> {
    const grant = prepareSql(this.db, "SELECT * FROM workspace_grants WHERE id=? AND kind='version' AND target_scope=? AND revoked_at IS NULL").get(id(grantId), this.scope) as GrantRow | undefined;
    if (!grant) throw new Error("分享不存在、已撤销或无权访问。");
    const source = await this.readArtifactVersion(grant.resource_id);
    return this.materializeInput(workspaceId, { id: `shared:${grantId}`, name: source.name, mime: source.mime, sha256: source.sha256, bytes: source.bytes });
  }
  private async sharedWorkspaceRoot(grantId: string): Promise<{ row: WorkspaceRow; root: string }> {
    const grant = prepareSql(this.db, "SELECT * FROM workspace_grants WHERE id=? AND kind='workspace' AND target_scope=? AND revoked_at IS NULL").get(id(grantId), this.scope) as GrantRow | undefined;
    if (!grant) throw new Error("项目分享不存在、已撤销或无权访问。");
    const row = prepareSql(this.db, "SELECT * FROM workspace_projects WHERE id=? AND scope=?").get(grant.resource_id, grant.scope) as WorkspaceRow | undefined;
    if (!row) throw new Error("分享的项目不存在。");
    await this.initializeSharedDirectory?.(row.id,row.scope);
    return { row, root: await ordinaryPath(this.directory(row)) };
  }
  async sharedWorkspaceFiles(grantId: string, path = ".", offset = 0, limit = 100): Promise<FilePage & { readOnly: true }> {
    const { row, root } = await this.sharedWorkspaceRoot(grantId);
    path = workspacePath(path); const target = await ordinaryPath(root, path);
    if (!(await stat(target)).isDirectory()) throw new Error("请选择分享项目中的目录。");
    const entries = (await readdir(target, { withFileTypes: true })).filter(entry => path !== "." || !internalPath(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    offset = bounded(offset, 1_000_000, 0); limit = Math.max(1, bounded(limit, 200, 100));
    const files: WorkspaceFile[] = [];
    for (const entry of entries.slice(offset, offset + limit)) {
      const relative = path === "." ? entry.name : `${path}/${entry.name}`;
      const info = await lstat(await ordinaryPath(root, relative));
      files.push({ path: relative, name: entry.name, type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtimeMs });
    }
    await this.sharedWorkspaceRoot(grantId);
    return { workspaceId: row.id, path, files, readOnly: true, ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}) };
  }
  async readSharedWorkspaceFile(grantId: string, path: string, offset = 0, limit = 24_000): Promise<WorkspaceRead & { readOnly: true }> {
    const { row, root } = await this.sharedWorkspaceRoot(grantId); path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能直接读取执行器内部元数据。");
    const { bytes } = await snapshotFile(root, path, Math.min(this.maxBytes, 8 * 1024 * 1024));
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("分享文件是二进制内容，请先复制到自己的项目后处理。"); }
    if (text.includes("\0")) throw new Error("分享文件是二进制内容，请先复制到自己的项目后处理。");
    const characters = new CodePointText(text); offset = bounded(offset, characters.length, 0); limit = Math.max(1, bounded(limit, 100_000, 24_000));
    await this.sharedWorkspaceRoot(grantId);
    return { workspaceId: row.id, path, name: basename(path), mime: workspaceMime(path), size: bytes.length, sha256: contentHash(bytes), text: characters.slice(offset, offset + limit), offset, readOnly: true, ...(offset + limit < characters.length ? { nextOffset: offset + limit } : {}) };
  }
  async copySharedWorkspaceFile(grantId: string, path: string, workspaceId: string, destination?: string) {
    const { root } = await this.sharedWorkspaceRoot(grantId); path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能复制执行器内部元数据。");
    const { bytes } = await snapshotFile(root, path, this.maxBytes);
    await this.sharedWorkspaceRoot(grantId);
    // A copy receives new local ownership; it never grants a write path back to the source.
    return this.writeFile(workspaceId, destination ?? path, bytes);
  }

  events(afterSequence = 0, workspaceId?: string, limit = 100): WorkspaceEvent[] {
    if (workspaceId) this.row(workspaceId);
    const rows = prepareSql(this.db, `SELECT sequence,workspace_id,type,data,created_at FROM workspace_events WHERE scope=? AND sequence>?${workspaceId ? " AND workspace_id=?" : ""} ORDER BY sequence LIMIT ?`).all(this.scope, bounded(afterSequence, Number.MAX_SAFE_INTEGER, 0), ...(workspaceId ? [workspaceId] : []), Math.max(1, bounded(limit, 500, 100))) as Array<{ sequence: number; workspace_id: string; type: string; data: string; created_at: number }>;
    return rows.map(row => ({ sequence: row.sequence, workspaceId: row.workspace_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at }));
  }
  acquireLease(workspaceId: string, jobId: string, ttlMs = 300_000): { id: string; renew(): void; release(): void } {
    this.row(workspaceId); if (!jobId || jobId.length > 200) throw new Error("执行租约标识无效。");
    const leaseId = randomUUID(), ttl = Math.max(10_000, Math.min(ttlMs, 24 * 60 * 60 * 1000));
    prepareSql(this.db, "INSERT INTO workspace_leases VALUES (?,?,?,?,?)").run(leaseId, this.scope, workspaceId, jobId, Date.now() + ttl);
    return { id: leaseId, renew: () => { prepareSql(this.db, "UPDATE workspace_leases SET expires_at=? WHERE id=? AND scope=?").run(Date.now() + ttl, leaseId, this.scope); }, release: () => { prepareSql(this.db, "DELETE FROM workspace_leases WHERE id=? AND scope=?").run(leaseId, this.scope); } };
  }
  /** Keep a blocked directory active and out of the next sweeps until this time. */
  private deferTemporaryReclaim(workspaceId: string, now: number) {
    prepareSql(this.db, `UPDATE workspace_lifecycles SET state='active',reclaim_after=?
      WHERE scope=? AND workspace_id=? AND kind='temporary' AND state!='deleted'`).run(now + 15 * 60_000, this.scope, workspaceId);
  }
  /** Reclaim only explicitly expiring task directories. Saved versions and
   * originals live in the blob store and remain downloadable after reclamation. */
  async cleanupTemporary(releaseExecution: (workspaceId: string) => Promise<void>, now = Date.now()) {
    const rows = prepareSql(this.db, `SELECT workspace_id FROM workspace_lifecycles
      WHERE scope=? AND kind='temporary' AND state!='deleted' AND expires_at<=? AND (reclaim_after IS NULL OR reclaim_after<=?)
      ORDER BY expires_at LIMIT 30`).all(this.scope, now, now) as Array<{ workspace_id: string }>;
    for (const { workspace_id: workspaceId } of rows) {
      try {
        await this.locked(workspaceId, async () => {
          const life = this.lifecycle(workspaceId);
          if (life.kind !== "temporary" || life.state === "deleted" || life.expires_at == null || life.expires_at > now) return;
          const busy = prepareSql(this.db, "SELECT 1 FROM workspace_leases WHERE scope=? AND workspace_id=? AND expires_at>? LIMIT 1").get(this.scope, workspaceId, now);
          const binding = prepareSql(this.db, "SELECT path,kind FROM workspace_directories WHERE scope=? AND workspace_id=?").get(this.scope, workspaceId) as { path: string; kind: string } | undefined;
          if (busy || binding && binding.kind !== "execution") { this.deferTemporaryReclaim(workspaceId, now); return; }
          try { await releaseExecution(workspaceId); }
          catch { this.deferTemporaryReclaim(workspaceId, now); return; }
          const roots = [join(this.stateDirectory, "workspaces", this.scope, workspaceId)];
          if (binding?.kind === "execution") roots.push(binding.path);
          for (const root of [...new Set(roots.map(item => resolve(item)))])
            await rm(await ordinaryPath(root, ".", true), { recursive: true, force: true });
          sqliteTransaction(this.db, () => {
            prepareSql(this.db, "DELETE FROM workspace_derived WHERE scope=? AND workspace_id=?").run(this.scope, workspaceId);
            prepareSql(this.db, "DELETE FROM session_directories WHERE scope=? AND workspace_id=?").run(this.scope, workspaceId);
            prepareSql(this.db, "UPDATE workspace_lifecycles SET state='deleted',reclaim_after=NULL WHERE scope=? AND workspace_id=?").run(this.scope, workspaceId);
            this.emit(workspaceId, "workspace.expired", {});
          });
        }, false);
      } catch { this.deferTemporaryReclaim(workspaceId, now); }
    }
  }
  async registerDerived(workspaceId: string, path: string, input: { sourceVersionId: string; recipe: string; expiresAt: number }): Promise<void> {
    path = workspacePath(path, false); this.artifactVersion(input.sourceVersionId);
    if (!/^(?:\.cache|\.scratch)\//.test(path) || !input.recipe || input.recipe.length > 2000 || !Number.isSafeInteger(input.expiresAt)) throw new Error("只能登记具有明确重建来源的缓存或临时文件。");
    const source = await this.readFileBytes(workspaceId, path);
    prepareSql(this.db, "INSERT OR REPLACE INTO workspace_derived VALUES (?,?,?,?,?,?,?)").run(this.scope, workspaceId, path, source.sha256, input.sourceVersionId, input.recipe, input.expiresAt);
  }
  async cleanupDerived(now = Date.now()): Promise<{ removed: number; retained: number }> {
    const rows = prepareSql(this.db, "SELECT workspace_id,path,sha256,source_version FROM workspace_derived WHERE scope=? AND expires_at<? LIMIT 500").all(this.scope, now) as Array<{ workspace_id: string; path: string; sha256: string; source_version: string }>;
    let removed = 0, retained = 0;
    for (const row of rows) await this.locked(row.workspace_id, async () => {
      const active = prepareSql(this.db, "SELECT 1 FROM workspace_leases WHERE workspace_id=? AND scope=? AND expires_at>? LIMIT 1").get(row.workspace_id, this.scope, now);
      const published = prepareSql(this.db, "SELECT 1 FROM workspace_versions WHERE workspace_id=? AND scope=? AND source_path=? LIMIT 1").get(row.workspace_id, this.scope, row.path);
      if (active || published) { retained++; return; }
      try {
        this.artifactVersion(row.source_version);
        const current = await this.readFileBytes(row.workspace_id, row.path);
        if (current.sha256 !== row.sha256) { retained++; return; }
        await rm(await this.resolvePath(row.workspace_id, row.path)); removed++;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { retained++; return; } }
      prepareSql(this.db, "DELETE FROM workspace_derived WHERE scope=? AND workspace_id=? AND path=? AND sha256=?").run(this.scope, row.workspace_id, row.path, row.sha256);
    });
    return { removed, retained };
  }
}
