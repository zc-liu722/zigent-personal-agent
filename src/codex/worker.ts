import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { delegationPrompt } from "./delegation.js";
import { CodexRpc } from "./rpc.js";
import { PROJECT_LIMIT, workerEventSchema, type CodexDisplay, type CodexTask, type WorkerEvent } from "./types.js";
import { itemDisplay, safeDisplay } from "./display.js";
import { codexProjects, type WorkerProject } from "./projects.js";
import { agentId, spaces } from "../project-spaces/policy.js";
import { assertProjectWorkspace, prepareWorkspace, completeWorkspace, projectExecutionScope } from "../project-spaces/workspace.js";

export const workerConfigSchema = z.object({
  endpoint: z.string().url().refine(value => { const u = new URL(value); return !u.username && !u.password && !u.search && !u.hash && /^\/v1\/codex\/[a-z][a-z0-9-]*\/$/.test(u.pathname) && (u.protocol === "https:" || u.protocol === "http:" && u.hostname === "127.0.0.1"); }),
  token: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), name: z.string().min(1).max(80), statePath: z.string().min(1),
  codexCommand: z.string().min(1), codexArgs: z.array(z.string()).default(["app-server", "proxy"]),
  projectSource: z.enum(["codex", "manual", "spaces"]).default("codex"),
  managed: z.object({ agent: agentId, registry: z.string().min(1) }).strict().optional(),
  projects: z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,80}$/), name: z.string().min(1).max(80), path: z.string().refine(isAbsolute) }).strict()).max(PROJECT_LIMIT).default([])
}).strict();
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
type LocalTask = { task: CodexTask; status: "running" | "finishing" | "done" | "blocked"; result?: string; fenced?: boolean };
type Command = { id: string; taskId: string; kind: "message" | "interrupt"; text: string };
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : {};
export class CodexWorker {
  readonly db: DatabaseSync;
  private readonly rpc: CodexRpc;
  private stopping = false;
  private draining = false;
  drain() { this.draining = true; }
  get idle() { return !this.jobs.size && !this.locals().some(local => ["running", "finishing"].includes(local.status)); }
  private timer?: ReturnType<typeof setInterval>;
  private guard?: ReturnType<typeof setInterval>;
  private heartbeating?: Promise<void>;
  private syncPromise?: Promise<void>;
  private flushing?: Promise<void>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly finalMessages = new Map<string, string>();
  private readonly waiters = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  private readonly pendingQuestions = new Map<string, { id: number | string; params: Record<string, unknown> }>();
  private locked = false;
  private displayTimer?: ReturnType<typeof setInterval>;
  private historyJob?: Promise<void>;
  private projects: WorkerProject[] = [];
  private projectsJob?: Promise<void>;
  private projectTimer?: ReturnType<typeof setTimeout>;
  private nextProjectReadAt = 0;
  private publishedCatalog = "";
  private readonly displayItems = new Map<string, { task: CodexTask; value: CodexDisplay; dirty: boolean }>();
  private streamAbort = new AbortController();
  constructor(readonly config: WorkerConfig, rpc?: CodexRpc) {
    mkdirSync(dirname(config.statePath), { recursive: true });
    this.db = new DatabaseSync(config.statePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_commands(id TEXT PRIMARY KEY,status TEXT NOT NULL);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS display_history(task_id TEXT PRIMARY KEY);");
    // Retired file-protocol callbacks must never clog or replay the new text channel.
    for (const row of this.db.prepare("SELECT id,payload FROM outbox").all() as { id: string; payload: string }[]) {
      if (!workerEventSchema.safeParse(JSON.parse(row.payload)).success) this.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
    }
    this.rpc = rpc ?? new CodexRpc(config.codexCommand, config.codexArgs);
    this.rpc.on("notification", message => this.notification(message).catch(() => {}));
    this.rpc.on("closed", () => { for (const waiter of this.waiters.values()) waiter.reject(new Error("Codex connection closed")); this.waiters.clear(); });
    this.rpc.on("request", (message: { id: number | string; method: string; params: Record<string, unknown> }) => {
      const threadId = String(message.params.threadId ?? "");
      const local = this.locals().find(item => item.task.threadId === threadId && item.status === "running");
      if (local && message.method === "item/tool/requestUserInput") {
        this.pendingQuestions.set(local.task.id, { id: message.id, params: message.params });
        local.task.state = "waiting_user"; this.save(local);
        const questions = Array.isArray(message.params.questions) ? message.params.questions.map(record) : [];
        const summary = questions.map(item => String(item.question ?? "") + (Array.isArray(item.options) ? "\n" + item.options.map(record).map(option => String(option.label ?? "")).join(" / ") : "")).join("\n").slice(0, 4000);
        void this.emit(local.task, "waiting_user", { phase: "需要补充信息", summary: summary || "请在 Codex 原会话中补充信息。" });
      } else this.rpc.reject(message.id);
    });
  }
  private locals() { return (this.db.prepare("SELECT payload FROM local_tasks").all() as { payload: string }[]).map(row => JSON.parse(row.payload) as LocalTask); }
  private local(id: string) { const row = this.db.prepare("SELECT payload FROM local_tasks WHERE id=?").get(id) as { payload: string } | undefined; return row ? JSON.parse(row.payload) as LocalTask : undefined; }
  private save(local: LocalTask) {
    const prior = this.local(local.task.id);
    if (prior?.task.attempt === local.task.attempt) {
      if (prior.status === "done" && local.status !== "done") return;
      local.fenced ||= prior.fenced;
      if ((prior.task.leaseUntil ?? 0) > (local.task.leaseUntil ?? 0)) { local.task.leaseUntil = prior.task.leaseUntil; local.task.leaseToken = prior.task.leaseToken; }
      local.task.lastProgressAt = Math.max(local.task.lastProgressAt ?? 0, prior.task.lastProgressAt ?? 0);
      if (local.task.execution && prior.task.execution && (prior.task.execution.usageReportedAt ?? 0) > (local.task.execution.usageReportedAt ?? 0)) {
        local.task.execution.usage = prior.task.execution.usage; local.task.execution.usageReportedAt = prior.task.execution.usageReportedAt;
      }
    }
    this.db.prepare("INSERT INTO local_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(local.task.id, JSON.stringify(local));
  }
  async request<T = Record<string, unknown>>(path: string, value?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.config.endpoint), { method: value === undefined ? "GET" : "POST", headers: {
      Authorization: "Bearer " + this.config.token, ...(value === undefined ? {} : { "Content-Type": "application/json" })
    }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Zigent request failed: HTTP " + response.status);
    return await response.json() as T;
  }
  async pair() {
    await this.refreshProjects({ publish: false, force: true });
    const response = await fetch(new URL("pair", this.config.endpoint), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenHash: createHash("sha256").update(this.config.token).digest("hex"), name: this.config.name, projects: this.projectCatalog() }), redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("配对入口暂时不可用");
    return await response.json() as { code?: string; paired?: boolean; expiresAt?: number };
  }
  async start() {
    const lock = this.config.statePath + ".lock";
    try { mkdirSync(lock); } catch {
      const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Worker lock requires inspection");
      try { process.kill(pid, 0); throw new Error("Another worker is running"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      rmSync(lock, { recursive: true }); mkdirSync(lock);
    }
    writeFileSync(join(lock, "pid"), String(process.pid), { mode: 0o600 }); this.locked = true;
    await this.rpc.start();
    await this.refreshProjects({ force: true });
    this.displayTimer = setInterval(() => { this.flushDisplay(); }, 1000); this.displayTimer.unref();
    for (const local of this.locals().filter(item => item.status !== "done")) await this.restore(local).catch(() => {});
    this.timer = setInterval(() => { void this.heartbeat().catch(() => {}); }, 15000); this.timer.unref();
    this.guard = setInterval(() => { void this.fenceExpired().catch(() => {}); }, 2000); this.guard.unref();
    void this.stream(); await this.sync();
    this.historyJob = this.syncDisplayHistory().catch(() => {});
  }
  private async stream() {
    while (!this.stopping) {
      try {
        const response = await fetch(new URL("events", this.config.endpoint), { headers: { Authorization: "Bearer " + this.config.token }, redirect: "error", signal: this.streamAbort.signal });
        if (!response.ok || !response.body) throw new Error("Event stream unavailable");
        await this.sync();
        for await (const chunk of response.body) { if (this.stopping) break; if (Buffer.from(chunk).toString("utf8").includes("event:")) await this.sync(); }
      } catch { /* Durable task and callback queues are reconciled on reconnection. */ }
      if (!this.stopping) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 3000); this.streamAbort.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });
    }
  }
  sync(): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.synchronize().finally(() => { this.syncPromise = undefined; }); return this.syncPromise;
  }
  private async synchronize() {
    if (this.stopping) return;
    await this.flush();
    const response = await this.request<{ commands: Command[] }>("commands");
    for (const command of response.commands) await this.command(command);
    if (!this.draining && !this.jobs.size && !this.locals().some(local => ["running", "finishing"].includes(local.status))) {
      const result = await this.request<{ task: CodexTask | null }>("claim", { protocol: "text-v1" });
      if (result.task) this.launch(result.task);
    }
  }
  private launch(task: CodexTask) {
    const local: LocalTask = { task, status: "running" }; this.save(local);
    const promise = this.run(local).catch(async () => {
      const latest = this.local(task.id) ?? local;
      if (latest.status === "done") return;
      if (latest.fenced || !this.rpc.connected) { latest.status = "blocked"; this.save(latest); return; }
      if (latest.result !== undefined) { latest.status = "finishing"; this.save(latest); return; }
      latest.status = "blocked"; this.save(latest);
      await this.emit(latest.task, "blocked", { phase: "执行受阻", summary: "本机通信未完成，已保留原会话；请核对后重新确认要发送的消息。" });
    }).finally(() => { this.jobs.delete(task.id); void this.sync().catch(() => {}); });
    this.jobs.set(task.id, promise);
  }
  private async run(local: LocalTask) {
    await this.refreshProjects({ force: true });
    const task = local.task;
    if (task.protocol !== "text-v1") throw new Error("Unconfirmed legacy task");
    const project = this.projects.find(project => project.id === task.projectId);
    if (!project || project.available === false) throw new Error("Project is not available in Codex");
    if (task.project?.directory && task.project.directory !== project.path) throw new Error("Project directory changed; confirm a new message");
    if (task.project?.codexProjectId && task.project.codexProjectId !== project.codexProjectId) throw new Error("Codex project identity changed");
    if (task.project?.roots && JSON.stringify(task.project.roots) !== JSON.stringify(project.roots)) throw new Error("Codex project roots changed; confirm a new message");
    if (task.project?.scopeVersion !== project.scopeVersion) throw new Error("Project authorization scope changed; confirm a new message");
    if (this.local(task.id)?.status === "done") return;
    if (this.config.projectSource === "spaces") {
      if (!this.config.managed || process.platform !== "win32") throw new Error("Managed Codex projects only execute on Windows");
      const account = await this.rpc.call<{ account?: { type?: string } }>("account/read", { refreshToken: false });
      if (account.account?.type !== "chatgpt") throw new Error("This executor requires its authorized ChatGPT subscription login");
      const space = (await spaces(this.config.managed.agent, this.config.managed.registry)).find(s => s.id === task.projectId);
      if (!space) throw new Error("Unregistered project");
      if (!task.execution) {
        const readiness = await this.request<{ state: string; inputVersion: string }>("space-readiness", { projectId: space.id });
        if (readiness.state !== "ready") throw new Error("Project inputs are still syncing");
        task.execution = await prepareWorkspace(space, dirname(this.config.statePath), task.id, readiness.inputVersion);
        this.save(local);
      } else {
        await assertProjectWorkspace(space, task.execution);
      }
    }
    const cwd = task.execution?.directory ?? project.path;
    const context = { cwd, approvalPolicy: "never", sandbox: "workspace-write" };
    if (task.threadId) {
      const read = await this.rpc.call<{ thread: { cwd?: string; status?: { type?: string } } }>("thread/read", { threadId: task.threadId });
      if (read.thread.cwd && read.thread.cwd !== cwd) throw new Error("Thread project changed");
      if (read.thread.status?.type === "active") throw new Error("Original thread is still active");
      await this.rpc.call("thread/resume", { threadId: task.threadId, ...context });
    } else {
      const started = await this.rpc.call<{ thread: { id: string } }>("thread/start", { ...context, ephemeral: false,
        ...(project.codexProjectId ? { projectId: project.codexProjectId } : {}) });
      task.threadId = started.thread.id; await this.rpc.call("thread/name/set", { threadId: task.threadId, name: task.title });
    }
    this.save(local);
    await this.emit(task, "started", { threadId: task.threadId, phase: "执行中", ...(task.execution ? { execution: task.execution } : {}) });
    if (this.local(task.id)?.status === "done") return;
    const finished = new Promise<string>((resolve, reject) => { this.waiters.set(task.threadId!, { resolve, reject }); });
    void finished.catch(() => {});
    for (const key of this.finalMessages.keys()) if (key.startsWith(task.threadId + ":")) this.finalMessages.delete(key);
    const started = await this.rpc.call<{ turn: { id: string } }>("turn/start", { threadId: task.threadId,
      clientUserMessageId: task.id.slice(0, 24) + task.attempt.toString().padStart(12, "0"),
      input: [{ type: "text", text: delegationPrompt(task.prompt, task.originalRequest, task.intent)
        + (task.execution?.mode === "project" ? "\nWork directly in this registered project directory. Read and edit the actual project files, following its rules. Save deliverables in the relevant existing topic. Do not create results/, task-ID folders, return manifests or task reports as a substitute for the requested work. Changes are saved in place; describe the actual file paths in your reply." : "") }],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: task.execution ? [cwd] : project.roots ?? [cwd], networkAccess: true } });
    task.turnId = started.turn.id; this.save(local);
    await this.emit(task, "started", { threadId: task.threadId, turnId: task.turnId, phase: "执行中" });
    local.result = await finished; this.waiters.delete(task.threadId!);
    // A foreground steer may have updated the source requirements/review consent.
    const current = await this.request<{ task: CodexTask }>("task", { id: task.id });
    task.originalRequest = current.task.originalRequest;
    local.task.originalRequest = current.task.originalRequest;
    local.status = "finishing"; this.save(local);
    await this.finish(local);
  }
  private async notification(message: { method: string; params: Record<string, unknown> }) {
    if (message.method === "project/changed" && this.config.projectSource === "codex") {
      if (this.projectTimer) clearTimeout(this.projectTimer);
      this.projectTimer = setTimeout(() => { void this.refreshProjects({ force: true }).catch(() => {}); }, 250); this.projectTimer.unref(); return;
    }
    const params = message.params, threadId = String(params.threadId ?? ""), local = this.locals().find(local => local.task.threadId === threadId && (local.status === "running" || message.method === "thread/tokenUsage/updated" && local.status === "finishing"));
    if (!local || params.turnId && local.task.turnId && params.turnId !== local.task.turnId) return;
    if (message.method === "thread/tokenUsage/updated" && local.task.execution) {
      const usage = record(record(params.tokenUsage).last);
      const valid = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
      if (valid(usage.inputTokens) && valid(usage.outputTokens) && valid(usage.cachedInputTokens)) {
        local.task.execution.usage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens,
          ...(valid(usage.cacheWriteInputTokens) ? { cacheWriteInputTokens: usage.cacheWriteInputTokens } : {}) };
        local.task.execution.usageReportedAt = Date.now(); this.save(local);
      }
      return;
    }
    if (message.method === "item/commandExecution/outputDelta") {
      const entry = this.displayItems.get(local.task.id + ":" + String(params.itemId));
      if (entry) { entry.value.output = ((entry.value.output ?? "") + String(params.delta ?? "")).slice(0, 12000); entry.dirty = true; }
      return;
    }
    if (message.method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan) ? params.plan.map(record).map(step => `${step.status === "completed" ? "✓" : step.status === "inProgress" ? "→" : "·"} ${String(step.step ?? "")}`).join("\n") : "";
      this.queueDisplay(local.task, { itemId: "plan:" + String(params.turnId ?? local.task.turnId), kind: "plan", title: "执行计划", status: "started", text: plan.slice(0, 8000) }, true);
    }
    if (message.method === "item/agentMessage/delta") {
      const key = threadId + ":" + String(params.itemId); this.finalMessages.set(key, ((this.finalMessages.get(key) ?? "") + String(params.delta ?? "")).slice(0, 100000)); return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = record(params.item), completed = message.method === "item/completed";
      const display = itemDisplay(item, completed);
      if (display && (display.kind !== "message" || completed)) this.queueDisplay(local.task, display, true);
      if (item.type === "agentMessage" && completed && typeof item.text === "string") this.finalMessages.set(threadId + ":" + String(item.id), item.text.slice(0, 100000));
      const kind = item.type === "commandExecution" ? "command" : item.type === "fileChange" ? "file" : ["mcpToolCall", "dynamicToolCall", "webSearch"].includes(String(item.type)) ? "tool" : undefined;
      if (kind) {
        const latest = this.local(local.task.id); if (latest) { latest.task.lastProgressAt = Date.now(); this.save(latest); }
        await this.emit(local.task, "progress", { phase: kind === "command" ? "执行命令" : kind === "file" ? "修改文件" : "处理工具结果",
        activity: { kind, status: completed ? item.status === "failed" ? "failed" : "completed" : "started",
          name: String(item.tool ?? item.type).slice(0, 80), ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}), ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}) } });
      }
    }
    if (message.method === "turn/completed") {
      this.flushDisplay(local.task.id);
      const turn = record(params.turn), waiter = this.waiters.get(threadId);
      const final = [...this.finalMessages.entries()].filter(([key]) => key.startsWith(threadId + ":")).map(([, text]) => text).at(-1) ?? "";
      if (turn.status === "completed") waiter?.resolve(final); else waiter?.reject(new Error("Codex turn did not complete"));
    }
  }
  private projectCatalog() { return this.projects.map(({ path: _path, ...project }) => project); }
  async refreshProjects(options: { force?: boolean; publish?: boolean } = {}): Promise<void> {
    if (this.projectsJob) return this.projectsJob;
    this.projectsJob = (async () => {
      if (options.force || Date.now() >= this.nextProjectReadAt) {
        if (this.config.projectSource === "spaces") {
          if (!this.config.managed || process.platform !== "win32") throw new Error("Managed projects require the registered Windows worker");
          this.projects = await Promise.all((await spaces(this.config.managed.agent, this.config.managed.registry)).filter(s => s.executors.includes("windows-codex")).map(async space => {
            const path = await realpath(space.windows!);
            return { id: space.id, name: space.name, path, directory: path, roots: [path], executor: "windows-codex" as const, host: "windows" as const, scopeVersion: projectExecutionScope(space), available: true };
          }));
        } else if (this.config.projectSource === "codex") { await this.rpc.start(); this.projects = await codexProjects(this.rpc); }
        else this.projects = await Promise.all(this.config.projects.map(async project => {
          const path = await realpath(project.path); if (!(await stat(path)).isDirectory()) throw new Error("授权项目不存在");
          return { ...project, path, directory: path, available: true };
        }));
        this.nextProjectReadAt = Date.now() + 30000;
      }
      const catalog = this.projectCatalog(), serialized = JSON.stringify(catalog);
      if (options.publish !== false && serialized !== this.publishedCatalog) { await this.request("projects", { projects: catalog }); this.publishedCatalog = serialized; }
    })().finally(() => { this.projectsJob = undefined; }); return this.projectsJob;
  }
  private async syncDisplayHistory() {
    for (const local of this.locals().filter(item => item.task.threadId && item.task.createdAt > Date.now() - 7 * 86400000).slice(-20)) {
      if (this.stopping) break;
      if (this.db.prepare("SELECT 1 FROM display_history WHERE task_id=?").get(local.task.id)) continue;
      const { task } = await this.request<{ task: CodexTask }>("task", { id: local.task.id });
      if (!["succeeded", "blocked", "cancelled"].includes(task.state) || task.threadId !== local.task.threadId || task.attempt !== local.task.attempt) continue;
      const read = await this.rpc.call<{ thread: { turns?: Array<Record<string, unknown>> } }>("thread/read", { threadId: task.threadId, includeTurns: true });
      for (const turn of read.thread.turns?.filter(turn => turn.id === task.turnId) ?? []) for (const item of Array.isArray(turn.items) ? turn.items.slice(-192) : []) {
        const display = itemDisplay(item, true);
        if (display) await this.emit({ ...task, leaseToken: local.task.leaseToken ?? randomUUID() }, "display", { historical: true, threadId: task.threadId, display: safeDisplay(display, [this.config.token]) });
      }
      this.db.prepare("INSERT OR IGNORE INTO display_history VALUES(?)").run(task.id);
    }
  }
  private queueDisplay(task: CodexTask, value: CodexDisplay, immediate = false) {
    const key = task.id + ":" + value.itemId, prior = this.displayItems.get(key);
    if (!value.output && prior?.value.output) value.output = prior.value.output;
    this.displayItems.set(key, { task, value, dirty: true });
    if (immediate) this.flushDisplay(task.id);
    while (this.displayItems.size > 192) this.displayItems.delete(this.displayItems.keys().next().value!);
  }
  private flushDisplay(taskId?: string) {
    for (const entry of this.displayItems.values()) {
      if (!entry.dirty || taskId && entry.task.id !== taskId) continue;
      entry.dirty = false;
      const task = this.local(entry.task.id)?.task ?? entry.task;
      if (["running", "waiting_user"].includes(task.state)) void this.emit(task, "display", { threadId: task.threadId, display: safeDisplay(entry.value, [this.config.token]) }).catch(() => {});
    }
  }
  private async emit(task: CodexTask, type: WorkerEvent["type"], value: Partial<WorkerEvent>) {
    if (!task.leaseToken) return;
    const execution = this.local(task.id)?.task.execution ?? task.execution;
    const event: WorkerEvent = { ...(execution && type !== "display" ? { execution } : {}), ...value, eventId: randomUUID(), taskId: task.id, attempt: task.attempt, leaseToken: task.leaseToken, type };
    this.db.prepare("INSERT INTO outbox VALUES(?,?,?)").run(event.eventId, JSON.stringify(event), Date.now());
    if (type === "display") this.db.exec("DELETE FROM outbox WHERE id IN (SELECT id FROM outbox WHERE json_extract(payload,'$.type')='display' ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 256)");
    await this.flush().catch(() => {});
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      // Notifications can enqueue more output while an HTTP acknowledgement is in flight.
      // Drain those rows too, rather than leaving them until the next heartbeat.
      while (true) {
        const rows = this.db.prepare("SELECT id,payload FROM outbox ORDER BY created_at,rowid LIMIT 64").all() as { id: string; payload: string }[];
        if (!rows.length) break;
        for (const row of rows) {
          const event = JSON.parse(row.payload) as WorkerEvent;
          let ack: { acknowledged: string; state: string };
          try { ack = await this.request("event", event); }
          catch (error) {
            if (!(error instanceof Error) || !error.message.endsWith("HTTP 409")) throw error;
            const current = await this.request<{ task: CodexTask }>("task", { id: event.taskId });
            if (current.task.attempt === event.attempt && ["running", "waiting_user", "reconciling"].includes(current.task.state)) throw error;
            this.db.exec("CREATE TABLE IF NOT EXISTS rejected_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL);");
            this.db.prepare("INSERT OR IGNORE INTO rejected_events VALUES(?,?)").run(row.id, row.payload);
            this.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id); continue;
          }
          if (ack.acknowledged !== row.id) throw new Error("Callback was not acknowledged");
          this.db.prepare("DELETE FROM outbox WHERE id=?").run(row.id);
          if (["completed", "blocked", "interrupted"].includes(event.type)) { const local = this.local(event.taskId); if (local) { local.status = event.type === "completed" || event.type === "interrupted" ? "done" : "blocked"; this.save(local); } }
        }
      }
    })().finally(() => { this.flushing = undefined; }); return this.flushing;
  }
  private async finish(local: LocalTask) {
    if (this.local(local.task.id)?.status === "done") return;
    if (local.task.execution && this.config.managed) {
      const space = (await spaces(this.config.managed.agent, this.config.managed.registry)).find(s => s.id === local.task.projectId);
      if (!space || projectExecutionScope(space) !== local.task.project?.scopeVersion || await realpath(space.windows!) !== local.task.project.directory) {
        local.status = "blocked"; this.save(local);
        await this.emit(local.task, "blocked", { phase: "项目范围已变化", summary: "已保存的项目文件保留；请核对项目范围后重新确认。" }); return;
      }
      local.task.execution = await completeWorkspace(space, dirname(this.config.statePath), local.task.id, local.task.execution); this.save(local);
    }
    await this.emit(local.task, "completed", { summary: (local.result ?? "").slice(0, 100000), ...(local.task.execution ? { execution: local.task.execution } : {}) });
  }
  async heartbeat() {
    if (this.heartbeating) return this.heartbeating;
    this.heartbeating = this.sendHeartbeat().finally(() => { this.heartbeating = undefined; }); return this.heartbeating;
  }
  private async sendHeartbeat() {
    if (this.stopping) return;
    await this.rpc.start();
    const active = this.locals().filter(local => ["running", "finishing"].includes(local.status) && local.task.leaseToken);
    const result = await this.request<{ tasks: Array<{ id: string; valid: boolean; leaseUntil?: number }> }>("heartbeat", { tasks: active.map(local => ({ id: local.task.id, attempt: local.task.attempt, leaseToken: local.task.leaseToken })) });
    for (const status of result.tasks) {
      const local = this.local(status.id); if (!local) continue;
      if (status.valid) {
        local.task.leaseUntil = status.leaseUntil; this.save(local);
        if (local.status === "finishing" && local.result !== undefined && !this.jobs.has(local.task.id)) await this.finish(local);
      } else await this.restore(local);
    }
    for (const local of this.locals().filter(item => item.status === "blocked")) {
      const server = await this.request<{ task: CodexTask }>("task", { id: local.task.id });
      if (["running", "reconciling"].includes(server.task.state)) await this.restore(local).catch(() => {});
    }
    await this.refreshProjects().catch(() => {});
    await this.watchdog(); await this.sync();
  }
  private async restore(local: LocalTask): Promise<void> {
    const snapshot = await this.request<{ task: CodexTask }>("task", { id: local.task.id });
    if (snapshot.task.protocol !== "text-v1") {
      if (local.task.threadId && local.task.turnId) {
        const read = await this.rpc.call<{ thread: { status?: { type?: string }; turns?: Array<{ id: string; status: string }> } }>("thread/read", { threadId: local.task.threadId, includeTurns: true });
        if (read.thread.status?.type === "active" && read.thread.turns?.some(turn => turn.id === local.task.turnId && turn.status === "inProgress")) await this.stopTurn(local.task);
      }
      local.status = "done"; this.save(local); return;
    }
    if (["succeeded", "cancelled", "blocked"].includes(snapshot.task.state)) {
      local.status = "done"; this.save(local); return;
    }
    if (!local.task.threadId || !local.task.turnId) {
      await this.request("reconcile", { taskId: local.task.id, attempt: local.task.attempt, threadId: local.task.threadId, state: "stopped" });
      local.status = "blocked"; this.save(local); return;
    }
    const read = await this.rpc.call<{ thread: { status?: { type?: string }; turns?: Array<Record<string, unknown>> } }>("thread/read", { threadId: local.task.threadId, includeTurns: true });
    const turn = read.thread.turns?.find(turn => turn.id === local.task.turnId);
    const running = read.thread.status?.type === "active" && turn?.status === "inProgress";
    if (running && local.fenced) { await this.stopTurn(local.task); local.status = "blocked"; this.save(local); return; }
    const reconciled = await this.request<{ task: CodexTask; accepted: boolean }>("reconcile", { taskId: local.task.id,
      attempt: local.task.attempt, threadId: local.task.threadId, state: running ? "running" : turn?.status === "completed" ? "completed" : "stopped" });
    if (!reconciled.accepted) { local.status = "done"; this.save(local); return; }
    const execution = local.task.execution;
    local.task = reconciled.task;
    if (execution && (!local.task.execution || local.task.execution.inputVersion === execution.inputVersion)) local.task.execution = execution;
    this.save(local); this.refreshOutboxLease(local.task);
    for (const raw of Array.isArray(turn?.items) ? turn.items : []) { const item = record(raw), display = itemDisplay(item, !["inProgress", "running"].includes(String(item.status))); if (display) this.queueDisplay(local.task, display); }
    this.flushDisplay(local.task.id);
    if (!running && turn?.status === "completed") {
      if (local.result === undefined) {
        const items = Array.isArray(turn.items) ? turn.items.map(record) : [];
        local.result = String(items.filter(item => item.type === "agentMessage").at(-1)?.text ?? "");
      }
      local.status = "finishing"; this.save(local); await this.finish(local);
    } else if (!running) { local.status = "blocked"; this.save(local); }
    else if (!this.jobs.has(local.task.id)) {
      local.status = "running"; this.save(local);
      const finished = new Promise<string>((resolve, reject) => { this.waiters.set(local.task.threadId!, { resolve, reject }); });
      const work = (async () => {
        await this.rpc.call("thread/resume", { threadId: local.task.threadId });
        local.result = await finished; local.status = "finishing"; this.save(local); await this.finish(local);
      })().catch(() => { local.status = "blocked"; this.save(local); }).finally(() => { this.jobs.delete(local.task.id); this.waiters.delete(local.task.threadId!); });
      this.jobs.set(local.task.id, work);
    }
  }
  private refreshOutboxLease(task: CodexTask) {
    for (const row of this.db.prepare("SELECT id,payload FROM outbox").all() as { id: string; payload: string }[]) {
      const event = JSON.parse(row.payload) as WorkerEvent;
      if (event.taskId === task.id && event.attempt === task.attempt) this.db.prepare("UPDATE outbox SET payload=? WHERE id=?").run(JSON.stringify({ ...event, leaseToken: task.leaseToken }), row.id);
    }
  }
  private async command(command: Command) {
    const prior = this.db.prepare("SELECT status FROM local_commands WHERE id=?").get(command.id) as { status: string } | undefined;
    if (prior?.status === "done" || prior?.status === "failed") {
      await this.request("command-ack", { id: command.id, failed: prior.status === "failed" }); return;
    }
    const local = this.local(command.taskId);
    if (!local || prior?.status === "started" && command.kind === "message") {
      this.db.prepare("INSERT INTO local_commands VALUES(?,'failed') ON CONFLICT(id) DO UPDATE SET status='failed'").run(command.id);
      await this.request("command-ack", { id: command.id, failed: true }); return;
    }
    this.db.prepare("INSERT INTO local_commands VALUES(?,'started') ON CONFLICT(id) DO NOTHING").run(command.id);
    try {
      if (command.kind === "interrupt") {
        local.status = "done"; local.fenced = true; this.save(local);
        if (local.task.threadId && local.task.turnId) await this.stopTurn(local.task);
        this.waiters.get(local.task.threadId ?? "")?.reject(new Error("Interrupted by user"));
        await this.emit(local.task, "interrupted", { phase: "已中断" });
      } else {
        await this.refreshProjects({ force: true });
        const project = this.projects.find(project => project.id === local.task.projectId);
        if (!project || project.available === false || local.task.protocol !== "text-v1"
          || local.task.project?.directory && project.path !== local.task.project.directory
          || local.task.project?.scopeVersion !== project.scopeVersion || local.task.project?.roots && JSON.stringify(project.roots) !== JSON.stringify(local.task.project.roots)) throw new Error("Project changed");
        const server = await this.request<{ task: CodexTask }>("task", { id: local.task.id });
        if (!["running", "waiting_user"].includes(server.task.state) || !this.jobs.has(local.task.id)
          || server.task.threadId !== local.task.threadId || (server.task.leaseUntil ?? 0) <= Date.now()) throw new Error("Original turn is no longer active");
        const read = await this.rpc.call<{ thread: { cwd?: string } }>("thread/read", { threadId: local.task.threadId });
        if (read.thread.cwd && read.thread.cwd !== (local.task.execution?.directory ?? project.path)) throw new Error("Thread project changed");
        const question = this.pendingQuestions.get(local.task.id);
        if (question) {
          const questions = Array.isArray(question.params.questions) ? question.params.questions.map(record) : [];
          this.rpc.respond(question.id, { answers: Object.fromEntries(questions.map(item => [String(item.id), { answers: [command.text] }])) }); this.pendingQuestions.delete(local.task.id);
          await this.emit(local.task, "started", { phase: "执行中" });
        } else await this.rpc.call("turn/steer", { threadId: local.task.threadId, expectedTurnId: local.task.turnId, input: [{ type: "text", text: command.text }] });
      }
      this.db.prepare("UPDATE local_commands SET status='done' WHERE id=?").run(command.id);
      await this.request("command-ack", { id: command.id });
    } catch {
      this.db.prepare("UPDATE local_commands SET status='failed' WHERE id=?").run(command.id);
      await this.request("command-ack", { id: command.id, failed: true });
    }
  }
  private async watchdog() {
    for (const local of this.locals().filter(item => item.status === "running" && item.task.threadId)) {
      const server = await this.request<{ task: CodexTask }>("task", { id: local.task.id });
      if (server.task.state === "waiting_user") continue;
      const now = Date.now(), silent = now - (local.task.lastProgressAt ?? local.task.createdAt);
      if (now < local.task.deadlineAt && silent < 15 * 60000) continue;
      const read = await this.rpc.call<{ thread: { status?: { type?: string; activeFlags?: string[] } } }>("thread/read", { threadId: local.task.threadId });
      if (read.thread.status?.activeFlags?.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))) {
        await this.emit(local.task, "waiting_user", { phase: "等待处理", summary: "原会话正在等待用户处理。" }); continue;
      }
      // Never create another task or repeat a publish when execution may still be active.
      local.fenced = true; this.save(local);
      if (local.task.turnId && read.thread.status?.type === "active") await this.rpc.call("turn/interrupt", { threadId: local.task.threadId, turnId: local.task.turnId });
      await this.emit(local.task, "blocked", { phase: "执行超时", summary: "任务超过阶段执行期限，已请求中断并保留现场；继续前请重新确认要发送的消息。" });
    }
  }
  private async fenceExpired() {
    for (const local of this.locals().filter(item => item.status === "running" && item.task.state !== "waiting_user" && !item.fenced && (item.task.leaseUntil ?? 0) <= Date.now())) {
      local.fenced = true; this.save(local);
      if (local.task.threadId && local.task.turnId && this.rpc.connected) await this.rpc.call("turn/interrupt", { threadId: local.task.threadId, turnId: local.task.turnId });
    }
  }
  private async stopTurn(task: CodexTask) {
    await this.rpc.call("turn/interrupt", { threadId: task.threadId, turnId: task.turnId });
    for (let i = 0; i < 20; i++) {
      const read = await this.rpc.call<{ thread: { status?: { type?: string } } }>("thread/read", { threadId: task.threadId });
      if (read.thread.status?.type !== "active") return;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error("Original turn has not stopped");
  }
  async close() {
    if (this.projectTimer) clearTimeout(this.projectTimer);
    if (this.displayTimer) clearInterval(this.displayTimer); this.flushDisplay();
    this.stopping = true; if (this.timer) clearInterval(this.timer); if (this.guard) clearInterval(this.guard); this.streamAbort.abort(); this.rpc.close();
    await Promise.allSettled([...this.jobs.values(), this.heartbeating, this.syncPromise, this.flushing, this.historyJob, this.projectsJob]); this.db.close();
    if (this.locked) { rmSync(this.config.statePath + ".lock", { recursive: true, force: true }); this.locked = false; }
  }
}
