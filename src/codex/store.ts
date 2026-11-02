import { prepareSql, closeSqlite } from "../sqlite.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { dispatchSchema, PROJECT_LIMIT, projectSchema, workerEventSchema, type CodexDevice, type CodexDispatch, type CodexScope, type CodexTask, type WorkerEvent } from "./types.js";
import { safeDisplay } from "./display.js";

type Row = Record<string, unknown>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const active = new Set(["running", "waiting_user"]);
export class CodexStore extends EventEmitter {
  readonly db: DatabaseSync;
  constructor(readonly options: { databasePath: string; agentId: string; ownerUserId: string }) {
    super(); mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codex_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),agent_id TEXT NOT NULL,user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,projects TEXT NOT NULL,pair_code TEXT UNIQUE,expires_at INTEGER NOT NULL,paired INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0,last_seen_at INTEGER);
      CREATE TABLE IF NOT EXISTS codex_tasks(id TEXT PRIMARY KEY,creation_key TEXT UNIQUE NOT NULL,device_id TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,task_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_commands(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS codex_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS codex_display(seq INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,item_id TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(task_id,attempt,item_id));
      CREATE TABLE IF NOT EXISTS project_execution_grants(device_id TEXT NOT NULL,project_id TEXT NOT NULL,digest TEXT NOT NULL,approved_at INTEGER NOT NULL,PRIMARY KEY(device_id,project_id));
      CREATE INDEX IF NOT EXISTS codex_display_task ON codex_display(task_id,seq);
      CREATE TABLE IF NOT EXISTS codex_display_receipts(event_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS codex_display_receipts_task ON codex_display_receipts(task_id);`);
    if (!(prepareSql(this.db, "PRAGMA table_info(codex_commands)").all() as Row[]).some(column => column.name === "protocol"))
      this.db.exec("ALTER TABLE codex_commands ADD COLUMN protocol TEXT");
    prepareSql(this.db, "INSERT OR IGNORE INTO codex_owner VALUES(1,?,?)").run(options.agentId, options.ownerUserId);
    const owner = prepareSql(this.db, "SELECT agent_id,user_id FROM codex_owner WHERE singleton=1").get() as Row;
    if (owner.agent_id !== options.agentId || owner.user_id !== options.ownerUserId) { closeSqlite(this.db); throw new Error("Codex storage owner mismatch"); }
    // Old queued work and commands were never approved as exact text messages.
    this.db.exec("UPDATE codex_commands SET status='cancelled' WHERE status='pending' AND protocol IS NULL");
    for (const row of prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE json_extract(payload,'$.protocol') IS NULL").all() as Row[]) {
      const task = JSON.parse(String(row.payload));
      if (task.state === "awaiting_review") { task.state = "succeeded"; task.phase = "已完成"; }
      else if (["queued", "running", "waiting_user", "uploading", "reconciling"].includes(task.state)) {
        task.state = "blocked"; task.phase = "请重新确认发送"; task.leaseUntil = undefined; task.leaseToken = undefined;
      }
      prepareSql(this.db, "UPDATE codex_tasks SET state=?,payload=? WHERE id=?").run(task.state, JSON.stringify(task), task.id);
    }
  }
  close() { this.removeAllListeners(); closeSqlite(this.db); }
  assertScope(scope: CodexScope) {
    if (scope.agentId !== this.options.agentId || scope.userId !== this.options.ownerUserId || scope.conversationKind !== "p2p") throw new Error("Codex 只能在所属用户的私聊中使用");
  }
  private tx<T>(action: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = action(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  limit(key: string, max: number, now = Date.now()) {
    return this.tx(() => {
      prepareSql(this.db, "INSERT INTO codex_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END").run(hash(key), now + 600000, now, now);
      return Number((prepareSql(this.db, "SELECT count FROM codex_limits WHERE key=?").get(hash(key)) as Row).count) <= max;
    });
  }
  pairRequest(input: { tokenHash: string; name: string; projects: CodexDevice["projects"] }, now = Date.now()) {
    const prior = prepareSql(this.db, "SELECT id,pair_code,expires_at,paired,revoked FROM codex_devices WHERE token_hash=?").get(input.tokenHash) as Row | undefined;
    if (prior && prior.paired && !prior.revoked) return { deviceId: String(prior.id), paired: true };
    if (prior && !prior.paired && Number(prior.expires_at) > now) return { deviceId: String(prior.id), paired: false, code: String(prior.pair_code), expiresAt: Number(prior.expires_at) };
    if (prior && !prior.paired && !prior.revoked) {
      const code = randomBytes(5).toString("hex").toUpperCase(), expiresAt = now + 600000;
      prepareSql(this.db, "UPDATE codex_devices SET pair_code=?,expires_at=? WHERE id=? AND paired=0 AND revoked=0").run(code, expiresAt, String(prior.id));
      return { deviceId: String(prior.id), paired: false, code, expiresAt };
    }
    if (prior) throw new Error("设备已断开，请重新生成设备凭据");
    const id = randomUUID(), code = randomBytes(5).toString("hex").toUpperCase(), expiresAt = now + 600000;
    prepareSql(this.db, "INSERT INTO codex_devices(id,name,token_hash,projects,pair_code,expires_at) VALUES(?,?,?,?,?,?)").run(id, input.name, input.tokenHash, JSON.stringify(input.projects), code, expiresAt);
    return { deviceId: id, paired: false, code, expiresAt };
  }
  pairPreview(scope: CodexScope, code: string, now = Date.now()) {
    this.assertScope(scope);
    const row = prepareSql(this.db, "SELECT * FROM codex_devices WHERE pair_code=? AND revoked=0 AND expires_at>?").get(code.toUpperCase(), now) as Row | undefined;
    if (!row) throw new Error("配对码已失效，请在 Mac 重新连接");
    return { id: String(row.id), name: String(row.name), projects: JSON.parse(String(row.projects)) as CodexDevice["projects"], paired: Boolean(row.paired) };
  }
  pair(scope: CodexScope, code: string) {
    const device = this.pairPreview(scope, code);
    prepareSql(this.db, "UPDATE codex_devices SET paired=1 WHERE id=? AND revoked=0").run(device.id);
    this.emit("change"); return device;
  }
  authenticate(token: string, pending = false): CodexDevice | undefined {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return undefined;
    const row = prepareSql(this.db, "SELECT * FROM codex_devices WHERE token_hash=? AND revoked=0").get(hash(token)) as Row | undefined;
    if (!row || !row.paired && (!pending || Number(row.expires_at) <= Date.now())) return undefined;
    return this.device(row);
  }
  paired(id: string) { return Boolean((prepareSql(this.db, "SELECT paired FROM codex_devices WHERE id=? AND revoked=0").get(id) as Row | undefined)?.paired); }
  projects(deviceId: string, projects: CodexDevice["projects"]) {
    if (!this.paired(deviceId) || projects.length > PROJECT_LIMIT || new Set(projects.map(p => p.id)).size !== projects.length) throw new Error("项目目录无效");
    const catalog = projects.map(p => projectSchema.parse(p));
    prepareSql(this.db, "UPDATE codex_devices SET projects=? WHERE id=? AND paired=1 AND revoked=0").run(JSON.stringify(catalog), deviceId);
  }
  private device(row: Row): CodexDevice { return { id: String(row.id), name: String(row.name), projects: JSON.parse(String(row.projects)), lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at), revoked: Boolean(row.revoked) }; }
  devices(scope: CodexScope) { this.assertScope(scope); return (prepareSql(this.db, "SELECT * FROM codex_devices WHERE paired=1 AND revoked=0 ORDER BY name").all() as Row[]).map(row => this.device(row)); }
  revoke(scope: CodexScope, id: string) { this.assertScope(scope); prepareSql(this.db, "UPDATE codex_devices SET revoked=1 WHERE id=?").run(id); this.sweep(); this.emit("change"); }
  create(scope: CodexScope, value: CodexDispatch, key: string, now = Date.now(), sourceRunId?: string, origin?: { originalRequest?: string; model?: string; reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>> }) {
    this.assertScope(scope); const input = dispatchSchema.parse(value);
    if (!scope.conversationId || !scope.sessionId) throw new Error("任务缺少所属会话");
    const previous = prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE creation_key=?").get(key) as Row | undefined;
    if (previous) return JSON.parse(String(previous.payload)) as CodexTask;
    const device = this.devices(scope).find(device => device.id === input.deviceId);
    if (!device?.projects.some(project => project.id === input.projectId && project.available !== false)) throw new Error("请选择已连接设备上的可用授权项目");
    const prior = input.continueTaskId ? this.owned(scope, input.continueTaskId) : undefined;
    if (prior && (prior.protocol !== "text-v1" || !prior.threadId || prior.deviceId !== input.deviceId || prior.projectId !== input.projectId
      || !["succeeded", "blocked", "cancelled"].includes(prior.state) || JSON.stringify(prior.project) !== JSON.stringify(device.projects.find(project => project.id === input.projectId))))
      throw new Error("原会话项目或状态已变化，请重新选择会话");
    const previousRequest = prior?.originalRequest, newRequest = origin?.originalRequest;
    const originalRequest = !newRequest ? previousRequest : !previousRequest || newRequest.includes(previousRequest) ? newRequest
      : previousRequest.includes(newRequest) ? previousRequest : previousRequest + "\n\n" + newRequest;
    if (originalRequest && originalRequest.length > 64000) throw new Error("原始要求过长，请明确本次任务范围后重新派发");
    const task: CodexTask = { originalRequest, intent: prior ? origin ? `${prior.intent ?? prior.prompt}\n\n用户后续要求：\n${input.prompt}` : prior.intent ?? prior.prompt : input.prompt,
      ...(input.reviewAfterCompletion ? { review: { state: "pending" as const, deadlineAt: now + input.timeoutMinutes * 60000, model: origin?.model, reasoningEfforts: origin?.reasoningEfforts } } : {}), id: randomUUID(), userId: scope.userId, conversationId: scope.conversationId, sessionId: scope.sessionId,
      deviceId: input.deviceId, projectId: input.projectId, project: device.projects.find(project => project.id === input.projectId), protocol: "text-v1", ...(sourceRunId ? { sourceRunId } : {}), title: input.title, prompt: input.prompt,
      ...(prior?.threadId ? { threadId: prior.threadId, continueTaskId: prior.id, execution: prior.execution ? { ...prior.execution, publication: "pending", files: 0, usage: undefined, usageReportedAt: undefined } : undefined } : {}), state: "queued", phase: "等待接单", attempt: 1, revision: 1, createdAt: now, updatedAt: now, deadlineAt: now + input.timeoutMinutes * 60000,
      notification: "none" };
    prepareSql(this.db, "INSERT INTO codex_tasks VALUES(?,?,?,?,?,?)").run(task.id, key, task.deviceId, task.state, JSON.stringify(task), now);
    this.record(task.id, randomUUID(), { type: "queued", phase: task.phase }, now); this.emit("change"); return task;
  }
  get(id: string): CodexTask | undefined { const row = prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE id=?").get(id) as Row | undefined; return row ? JSON.parse(String(row.payload)) : undefined; }
  owned(scope: CodexScope, id: string) { this.assertScope(scope); const task = this.get(id); if (!task || task.userId !== scope.userId) throw new Error("没有找到所属任务"); return task; }
  list(scope: CodexScope, limit = 20) { this.assertScope(scope); return (prepareSql(this.db, "SELECT payload FROM codex_tasks ORDER BY updated_at DESC LIMIT ?").all(Math.min(50, limit)) as Row[]).map(row => JSON.parse(String(row.payload)) as CodexTask); }
  save(task: CodexTask) { prepareSql(this.db, "UPDATE codex_tasks SET state=?,payload=?,updated_at=? WHERE id=?").run(task.state, JSON.stringify(task), task.updatedAt, task.id); this.emit("change", task.id); }
  update(id: string, action: (task: CodexTask) => void) {
    return this.tx(() => { const task = this.get(id); if (!task) throw new Error("任务不存在"); action(task); this.save(task); return task; });
  }
  all() { return (prepareSql(this.db, "SELECT payload FROM codex_tasks ORDER BY updated_at").all() as Row[]).map(row => JSON.parse(String(row.payload)) as CodexTask); }
  claimReview(id: string, now = Date.now()) {
    return this.tx(() => {
      const task = this.get(id), review = task?.review;
      if (!task || task.state !== "succeeded" || !review || !["pending", "running"].includes(review.state)
        || (review.nextAttemptAt ?? 0) > now || review.state === "running" && (review.leaseUntil ?? 0) > now) return undefined;
      review.state = "running"; review.leaseToken = randomUUID(); review.leaseUntil = now + 240000;
      task.phase = "核对中"; task.revision++; task.updatedAt = now; this.save(task); return task;
    });
  }
  finishReview(id: string, token: string, decision: { decision: "continue" | "deliver" | "blocked"; message: string; followup?: string }, now = Date.now()) {
    return this.tx(() => {
      const task = this.get(id), review = task?.review;
      if (!task || task.state !== "succeeded" || !review || review.state !== "running" || review.leaseToken !== token || (review.leaseUntil ?? 0) <= now) return;
      const scope = { agentId: this.options.agentId, userId: task.userId, conversationId: task.conversationId, sessionId: task.sessionId, conversationKind: "p2p" as const };
      const project = this.devices(scope).find(d => d.id === task.deviceId)?.projects.find(p => p.id === task.projectId);
      const unchanged = project && JSON.stringify(project) === JSON.stringify(task.project)
        && (!project.executor || this.executionGrant(scope, task.deviceId, task.projectId));
      if (!unchanged) decision = { decision: "blocked", message: "项目授权或范围已变化，结果已保留，请确认后继续。" };
      if (decision.decision === "continue" && (!unchanged || !task.threadId || review.deadlineAt <= now || !decision.followup)) {
        decision = { decision: "blocked", message: !unchanged ? "项目授权或范围已变化，请确认后继续。" : review.deadlineAt <= now ? "本次授权执行时间已到，现有结果保留，请决定是否继续。" : "补做内容尚未明确，请决定下一步。" };
      }
      if (decision.decision === "continue") {
        const next = this.create(scope, { deviceId: task.deviceId, projectId: task.projectId, title: task.title, prompt: decision.followup!,
          continueTaskId: task.id, reviewAfterCompletion: true, timeoutMinutes: Math.max(5, Math.min(1440, Math.ceil((review.deadlineAt - now) / 60000))) }, `review:${task.id}`, now, task.sourceRunId);
        next.originalRequest = task.originalRequest;
        next.review = { state: "pending", deadlineAt: review.deadlineAt, model: review.model, reasoningEfforts: review.reasoningEfforts };
        next.deadlineAt = review.deadlineAt; this.save(next);
        review.state = "continued"; review.nextTaskId = next.id; task.phase = "继续补充"; task.notification = "none";
      } else {
        review.state = decision.decision === "deliver" ? "delivered" : "blocked";
        task.phase = decision.decision === "deliver" ? "已核对" : "需要你决定";
        task.notification = "pending:review:" + task.id;
      }
      review.decision = decision.decision; review.message = decision.message; review.leaseToken = undefined; review.leaseUntil = undefined;
      task.revision++; task.updatedAt = now; this.save(task);
      this.record(task.id, randomUUID(), { type: "reviewed", decision: decision.decision, nextTaskId: review.nextTaskId }, now);
    });
  }
  failReview(id: string, token: string) {
    this.update(id, task => {
      if (!task.review || task.review.state !== "running" || task.review.leaseToken !== token) return;
      const review = task.review; review.failures = (review.failures ?? 0) + 1;
      review.leaseUntil = undefined; review.leaseToken = undefined;
      if (review.failures >= 3 || review.deadlineAt <= Date.now()) {
        review.state = "blocked"; review.message = "结果已保留，但自动核对未完成，请决定下一步。";
        task.phase = "核对受阻"; task.notification = "pending:review:" + task.id;
      } else { review.state = "pending"; review.nextAttemptAt = Date.now() + 30000 * review.failures; task.phase = "等待重新核对"; }
      task.revision++; task.updatedAt = Date.now();
    });
  }
  stopReview(scope: CodexScope, id: string): boolean {
    const task = this.owned(scope, id);
    if (!task.review || !["pending", "running"].includes(task.review.state) || task.state !== "succeeded") return false;
    this.update(id, current => { current.review!.state = "blocked"; current.review!.leaseToken = undefined;
      current.review!.message = "已停止后续核对与补做。"; current.phase = "已停止跟进"; current.notification = "none"; current.revision++; });
    return true;
  }
  private record(taskId: string, eventId: string, value: unknown, now: number) {
    prepareSql(this.db, "INSERT INTO codex_events(event_id,task_id,payload,created_at) VALUES(?,?,?,?)").run(eventId, taskId, JSON.stringify(value), now);
  }
  cursor() { return Number((prepareSql(this.db, "SELECT COALESCE(MAX(seq),0) n FROM codex_events").get() as Row).n); }
  events(scope: CodexScope, id: string, limit = 20) { this.owned(scope, id); return (prepareSql(this.db, "SELECT seq,payload,created_at FROM codex_events WHERE task_id=? ORDER BY seq DESC LIMIT ?").all(id, Math.min(50, limit)) as Row[]).reverse().map(row => ({ seq: Number(row.seq), at: Number(row.created_at), ...JSON.parse(String(row.payload)) as object })); }
  nextQueued(deviceId: string): CodexTask | undefined {
    const row = prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE device_id=? AND state='queued' ORDER BY updated_at LIMIT 1").get(deviceId) as Row | undefined;
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  executionGrant(scope: CodexScope, deviceId: string, projectId: string, approve = false): boolean {
    const project = this.devices(scope).find(d => d.id === deviceId)?.projects.find(p => p.id === projectId);
    if (!project?.executor || project.available === false) return false;
    const digest = hash(JSON.stringify(project));
    if (approve) prepareSql(this.db, "INSERT INTO project_execution_grants VALUES(?,?,?,?) ON CONFLICT(device_id,project_id) DO UPDATE SET digest=excluded.digest,approved_at=excluded.approved_at").run(deviceId, projectId, digest, Date.now());
    return Boolean(prepareSql(this.db, "SELECT 1 FROM project_execution_grants WHERE device_id=? AND project_id=? AND digest=?").get(deviceId, projectId, digest));
  }
  claim(deviceId: string, now = Date.now()) {
    return this.tx(() => {
      if (prepareSql(this.db, "SELECT 1 FROM codex_tasks WHERE device_id=? AND state IN ('running','waiting_user','reconciling') LIMIT 1").get(deviceId)) return undefined;
      const row = prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE device_id=? AND state='queued' ORDER BY updated_at LIMIT 1").get(deviceId) as Row | undefined;
      if (!row) return undefined;
      const task = JSON.parse(String(row.payload)) as CodexTask;
      if (task.deadlineAt <= now) { task.state = "blocked"; task.phase = "任务已超时"; task.notification = "pending:" + randomUUID(); this.save(task); return undefined; }
      task.state = "running"; task.phase = "连接会话"; task.leaseToken = randomUUID(); task.leaseUntil = now + 90000; task.lastSeenAt = now; task.lastProgressAt = now; task.updatedAt = now;
      task.revision += 1;
      this.save(task); this.record(task.id, randomUUID(), { type: "claimed", phase: task.phase }, now); return task;
    });
  }
  heartbeat(deviceId: string, tasks: Array<{ id: string; attempt: number; leaseToken: string }>, now = Date.now()) {
    return this.tx(() => {
    prepareSql(this.db, "UPDATE codex_devices SET last_seen_at=? WHERE id=? AND revoked=0").run(now, deviceId);
    return tasks.map(item => {
      const task = this.get(item.id);
      if (!task || task.deviceId !== deviceId || task.attempt !== item.attempt || task.leaseToken !== item.leaseToken || !active.has(task.state) || (task.leaseUntil ?? 0) <= now)
        return { id: item.id, valid: false };
      task.lastSeenAt = now; task.leaseUntil = now + 90000;
      // Heartbeats update liveness only: no event, model call, message or progress timestamp.
      prepareSql(this.db, "UPDATE codex_tasks SET payload=? WHERE id=?").run(JSON.stringify(task), task.id);
      return { id: task.id, valid: true, leaseUntil: task.leaseUntil };
    });
    });
  }
  assertLease(deviceId: string, id: string, attempt: number, token: string, now = Date.now()) {
    const task = this.get(id);
    if (!this.paired(deviceId) || !task || task.deviceId !== deviceId || task.attempt !== attempt || task.leaseToken !== token || !active.has(task.state) || (task.leaseUntil ?? 0) <= now) throw new Error("执行租约已失效，请先核对原任务");
    return task;
  }
  event(deviceId: string, value: WorkerEvent, now = Date.now()) {
    const event = workerEventSchema.parse(value);
    if (event.type === "display") return this.displayEvent(deviceId, event, now);
    if (event.display || event.historical) throw new Error("执行详情必须使用独立通道");
    return this.tx(() => {
      const prior = prepareSql(this.db, "SELECT task_id,payload FROM codex_events WHERE event_id=?").get(event.eventId) as Row | undefined;
      if (prior) {
        const task = this.get(String(prior.task_id));
        if (!task || task.deviceId !== deviceId || task.id !== event.taskId || String(prior.payload) !== JSON.stringify(this.eventPayload(event))) throw new Error("回执编号冲突");
        return { acknowledged: event.eventId, duplicate: true, state: task.state };
      }
      const reconciling = this.get(event.taskId);
      const task = event.type === "interrupted" && reconciling?.state === "reconciling" && reconciling.deviceId === deviceId
        && reconciling.attempt === event.attempt && reconciling.leaseToken === event.leaseToken && this.paired(deviceId)
        ? reconciling : this.assertLease(deviceId, event.taskId, event.attempt, event.leaseToken, now);
      if (event.threadId) { if (task.threadId && task.threadId !== event.threadId) throw new Error("任务会话不匹配"); task.threadId = event.threadId; }
      if (event.turnId) task.turnId = event.turnId;
      if (event.execution) {
        if (task.project?.executor !== event.execution.executor || task.project.host !== event.execution.host || task.execution &&
          (task.execution.inputVersion !== event.execution.inputVersion || task.execution.directory !== event.execution.directory || task.execution.baselineTaskId !== event.execution.baselineTaskId)) throw new Error("Execution identity changed");
        task.execution = event.execution;
      }
      if (event.phase) task.phase = event.phase;
      if (event.type === "started") {
        if (task.waitingSince) task.deadlineAt += now - task.waitingSince;
        task.waitingSince = undefined; task.state = "running";
      }
      if (event.type === "progress" && event.activity?.kind !== "reasoning_summary") task.lastProgressAt = now;
      if (event.type === "waiting_user") { task.state = "waiting_user"; task.waitingSince ??= now; task.summary = event.summary; task.notification = "pending:" + event.eventId; }
      if (event.type === "completed") { task.state = "succeeded"; task.phase = "已完成"; task.summary = event.summary ?? ""; task.notification = "pending:" + event.eventId; }
      if (event.type === "blocked") { task.state = "blocked"; task.phase = "执行受阻"; task.summary = event.summary; task.notification = "pending:" + event.eventId; }
      if (event.type === "interrupted") { task.state = "cancelled"; task.phase = "已中断"; task.notification = "pending:" + event.eventId; }
      if (!active.has(task.state)) { task.leaseUntil = undefined; task.leaseToken = undefined; }
      task.updatedAt = now; task.revision += 1; this.save(task);
      this.record(task.id, event.eventId, this.eventPayload(event), now);
      return { acknowledged: event.eventId, duplicate: false, state: task.state };
    });
  }
  private eventPayload(event: WorkerEvent) { const { leaseToken: _token, ...safe } = event; return safe; }
  private displayEvent(deviceId: string, event: WorkerEvent, now: number) {
    if (!event.display) throw new Error("执行详情为空");
    const display = safeDisplay(event.display), digest = hash(JSON.stringify([event.taskId, event.attempt, display]));
    return this.tx(() => {
      const task = this.get(event.taskId), prior = prepareSql(this.db, "SELECT task_id,digest FROM codex_display_receipts WHERE event_id=?").get(event.eventId) as Row | undefined;
      if (!task || task.deviceId !== deviceId || !this.paired(deviceId)) throw new Error("任务不存在");
      if (prior) { if (prior.task_id !== task.id || prior.digest !== digest) throw new Error("回执编号冲突"); return { acknowledged: event.eventId, duplicate: true, state: task.state }; }
      if (event.historical) {
        if (!["succeeded", "blocked", "cancelled"].includes(task.state) || event.attempt !== task.attempt || !task.threadId || event.threadId !== task.threadId) throw new Error("历史会话不匹配");
      } else this.assertLease(deviceId, task.id, event.attempt, event.leaseToken, now);
      if (event.threadId && event.threadId !== task.threadId) throw new Error("任务会话不匹配");
      // A noisy process cannot grow the database indefinitely or wake the model supervisor.
      const count = Number((prepareSql(this.db, "SELECT COUNT(*) n FROM codex_display_receipts WHERE task_id=?").get(task.id) as Row).n);
      if (count < 10000) {
        prepareSql(this.db, "INSERT INTO codex_display_receipts VALUES(?,?,?)").run(event.eventId, task.id, digest);
        const old = prepareSql(this.db, "SELECT created_at FROM codex_display WHERE task_id=? AND attempt=? AND item_id=?").get(task.id, event.attempt, display.itemId) as Row | undefined;
        prepareSql(this.db, "DELETE FROM codex_display WHERE task_id=? AND attempt=? AND item_id=?").run(task.id, event.attempt, display.itemId);
        prepareSql(this.db, "INSERT INTO codex_display(task_id,attempt,item_id,payload,created_at) VALUES(?,?,?,?,?)").run(task.id, event.attempt, display.itemId, JSON.stringify(display), Number(old?.created_at ?? now));
        prepareSql(this.db, "DELETE FROM codex_display WHERE task_id=? AND seq NOT IN (SELECT seq FROM codex_display WHERE task_id=? ORDER BY seq DESC LIMIT 192)").run(task.id, task.id);
      }
      return { acknowledged: event.eventId, duplicate: false, state: task.state };
    });
  }
  display(scope: CodexScope, taskId: string, after = 0) {
    this.owned(scope, taskId);
    const rows = prepareSql(this.db, "SELECT seq,attempt,payload,created_at FROM codex_display WHERE task_id=? AND seq>? ORDER BY seq LIMIT 100").all(taskId, after) as Row[];
    const cursor = rows.length ? Number(rows.at(-1)!.seq) : after;
    return { items: rows.map(row => ({ seq: Number(row.seq), attempt: Number(row.attempt), at: Number(row.created_at), ...JSON.parse(String(row.payload)) as object })), cursor,
      hasMore: Boolean(prepareSql(this.db, "SELECT 1 FROM codex_display WHERE task_id=? AND seq>? LIMIT 1").get(taskId, cursor)) };
  }
  displayCursor() { return Number((prepareSql(this.db, "SELECT COALESCE(MAX(seq),0) n FROM codex_display").get() as Row).n); }
  command(scope: CodexScope, id: string, kind: "message" | "interrupt", text: string, key: string) {
    const task = this.owned(scope, id);
    if (task.protocol !== "text-v1") throw new Error("旧任务需要重新确认发送");
    if (kind === "interrupt" && task.state === "queued") {
      task.state = "cancelled"; task.phase = "已取消"; task.revision++; task.updatedAt = Date.now(); this.save(task);
      return { id: hash(key), status: "acknowledged" };
    }
    if (!["running", "waiting_user", "reconciling", "blocked"].includes(task.state)) throw new Error("该任务当前不能执行此操作");
    const commandId = hash(key);
    const changed = prepareSql(this.db, "INSERT OR IGNORE INTO codex_commands(id,task_id,kind,text,status,created_at,protocol) VALUES(?,?,?,?,?,?,'text-v1')").run(commandId, id, kind, text, "pending", Date.now());
    if (changed.changes) this.record(id, randomUUID(), { type: "command", kind }, Date.now());
    this.emit("change"); return { id: commandId, status: "pending" };
  }
  commands(deviceId: string) { return (prepareSql(this.db, "SELECT c.* FROM codex_commands c JOIN codex_tasks t ON t.id=c.task_id WHERE t.device_id=? AND c.status='pending' AND c.protocol='text-v1' ORDER BY c.created_at LIMIT 10").all(deviceId) as Row[]).map(row => ({ id: String(row.id), taskId: String(row.task_id), kind: String(row.kind), text: String(row.text) })); }
  acknowledgeCommand(deviceId: string, id: string, failed = false) {
    this.tx(() => {
      const row = prepareSql(this.db, "SELECT c.task_id FROM codex_commands c JOIN codex_tasks t ON t.id=c.task_id WHERE c.id=? AND t.device_id=? AND c.status='pending'").get(id, deviceId) as Row | undefined;
      if (!row) return;
      prepareSql(this.db, "UPDATE codex_commands SET status=? WHERE id=?").run(failed ? "failed" : "acknowledged", id);
      if (failed) {
        const task = this.get(String(row.task_id))!;
        task.summary = (task.summary ? task.summary + "\n\n" : "") + "补充操作未确认送达，请检查原会话后重新确认消息。";
        task.notification = "pending:" + randomUUID(); task.revision += 1; task.updatedAt = Date.now(); this.save(task);
        this.record(task.id, randomUUID(), { type: "command_failed" }, Date.now());
      }
    });
  }
  reconcile(deviceId: string, id: string, input: { attempt: number; threadId?: string; state: "running" | "completed" | "stopped" }, now = Date.now()) {
    return this.tx(() => {
      const task = this.get(id);
      if (!task || task.deviceId !== deviceId || task.attempt !== input.attempt || input.threadId && task.threadId && input.threadId !== task.threadId) throw new Error("任务核对信息不匹配");
      if (!["reconciling", "running", "waiting_user"].includes(task.state)) return { task, accepted: false };
      if (input.state === "running" && !task.waitingSince && task.deadlineAt <= now) throw new Error("任务已超时，请先停止原执行");
      task.state = input.state === "stopped" ? "blocked" : "running"; task.phase = input.state === "completed" ? "读取回复" : input.state === "stopped" ? "等待恢复" : "执行中";
      if (input.state === "running" && task.waitingSince) { task.state = "waiting_user"; task.phase = "等待补充信息"; }
      task.revision += 1;
      if (input.state === "stopped") { task.summary = "原执行已停止，请核对检查点后继续。"; task.notification = "pending:" + randomUUID(); }
      task.leaseToken = randomUUID(); task.leaseUntil = now + 90000; task.lastSeenAt = now; task.updatedAt = now; this.save(task);
      this.record(id, randomUUID(), { type: "reconciled", phase: task.phase }, now); return { task, accepted: true };
    });
  }
  sweep(now = Date.now()) {
    this.tx(() => {
    const rows = prepareSql(this.db, "SELECT payload FROM codex_tasks WHERE state IN ('queued','running','waiting_user')").all() as Row[];
    for (const row of rows) {
      const task = JSON.parse(String(row.payload)) as CodexTask;
      const revoked = !this.paired(task.deviceId);
      if (task.state === "queued") {
        if (revoked || task.deadlineAt <= now) {
          task.state = "blocked"; task.phase = revoked ? "设备已断开" : "等待接单超时"; task.notification = "pending:" + randomUUID(); task.updatedAt = now; task.revision += 1;
          this.save(task); this.record(task.id, randomUUID(), { type: "blocked", phase: task.phase }, now);
        }
        continue;
      }
      if (revoked || (task.leaseUntil ?? 0) <= now || task.state !== "waiting_user" && task.deadlineAt <= now) {
        task.state = "reconciling"; task.phase = revoked ? "设备已断开" : "失联待核对"; task.notification = "pending:" + randomUUID(); task.updatedAt = now; task.revision += 1; this.save(task);
        this.record(task.id, randomUUID(), { type: "reconciling", phase: task.phase }, now);
      }
    }
    });
  }
}
