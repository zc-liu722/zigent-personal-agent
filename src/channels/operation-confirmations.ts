import { prepareSql, closeSqlite } from "../sqlite.js";
import { codexEditsSchema, codexForm, editCodexDraft, type CodexEdits, type CodexForm } from "../codex/confirmation.js";
import type { CodexDevice } from "../codex/types.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { AgentToolSet, ToolExecutionContext } from "../tools/registry.js";
import { executeConfirmedOperation, operationDigest } from "../tools/confirmed-operation.js";
import { buildOperationDraft, object, operationSnapshots, type OperationDraft } from "../tools/operation-policy.js";
import { skillSectionsSchema } from "../skills/service.js";
import type { ChangeDocument, ChangePreview } from "./change-preview.js";
import { ProductivityRequestError } from "../productivity/http.js";
import { ProductivityAuthorizationRequiredError } from "../productivity/credentials.js";

export type OperationScope = Pick<ToolExecutionContext, "agentId" | "userId" | "principalId" | "conversationId" | "conversationKind" | "sessionId" | "turnId" | "delegationRequest" | "model" | "reasoningEfforts">;
export type OperationNotice = { id: string; actionId?: string; conversationId: string; sessionId?: string; messageId?: string; title: string; description: string;
  status: "pending" | "completed" | "cancelled" | "expired" | "failed"; statusMessage: string; expiresAt: number; retryable: boolean;
  changes?: ChangePreview[]; changeDocuments?: ChangeDocument[]; codexForm?: CodexForm; view?: "todo" | "calendar" | "task" };
type Saved = { draft: OperationDraft; scope: OperationScope; expiresAt: number; status: OperationNotice["status"] | "executing";
  statusMessage: string; messageId?: string; retryable: boolean; codexForm?: CodexForm;
  failure?: OperationFailure;
  batch?: Array<{ draft: OperationDraft; completed?: boolean }> };
type Row = { id: string; payload: string };
type OperationFailure = { phase: "before_write" | "write"; reason: "authorization" | "connect" | "timeout" | "dns" | "tls" | "network" | "http" | "unknown"; httpStatus?: number; at: number };

/** Persist and log fixed categories only; never log upstream messages, inputs, or credentials. */
function operationFailure(error: unknown, writeStarted: boolean): OperationFailure {
  const phase = writeStarted ? "write" : "before_write";
  if (error instanceof ProductivityAuthorizationRequiredError) return { phase, reason: "authorization", at: Date.now() };
  if (error instanceof ProductivityRequestError) return { phase, reason: error.failure,
    ...(error.status && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}), at: Date.now() };
  return { phase, reason: "unknown", at: Date.now() };
}
function failureText(failure: OperationFailure): string {
  const detail = failure.reason === "authorization" ? "账号需要重新连接。"
    : failure.reason === "http" ? `日历服务拒绝或未完成请求${failure.httpStatus ? `（HTTP ${failure.httpStatus}）` : ""}。`
    : ["connect", "timeout", "dns", "tls", "network"].includes(failure.reason) ? "日历服务连接失败。" : "日程操作未完成。";
  return failure.phase === "before_write" ? `${detail}执行前核对未完成，未提交变更；可以重试核对。`
    : `${detail}执行结果尚未确认，请先查看日历，再提出需要的变更。`;
}

