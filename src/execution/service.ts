import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceService } from "../workspaces/service.js";
import { AgentRunInterruption } from "../agent/interruption.js";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { applySnapshot, decodeSnapshot, makeSnapshot, safeRelative } from "./snapshot.js";
import type { ExecutionContext, ExecutionEvent, ExecutionInput, ExecutionJob, ExecutionResult, WorkerIdentity } from "./types.js";
export type { ExecutionContext, ExecutionInput, ExecutionJob, ExecutionResult, ExecutionEvent } from "./types.js";

export type ExecutionOptions = {
  agentId: string; ownerUserId: string; stateDirectory: string; workspaces: WorkspaceService;
  endpoint?: string; previousEndpoint?:string; token?: string; maxSnapshotBytes?: number; onSynchronized?:(workspaceId:string)=>Promise<void>;
  recoverState?: boolean;
};
type Row = { id: string; workspace_id: string; state: ExecutionJob["state"]; created_at: number; updated_at: number;
  exit_code: number | null; error: string | null; snapshot_state: ExecutionJob["snapshotState"]; snapshot_error: string | null;
  snapshot_path: string | null; local_revision: string; remote_revision: string | null; session_id: string | null; turn_id: number | null };
export type ExecutionCompletion = { jobId: string; workspaceId: string; sessionId: string; idempotencyKey: string; title: string; text: string };
type CompletionRow = { job_id: string; session_id: string; status: string; title: string | null; text: string | null };
type RemoteJob = { id: string; state: ExecutionJob["state"]; exitCode?: number; error?: string; output?: string;
  offset?: number; nextOffset?: number; outputBytes?: number; truncated?: boolean };
type AdmissionPhase = "prepared" | "submitting" | "accepted" | "rejected" | "uncertain";
type Admission = { phase: AdmissionPhase; first_error: string | null };
const rejectedAdmission = (error: unknown) => /EXECUTION_HTTP_(400|401|403|404|405|409|413|415|422):/.test(String(error));
const rejectedSnapshotConflict = (error: unknown) => /EXECUTION_HTTP_409:.*(?:Remote workspace (?:already exists|changed)|Workspace is running a program)/.test(String(error));
const terminal = (state: ExecutionJob["state"]) => ["completed", "failed", "cancelled", "interrupted"].includes(state);
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function utf8Prefix(bytes: Buffer, final: boolean): number {
  if (final || !bytes.length) return bytes.length;
  let start = bytes.length - 1;
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!, width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  return bytes.length - start < width ? start : bytes.length;
}

