import { prepareSql } from "../sqlite.js";
import { z } from "zod";
import type { AgentRuntime } from "../runtime.js";
import type { AgentInteractionController } from "../agent/interaction-controller.js";
import type { TaskRun, TaskScope, TaskTrigger } from "../tasks/types.js";
import type { SharedTrigger, ReusableTriggerSpec, TriggerCondition } from "../tasks/reusable.js";
import type { WebStore } from "./store.js";
import { taskScheduleText } from "../tasks/schedule-text.js";
import { object } from "../tools/operation-policy.js";
import { reusableTriggerDiagram, taskTriggerDiagram } from "../tasks/trigger-diagram.js";
import { triggerTypes } from "./trigger-types.js";
import { executeConfirmedOperation } from "../tools/confirmed-operation.js";

export const automationControlSchema = z.object({
  requestId: z.string().uuid(), id: z.string().uuid(), revision: z.number().int().positive(),
  action: z.enum(["pause", "resume", "delete"])
}).strict();

export const automationOperationSchema = z.object({
  requestId: z.string().uuid(), conversationId: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().uuid(), action: z.enum(["pause", "resume", "delete", "trigger_activate", "trigger_rollback", "trigger_pause", "trigger_resume"]),
  revision: z.number().int().positive().optional()
}).strict();
type OperationInput = z.infer<typeof automationOperationSchema>;
type Receipt = { conversationId: string; proposalId: string };
type RequestRow = { payload: string; receipt: string | null };

export class AutomationRequestError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const safeCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function runMetadata(run: TaskRun) {
  const usage = run.result?.usage;
  return { id: run.id, taskId: run.taskId, taskRevision: run.taskRevision, state: run.state,
    attempts: run.attempts, triggeredAt: run.triggeredAt, startedAt: run.startedAt, endedAt: run.endedAt,
    notificationStatus: run.notificationStatus, deliveredAt: run.deliveredAt,
    model: run.result?.model,
    ...(usage ? { tokens: { input: safeCount(usage.inputTokens), output: safeCount(usage.outputTokens), cached: safeCount(usage.cachedInputTokens) } } : {}) };
}