/** Group only operations whose targets are independent within one turn. */
function batchTarget(draft: OperationDraft): string | undefined {
  const action = String(draft.input.action);
  if (draft.tool === "schedule") {
    if (action === "create" && !object(draft.input.item).parentId) return `create:${operationDigest(draft)}`;
    if (["update", "complete", "reopen", "delete"].includes(action) && typeof draft.input.id === "string") return `item:${draft.input.id}`;
  }
  if (draft.tool === "todoist") {
    if (action === "create_task" && !draft.input.parent_id) return `create:${operationDigest(draft)}`;
    if (["update_task", "complete_task", "reopen_task", "delete_task"].includes(action) && typeof draft.input.task_id === "string") return `task:${draft.input.task_id}`;
  }
  if (draft.tool === "google_calendar") {
    if (action === "create_event") return `create:${operationDigest(draft)}`;
    if (["update_event", "delete_event"].includes(action) && typeof draft.input.event_id === "string") return `event:${draft.input.calendar_id ?? "primary"}:${draft.input.event_id}`;
  }
  if (["proactive_tasks", "health_tasks"].includes(draft.tool) && !draft.input.activate_revision && object(draft.input.trigger).type !== "reference") {
    if (action === "create") return `create:${operationDigest(draft)}`;
    if (["update", "delete", "pause", "resume", "cancel"].includes(action) && typeof draft.input.id === "string") return `task:${draft.input.id}`;
  }
  return undefined;
}
function operationView(draft: OperationDraft): OperationNotice["view"] {
  const tool = draft.tool;
  if (tool === "schedule") {
    const kind = object(draft.input.item).kind ?? object(object(draft.changes?.[0]?.presentation).after).kind;
    const presentation = object(draft.changes?.[0]?.presentation);
    return presentation.kind === "todo" || presentation.kind === "calendar" ? presentation.kind : kind === "todo" ? "todo" : kind === "event" ? "calendar" : undefined;
  }
  return tool === "todoist" ? "todo" : tool === "google_calendar" ? "calendar" : ["proactive_tasks", "health_tasks"].includes(tool) ? "task" : undefined;
}
function unsuccessful(output: Record<string, unknown>): boolean {
  return output.ok === false || output.isError === true || output.bound === false || output.result === "not_owner"
    || ["authorization_pending", "authorization_required", "not_configured", "confirmation_required", "pending_confirmation", "failed", "uncertain", "expired"].includes(String(output.status))
    || Boolean(output.requires_confirmation);
}

