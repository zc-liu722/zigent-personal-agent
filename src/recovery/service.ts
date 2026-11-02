import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RecoveryIdentity } from "./auth.js";

const sha = /^[a-f0-9]{40}$/;
export type RecoveryConfig = { root: string; listenHost: "127.0.0.1"; listenPort: number; backendPort: number; publicOrigin: string; basePath: string; webDatabasePath: string };
export type Release = { id: string; createdAt?: string };
export type RollbackInput = { confirmationId: string; expectedCurrent: string; targetVersion: string };
export type RecoveryOperation = { operationId: string; status: "running" | "completed" | "failed"; message?: string };
export class RecoveryError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function validateConfig(value: unknown): RecoveryConfig {
  const config = value as RecoveryConfig;
  const keys = ["root", "listenHost", "listenPort", "backendPort", "publicOrigin", "basePath", "webDatabasePath"];
  if (!config || typeof config !== "object" || Object.keys(config).some(key => !keys.includes(key)) || !isAbsolute(config.root ?? "") || !isAbsolute(config.webDatabasePath ?? "")
    || config.listenHost !== "127.0.0.1" || ![config.listenPort, config.backendPort].every(port => Number.isInteger(port) && port > 0 && port <= 65535)
    || config.listenPort === config.backendPort || !/^\/[a-z][a-z0-9_-]*\/$/.test(config.basePath ?? "")) throw new Error("Invalid fixed recovery configuration");
  const origin = new URL(config.publicOrigin);
  if (!["https:", "http:"].includes(origin.protocol) || origin.origin !== config.publicOrigin || origin.username || origin.password) throw new Error("Invalid recovery origin");
  return config;
}
export function parseRollback(value: unknown): RollbackInput {
  const input = value as RollbackInput;
  if (!input || typeof input !== "object" || Object.keys(input).sort().join(",") !== "confirmationId,expectedCurrent,targetVersion" || !/^[a-f0-9-]{36}$/.test(input.confirmationId)
    || !sha.test(input.expectedCurrent) || !sha.test(input.targetVersion)) throw new RecoveryError(400, "回退请求格式不正确。");
  return input;
}
async function release(root: string, directory: "current" | "previous"): Promise<Release | undefined> {
  try {
    const path = join(root, directory, "release.json"), metadata = JSON.parse(await readFile(path, "utf8"));
    if (!sha.test(metadata.commit)) return;
    await stat(join(root, directory, "dist", "index.js"));
    const details = await stat(path);
    return { id: metadata.commit, createdAt: details.mtime.toISOString() };
  } catch { return undefined; }
}
export class RecoveryService {
  readonly directory: string;
  private running?: Promise<void>;
  private readonly run: (input: RollbackInput, operationId: string) => Promise<void>;
  private constructor(readonly config: RecoveryConfig, readonly db: DatabaseSync, run?: RecoveryService["run"]) {
    this.directory = join(config.root, "shared", "recovery");
    this.run = run ?? ((input, operationId) => executeRollback(config, input, operationId));
    db.exec(`CREATE TABLE IF NOT EXISTS recovery_tickets(id TEXT PRIMARY KEY,device TEXT NOT NULL,password_version TEXT NOT NULL,current_version TEXT NOT NULL,target_version TEXT NOT NULL,expires_at INTEGER NOT NULL,operation_id TEXT);
      CREATE TABLE IF NOT EXISTS recovery_operations(id TEXT PRIMARY KEY,status TEXT NOT NULL,created_at INTEGER NOT NULL,ended_at INTEGER);`);
    // Never rerun a persisted request. A live external lock or the fixed script's
    // exact outcome reconciles a request if the gateway itself was restarted.
  }
  static async open(config: RecoveryConfig, run?: RecoveryService["run"]): Promise<RecoveryService> {
    const directory = join(config.root, "shared", "recovery"); await mkdir(directory, { recursive: true });
    return new RecoveryService(config, new DatabaseSync(join(directory, "recovery.sqlite")), run);
  }
  private async versions(): Promise<{ current?: Release; previous?: Release }> {
    const [current, previous] = await Promise.all([release(this.config.root, "current"), release(this.config.root, "previous")]);
    if (!previous || previous.id === current?.id) return { current };
    try {
      const saved = JSON.parse(await readFile(join(this.directory, "previous.config.json"), "utf8"));
      if (!Array.isArray(saved.agents) || !saved.agents.length) return { current };
      await stat(join(this.directory, "previous.backend.config.json"));
      await stat(join(this.directory, "control", "recovery-rollback.ps1"));
      return { current, previous };
    } catch { return { current }; }
  }
  async externallyBusy(): Promise<boolean> {
    // Windows denies opening a live exclusive FileStream held by deployment or rollback.
    for (const name of ["operation.lock", "deployment.lock"]) {
      try { const file = await open(join(this.directory, name), "r+"); await file.close(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
    }
    return false;
  }
  private lastResult(): RecoveryOperation | undefined {
    const row = this.db.prepare("SELECT id,status FROM recovery_operations ORDER BY created_at DESC,rowid DESC LIMIT 1").get() as { id: string; status: RecoveryOperation["status"] } | undefined;
    if (!row) return;
    return { operationId: row.id, status: row.status, ...(row.status === "failed" ? { message: "服务回退未确认完成，请检查恢复状态。" } : {}) };
  }
  private async reconcileResult(): Promise<void> {
    try {
      const outcome = JSON.parse(await readFile(join(this.directory, "result.json"), "utf8"));
      if (!/^[a-f0-9-]{36}$/.test(outcome.operationId) || !["completed", "failed"].includes(outcome.status) || !sha.test(outcome.expectedCurrent) || !sha.test(outcome.targetVersion)) return;
      const ticket = this.db.prepare("SELECT current_version,target_version FROM recovery_tickets WHERE operation_id=?").get(outcome.operationId) as { current_version: string; target_version: string } | undefined;
      if (!ticket || ticket.current_version !== outcome.expectedCurrent || ticket.target_version !== outcome.targetVersion) return;
      if (outcome.status === "completed" && (await release(this.config.root, "current"))?.id !== outcome.targetVersion) return;
      this.db.prepare("UPDATE recovery_operations SET status=?,ended_at=? WHERE id=?").run(outcome.status, Date.now(), outcome.operationId);
    } catch { /* An absent or incomplete outcome is never evidence of a successful recovery. */ }
  }
  async report(identity: RecoveryIdentity) {
    await this.reconcileResult();
    const versions = await this.versions(), busy = Boolean(this.running) || await this.externallyBusy();
    if (!busy) this.db.prepare("UPDATE recovery_operations SET status='failed',ended_at=? WHERE status='running'").run(Date.now());
    const available = Boolean(versions.current && versions.previous);
    this.db.prepare("DELETE FROM recovery_tickets WHERE expires_at<=? AND operation_id IS NULL").run(Date.now());
    let confirmation: { id: string; expectedCurrent: string; targetVersion: string; expiresAt: number } | undefined;
    if (available && !busy) {
      confirmation = { id: randomUUID(), expectedCurrent: versions.current!.id, targetVersion: versions.previous!.id, expiresAt: Date.now() + 300000 };
      this.db.prepare("INSERT INTO recovery_tickets VALUES(?,?,?,?,?,?,NULL)").run(confirmation.id, identity.key, identity.passwordVersion, confirmation.expectedCurrent, confirmation.targetVersion, confirmation.expiresAt);
    }
    return { service: { available, ...versions, busy, ...(this.lastResult() ? { lastResult: this.lastResult() } : {}) }, ...(confirmation ? { confirmation } : {}) };
  }
  async rollback(identity: RecoveryIdentity, value: unknown): Promise<RecoveryOperation> {
    const input = parseRollback(value);
    const ticket = this.db.prepare("SELECT * FROM recovery_tickets WHERE id=? AND device=? AND password_version=?").get(input.confirmationId, identity.key, identity.passwordVersion) as
      { current_version: string; target_version: string; expires_at: number; operation_id: string | null } | undefined;
    if (!ticket || ticket.current_version !== input.expectedCurrent || ticket.target_version !== input.targetVersion) throw new RecoveryError(403, "请重新选择版本并确认回退。");
    if (ticket.operation_id) {
      const operation = this.db.prepare("SELECT id,status FROM recovery_operations WHERE id=?").get(ticket.operation_id) as { id: string; status: RecoveryOperation["status"] };
      return { operationId: operation.id, status: operation.status };
    }
    if (ticket.expires_at <= Date.now()) throw new RecoveryError(409, "确认已过期，请重新选择版本。");
    if (this.running || await this.externallyBusy()) throw new RecoveryError(409, "服务正在发布或回退，请稍后重试。");
    const versions = await this.versions();
    if (versions.current?.id !== input.expectedCurrent || versions.previous?.id !== input.targetVersion) throw new RecoveryError(409, "服务版本已变化，请刷新后重新确认。");
    // Recheck after all awaited filesystem reads. Claiming an operation is synchronous and serialized.
    if (this.running) {
      const prior = this.db.prepare("SELECT operation_id FROM recovery_tickets WHERE id=?").get(input.confirmationId) as { operation_id?: string };
      if (prior.operation_id) return { operationId: prior.operation_id, status: "running" };
      throw new RecoveryError(409, "已有回退正在执行。");
    }
    const operationId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO recovery_operations VALUES(?,'running',?,NULL)").run(operationId, Date.now());
      this.db.prepare("UPDATE recovery_tickets SET operation_id=? WHERE id=? AND operation_id IS NULL").run(operationId, input.confirmationId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.running = Promise.resolve().then(() => this.run(input, operationId)).then(async () => {
      if ((await release(this.config.root, "current"))?.id !== input.targetVersion) throw new Error("Restored release was not confirmed");
      this.db.prepare("UPDATE recovery_operations SET status='completed',ended_at=? WHERE id=?").run(Date.now(), operationId);
    }).catch(() => {
      this.db.prepare("UPDATE recovery_operations SET status='failed',ended_at=? WHERE id=?").run(Date.now(), operationId);
    }).finally(() => { this.running = undefined; });
    return { operationId, status: "running" };
  }
  async close(): Promise<void> { await this.running; this.db.close(); }
}
function executeRollback(config: RecoveryConfig, input: RollbackInput, operationId: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Recovery executor requires Windows"));
  const script = join(config.root, "shared", "recovery", "control", "recovery-rollback.ps1");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
      "-Root", config.root, "-OperationId", operationId, "-ExpectedCurrent", input.expectedCurrent, "-TargetVersion", input.targetVersion],
    { cwd: join(config.root, "shared", "recovery", "control"), env: environment, shell: false, windowsHide: true, stdio: "ignore" });
    child.once("error", () => reject(new Error("Recovery executor unavailable")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Recovery did not pass readiness")));
  });
}