/** The control plane never executes arbitrary commands locally. */
export class ExecutionService {
  private readonly db: DatabaseSync;
  private readonly directory: string;
  private readonly endpoint?: string;
  private readonly token?: string;
  private readonly maxBytes: number;
  private description?:{expires:number;value:ReturnType<ExecutionService["runtimeDescription"]>};
  private draining = false;
  private closed = false;
  private readonly terminalReads = new Map<number,Promise<unknown>>();
  private readonly runBindings = new Map<string, { signal: AbortSignal; abort: () => void }>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string,Promise<void>>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly starting = new Set<string>();
  private readonly leases = new Map<string, ReturnType<WorkspaceService["acquireLease"]>>();
  private readonly leaseTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: ExecutionOptions) {
    this.directory = resolve(options.stateDirectory, "execution", createHash("sha256").update(options.agentId + "\0" + options.ownerUserId).digest("hex"));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, "jobs.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,state TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,exit_code INTEGER,error TEXT,snapshot_state TEXT NOT NULL,
      snapshot_error TEXT,snapshot_path TEXT,local_revision TEXT NOT NULL,remote_revision TEXT,session_id TEXT,turn_id INTEGER);
      CREATE TABLE IF NOT EXISTS execution_completions(job_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,status TEXT NOT NULL,
      title TEXT,text TEXT,next_attempt_at INTEGER NOT NULL DEFAULT 0,message_id TEXT);
      CREATE TABLE IF NOT EXISTS execution_polling(job_id TEXT PRIMARY KEY,last_polled_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL UNIQUE,owner_session TEXT NOT NULL,output_offset INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS workspace_sync(workspace_id TEXT PRIMARY KEY,remote_revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_origins(job_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_sync_origins(workspace_id TEXT PRIMARY KEY,endpoint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_repairs(job_id TEXT PRIMARY KEY,parent_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_admissions(job_id TEXT PRIMARY KEY,phase TEXT NOT NULL,first_error TEXT);
      CREATE TABLE IF NOT EXISTS execution_cancellations(job_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS execution_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,type TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_jobs_workspace ON jobs(workspace_id,created_at DESC)`);
    // An interrupted foreground wait has no synchronous reply after restart.
    if(options.recoverState!==false)prepareSql(this.db,"UPDATE execution_completions SET status='waiting' WHERE status='foreground'").run();
    const endpoint = options.endpoint;
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.search || url.hash || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        throw new Error("Execution worker requires HTTPS or a loopback HTTP endpoint without embedded credentials");
      this.endpoint = endpoint.replace(/\/+$/, "");
    }
    const previous=options.previousEndpoint?.replace(/\/+$/, "")??this.endpoint;
    if(previous && options.recoverState!==false){
      const url=new URL(previous);
      if(url.username || url.password || url.search || url.hash || url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw new Error("Invalid previous execution endpoint");
      prepareSql(this.db,"INSERT OR IGNORE INTO execution_origins SELECT id,? FROM jobs").run(previous);
      prepareSql(this.db,"INSERT OR IGNORE INTO workspace_sync_origins SELECT workspace_id,? FROM workspace_sync").run(previous);
    }
    this.token = options.token;
    this.maxBytes = Math.min(Math.max(options.maxSnapshotBytes ?? 512 * 1024 * 1024, 1024 * 1024), 2 * 1024 * 1024 * 1024);
    for (const row of (options.recoverState===false?[]:prepareSql(this.db, "SELECT id,workspace_id FROM jobs WHERE state IN ('starting','running') OR snapshot_state='pending'").all()) as Array<{ id: string; workspace_id: string }>) {
      this.leases.set(row.id, options.workspaces.acquireLease(row.workspace_id, row.id));
    }
    this.leaseTimer = setInterval(() => { for (const lease of this.leases.values()) { try { lease.renew(); } catch { /* Owner shutdown is reconciled on restart. */ } } }, 60_000);
    this.leaseTimer.unref();
  }

  get configured() { return Boolean(this.endpoint && this.token); }

  private bindRun(id: string, signal?: AbortSignal) {
    if (!signal) return;
    const abort = () => {
      // Release updates reconnect to durable jobs; an explicit stop owns cleanup.
      if (signal.reason instanceof AgentRunInterruption && signal.reason.kind === "service_shutdown") return;
      void this.cancel(id).catch(() => { /* The durable cancellation is retried by maintenance. */ });
    };
    this.runBindings.set(id, { signal, abort });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }

  private unbindRun(id: string) {
    const binding = this.runBindings.get(id);
    if (binding) binding.signal.removeEventListener("abort", binding.abort);
    this.runBindings.delete(id);
  }

  private cancelBeforeSubmission(id: string, signal?: AbortSignal): boolean {
    if (!signal?.aborted) return false;
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "UPDATE jobs SET state='cancelled',snapshot_state='saved',updated_at=? WHERE id=?").run(Date.now(), id);
      this.recordAdmission(id, "rejected", "程序提交前已取消。");
      prepareSql(this.db, "DELETE FROM execution_cancellations WHERE job_id=?").run(id);
      this.event(id, this.row(id).workspace_id, "cancelled");
    });
    this.unbindRun(id);
    this.releaseLease(id);
    return true;
  }

  async describe(force=false) {
    if(!force && this.description && this.description.expires>Date.now())return this.description.value;
    const value=this.runtimeDescription();const entry={expires:Date.now()+10_000,value};this.description=entry;
    void value.then(result=>{if(this.description===entry)entry.expires=Date.now()+(result.available?60_000:5_000);});
    return value;
  }
  private async runtimeDescription() {
    if (!this.configured) return { available: false, backend: "unavailable", reason: "执行环境尚未配置。", protocol: 1 };
    try {
      const identity = JSON.parse(await this.boundedText(await this.response("GET","/v1/health",undefined,undefined,10_000),256_000)) as WorkerIdentity;
      if (identity.protocol !== 1 || !["container","windows-native"].includes(identity.backend) || identity.agentId !== this.options.agentId || identity.ownerUserId !== this.options.ownerUserId)
        throw new Error("Execution worker identity does not match this Agent");
      return { available: true, backend: identity.backend, protocol: identity.protocol, image: identity.image, persistentWorkspace: true, arbitraryCodeOnHost: identity.backend==="windows-native",permissions:identity.permissions,
        admissionTracking: identity.admissionTracking === true,
        instanceId:identity.instanceId,hostEpoch:identity.hostEpoch,runtimeIdentity:identity.runtimeIdentity, capabilities:identity.capabilities, githubSshConfigured: identity.githubSshConfigured === true };
    } catch (error) { return { available: false, backend: "unavailable", protocol: 1, reason: String(error instanceof Error ? error.message : error) }; }
  }

  private async response(method: string, path: string, body?: unknown, headers?: Record<string, string>, timeoutMs=120_000): Promise<Response> {
    if (!this.configured || this.closed) throw new Error("执行环境尚未配置或已关闭。");
    const binary = body instanceof Uint8Array;
    const response = await fetch(this.requestEndpoint(path) + path, { method, headers: { authorization: "Bearer " + this.token,
      ...(body !== undefined ? { "content-type": binary ? "application/zip" : "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: binary ? body as Buffer : JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      const content = await this.boundedText(response, 4096).catch(() => "");
      let message = "执行服务暂时不可用。";
      try { message = String(JSON.parse(content).error ?? message).slice(0, 1000); } catch { /* Never echo HTTP proxy bodies or credentials. */ }
      throw new Error(`EXECUTION_HTTP_${response.status}: ${message}`);
    }
    return response;
  }
  private origin(id:string) {return (prepareSql(this.db,"SELECT endpoint FROM execution_origins WHERE job_id=?").get(id) as {endpoint:string}|undefined)?.endpoint??this.endpoint!;}
  private requestEndpoint(path:string) {
    const job=/^\/v1\/jobs\/([^/?]+)/.exec(path);if(job)return this.origin(decodeURIComponent(job[1]!));
    const workspace=/^\/v1\/workspaces\/([^/?]+)/.exec(path);
    if(workspace){const row=prepareSql(this.db,"SELECT id FROM jobs WHERE workspace_id=? AND (state IN ('starting','running') OR snapshot_state IN ('pending','failed','conflict')) ORDER BY created_at DESC LIMIT 1").get(decodeURIComponent(workspace[1]!)) as {id:string}|undefined;if(row)return this.origin(row.id);}
    return this.endpoint!;
  }
  private rememberBackend(workspaceId:string,id?:string) {prepareSql(this.db,"INSERT OR REPLACE INTO workspace_sync_origins VALUES (?,?)").run(workspaceId,id?this.origin(id):this.endpoint!);}
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.response(method, path, body);
    const text = await this.boundedText(response, 2 * 1024 * 1024);
    return JSON.parse(text) as T;
  }
  private async boundedText(response: Response, maximum: number): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > maximum) throw new Error("Execution response exceeded its limit");
        chunks.push(result.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private row(id: string): Row {
    const value = prepareSql(this.db, "SELECT * FROM jobs WHERE id=?").get(id) as Row | undefined;
    if (!value) throw new Error("找不到这次执行任务。");
    return value;
  }
  private view(row: Row): ExecutionJob {
    return { id: row.id, workspaceId: row.workspace_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}), ...(row.error ? { error: row.error } : {}), snapshotState: row.snapshot_state,
      ...(row.snapshot_error ? { snapshotError: row.snapshot_error } : {}) };
  }
  private event(id: string, workspace: string, type: string) {
    prepareSql(this.db, "INSERT INTO execution_events(job_id,workspace_id,type,created_at) VALUES (?,?,?,?)").run(id, workspace, type, Date.now());
  }

  private admission(id: string): Admission | undefined {
    return prepareSql(this.db, "SELECT phase,first_error FROM execution_admissions WHERE job_id=?").get(id) as Admission | undefined;
  }
  private recordAdmission(id: string, phase: AdmissionPhase, error?: unknown) {
    prepareSql(this.db, `INSERT INTO execution_admissions(job_id,phase,first_error) VALUES (?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET phase=excluded.phase,first_error=COALESCE(execution_admissions.first_error,excluded.first_error)`)
      .run(id, phase, error === undefined ? null : String(error instanceof Error ? error.message : error).slice(0, 1000));
    this.event(id, this.row(id).workspace_id, "admission_" + phase);
  }

  async start(workspaceId:string,input:ExecutionInput,context:ExecutionContext={}):Promise<ExecutionResult> {
    const previous=this.admissions.get(workspaceId)??Promise.resolve();let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});const tail=previous.catch(()=>{}).then(()=>gate);this.admissions.set(workspaceId,tail);
    await previous.catch(()=>{});
    const admitted=()=>{release();if(this.admissions.get(workspaceId)===tail)this.admissions.delete(workspaceId);};
    try{return await this.startJob(workspaceId,input,context,admitted);}finally{admitted();}
  }
  private async startJob(workspaceId: string, input: ExecutionInput, context: ExecutionContext, admittedGate:()=>void): Promise<ExecutionResult> {
    if (this.draining || this.closed) throw new Error("执行服务正在更新，请稍后重试。");
    if (!this.configured) throw new Error("执行环境尚未配置，不能在生产主机直接运行代码。");
    if (!input.command?.trim() || input.command.length > 64_000 || input.command.includes("\0")) throw new Error("执行命令无效。");
    const cwd = safeRelative(input.cwd ?? "", true);
    if (context.signal?.aborted) throw new Error("任务已取消。");
    this.options.workspaces.workspace(workspaceId);
    await Promise.all([...this.syncing.values()]);
    // Old versions left a missing remote job permanently attached to its project.
    // Reconcile its files before considering a repair; a repair requires a real parent.
    const stale = prepareSql(this.db, "SELECT id FROM jobs WHERE workspace_id=? AND state NOT IN ('starting','running') AND snapshot_state IN ('failed','conflict')")
      .all(workspaceId) as Array<{id:string}>;
    for (const row of stale) await this.read(row.id);
    const activeRows = prepareSql(this.db, "SELECT j.*,t.id AS terminal_id FROM jobs j LEFT JOIN terminal_sessions t ON t.job_id=j.id WHERE j.workspace_id=? AND (j.state IN ('starting','running') OR j.snapshot_state IN ('pending','conflict','failed')) ORDER BY j.created_at")
      .all(workspaceId) as Array<Row & {terminal_id:number|null}>;
    const active = activeRows[0];
    const fault=activeRows.find(row=>terminal(row.state) && ['failed','conflict'].includes(row.snapshot_state));
    if(input.terminal && fault && activeRows.every(row=>terminal(row.state))) {
      if (this.admission(fault.id)?.phase === "rejected" || fault.error?.includes("服务端未找到任务"))
        throw new Error("旧任务不存在，项目文件仍已保留；请等待快照核对完成，存在冲突时在文件面板恢复为独立项目。");
      return this.repair(fault.id,input,context);
    }
    if (this.starting.has(workspaceId) || active && (!input.terminal || activeRows.some(row=>!row.terminal_id || ['conflict','failed'].includes(row.snapshot_state))))
      throw new Error("工作区仍有旧任务或同步冲突，请在文件面板读取或恢复结果。");
    this.starting.add(workspaceId);
    let id = "";
    try {
      const health = await this.describe();
      if (!health.available) throw new Error("reason" in health ? health.reason : "执行环境不可用。");
      id = randomUUID();
      this.leases.set(id, this.options.workspaces.acquireLease(workspaceId, id));
      const snapshot = active ? {revision:active.local_revision,bytes:undefined} : await makeSnapshot(this.options.workspaces, workspaceId, this.maxBytes);
      const sync = prepareSql(this.db, "SELECT s.remote_revision FROM workspace_sync s JOIN workspace_sync_origins o USING(workspace_id) WHERE s.workspace_id=? AND o.endpoint=?").get(workspaceId,this.endpoint!) as { remote_revision: string } | undefined;
      const now = Date.now();
      context.signal?.throwIfAborted();
      sqliteTransaction(this.db, () => {
        prepareSql(this.db, "INSERT INTO jobs VALUES (?,?,?,?,?,NULL,NULL,'pending',NULL,NULL,?,?,?,?)")
          .run(id, workspaceId, "starting", now, now, snapshot.revision, sync?.remote_revision ?? null, context.sessionId ?? null, context.turnId ?? null);
        prepareSql(this.db,"INSERT INTO execution_origins VALUES (?,?)").run(id,this.endpoint!);
        if(input.terminal)prepareSql(this.db,"INSERT INTO terminal_sessions(job_id,owner_session) VALUES (?,?)").run(id,context.sessionId ?? "");
        if(context.sessionId && !input.terminal)prepareSql(this.db,"INSERT INTO execution_completions(job_id,session_id,status) VALUES (?,?,'foreground')").run(id,context.sessionId);
        this.event(id, workspaceId, "starting");
        this.recordAdmission(id, "prepared");
      });
      this.bindRun(id, context.signal);
      let admitted = false;
      try {
        if (!active) {
          const imported = await (await this.response("PUT", `/v1/workspaces/${encodeURIComponent(workspaceId)}/snapshot`, snapshot.bytes!,
            { "x-expected-revision": sync?.remote_revision ?? "new" })).json() as {revision:string};
          if (this.closed) throw new Error("执行服务已关闭。");
          prepareSql(this.db,"INSERT OR REPLACE INTO workspace_sync VALUES (?,?)").run(workspaceId,imported.revision);this.rememberBackend(workspaceId);
          prepareSql(this.db,"UPDATE jobs SET remote_revision=? WHERE id=?").run(imported.revision,id);
        }
        if (this.cancelBeforeSubmission(id, context.signal))
          return this.backgroundResult({ ...this.view(this.row(id)), output: "", offset: 0, nextOffset: 0, outputBytes: 0, truncated: false });
        admitted = true;
        this.recordAdmission(id, "submitting");
        await this.request<RemoteJob>("POST", "/v1/jobs", { id, workspaceId, command: input.command, cwd,
          timeoutMs: Math.min(Math.max(input.timeoutMs ?? 24 * 60 * 60_000, 1000), 24 * 60 * 60_000), ...(input.terminal?{terminal:input.terminal}:{}) });
        this.recordAdmission(id, "accepted");
      } catch (error) {
        if (this.closed) throw new Error("执行服务已关闭，任务将在重启后核对。");
        const rejected = rejectedAdmission(error);
        this.recordAdmission(id, rejected ? "rejected" : "uncertain", error);
        if (rejected) {
          this.unbindRun(id);
          const message = String(error instanceof Error ? error.message : error);
          const remoteConflict = !admitted && rejectedSnapshotConflict(message);
          // Definite rejection created no command. Preserve both project trees
          // before resetting the synchronization baseline; never replay the command.
          sqliteTransaction(this.db, () => {
            prepareSql(this.db, "UPDATE jobs SET state='failed',snapshot_state=?,snapshot_error=?,local_revision=?,error=?,updated_at=? WHERE id=?")
              .run(remoteConflict ? "conflict" : "saved", remoteConflict ? "远端工作区保留了不同状态，请恢复为独立项目后继续。" : null,
                snapshot.revision, message, Date.now(), id);
            this.event(id, workspaceId, remoteConflict ? "snapshot_conflict" : "failed");
          });
          if (!remoteConflict) this.releaseLease(id);
          else await this.reconcileRejectedSnapshot(id);
          if (/EXECUTION_HTTP_404:/.test(message)) {
            prepareSql(this.db, "DELETE FROM workspace_sync WHERE workspace_id=?").run(workspaceId);
            prepareSql(this.db, "DELETE FROM workspace_sync_origins WHERE workspace_id=?").run(workspaceId);
          }
        }
        // A transport timeout does not prove the command was not admitted. Keep the ID for reconciliation.
        if (!rejected) prepareSql(this.db, "UPDATE jobs SET error=?,updated_at=? WHERE id=?").run(String(error instanceof Error ? error.message : error), Date.now(), id);
        return this.backgroundResult({ ...this.view(this.row(id)), output: "", offset: 0, nextOffset: 0, outputBytes: 0, truncated: false });
      }
    } catch (error) {
      if (id && !this.closed && !prepareSql(this.db, "SELECT id FROM jobs WHERE id=?").get(id)) this.releaseLease(id);
      throw error;
    } finally {
      this.starting.delete(workspaceId); admittedGate();
      if (id && !this.closed && prepareSql(this.db, "SELECT job_id FROM execution_cancellations WHERE job_id=?").get(id))
        await this.cancel(id).catch(() => {});
    }
    const until = Date.now() + Math.min(Math.max(input.waitMs ?? 1000, 0), 30_000);
    let result = await this.read(id);
    while (!terminal(result.state) && Date.now() < until && !context.signal?.aborted) { await sleep(Math.min(250, until - Date.now())); result = await this.read(id); }
    return this.backgroundResult(result);
  }

  async read(id: string, offset = 0, limit = 16_000): Promise<ExecutionResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64_000) throw new Error("输出范围无效。");
    const row = this.row(id);
    if (terminal(row.state)) this.unbindRun(id);
    const admission = this.admission(id);
    if (admission?.phase === "rejected" && ["conflict", "failed"].includes(row.snapshot_state)
      && rejectedSnapshotConflict(admission.first_error)) {
      await this.reconcileRejectedSnapshot(id);
      return { ...this.view(this.row(id)), output: "", offset, nextOffset: offset, outputBytes: offset, truncated: false };
    }
    // A reconciliation tick can run while snapshot upload/POST is still in flight.
    // Until admission finishes, a worker 404 says nothing about the new command.
    if ((row.state === "starting" && this.starting.has(row.workspace_id) && admission?.phase !== "accepted")
      || admission?.phase === "rejected")
      return { ...this.view(row), output: "", offset, nextOffset: offset, outputBytes: offset, truncated: false };
    if (terminal(row.state) && ["saved", "superseded", "conflict"].includes(row.snapshot_state)) {
      const cached = await this.localOutput(row, offset, limit);
      if (cached) return cached;
    }
    let remote: RemoteJob;
    try { remote = await this.request<RemoteJob>("GET", `/v1/jobs/${encodeURIComponent(id)}?offset=${offset}&limit=${limit}`); }
    catch (error) {
      if (this.closed) throw new Error("执行服务已关闭。");
      if (String(error).includes("EXECUTION_HTTP_404")) {
        const current = this.row(id);
        if (terminal(current.state) && ["saved", "superseded"].includes(current.snapshot_state)) return { ...this.view(current), output: "", offset, nextOffset: offset, outputBytes: offset, truncated: false };
        await this.markMissingJob(id);
      }
      const saved = this.view(this.row(id));
      return { ...saved, error: saved.error ?? String(error instanceof Error ? error.message : error), output: "", offset, nextOffset: offset, outputBytes: offset, truncated: false };
    }
    if (this.closed) throw new Error("执行服务已关闭。");
    if (!["starting", "running", "completed", "failed", "cancelled", "interrupted"].includes(remote.state)) throw new Error("Invalid worker job state");
    if (terminal(remote.state)) {
      this.unbindRun(id);
      prepareSql(this.db, "DELETE FROM execution_cancellations WHERE job_id=?").run(id);
    }
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "UPDATE jobs SET state=?,exit_code=?,error=?,updated_at=? WHERE id=?")
        .run(remote.state, remote.exitCode ?? null, remote.error ?? null, Date.now(), id);
      if (row.state !== remote.state) this.event(id, row.workspace_id, remote.state);
      const repair = prepareSql(this.db, "SELECT parent_id FROM job_repairs WHERE job_id=?").get(id) as { parent_id: string } | undefined;
      if (repair) {
        prepareSql(this.db, "UPDATE jobs SET snapshot_state='superseded',snapshot_error=? WHERE id=?").run("结果由修复任务继续处理。", repair.parent_id);
        this.releaseLease(repair.parent_id);
      }
    });
    if (terminal(remote.state) && !["saved", "superseded"].includes(this.row(id).snapshot_state)) await this.synchronize(id);
    return { ...this.view(this.row(id)), output: remote.output ?? "", offset: remote.offset ?? offset,
      nextOffset: remote.nextOffset ?? offset, outputBytes: remote.outputBytes ?? offset, truncated: remote.truncated ?? false };
  }

  private async markMissingJob(id: string) {
    const row = this.row(id), original = this.admission(id)?.first_error ?? row.error;
    const message = original?.includes("服务端未找到任务") ? original
      : (original ? original + "；" : "") + "服务端未找到任务，命令未自动重放。";
    prepareSql(this.db, `UPDATE jobs SET state='interrupted',error=?,
      snapshot_state=CASE WHEN snapshot_state='conflict' THEN 'conflict' ELSE 'failed' END,
      snapshot_error=?,updated_at=? WHERE id=?`)
      .run(message, "远端任务不存在，正在核对项目快照。", Date.now(), id);
    this.event(id, row.workspace_id, "remote_job_missing");
    if (row.snapshot_state === "conflict" && row.snapshot_path) return;
    await this.reconcileMissingJob(id);
  }

  /** A missing task is not a missing project. Preserve its files before releasing the blocker. */
  private async reconcileMissingJob(id: string) {
    if (this.origin(id) !== this.endpoint) return;
    const health = await this.describe(true);
    if (!health.available || !("admissionTracking" in health) || !health.admissionTracking || this.closed) return;
    await this.synchronize(id);
    if (this.closed) return;
    const row = this.row(id);
    if (row.snapshot_state !== "failed" || row.snapshot_path || !row.snapshot_error?.includes("EXECUTION_HTTP_404:")
      || this.origin(id) !== this.endpoint) return;
    // Only an authenticated, identity-checked worker may confirm that both the
    // task and remote project are absent. Transport failures never clear state.
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "UPDATE jobs SET snapshot_state='superseded',snapshot_error=?,updated_at=? WHERE id=?")
        .run("远端任务与项目均不存在，已保留本地文件；后续新命令可重新同步项目。", Date.now(), id);
      prepareSql(this.db, "DELETE FROM workspace_sync WHERE workspace_id=?").run(row.workspace_id);
      prepareSql(this.db, "DELETE FROM workspace_sync_origins WHERE workspace_id=?").run(row.workspace_id);
      this.event(id, row.workspace_id, "missing_job_reconciled");
    });
    this.releaseLease(id);
  }

  private synchronize(id: string): Promise<void> {
    const workspace=this.row(id).workspace_id;
    const pending=this.syncing.get(workspace);if(pending)return pending;
    const operation=this.saveSnapshot(id).finally(()=>this.syncing.delete(workspace));
    this.syncing.set(workspace,operation);return operation;
  }
  private async saveSnapshot(id: string): Promise<void> {
    const row = this.row(id);
    try {
      const isTerminal=Boolean(prepareSql(this.db,"SELECT id FROM terminal_sessions WHERE job_id=?").get(id));
      if(isTerminal && prepareSql(this.db,"SELECT id FROM jobs WHERE workspace_id=? AND state IN ('starting','running')").get(row.workspace_id))return;
      let response: Response;
      try { response = await this.response("GET", `/v1/jobs/${encodeURIComponent(id)}/snapshot`); }
      catch (error) {
        if (!String(error).includes("EXECUTION_HTTP_404")) throw error;
        response = await this.response("GET", `/v1/workspaces/${encodeURIComponent(row.workspace_id)}/snapshot`);
      }
      if (this.closed) return;
      const length = Number(response.headers.get("content-length"));
      if (length > this.maxBytes + 32 * 1024 * 1024) throw new Error("项目快照超过传输限制。");
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > this.maxBytes + 32 * 1024 * 1024) { await response.body?.cancel().catch(() => {}); throw new Error("项目快照超过传输限制。"); }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks), directory = join(this.directory, "snapshots");
      if (this.closed) return;
      decodeSnapshot(bytes, this.maxBytes);
      await mkdir(directory, { recursive: true });
      const path = join(directory, id + ".zip"), temporary = path + ".part";
      const file = await open(temporary, "w", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      if (this.closed) return;
      prepareSql(this.db, "UPDATE jobs SET snapshot_path=? WHERE id=?").run(path, id);
      const logDigest = await this.saveLog(id).catch(() => undefined);
      if (logDigest) await this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/acknowledge`, {
        snapshotSha256: createHash("sha256").update(bytes).digest("hex"), logSha256: logDigest
      }).catch(() => {});
      const revision = await applySnapshot(this.options.workspaces, row.workspace_id, bytes, row.local_revision, this.maxBytes);
      if (this.closed) return;
      sqliteTransaction(this.db, () => {
        prepareSql(this.db, "UPDATE jobs SET snapshot_state='saved',snapshot_error=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
        prepareSql(this.db, "INSERT OR REPLACE INTO workspace_sync VALUES (?,?)").run(row.workspace_id, revision);this.rememberBackend(row.workspace_id,id);
        this.event(id, row.workspace_id, "snapshot_saved");
      });
      if(isTerminal) {
        const siblings=prepareSql(this.db,"SELECT j.* FROM jobs j JOIN terminal_sessions t ON t.job_id=j.id WHERE j.workspace_id=? AND j.state NOT IN ('starting','running') AND j.snapshot_state='pending' AND j.local_revision=?").all(row.workspace_id,row.local_revision) as Row[];
        for(const sibling of siblings) {
          const logHash=await this.saveLog(sibling.id).catch(()=>undefined);
          try {
            const exported=await this.request<{snapshotSha256:string;size:number}>("GET",`/v1/jobs/${sibling.id}/export`);
            let siblingPath=path;
            if(exported.snapshotSha256!==createHash("sha256").update(bytes).digest("hex")) {
              const response=await this.response('GET',`/v1/jobs/${sibling.id}/snapshot`);
              const archive=Buffer.from(await response.arrayBuffer());
              if(archive.length>this.maxBytes+32*1024*1024 || archive.length!==exported.size || createHash('sha256').update(archive).digest('hex')!==exported.snapshotSha256)throw new Error('命令快照校验失败。');
              decodeSnapshot(archive,this.maxBytes);siblingPath=join(directory,sibling.id+'.zip');
              await this.writeArchive(siblingPath,archive);
            }
            prepareSql(this.db,'UPDATE jobs SET snapshot_path=? WHERE id=?').run(siblingPath,sibling.id);
            if(logHash)await this.request('POST',`/v1/jobs/${sibling.id}/acknowledge`,{snapshotSha256:exported.snapshotSha256,logSha256:logHash});
          }catch { /* Retain unacknowledged remote bytes for recovery instead of discarding them. */ }
          prepareSql(this.db,"UPDATE jobs SET snapshot_state='saved',snapshot_error=NULL,updated_at=? WHERE id=?").run(Date.now(),sibling.id);
          this.releaseLease(sibling.id);
        }
      }
      this.releaseLease(id);
      await this.options.onSynchronized?.(row.workspace_id).catch(()=>{});
    } catch (error) {
      if (this.closed) return;
      const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
      if(/EXECUTION_HTTP_409/.test(message) && /running a program|still running/.test(message))return;
      prepareSql(this.db, "UPDATE jobs SET snapshot_state=?,snapshot_error=?,updated_at=? WHERE id=?")
        .run(message.includes("Workspace changed") ? "conflict" : "failed", message, Date.now(), id);
      this.event(id, row.workspace_id, "snapshot_failed");
    }
  }

  private async writeArchive(path:string,bytes:Buffer) {
    const temporary=path+'.part',file=await open(temporary,'w',0o600);
    try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
    await rename(temporary,path);
  }
  private async saveLog(id: string) {
    const response = await this.response("GET", `/v1/jobs/${encodeURIComponent(id)}/log`);
    const directory = join(this.directory, "logs"); await mkdir(directory, { recursive: true });
    const path = join(directory, id + ".log"), temporary = path + ".part";
    const file = await open(temporary, "w", 0o600), digest = createHash("sha256"); let size = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > 128 * 1024 * 1024) throw new Error("执行日志超过保留预算。");
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk.subarray(offset));
          if (!written.bytesWritten) throw new Error("执行日志写入未完成。");
          offset += written.bytesWritten;
        }
      }
      await file.sync(); await file.close(); await rename(temporary, path);
      return digest.digest("hex");
    } catch (error) { await file.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
  }
  private async localOutput(row: Row, offset: number, limit: number): Promise<ExecutionResult | undefined> {
    let file;
    try { file = await open(join(this.directory, "logs", row.id + ".log"), "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const info = await file.stat(), start = Math.min(offset, info.size), bytes = Buffer.alloc(Math.min(Math.max(4, limit), info.size - start));
      const result = await file.read(bytes, 0, bytes.length, start);
      const consumed = utf8Prefix(bytes.subarray(0, result.bytesRead), start + result.bytesRead === info.size);
      return { ...this.view(row), output: bytes.subarray(0, consumed).toString("utf8"), offset: start,
        nextOffset: start + consumed, outputBytes: info.size, truncated: start + consumed < info.size };
    } finally { await file.close(); }
  }

  private releaseLease(id: string) { this.leases.get(id)?.release(); this.leases.delete(id); }

  /** Rejected uploads have no remote command to repair. Reconcile files instead. */
  private reconcileRejectedSnapshot(id: string): Promise<void> {
    const row = this.row(id), pending = this.syncing.get(row.workspace_id);
    if (pending) return pending;
    const operation = this.saveRejectedSnapshot(id).finally(() => this.syncing.delete(row.workspace_id));
    this.syncing.set(row.workspace_id, operation);
    return operation;
  }
  private async saveRejectedSnapshot(id: string): Promise<void> {
    const row = this.row(id);
    if (this.origin(id) !== this.endpoint || this.closed || !terminal(row.state)
      || this.admission(id)?.phase !== "rejected" || !rejectedSnapshotConflict(this.admission(id)?.first_error)) return;
    if (prepareSql(this.db, "SELECT id FROM jobs WHERE workspace_id=? AND state IN ('starting','running') LIMIT 1").get(row.workspace_id)) return;
    try {
      const health = await this.describe(true);
      if (!health.available || !health.admissionTracking) return;
      const response = await this.response("GET", `/v1/workspaces/${encodeURIComponent(row.workspace_id)}/snapshot`);
      const bytes = await this.snapshotBytes(response), snapshot = decodeSnapshot(bytes, this.maxBytes);
      const directory = join(this.directory, "snapshots");
      await mkdir(directory, { recursive: true });
      const path = join(directory, id + ".zip");
      await this.writeArchive(path, bytes);
      if (this.closed) return;
      prepareSql(this.db, "UPDATE jobs SET snapshot_path=? WHERE id=?").run(path, id);
      const sync = prepareSql(this.db, `SELECT s.remote_revision FROM workspace_sync s
        JOIN workspace_sync_origins o USING(workspace_id) WHERE s.workspace_id=? AND o.endpoint=?`)
        .get(row.workspace_id, this.endpoint!) as { remote_revision: string } | undefined;
      const local = await makeSnapshot(this.options.workspaces, row.workspace_id, this.maxBytes);
      if (local.revision !== snapshot.revision && snapshot.revision !== sync?.remote_revision) {
        if (local.revision === sync?.remote_revision) {
          // Only the remote tree changed since the last successful synchronization.
          await applySnapshot(this.options.workspaces, row.workspace_id, bytes, local.revision, this.maxBytes);
        } else {
          // No common baseline: keep the local tree and retain a separate remote copy.
          const source = this.options.workspaces.workspace(row.workspace_id);
          const recovered = await this.options.workspaces.createWorkspace({ name: `${source.name.slice(0, 100)} · 恢复结果` });
          const empty = await makeSnapshot(this.options.workspaces, recovered.id, this.maxBytes);
          await applySnapshot(this.options.workspaces, recovered.id, bytes, empty.revision, this.maxBytes);
          this.event(id, row.workspace_id, "snapshot_recovered");
        }
      }
      if (this.closed) return;
      sqliteTransaction(this.db, () => {
        prepareSql(this.db, "UPDATE jobs SET snapshot_state='superseded',snapshot_error=NULL,error=?,updated_at=? WHERE id=?")
          .run("项目快照已自动核对并保留；本次命令未执行，请重新提交命令。", Date.now(), id);
        prepareSql(this.db, "INSERT OR REPLACE INTO workspace_sync VALUES (?,?)").run(row.workspace_id, snapshot.revision);
        this.rememberBackend(row.workspace_id, id);
        this.event(id, row.workspace_id, "rejected_snapshot_reconciled");
      });
      this.releaseLease(id);
      await this.options.onSynchronized?.(row.workspace_id).catch(() => {});
    } catch (error) {
      if (this.closed) return;
      prepareSql(this.db, "UPDATE jobs SET snapshot_error=?,updated_at=? WHERE id=?")
        .run(String(error instanceof Error ? error.message : error).slice(0, 1000), Date.now(), id);
    }
  }

  private async snapshotBytes(response: Response): Promise<Buffer> {
    const maximum = this.maxBytes + 32 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body?.cancel().catch(() => {});
      throw new Error("项目快照超过传输限制。");
    }
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maximum) throw new Error("项目快照超过传输限制。");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** Repair executes only inside the existing isolated project; it never discards its faulted files. */
  async repair(parentId: string, input: ExecutionInput, context: ExecutionContext = {}): Promise<ExecutionResult> {
    if(this.origin(parentId)!==this.endpoint)throw new Error('旧执行环境仍保留未同步结果，请先恢复为独立项目后再使用新环境。');
    if (this.draining || this.closed) throw new Error("执行服务正在更新，请稍后重试。");
    const parent = this.row(parentId), workspaceId = parent.workspace_id;
    if (!terminal(parent.state) || !["failed", "conflict"].includes(parent.snapshot_state)) throw new Error("该任务不需要修复，请读取结果或恢复为新项目。");
    if (!input.command?.trim() || input.command.length > 64_000 || input.command.includes("\0")) throw new Error("修复命令无效。");
    const cwd = safeRelative(input.cwd ?? "", true);
    if (context.signal?.aborted) throw new Error("任务已取消。");
    if (this.starting.has(workspaceId) || prepareSql(this.db, "SELECT id FROM jobs WHERE workspace_id=? AND state IN ('starting','running') LIMIT 1").get(workspaceId)) throw new Error("工作区仍有运行中的任务。");
    this.starting.add(workspaceId);
    const id = randomUUID(), now = Date.now();
    this.leases.set(id, this.options.workspaces.acquireLease(workspaceId, id));
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "INSERT INTO jobs VALUES (?,?,?,?,?,NULL,NULL,'pending',NULL,NULL,?,?,?,?)")
        .run(id, workspaceId, "starting", now, now, parent.local_revision, parent.remote_revision, context.sessionId ?? null, context.turnId ?? null);
      prepareSql(this.db, "INSERT INTO job_repairs VALUES (?,?)").run(id, parentId);
      prepareSql(this.db,"INSERT INTO execution_origins VALUES (?,?)").run(id,this.endpoint!);
      if(input.terminal)prepareSql(this.db,"INSERT INTO terminal_sessions(job_id,owner_session) VALUES (?,?)").run(id,context.sessionId??"");
      if(context.sessionId && !input.terminal)prepareSql(this.db,"INSERT INTO execution_completions(job_id,session_id,status) VALUES (?,?,'foreground')").run(id,context.sessionId);
      this.event(id, workspaceId, "starting");
      this.recordAdmission(id, "submitting");
    });
    this.bindRun(id, context.signal);
    try {
      await this.request("POST", "/v1/jobs", { id, workspaceId, command: input.command, cwd,
        timeoutMs: Math.min(Math.max(input.timeoutMs ?? 30 * 60_000, 1000), 24 * 60 * 60_000), repairOf: parentId,...(input.terminal?{terminal:input.terminal}:{}) });
      if (this.closed) throw new Error("执行服务已关闭。");
      this.recordAdmission(id, "accepted");
      prepareSql(this.db, "UPDATE jobs SET snapshot_state='superseded',snapshot_error=? WHERE id=?").run("结果由修复任务继续处理。", parentId);
      this.releaseLease(parentId);
      this.event(parentId, workspaceId, "repair_started");
    } catch (error) {
      if (this.closed) throw error;
      this.recordAdmission(id, rejectedAdmission(error) ? "rejected" : "uncertain", error);
      if (rejectedAdmission(error)) {
        prepareSql(this.db, "UPDATE jobs SET state='failed',snapshot_state='superseded',error=?,updated_at=? WHERE id=?").run(String(error instanceof Error ? error.message : error), Date.now(), id);
        this.releaseLease(id);
      }
      if (String(error).includes("EXECUTION_HTTP_404:")) await this.markMissingJob(parentId);
      return this.backgroundResult({ ...this.view(this.row(id)), error: String(error instanceof Error ? error.message : error), output: "", offset: 0, nextOffset: 0, outputBytes: 0, truncated: false });
    } finally {
      this.starting.delete(workspaceId);
      if (!this.closed && prepareSql(this.db, "SELECT job_id FROM execution_cancellations WHERE job_id=?").get(id))
        await this.cancel(id).catch(() => {});
    }
    const until = Date.now() + Math.min(Math.max(input.waitMs ?? 1000, 0), 10_000);
    let result = await this.read(id);
    while (!terminal(result.state) && Date.now() < until && !context.signal?.aborted) { await sleep(Math.min(250, until - Date.now())); result = await this.read(id); }
    return this.backgroundResult(result);
  }

  /** Conflicting results become a new project; local edits are never overwritten. */
  async recover(id: string) {
    let row = this.row(id);
    if (!terminal(row.state)) throw new Error("请等待程序结束后恢复结果。");
    if (!row.snapshot_path) { await this.synchronize(id); row = this.row(id); }
    if (!row.snapshot_path) {
      if (row.state === "interrupted" && row.snapshot_error?.includes("EXECUTION_HTTP_404")) {
        prepareSql(this.db, "UPDATE jobs SET snapshot_state='superseded',snapshot_error=? WHERE id=?").run("远端任务与工作区均不存在，已保留本地项目，可重新开始。", id);
        prepareSql(this.db, "DELETE FROM workspace_sync WHERE workspace_id=?").run(row.workspace_id);
        this.releaseLease(id);
        return { jobId: id, workspace: this.options.workspaces.workspace(row.workspace_id), recovered: false, localWorkspacePreserved: true };
      }
      throw new Error(row.snapshot_error ?? "尚无可恢复的项目快照。");
    }
    const bytes = await readFile(row.snapshot_path), snapshot = decodeSnapshot(bytes, this.maxBytes);
    const source = this.options.workspaces.workspace(row.workspace_id);
    const workspace = await this.options.workspaces.createWorkspace({ name: `${source.name.slice(0, 100)} · 恢复结果` });
    const empty = await makeSnapshot(this.options.workspaces, workspace.id, this.maxBytes);
    await applySnapshot(this.options.workspaces, workspace.id, bytes, empty.revision, this.maxBytes);
    if (this.closed) throw new Error("执行服务已关闭。");
    sqliteTransaction(this.db, () => {
      prepareSql(this.db, "UPDATE jobs SET snapshot_state='saved',snapshot_error=NULL,updated_at=? WHERE id=?").run(Date.now(), id);
      prepareSql(this.db, "INSERT OR REPLACE INTO workspace_sync VALUES (?,?)").run(row.workspace_id, snapshot.revision);this.rememberBackend(row.workspace_id,id);
      this.event(id, row.workspace_id, "snapshot_recovered");
    });
    this.releaseLease(id);
    return { jobId: id, workspace, recovered: true };
  }

  terminalSessions(owner:string) {
    return (prepareSql(this.db,"SELECT t.id,j.workspace_id,j.state,j.exit_code,j.updated_at FROM terminal_sessions t JOIN jobs j ON j.id=t.job_id WHERE t.owner_session=? ORDER BY j.updated_at DESC LIMIT 20").all(owner) as Array<{id:number;workspace_id:string;state:string;exit_code:number|null;updated_at:number}>)
      .map(row=>({session_id:row.id,environment_id:row.workspace_id,state:row.state,...(row.exit_code===null?{}:{exit_code:row.exit_code}),updated_at:row.updated_at}));
  }
  private terminalSession(id:number,owner:string) {
    const row=prepareSql(this.db,"SELECT * FROM terminal_sessions WHERE id=? AND owner_session=?").get(id,owner) as {id:number;job_id:string;output_offset:number}|undefined;
    if(!row)throw new Error("找不到当前会话的命令进程。");return row;
  }
  async execCommand(workspaceId:string,input:{cmd:string;workdir?:string;shell?:string;login?:boolean;tty?:boolean;timeout_ms?:number;yield_time_ms?:number;max_output_tokens?:number},context:ExecutionContext) {
    const health=await this.describe();
    if(!health.available || !('capabilities' in health) || health.capabilities?.commandRuntime?.engine!=='zigent-native')throw new Error('独立执行环境尚未就绪，请先完成运行时更新。');
    const windows=health.backend==='windows-native';
    const cwd=await this.workspaceRelativePath(workspaceId,input.workdir??(windows?'.':'/workspace'),true);
    const result=await this.start(workspaceId,{command:input.cmd,cwd,timeoutMs:input.timeout_ms,waitMs:input.yield_time_ms ?? 10_000,terminal:{tty:input.tty??false,shell:input.shell??(windows?'pwsh':'/bin/bash'),login:input.login??!windows}},context);
    const row=prepareSql(this.db,"SELECT id FROM terminal_sessions WHERE job_id=?").get(result.id) as {id:number};
    return this.terminalOutput(row.id,context.sessionId??'',input.max_output_tokens??10_000,0,context.signal);
  }
  async workspaceRelativePath(workspaceId:string,path:string,empty=false):Promise<string> {
    const health=await this.describe();
    if(health.available && health.backend==='windows-native' && 'capabilities' in health){
      const root=health.capabilities?.workspaceRoot;
      if(win32.isAbsolute(path)){
        if(!root || path.startsWith('\\\\'))throw new Error('文件路径必须属于当前执行工作区。');
        path=win32.relative(win32.join(root,workspaceId),path);
      }
      return safeRelative(path.replaceAll('\\','/'),empty);
    }
    if(path==='/workspace')return safeRelative('',empty);
    return safeRelative(path.startsWith('/workspace/')?path.slice(11):path,empty);
  }
  private async terminalOutput(sessionId:number,owner:string,tokens:number,wait:number,signal?:AbortSignal):Promise<{chunk_id:string;wall_time_seconds:number;output:string;session_id?:number;exit_code?:number;workspace_state?:string;error?:string;workspace_error?:string;truncated:boolean}> {
    const previous=this.terminalReads.get(sessionId)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.readTerminalOutput(sessionId,owner,tokens,wait,signal));this.terminalReads.set(sessionId,operation);
    try{return await operation;}finally{if(this.terminalReads.get(sessionId)===operation)this.terminalReads.delete(sessionId);}
  }
  private async readTerminalOutput(sessionId:number,owner:string,tokens:number,wait:number,signal?:AbortSignal) {
    const session=this.terminalSession(sessionId,owner),started=Date.now(),limit=Math.max(4,Math.min(64_000,tokens*4));
    let result=await this.read(session.job_id,session.output_offset,limit);
    while(!signal?.aborted && !terminal(result.state) && result.nextOffset===session.output_offset && Date.now()-started<wait) {
      await sleep(Math.min(200,wait-(Date.now()-started)));result=await this.read(session.job_id,session.output_offset,limit);
    }
    prepareSql(this.db,"UPDATE terminal_sessions SET output_offset=? WHERE id=?").run(result.nextOffset,session.id);
    return {chunk_id:randomUUID().slice(0,8),wall_time_seconds:(Date.now()-started)/1000,output:result.output,
      ...(!terminal(result.state)||result.truncated?{session_id:session.id}:{}),
      execution_state:result.state,
      ...(terminal(result.state)&&result.exitCode!==undefined?{exit_code:result.exitCode}:{}),
      ...(result.snapshotState!=='saved'?{workspace_state:result.snapshotState}:{}),
      ...(result.error?{error:result.error}:{}),...(result.snapshotError?{workspace_error:result.snapshotError}:{}),truncated:result.truncated};
  }
  async applyPatch(workspaceId:string,patch:string,context:ExecutionContext) {
    if(patch.includes("\0"))throw new Error("补丁必须是文字文件内容。");
    const length=Buffer.byteLength(patch);
    const program=`import sys,subprocess;patch=sys.stdin.buffer.read(${length});sys.exit(subprocess.run(['apply_patch'],input=patch).returncode)`;
    const health=await this.describe();const windows=health.available && health.backend==='windows-native';
    const cmd=windows?"python -c '"+program.replaceAll("'","''")+"'":"python3 -c '"+program.replaceAll("'","'\\''")+"'";
    const started=await this.execCommand(workspaceId,{cmd,login:false,yield_time_ms:250},context);
    if(!('session_id' in started) || !started.session_id)return started;
    const session=this.terminalSession(started.session_id,context.sessionId??'');
    await this.writeStdin(session.job_id,patch);
    return this.terminalOutput(session.id,context.sessionId??'',10_000,10_000,context.signal);
  }
  async terminalInput(sessionId:number,chars:string,owner:string,tokens=10_000,wait?:number,signal?:AbortSignal) {
    const session=this.terminalSession(sessionId,owner);
    if(chars)await this.writeStdin(session.job_id,chars);
    const result=await this.terminalOutput(sessionId,owner,tokens,Math.min(wait??(chars?250:5000),300_000),signal);
    return {...result,...(chars.includes('\u0003')?{interrupt_requested:true}:{})};
  }
  async derivePreview(bytes:Buffer,name:string,sha256:string) {
    for(let attempt=0;attempt<2;attempt++){
      const health=await this.describe();const expected=health.available && health.backend==='windows-native' && 'runtimeIdentity' in health?health.runtimeIdentity:undefined;
      try{
        const response=await this.response('POST','/v1/derived/preview',{source:bytes.toString('base64'),name,sha256,...(expected?{expectedRuntimeIdentity:expected}:{})},{},300_000);
        return JSON.parse(await this.boundedText(response,360*1024*1024)) as {pdf:string;sha256:string;totalPages:number;warnings:string[];runtimeIdentity?:string};
      }catch(error){if(attempt===0 && String(error).includes('RENDERING_RUNTIME_CHANGED')){this.description=undefined;continue;}throw error;}
    }
    throw new Error('渲染环境已改变，请重试。');
  }
  hasPendingWorkspace(workspaceId:string) {
    return Boolean(prepareSql(this.db,"SELECT id FROM jobs WHERE workspace_id=? AND (state IN ('starting','running') OR snapshot_state IN ('pending','conflict','failed'))").get(workspaceId));
  }
  async listWorkingFiles(workspaceId:string,path='.',offset=0,limit=100) {
    if(!this.hasPendingWorkspace(workspaceId))return this.options.workspaces.listFiles(workspaceId,path,offset,limit);
    const relative=safeRelative(path,true);
    return this.request<import('../workspaces/types.js').FilePage>('GET',`/v1/workspaces/${workspaceId}/files?path=${encodeURIComponent(relative)}&offset=${offset}&limit=${limit}`);
  }
  async readRemoteFile(workspaceId:string,path:string) {
    if(!this.hasPendingWorkspace(workspaceId))return (await this.options.workspaces.readFileBytes(workspaceId,path)).bytes;
    const response=await this.response("GET",`/v1/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(safeRelative(path))}`);
    const length=Number(response.headers.get('content-length'));if(length>256*1024*1024)throw new Error('文件过大。');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>256*1024*1024)throw new Error('文件过大。');return bytes;
  }

  async writeStdin(id: string, text: string) {
    this.row(id);
    if (text.length > 1_000_000 || text.includes("\0")) throw new Error("输入内容过长或无效。");
    let chunk = "", bytes = 0;
    for (const character of text) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 4096) { await this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/stdin`, { text: chunk }); chunk = ""; bytes = 0; }
      chunk += character; bytes += length;
    }
    if (chunk) await this.request("POST", `/v1/jobs/${encodeURIComponent(id)}/stdin`, { text: chunk });
    return this.read(id);
  }
  async cancel(id: string) {
    const row = this.row(id);
    if (terminal(row.state)) {
      this.unbindRun(id);
      prepareSql(this.db, "DELETE FROM execution_cancellations WHERE job_id=?").run(id);
      return this.read(id);
    }
    prepareSql(this.db, "INSERT OR IGNORE INTO execution_cancellations VALUES (?)").run(id);
    // A cancel sent before admission can miss a command that is still uploading.
    if (this.starting.has(row.workspace_id) && this.admission(id)?.phase !== "accepted")
      throw new Error("程序仍在提交，停止请求已保存，接收后将立即终止。");
    let pending = this.cancellations.get(id);
    if (!pending) {
      pending = (async () => {
        const receipt = await this.request<{ terminationConfirmed?: boolean }>("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`, {});
        if (receipt.terminationConfirmed !== true) throw new Error("尚未确认程序已停止，请重试。");
        if (!this.closed) {
          prepareSql(this.db, "DELETE FROM execution_cancellations WHERE job_id=?").run(id);
          this.unbindRun(id);
        }
      })();
      this.cancellations.set(id, pending);
    }
    try { await pending; } finally { if (this.cancellations.get(id) === pending) this.cancellations.delete(id); }
    return this.read(id);
  }
  async cancelSession(sessionId: string) {
    if (!sessionId) return;
    const rows = prepareSql(this.db, "SELECT id FROM jobs WHERE session_id=? AND state IN ('starting','running')").all(sessionId) as { id: string }[];
    const results = await Promise.allSettled(rows.map(row => this.cancel(row.id)));
    if (results.some(result => result.status === "rejected")) throw new Error("部分程序尚未确认停止，系统会继续重试，请稍后重试停止。");
  }
  async retryCancellations() {
    const rows = prepareSql(this.db, "SELECT job_id FROM execution_cancellations LIMIT 100").all() as { job_id: string }[];
    await Promise.allSettled(rows.map(row => this.cancel(row.job_id)));
  }
  private backgroundResult(result: ExecutionResult): ExecutionResult {
    const row = this.row(result.id);
    if (row.session_id) {
      const background=!terminal(row.state) || row.snapshot_state === "pending";
      prepareSql(this.db,"UPDATE execution_completions SET status=? WHERE job_id=? AND status='foreground'").run(background ? "waiting" : "synchronous",row.id);
    }
    return result;
  }
  /** Poll all durable active jobs, independently of the recent-jobs UI limit. */
  reconciliationCandidates(limit = 4): ExecutionJob[] {
    const rows = prepareSql(this.db, `SELECT j.* FROM jobs j LEFT JOIN execution_polling p ON p.job_id=j.id
      WHERE j.state IN ('starting','running') OR j.snapshot_state='pending' OR (j.state='interrupted' AND j.snapshot_state='failed')
        OR (j.snapshot_state IN ('conflict','failed') AND EXISTS (
          SELECT 1 FROM execution_admissions a WHERE a.job_id=j.id AND a.phase='rejected'
            AND (a.first_error LIKE '%EXECUTION_HTTP_409:%Remote workspace %'
              OR a.first_error LIKE '%EXECUTION_HTTP_409:%Workspace is running a program%')))
      ORDER BY COALESCE(p.last_polled_at,0),j.created_at LIMIT ?`).all(Math.min(Math.max(limit,1),100)) as Row[];
    for (const row of rows) prepareSql(this.db,"INSERT OR REPLACE INTO execution_polling VALUES (?,?)").run(row.id,Date.now());
    return rows.map(row=>this.view(row));
  }
  pendingCompletions(limit = 10): ExecutionCompletion[] {
    // Successful internal commands are reflected in the workspace and tool results;
    // sending each completion to chat obscures the user's actual deliverable.
    // Clear already-queued notices too, while retaining failures and sync problems.
    prepareSql(this.db, `UPDATE execution_completions SET status='skipped'
      WHERE status IN ('waiting','pending') AND job_id IN (
        SELECT id FROM jobs WHERE state='completed' AND exit_code=0 AND snapshot_state='saved'
      )`).run();
    const waiting = prepareSql(this.db, `SELECT c.* FROM execution_completions c JOIN jobs j ON j.id=c.job_id
      WHERE c.status='waiting' AND j.state IN ('completed','failed','cancelled','interrupted') AND j.snapshot_state IN ('saved','conflict','failed','superseded')`).all() as CompletionRow[];
    for (const receipt of waiting) {
      const row=this.row(receipt.job_id);
      if (row.snapshot_state === "superseded") { this.acknowledgeCompletion(row.id,"skipped"); continue; }
      const name=this.options.workspaces.workspace(row.workspace_id).name;
      const state=({completed:"执行结束",failed:"执行失败",cancelled:"执行已取消",interrupted:"执行已中断"} as Record<string,string>)[row.state]!;
      const snapshot=row.snapshot_state === "saved" ? "项目结果已保存。" : row.snapshot_state === "conflict" ? "结果与本地修改冲突，可在文件面板恢复为新项目。" : "项目结果同步失败，可在文件面板查看或修复。";
      const text=`${name}：${state}${row.exit_code === null ? "" : `（退出码 ${row.exit_code}）`}。\n${snapshot}\n任务：${row.id}`;
      prepareSql(this.db,"UPDATE execution_completions SET status='pending',title=?,text=? WHERE job_id=? AND status='waiting'").run("执行结果",text,row.id);
    }
    return (prepareSql(this.db,"SELECT * FROM execution_completions WHERE status='pending' AND next_attempt_at<=? ORDER BY rowid LIMIT ?").all(Date.now(),Math.min(Math.max(limit,1),100)) as CompletionRow[])
      .map(receipt=>({jobId:receipt.job_id,workspaceId:this.row(receipt.job_id).workspace_id,sessionId:receipt.session_id,
        idempotencyKey:`execution:${receipt.job_id}:finished`,title:receipt.title!,text:receipt.text!}));
  }
  acknowledgeCompletion(jobId: string, status: "delivered"|"skipped", messageId?: string) {
    prepareSql(this.db,"UPDATE execution_completions SET status=?,message_id=? WHERE job_id=?").run(status,messageId ?? null,jobId);
  }
  deferCompletion(jobId: string, uncertain = false) {
    prepareSql(this.db,"UPDATE execution_completions SET status=?,next_attempt_at=? WHERE job_id=?").run(uncertain ? "uncertain" : "pending",Date.now()+30_000,jobId);
  }
  list(workspaceId?: string): ExecutionJob[] {
    if (workspaceId) this.options.workspaces.workspace(workspaceId);
    const rows = (workspaceId ? prepareSql(this.db, "SELECT * FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100").all(workspaceId)
      : prepareSql(this.db, "SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100").all()) as Row[];
    return rows.map(row => this.view(row));
  }
  events(after = 0, limit = 100): ExecutionEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("事件范围无效。");
    return (prepareSql(this.db, "SELECT * FROM execution_events WHERE sequence>? ORDER BY sequence LIMIT ?").all(after, limit) as Array<{ sequence: number; job_id: string; workspace_id: string; type: string; created_at: number }>)
      .map(row => ({ sequence: row.sequence, jobId: row.job_id, workspaceId: row.workspace_id, type: row.type, createdAt: row.created_at }));
  }
  drain() { this.draining = true; }
  /** Closing the API does not terminate remote jobs; a new service instance can reconnect by durable ID. */
  close() { if (!this.closed) { this.draining = true; this.closed = true; clearInterval(this.leaseTimer); for (const id of this.runBindings.keys()) this.unbindRun(id); closeSqlite(this.db); } }
}