/** Channel-neutral durable consent. The client only selects a saved operation ID. */
export class OperationConfirmations {
  private readonly db: DatabaseSync;
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private offers: Promise<void> = Promise.resolve();
  constructor(path: string, private readonly tools: AgentToolSet,
    private readonly deliver: (notice: OperationNotice) => Promise<{ messageId: string }>,
    private readonly restoreContext: (scope: OperationScope) => Partial<ToolExecutionContext> = () => ({})) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operation_confirmations(id TEXT PRIMARY KEY, operation_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)`);
    for (const row of prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.draft.tool')='project_sync' AND json_extract(payload,'$.status') IN ('pending','failed')").all() as Row[]) {
      const saved = JSON.parse(row.payload) as Saved;
      this.save(row.id, { ...saved, status: "expired", retryable: false, statusMessage: "旧快照入口已退役，请查看项目空间同步状态。" });
    }
    for (const row of prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.draft.tool')='codex' AND json_extract(payload,'$.draft.input.action') IN ('dispatch','message') AND json_extract(payload,'$.scope.delegationRequest') IS NULL AND json_extract(payload,'$.status') IN ('pending','failed')").all() as Row[]) {
      const saved = JSON.parse(row.payload) as Saved;
      this.save(row.id, { ...saved, status: "expired", retryable: false, statusMessage: "派发规则已更新，请按原始要求重新准备任务。" });
    }
    // An interrupted external write is never automatically replayed.
    for (const row of prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.status')='executing'").all() as Row[]) {
      const saved = JSON.parse(row.payload) as Saved;
      this.save(row.id, { ...saved, status: "failed", retryable: false, statusMessage: "服务重启，执行结果尚未确认。请先查看目标状态，再提出需要的变更。" });
    }
  }
  private save(id: string, saved: Saved): void { prepareSql(this.db, "UPDATE operation_confirmations SET payload=? WHERE id=?").run(JSON.stringify(saved), id); }
  private load(id: string): Saved | undefined {
    const row = prepareSql(this.db, "SELECT payload FROM operation_confirmations WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Saved : undefined;
  }
  /** Read the exact saved proposal, including older create cards, without executing tools. */
  taskPreview(userId: string, conversationId: string, principalId: string | undefined, id: string) {
    const saved = this.load(id);
    if (!saved || saved.scope.userId !== userId || saved.scope.conversationId !== conversationId
      || saved.scope.principalId && saved.scope.principalId !== principalId
      || !["proactive_tasks", "health_tasks"].includes(saved.draft.tool)) return undefined;
    if (saved.batch) return { changes: saved.batch.flatMap((item, index) => (item.draft.changes ?? []).map(change => ({ ...change, title: `${index + 1}. ${change.title}`, ...(item.completed ? { note: "已完成" } : {}) }))),
      triggers: saved.batch.flatMap(item => (item.draft.changes ?? []).map((_, index) => item.draft.taskTriggers?.[index] ?? {})) };
    const draft = saved.draft;
    if (draft.taskTriggers) return { changes: draft.changes, triggers: draft.taskTriggers };
    if (draft.input.action !== "create") return undefined;
    try {
      const restored = buildOperationDraft(draft.tool, draft.input, []);
      return { changes: restored.changes, triggers: restored.taskTriggers };
    } catch { return undefined; }
  }
  private async publish(id: string, saved: Saved): Promise<void> {
    const task = this.taskPreview(saved.scope.userId, saved.scope.conversationId!, saved.scope.principalId, id);
    const drafts = saved.batch?.map(item => item.draft);
    const receipt = await this.deliver({ id, actionId: this.actionId(id, saved), conversationId: saved.scope.conversationId!, sessionId: saved.scope.sessionId, messageId: saved.messageId,
      title: drafts ? `${({ todo: "待办", calendar: "日程", task: "任务" } as const)[operationView(saved.draft)!]}（${drafts.length}项）` : saved.draft.title,
      view: operationView(saved.draft),
      description: drafts ? drafts.map((draft, index) => `${index + 1}. ${draft.description}`).join("\n\n") : saved.draft.description,
      codexForm: saved.codexForm, changes: drafts ? drafts.flatMap((draft, index) => (draft.changes ?? [{ title: draft.title, after: draft.description }])
        .map(change => ({ ...change, title: `${index + 1}. ${change.title}`,
          ...(saved.batch![index]!.completed ? { note: "已完成" } : {}) }))) : task?.changes ?? saved.draft.changes,
      changeDocuments: saved.draft.changeDocuments,
      status: saved.status === "executing" ? "pending" : saved.status,
      statusMessage: saved.statusMessage, expiresAt: saved.expiresAt, retryable: saved.retryable });
    saved.messageId = receipt.messageId;
    // A slow stale-button delivery must never restore an older consent/execution state.
    const latest = this.load(id);
    if (latest) { latest.messageId = receipt.messageId; this.save(id, latest); }
  }
  private actionId(id: string, saved: Saved): string {
    // Version the first batchable draft too: its old button must not authorize later additions.
    return saved.batch || batchTarget(saved.draft) || saved.draft.skillBaseline || saved.draft.tool === "codex"
      ? `${id}:${operationDigest(saved.batch?.map(item => item.draft) ?? saved.draft)}` : id;
  }
  offer(draft: OperationDraft, context: ToolExecutionContext): Promise<{ proposalId: string }> {
    const task = this.offers.then(() => this.offerDraft(draft, context));
    this.offers = task.then(() => undefined, () => undefined);
    return task;
  }
  private async offerDraft(draft: OperationDraft, context: ToolExecutionContext): Promise<{ proposalId: string }> {
    context.signal?.throwIfAborted();
    if (!context.conversationId || context.conversationKind !== "p2p" || context.taskRunId || context.backgroundTaskKind) throw new Error("变更确认只能在本人私聊中发起。");
    const scope: OperationScope = { agentId: context.agentId, userId: context.userId, principalId: context.principalId,
      conversationId: context.conversationId, conversationKind: context.conversationKind, sessionId: context.sessionId, turnId: context.turnId, delegationRequest: draft.delegationEvidence ?? context.delegationRequest, model: context.model, reasoningEfforts: context.reasoningEfforts };
    const key = operationDigest([scope, draft]);
    const prior = prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE operation_key=?").get(key) as Row | undefined;
    if (!prior && batchTarget(draft) && scope.sessionId && scope.turnId !== undefined) {
      const rows = prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.status')='pending'").all() as Row[];
      for (const row of rows) {
        const pending = JSON.parse(row.payload) as Saved;
        if (!pending.retryable || pending.expiresAt <= Date.now() || operationDigest(pending.scope) !== operationDigest(scope)
          || pending.draft.tool !== draft.tool || operationView(pending.draft) !== operationView(draft)) continue;
        const batch = pending.batch ?? [{ draft: pending.draft }];
        if (batch.some(item => operationDigest(item.draft) === operationDigest(draft))) {
          await this.publish(row.id, pending);
          return { proposalId: this.actionId(row.id, pending) };
        }
        if (batch.length >= 50 || batch.some(item => !batchTarget(item.draft) || batchTarget(item.draft) === batchTarget(draft))) continue;
        const drafts = [...batch.map(item => item.draft), draft];
        if (drafts.reduce((size, item) => size + item.description.length, 0) > 22_000
          || drafts.flatMap(item => item.changes ?? []).reduce((size, change) => size + (change.before?.length ?? 0) + (change.after?.length ?? 0), 0) > 44_000) continue;
        pending.batch = [...batch, { draft: structuredClone(draft) }];
        this.save(row.id, pending);
        await this.publish(row.id, pending);
        return { proposalId: this.actionId(row.id, pending) };
      }
    }
    if (!prior && draft.skillBaseline) {
      const rows = prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.status')='pending'").all() as Row[];
      for (const row of rows) {
        const pending = JSON.parse(row.payload) as Saved;
        if (pending.expiresAt <= Date.now() || operationDigest(pending.scope) !== operationDigest(scope)
          || pending.draft.tool !== draft.tool || pending.draft.input.name !== draft.input.name || (pending.draft.input.target ?? "body") !== (draft.input.target ?? "body") || !pending.draft.skillBaseline) continue;
        if (pending.draft.baseline !== draft.baseline) throw new Error("File changed during this turn; read it again before proposing changes");
        const sections = new Map(skillSectionsSchema.parse(pending.draft.input.action === "replace_sections" ? pending.draft.input.sections
          : [{ heading: pending.draft.input.heading, content: pending.draft.input.content }]).map(section => [section.heading, section]));
        for (const section of skillSectionsSchema.parse(draft.input.action === "replace_sections" ? draft.input.sections
          : [{ heading: draft.input.heading, content: draft.input.content }])) sections.set(section.heading, section);
        pending.draft = buildOperationDraft(draft.tool, { name: draft.input.name, action: "replace_sections", ...(draft.input.target ? { target: draft.input.target } : {}), sections: [...sections.values()],
          expected_revision: draft.skillBaseline.revision, source_request_id: `merged:${operationDigest([scope, draft.input.name, draft.input.target ?? "body"])}` }, [draft.skillBaseline]);
        this.save(row.id, pending);
        await this.publish(row.id, pending);
        return { proposalId: this.actionId(row.id, pending) };
      }
    }
    const id = prior?.id ?? randomUUID();
    const saved: Saved = prior ? JSON.parse(prior.payload) : { draft: structuredClone(draft), scope, expiresAt: Date.now() + 30 * 60_000,
      status: "pending", statusMessage: "确认后才会执行。", retryable: true };
    if (!prior && draft.tool === "codex" && ["dispatch", "message"].includes(String(draft.input.action))) {
      const [devices, listed] = await Promise.all([
        this.tools.execute("codex", { action: "devices" }, context), this.tools.execute("codex", { action: "list", limit: 50 }, context)
      ]);
      const tasks = object(listed).tasks as unknown[];
      const targetId = draft.input.action === "message" ? draft.input.id : object(draft.input.task).continueTaskId;
      if (targetId && !tasks.some(task => object(task).id === targetId)) tasks.unshift(object(await this.tools.execute("codex", { action: "get", id: targetId }, context)).task);
      saved.codexForm = { ...codexForm(draft, object(devices).devices as CodexDevice[], tasks), originalRequest: scope.delegationRequest };
    }
    if (!prior) prepareSql(this.db, "INSERT INTO operation_confirmations(id,operation_key,payload) VALUES(?,?,?)").run(id, key, JSON.stringify(saved));
    await this.publish(id, saved);
    return { proposalId: this.actionId(id, saved) };
  }
  async supersede(userId: string, conversationId: string): Promise<void> {
    for (const row of prepareSql(this.db, "SELECT id,payload FROM operation_confirmations WHERE json_extract(payload,'$.status') IN ('pending','failed')").all() as Row[]) {
      const saved = JSON.parse(row.payload) as Saved;
      if (saved.scope.userId !== userId || saved.scope.conversationId !== conversationId || !saved.retryable) continue;
      saved.status = "cancelled"; saved.retryable = false; saved.statusMessage = "已有新的对话请求，旧变更已失效。需要时请重新提出。";
      this.save(row.id, saved);
      await this.publish(row.id, saved).catch(() => undefined);
    }
  }
  async act(userId: string, conversationId: string, actionId: string, confirm: boolean, edits?: CodexEdits, editOnly = false): Promise<{ ok: boolean; message: string }> {
    const id = actionId.split(":", 1)[0]!;
    const saved = this.load(id);
    if (!saved || saved.scope.userId !== userId || saved.scope.conversationId !== conversationId) return { ok: false, message: "这项确认不存在或不属于当前对话。" };
    if (actionId !== this.actionId(id, saved)) {
      await this.publish(id, saved).catch(() => undefined);
      return { ok: false, message: "确认内容已更新，请查看最新内容后再确认。" };
    }
    if (this.inFlight.has(id)) return { ok: false, message: "这项操作正在执行，请稍候。" };
    if (["completed", "cancelled", "expired"].includes(saved.status) || saved.status === "failed" && !saved.retryable) {
      await this.publish(id, saved).catch(() => undefined);
      return { ok: saved.status === "completed" || saved.status === "cancelled", message: saved.statusMessage };
    }
    if (saved.expiresAt <= Date.now()) {
      saved.status = "expired"; saved.retryable = false; saved.statusMessage = "变更已过期，请重新提出。";
      this.save(id, saved); await this.publish(id, saved); return { ok: false, message: saved.statusMessage };
    }
    if (!confirm) {
      saved.status = "cancelled"; saved.retryable = false; saved.statusMessage = "已取消，未执行变更。";
      this.save(id, saved); await this.publish(id, saved); return { ok: true, message: saved.statusMessage };
    }
    if (edits !== undefined) {
      try {
        if (!saved.codexForm) throw new Error("此操作不接收 Codex 编辑");
        const parsed = codexEditsSchema.parse(edits);
        if (parsed.prompt !== saved.codexForm.prompt) {
          saved.scope = { ...saved.scope, delegationRequest: [saved.scope.delegationRequest, `用户在确认卡片中编辑的本次要求：
${parsed.prompt}`].filter(Boolean).join("\n\n") };
          saved.codexForm.originalRequest = saved.scope.delegationRequest;
        }
        saved.draft = { ...editCodexDraft(saved.draft, saved.codexForm, parsed), delegationEvidence: saved.scope.delegationRequest };
        Object.assign(saved.codexForm, parsed);
        this.save(id, saved);
      } catch {
        saved.status = "failed"; saved.statusMessage = "项目、会话或提示词无效，请修改后重试。";
        this.save(id, saved); await this.publish(id, saved);
        return { ok: false, message: saved.statusMessage };
      }
    }
    if (editOnly && edits !== undefined) {
      saved.status = "pending"; saved.statusMessage = "确认后才会执行。";
      this.save(id, saved); await this.publish(id, saved);
      return { ok: true, message: "会话已更新，请确认派发。" };
    }
    const work = saved.batch ? this.applyBatch(id, saved) : this.apply(id, saved);
    this.inFlight.set(id, work);
    try { return await work; } finally { this.inFlight.delete(id); }
  }
  private async applyBatch(id: string, saved: Saved): Promise<{ ok: boolean; message: string }> {
    const batch = saved.batch!;
    const completed = () => batch.filter(item => item.completed).length;
    let writeStarted = false;
    let claimedBatch = false;
    try {
      const context = { ...this.restoreContext(saved.scope), ...saved.scope };
      // Verify the whole group before the first write, not after partially applying a stale proposal.
      const current = async (draft: OperationDraft) => {
        const results: unknown[] = [];
        for (const read of draft.reads) results.push(await this.tools.execute(read.tool, read.input, context));
        return operationDigest(operationSnapshots(draft.reads, results, draft.input)) === draft.baseline;
      };
      for (const { draft } of batch) {
        if (!await current(draft)) {
          const latest = this.load(id);
          if (!latest || operationDigest(latest) !== operationDigest(saved)) return { ok: false, message: "确认内容已更新，请查看最新内容后再确认。" };
          saved.status = "expired"; saved.retryable = false;
          saved.statusMessage = "目标内容已变化，整批未执行。请重新提出并确认最新内容。";
          this.save(id, saved); await this.publish(id, saved);
          return { ok: false, message: saved.statusMessage };
        }
      }
      const claimed = prepareSql(this.db, "UPDATE operation_confirmations SET payload=? WHERE id=? AND payload=? AND json_extract(payload,'$.status') IN ('pending','failed')")
        .run(JSON.stringify({ ...saved, status: "executing", retryable: false }), id, JSON.stringify(saved));
      if (!claimed.changes) return { ok: false, message: "确认内容已更新或已处理，请查看最新状态。" };
      claimedBatch = true;
      saved.status = "executing"; saved.retryable = false;
      saved.statusMessage = `正在执行（${completed()}/${batch.length}）…`;
      await this.publish(id, saved);
      for (const item of batch) {
        if (item.completed) continue;
        const { draft } = item;
        // Earlier writes and network delays must not hide concurrent edits to later targets.
        if (!await current(draft)) throw new Error("Batch target changed before its write");
        writeStarted = true;
        const output = object(await executeConfirmedOperation(context, draft.tool, draft.input,
          approved => this.tools.execute(draft.tool, draft.input, approved), draft.baseline));
        if (unsuccessful(output)) {
          if (["authorization_pending", "authorization_required", "not_configured"].includes(String(output.status)))
            throw new ProductivityAuthorizationRequiredError("Account");
          throw new Error("Batch write was not confirmed");
        }
        item.completed = true;
        saved.statusMessage = `正在执行（${completed()}/${batch.length}）…`;
        this.save(id, saved);
        await this.publish(id, saved).catch(() => undefined);
      }
      saved.status = "completed"; saved.statusMessage = `已完成全部 ${batch.length} 项变更。`; delete saved.failure;
    } catch (error) {
      if (!claimedBatch) {
        const latest = this.load(id);
        if (!latest || operationDigest(latest) !== operationDigest(saved)) return { ok: false, message: "确认内容已更新或已处理，请查看最新状态。" };
      }
      saved.status = "failed"; saved.retryable = !writeStarted;
      if (["google_calendar", "schedule"].includes(saved.draft.tool)) {
        saved.failure = operationFailure(error, writeStarted);
        console.error("OPERATION_FAILURE", JSON.stringify({ agent: saved.scope.agentId, tool: saved.draft.tool, ...saved.failure }));
      }
      saved.statusMessage = writeStarted ? `已完成 ${completed()}/${batch.length} 项；后续执行已停止，请先核对目标状态再提出剩余变更。`
        : "执行前核对未完成，整批未提交；可以重试核对。";
      if (saved.failure) saved.statusMessage = `${failureText(saved.failure)} ${saved.statusMessage}`;
    }
    this.save(id, saved);
    await this.publish(id, saved).catch(() => undefined);
    return { ok: saved.status === "completed", message: saved.statusMessage };
  }
  private async apply(id: string, saved: Saved): Promise<{ ok: boolean; message: string }> {
    let writeStarted = false;
    try {
      const context = { ...this.restoreContext(saved.scope), ...saved.scope };
      const results: unknown[] = [];
      for (const read of saved.draft.reads) results.push(await this.tools.execute(read.tool, read.input, context));
      const latest = this.load(id);
      if (!latest || latest.status !== saved.status || this.actionId(id, latest) !== this.actionId(id, saved))
        return { ok: false, message: "确认内容已更新，请查看最新内容后再确认。" };
      if (operationDigest(operationSnapshots(saved.draft.reads, results, saved.draft.input)) !== saved.draft.baseline) {
        saved.status = "expired"; saved.retryable = false; saved.statusMessage = "目标内容已变化，未执行变更。请重新提出并确认最新内容。";
      } else {
        // Atomically claim before any external write; duplicate callbacks cannot replay it.
        const claimed = prepareSql(this.db, "UPDATE operation_confirmations SET payload=? WHERE id=? AND payload=? AND json_extract(payload,'$.status') IN ('pending','failed')")
          .run(JSON.stringify({ ...saved, status: "executing", retryable: false, statusMessage: "正在执行已确认的变更…" }), id, JSON.stringify(saved));
        if (!claimed.changes) return { ok: false, message: "这项确认已处理。" };
        saved.status = "executing"; saved.retryable = false; saved.statusMessage = "正在执行已确认的变更…";
        await this.publish(id, saved);
        writeStarted = true;
        const result = await executeConfirmedOperation(context, saved.draft.tool, saved.draft.input,
          approved => this.tools.execute(saved.draft.tool, saved.draft.input, approved), saved.draft.baseline);
        const output = object(result);
        if (unsuccessful(output)) {
          saved.status = "failed"; saved.statusMessage = output.status === "authorization_pending" || output.status === "authorization_required" || output.status === "not_configured"
            ? "账号需要连接，变更尚未完成。连接后请重新提出并确认。" : "执行结果尚未确认。请先查看目标状态，再提出需要的变更。";
          if (["google_calendar", "schedule"].includes(saved.draft.tool)) {
            saved.failure = { phase: "write", reason: ["authorization_pending", "authorization_required", "not_configured"].includes(String(output.status)) ? "authorization" : "unknown", at: Date.now() };
            console.error("OPERATION_FAILURE", JSON.stringify({ agent: saved.scope.agentId, tool: saved.draft.tool, ...saved.failure }));
          }
        } else {
          saved.status = "completed"; saved.statusMessage = `${saved.draft.title}已完成。`;
          delete saved.failure;
          const resource = object(output.event ?? output.task ?? output.file);
          if (typeof resource.htmlLink === "string" || typeof resource.url === "string" || typeof resource.webViewLink === "string") {
            const link = String(resource.htmlLink ?? resource.url ?? resource.webViewLink);
            if (/^https:\/\//.test(link)) saved.statusMessage += `\n${link}`;
          }
        }
      }
    } catch (error) {
      saved.status = "failed"; saved.retryable = !writeStarted;
      saved.statusMessage = writeStarted ? "执行结果尚未确认。请先查看目标状态，再提出需要的变更。" : "执行前核对未完成，未提交变更；可以重试核对。";
      if (["google_calendar", "schedule"].includes(saved.draft.tool)) {
        saved.failure = operationFailure(error, writeStarted);
        saved.statusMessage = failureText(saved.failure);
        console.error("OPERATION_FAILURE", JSON.stringify({ agent: saved.scope.agentId, tool: saved.draft.tool, ...saved.failure }));
      }
    }
    this.save(id, saved);
    await this.publish(id, saved).catch(() => undefined);
    return { ok: saved.status === "completed", message: saved.statusMessage };
  }
  async close(): Promise<void> { await this.offers; await Promise.allSettled([...this.inFlight.values()]); closeSqlite(this.db); }
}
