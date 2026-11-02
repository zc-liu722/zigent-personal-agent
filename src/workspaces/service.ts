import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactBlobStore, contentHash } from "../artifacts/blob-store.js";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { ordinaryPath, snapshotFile, workspaceName, workspacePath } from "./paths.js";
import type { ArtifactVersion, FileInput, FilePage, PublishOptions, ShareAuthorization, ShareGrant, ShareTarget, TextEdit, Workspace, WorkspaceEvent, WorkspaceFile, WorkspaceOptions, WorkspaceRead } from "./types.js";
export type * from "./types.js";

type WorkspaceRow = { id: string; name: string; created_at: number; updated_at: number; scope: string };
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
      CREATE TABLE IF NOT EXISTS workspace_derived(scope TEXT NOT NULL,workspace_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,source_version TEXT NOT NULL,recipe TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(scope,workspace_id,path));`);
  }

  close(): void { closeSqlite(this.db); }
  private row(workspaceId: string): WorkspaceRow {
    const row = prepareSql(this.db, "SELECT * FROM workspace_projects WHERE id=? AND scope=?").get(id(workspaceId), this.scope) as WorkspaceRow | undefined;
    if (!row) throw new Error("工作区不存在或无权访问。");
    return row;
  }
  private directory(row: WorkspaceRow) { return join(this.stateDirectory, "workspaces", row.scope, row.id); }
  private emit(workspaceId: string, type: string, data: Record<string, unknown>): void {
    prepareSql(this.db, "INSERT INTO workspace_events(scope,workspace_id,type,data,created_at) VALUES (?,?,?,?,?)").run(this.scope, workspaceId, type, JSON.stringify(data), Date.now());
  }
  private touch(workspaceId: string): void { prepareSql(this.db, "UPDATE workspace_projects SET updated_at=? WHERE id=? AND scope=?").run(Date.now(), workspaceId, this.scope); }

  async createWorkspace(input: { name?: string } = {}): Promise<Workspace> {
    const name = label(input.name ?? "新项目", "项目名称"), workspaceId = randomUUID(), now = Date.now();
    await mkdir(this.directory({ id: workspaceId, scope: this.scope } as WorkspaceRow), { recursive: false, mode: 0o700 });
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "INSERT INTO workspace_projects VALUES (?,?,?,?,?)").run(workspaceId, this.scope, name, now, now);
      this.emit(workspaceId, "workspace.created", { name });
    });
    return { id: workspaceId, name, createdAt: now, updatedAt: now };
  }
  listWorkspaces(): Workspace[] {
    return (prepareSql(this.db, "SELECT * FROM workspace_projects WHERE scope=? ORDER BY updated_at DESC,id LIMIT 500").all(this.scope) as WorkspaceRow[])
      .map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  workspace(workspaceId: string): Workspace { const row = this.row(workspaceId); return { id: row.id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at }; }
  async workspaceDirectory(workspaceId: string): Promise<string> {
    const root = this.directory(this.row(workspaceId));
    try { const path = await ordinaryPath(root); if (!(await stat(path)).isDirectory()) throw new Error("项目目录不可用。"); return path; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.locked(workspaceId, async () => {});
      const path = await ordinaryPath(root); if (!(await stat(path)).isDirectory()) throw new Error("项目目录不可用。"); return path;
    }
  }
  async resolvePath(workspaceId: string, path = ".", options: { allowMissing?: boolean; directory?: boolean } = {}): Promise<string> {
    const target = await ordinaryPath(await this.workspaceDirectory(workspaceId), path, options.allowMissing);
    if (options.directory) {
      try { if (!(await stat(target)).isDirectory()) throw new Error("请选择工作区目录。"); }
      catch (error) { if (!(options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error; }
    }
    return target;
  }

  /** SQLite coordinates broker writers across Agent processes; a dead holder can be reclaimed. */
  private async locked<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    this.row(workspaceId);
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

  async listFiles(workspaceId: string, path = ".", offset = 0, limit = 100): Promise<FilePage> {
    path = workspacePath(path); const directory = await this.resolvePath(workspaceId, path, { directory: true });
    offset = bounded(offset, 1_000_000, 0); limit = Math.max(1, bounded(limit, 200, 100));
    const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => path !== "." || !internalPath(entry.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const files: WorkspaceFile[] = [];
    for (const entry of entries.slice(offset, offset + limit)) {
      const relative = path === "." ? entry.name : `${path}/${entry.name}`;
      // Unsafe names/links remain unavailable; they are never silently followed.
      try {
        const target = await this.resolvePath(workspaceId, relative), info = await lstat(target);
        files.push({ path: relative, name: entry.name, type: info.isDirectory() ? "directory" : "file", size: info.size, modifiedAt: info.mtimeMs });
      } catch { files.push({ path: relative, name: entry.name, type: entry.isDirectory() ? "directory" : "file", size: 0, modifiedAt: 0 }); }
    }
    return { workspaceId, path, files, ...(offset + limit < entries.length ? { nextOffset: offset + limit } : {}) };
  }
  async readFileBytes(workspaceId: string, path: string): Promise<{ bytes: Buffer; path: string; name: string; mime: string; size: number; sha256: string }> {
    path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能直接读取执行器内部元数据。");
    const { bytes } = await snapshotFile(await this.workspaceDirectory(workspaceId), path, this.maxBytes);
    return { bytes, path, name: basename(path), mime: workspaceMime(path), size: bytes.length, sha256: contentHash(bytes) };
  }
  async readFile(workspaceId: string, path: string, offset = 0, limit = 24_000): Promise<WorkspaceRead> {
    const result = await this.readFileBytes(workspaceId, path);
    if (result.size > 8 * 1024 * 1024) throw new Error("文本文件较大，请通过执行环境分段处理。");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes); } catch { throw new Error("文件是二进制内容，请使用文档或图像处理能力。"); }
    if (text.includes("\0")) throw new Error("文件是二进制内容，请使用文档或图像处理能力。");
    const characters = Array.from(text); offset = bounded(offset, characters.length, 0); limit = Math.max(1, bounded(limit, 100_000, 24_000));
    const { bytes: _bytes, ...metadata } = result;
    return { ...metadata, workspaceId, text: characters.slice(offset, offset + limit).join(""), offset, ...(offset + limit < characters.length ? { nextOffset: offset + limit } : {}) };
  }

  private async writeUnlocked(workspaceId: string, path: string, bytes: Buffer, expectedHash?: string): Promise<WorkspaceFile & { sha256: string }> {
    path = workspacePath(path, false);
    if (internalPath(path)) throw new Error("不能覆盖执行器内部元数据。");
    if (bytes.length > this.maxBytes) throw new Error("文件超过工作区大小限制。");
    const target = await this.resolvePath(workspaceId, path, { allowMissing: true });
    let existing: { sha256: string } | undefined;
    try { existing = await this.readFileBytes(workspaceId, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing && (!expectedHash || existing.sha256 !== expectedHash) || !existing && expectedHash !== undefined) throw new Error("文件版本已变化，请重新读取后修改；创建新文件时不要传 expectedHash。");
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
  async patchFile(workspaceId: string, path: string, edits: readonly TextEdit[], expectedHash: string) {
    return this.locked(workspaceId, async () => {
      const current = await this.readFileBytes(workspaceId, path);
      if (current.sha256 !== expectedHash) throw new Error("文件版本已变化，请重新读取后修改。");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes);
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
      return this.writeUnlocked(workspaceId, path, Buffer.from(next), expectedHash);
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

  async searchFiles(workspaceId: string, query: string, options: { path?: string; limit?: number; includeContent?: boolean } = {}) {
    if (!query || query.length > 500) throw new Error("检索内容无效。");
    const start = workspacePath(options.path ?? "."), limit = Math.max(1, bounded(options.limit ?? 50, 100, 50));
    const matches: Array<{ path: string; line?: number; text?: string }> = [], queue = [start];
    let visited = 0;
    while (queue.length && matches.length < limit && visited < 10_000) {
      const path = queue.shift()!, directory = await this.resolvePath(workspaceId, path, { directory: true });
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (++visited > 10_000 || matches.length >= limit) break;
        if (path === "." && internalPath(item.name)) continue;
        if (["node_modules", ".git", ".venv", "__pycache__", ".cache", ".scratch"].includes(item.name)) continue;
        const relative = path === "." ? item.name : `${path}/${item.name}`;
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

  async materializeInput(workspaceId: string, input: FileInput): Promise<ArtifactVersion & { path: string }> {
    this.row(workspaceId); const name = workspaceName(input.name);
    if (!input.id || input.id.length > 500 || contentHash(input.bytes) !== input.sha256) throw new Error("上传原件校验失败。");
    const hash = await this.blobStore.put(input.bytes);
    return this.locked(workspaceId, async () => {
      const known = prepareSql(this.db, "SELECT path,version_id FROM workspace_inputs WHERE scope=? AND workspace_id=? AND source_id=? AND sha256=?").get(this.scope, workspaceId, input.id, hash) as { path: string; version_id: string } | undefined;
      if (known) return { ...this.artifactVersion(known.version_id), path: known.path };
      const sourceKey = createHash("sha256").update(`${input.id}\0${hash}`).digest("hex").slice(0, 24), path = `inputs/${sourceKey}/${name}`;
      // A process can stop after writing the deterministic working copy but
      // before committing its receipt. Adopt only exactly matching bytes.
      try {
        const existing = await this.readFileBytes(workspaceId, path);
        if (existing.sha256 !== hash) throw new Error("原件的工作副本已变化，请保留该文件并选择其他项目导入。");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") await this.writeUnlocked(workspaceId, path, input.bytes); else throw error; }
      const fileId = randomUUID(), versionId = randomUUID(), now = Date.now();
      sqliteTransaction(this.db, () => {
        prepareSql(this.db, "INSERT INTO workspace_files VALUES (?,?,?,?,?,?)").run(fileId, this.scope, workspaceId, path, "original", versionId);
        prepareSql(this.db, "INSERT INTO workspace_versions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(versionId, this.scope, fileId, workspaceId, path, "original", name, name, input.mime, input.bytes.length, hash, null, now);
        prepareSql(this.db, "INSERT INTO workspace_inputs VALUES (?,?,?,?,?,?)").run(this.scope, workspaceId, input.id, hash, path, versionId);
        this.emit(workspaceId, "input.saved", { versionId, fileId, path, sha256: hash, name });
      });
      return { ...this.artifactVersion(versionId), path };
    });
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
    this.row(workspaceId); return this.grant("workspace", workspaceId, workspaceId, target, authorization);
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
    const characters = Array.from(text); offset = bounded(offset, characters.length, 0); limit = Math.max(1, bounded(limit, 100_000, 24_000));
    await this.sharedWorkspaceRoot(grantId);
    return { workspaceId: row.id, path, name: basename(path), mime: workspaceMime(path), size: bytes.length, sha256: contentHash(bytes), text: characters.slice(offset, offset + limit).join(""), offset, readOnly: true, ...(offset + limit < characters.length ? { nextOffset: offset + limit } : {}) };
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