/** Browser-facing metadata excludes routing identities, credentials, event payloads and run content. */
export class WebAutomation {
  private readonly requests = new Map<string, Promise<Receipt>>();
  private readonly controls = new Map<string, Promise<unknown>>();
  constructor(private readonly store: WebStore, private readonly runtime: AgentRuntime,
    private readonly controller: Pick<AgentInteractionController, "proposeOperation">) {
    store.db.exec("CREATE TABLE IF NOT EXISTS web_automation_requests(id TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT)");
  }
  private scope(conversationId = "web:automation"): TaskScope {
    return { agentId: this.runtime.config.id, userId: this.store.owner, principalId: this.runtime.config.web!.ownerPrincipalId,
      conversationKind: "p2p", conversationId };
  }
  private tasks() {
    if (!this.runtime.proactiveTasks) throw new AutomationRequestError(503, "主动任务暂时不可用。");
    return this.runtime.proactiveTasks;
  }
  private triggerSummary(trigger: TaskTrigger): string {
    if (trigger.type === "reference") {
      const saved = this.tasks().getTrigger(this.scope(), trigger.triggerId);
      return saved ? `${saved.title}${saved.activeRevision ? ` · v${saved.activeRevision}` : ""}` : "触发点不可用";
    }
    return taskScheduleText(trigger);
  }
  private triggerMetadata(trigger: SharedTrigger, names: Parameters<typeof reusableTriggerDiagram>[1]) {
    const latest = trigger.revisions.at(-1), active = trigger.revisions.find(item => item.revision === trigger.activeRevision);
    const diagram = active ? reusableTriggerDiagram(active.spec, names, trigger.status === "paused" ? "触发已暂停" : "触发订阅任务")
      : taskTriggerDiagram({ type: "reference", triggerId: trigger.id });
    if (trigger.status === "paused") diagram.steps[diagram.steps.length - 1]!.kind = "stop";
    return { id: trigger.id, kind: "point" as const, title: trigger.title, status: trigger.status, revision: trigger.revision,
      activeRevision: trigger.activeRevision, previousRevision: trigger.previousRevision,
      subscriberCount: trigger.subscriberCount,
      // A schema summary is safe to show; fixtures and validation inputs remain server-side.
      summary: active ? ruleSummary(active.spec) : latest ? ruleSummary(latest.spec) : "",
      candidateSummary: latest ? ruleSummary(latest.spec) : "",
      diagram,
      candidateDiagram: latest && latest.revision !== trigger.activeRevision ? reusableTriggerDiagram(latest.spec, names) : undefined,
      validation: latest?.validation ? { passed: latest.validation.passed, checkedAt: latest.validation.checkedAt,
        checks: latest.validation.results.length } : undefined,
      lastFiredAt: trigger.lastFiredAt, nextAt: trigger.nextAt };
  }
  overview() {
    const tasks = this.tasks(), scope = this.scope();
    const sources = tasks.externalSources(scope), events = tasks.externalEvents(scope, 100);
    const ownedTasks = tasks.list(scope).filter(task => !task.principalId || task.principalId === scope.principalId);
    const now = Date.now(), currentTasks = ownedTasks.filter(task => !tasks.isHistorical(task, now));
    const triggers = tasks.listTriggers(scope), names = { taskTitle: (id: string) => ownedTasks.find(task => task.id === id)?.title };
    const capabilities = { location: Boolean(this.runtime.location?.store.isOwner(scope.principalId ?? scope.userId, [scope.userId])),
      health: Boolean(this.runtime.health && this.runtime.skills?.canAccess(scope)),
      calendar: Boolean(this.runtime.schedule || this.runtime.config.allowedTools?.includes("google_calendar") && this.runtime.config.toolSettings?.google_calendar?.agentId === scope.agentId
        && this.runtime.config.toolSettings.google_calendar.ownerUserId === scope.userId) };
    const triggerPoints = triggers.map(trigger => this.triggerMetadata(trigger, names));
    return { models: this.runtime.config.modelOrder ?? [], defaultModel: this.runtime.model.defaultProvider, tasks: currentTasks.map(task => {
      const triggerId = task.trigger.type === "reference" ? task.trigger.triggerId : undefined;
      const shared = triggers.find(trigger => trigger.id === triggerId);
      const active = shared?.revisions.find(revision => revision.revision === shared.activeRevision);
      const diagram = active ? reusableTriggerDiagram(active.spec, names, shared?.status === "paused" ? "触发已暂停" : "执行任务提示词") : taskTriggerDiagram(task.trigger);
      if (shared?.status === "paused") diagram.steps[diagram.steps.length - 1]!.kind = "stop";
      return { id: task.id, model: task.model, title: task.title, status: task.status, revision: task.revision,
        instruction: task.instruction, schedule: this.triggerSummary(task.trigger), triggerType: task.trigger.type,
        diagram,
        ...(task.trigger.type === "reference" ? { triggerId: task.trigger.triggerId } : {}),
        deliveryPolicy: task.deliveryPolicy ?? "conditional", nextAt: task.nextAt,
        latestRun: tasks.runs(scope, task.id, 1).map(runMetadata)[0] }; }),
      triggerPoints,
      triggers: triggerPoints, // Compatibility for pages opened before this deployment.
      triggerTypes: triggerTypes(capabilities, sources.some(source => source.status === "active")),
      sources: sources.map(source => ({ id: source.id, name: source.source, kind: "external", status: source.status,
        events: source.allowedEvents,
        lastReceivedAt: events.find(event => event.source === source.source)?.receivedAt,
        lastEvent: events.find(event => event.source === source.source)?.event })),
      capabilities };
  }
  selectModel(id: string, model: string | null, revision: number) {
    const tasks = this.tasks(), scope = this.scope(), task = tasks.get(id);
    if (!task || task.userId !== scope.userId || task.principalId && task.principalId !== scope.principalId)
      throw new AutomationRequestError(404, "任务不存在。");
    if (task.status === "cancelled" || task.revision !== revision) throw new AutomationRequestError(409, "任务已变化，请刷新后重试。");
    if (model !== null && !this.runtime.config.modelOrder?.includes(model)) throw new AutomationRequestError(400, "模型不存在。");
    const updated = tasks.update(scope, id, { model: model ?? this.runtime.model.defaultProvider });
    return { model: updated.model };
  }
  runs(id: string) {
    const tasks = this.tasks(), scope = this.scope(), task = tasks.get(id);
    if (!task || task.userId !== scope.userId || task.principalId && task.principalId !== scope.principalId)
      throw new AutomationRequestError(404, "任务不存在。");
    return { runs: tasks.runs(scope, id, 30).map(runMetadata) };
  }
  run(id: string, runId: string) {
    this.runs(id); // Validate ownership before reading any execution content.
    const run = this.tasks().getRun(runId);
    if (!run || run.taskId !== id) throw new AutomationRequestError(404, "运行记录不存在。");
    const delivered = run.messageId ? this.store.message(run.messageId) : undefined;
    const attempts = this.tasks().activity(run.id).map(item => ({ ...item,
      snapshot: { ...item.snapshot, answerDraft: "", ...(item.snapshot.status === "running" && (run.state !== "running" || item.attempt !== run.attempts)
        ? { status: run.state === "cancelled" ? "cancelled" as const : "failed" as const } : {}) } }));
    return { ...runMetadata(run), attempts, summary: run.result?.summary,
      // Only the first task message belongs to this execution, never later chat turns.
      message: run.notificationStatus === "delivered" ? delivered?.text ?? run.result?.text : undefined,
      conversationId: delivered ? this.store.publicId(delivered.conversationId) : undefined,
      messageId: delivered?.id };
  }
  async control(input: z.infer<typeof automationControlSchema>): Promise<unknown> {
    const key = `control:${input.requestId}`, payload = JSON.stringify(input);
    const prior = prepareSql(this.store.db, "SELECT payload,receipt FROM web_automation_requests WHERE id=?").get(key) as RequestRow | undefined;
    if (prior && prior.payload !== payload) throw new AutomationRequestError(409, "操作编号已使用，请重试。");
    if (prior?.receipt) return JSON.parse(prior.receipt);
    const pending = this.controls.get(key);
    if (pending) return pending;
    const work = this.applyControl(input, key, payload);
    this.controls.set(key, work);
    try { return await work; } finally { this.controls.delete(key); }
  }
  private async applyControl(input: z.infer<typeof automationControlSchema>, key: string, payload: string) {
    const task = this.tasks().get(input.id), scope = this.scope();
    if (!task || task.userId !== scope.userId || task.principalId && task.principalId !== scope.principalId)
      throw new AutomationRequestError(404, "任务不存在。");
    if (task.status === "cancelled" || task.revision !== input.revision)
      throw new AutomationRequestError(409, "任务已变化，请刷新后重试。");
    const toolInput = { action: input.action, id: input.id };
    prepareSql(this.store.db, "INSERT OR IGNORE INTO web_automation_requests(id,payload) VALUES(?,?)").run(key, payload);
    // These owner-authenticated list controls are user gestures; model tools still require their confirmation components.
    const context = { ...scope, conversationId: task.conversationId, sessionId: key, turnId: 0 };
    const result = object(await executeConfirmedOperation(context, "proactive_tasks", toolInput,
      approved => this.runtime.tools.execute("proactive_tasks", toolInput, approved)));
    const updated = object(result.task);
    if (typeof updated.id !== "string") throw new AutomationRequestError(409, "变更未完成，请重试。");
    const receipt = { id: updated.id, status: updated.status, revision: updated.revision };
    prepareSql(this.store.db, "UPDATE web_automation_requests SET receipt=? WHERE id=?").run(JSON.stringify(receipt), key);
    return receipt;
  }
  async propose(input: OperationInput): Promise<Receipt> {
    const payload = JSON.stringify(input);
    const prior = prepareSql(this.store.db, "SELECT payload,receipt FROM web_automation_requests WHERE id=?").get(input.requestId) as RequestRow | undefined;
    if (prior && prior.payload !== payload) throw new AutomationRequestError(409, "操作编号已使用，请重试。");
    if (prior?.receipt) return JSON.parse(prior.receipt) as Receipt;
    const pending = this.requests.get(input.requestId);
    if (pending) return pending;
    const work = this.offer(input, payload);
    this.requests.set(input.requestId, work);
    try { return await work; } finally { this.requests.delete(input.requestId); }
  }
  private async offer(input: OperationInput, payload: string): Promise<Receipt> {
    const conversationId = this.store.resolveConversation(input.conversationId);
    const conversation = conversationId && this.store.conversationInfo(conversationId);
    if (!conversationId || !conversation) throw new AutomationRequestError(404, "请重新打开对话后重试。");
    const tasks = this.tasks(), scope = this.scope(conversation.chatId);
    const isTrigger = input.action.startsWith("trigger_");
    const resource = isTrigger ? tasks.getTrigger(scope, input.id) : tasks.get(input.id);
    if (!resource || !isTrigger && ("userId" in resource && resource.userId !== scope.userId
      || "principalId" in resource && resource.principalId && resource.principalId !== scope.principalId))
      throw new AutomationRequestError(404, isTrigger ? "触发点不存在。" : "任务不存在。");
    if (input.action === "trigger_activate" && !input.revision || input.action !== "trigger_activate" && input.revision !== undefined)
      throw new AutomationRequestError(400, "触发点版本不正确。");
    const toolInput = { action: input.action, id: input.id, ...(input.revision ? { revision: input.revision } : {}) };
    prepareSql(this.store.db, "INSERT OR IGNORE INTO web_automation_requests(id,payload) VALUES(?,?)").run(input.requestId, payload);
    const context = { ...scope, sessionId: `automation:${input.requestId}`, turnId: 0,
      proposeOperation: (draft: Parameters<AgentInteractionController["proposeOperation"]>[0]) => this.controller.proposeOperation(draft,
        { ...scope, sessionId: `automation:${input.requestId}`, turnId: 0 }) };
    // The deployed registry performs the same reads, snapshot comparison, permissions and confirmation as chat tools.
    const result = object(await this.runtime.tools.execute("proactive_tasks", toolInput, context));
    if (result.status !== "pending_confirmation" || typeof result.proposalId !== "string")
      throw new AutomationRequestError(409, "未能准备变更，请重新加载后重试。");
    const receipt = { conversationId: input.conversationId, proposalId: result.proposalId };
    prepareSql(this.store.db, "UPDATE web_automation_requests SET receipt=? WHERE id=?").run(JSON.stringify(receipt), input.requestId);
    return receipt;
  }
}

/** Keep rendered labels separate from executable specifications. */
function ruleSummary(spec: ReusableTriggerSpec): string {
  const source = spec.source;
  return [taskScheduleText(source), conditionSummary(spec.condition),
    spec.delaySeconds ? `等待${spec.delaySeconds}秒` : undefined].filter(Boolean).join(" · ");
}
function conditionSummary(condition?: TriggerCondition): string | undefined {
  if (!condition) return undefined;
  if (condition.type === "all" || condition.type === "any") return `（${condition.conditions.map(conditionSummary).join(condition.type === "all" ? "且" : "或")}）`;
  if (condition.type === "not") return `排除（${conditionSummary(condition.condition)}）`;
  if (condition.type === "task_delivered") return `${condition.withinSeconds}秒内前置任务已送达`;
  if (condition.type === "recent_event") return `${condition.withinSeconds}秒内收到${condition.event === "alarm_stopped" ? "闹钟停止" : condition.event === "charging_started" ? "开始充电" : condition.event === "notification_received" ? "应用通知" : condition.event}`;
  if (condition.type !== "time_window") return undefined;
  return [condition.weekdays ? `周${condition.weekdays.map(day => ["日", "一", "二", "三", "四", "五", "六"][day]).join("、")}` : "", condition.after ?? "", condition.before ? `至${condition.before}` : ""].filter(Boolean).join(" ") || "时间条件";
}
