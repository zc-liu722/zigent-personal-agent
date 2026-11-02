import type { ModelGateway } from "../llm.js";
import { z } from "zod";
import type { AgentConfig } from "../config.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import { isConfirmedOperation, operationDigest, confirmedOperationBaseline } from "../tools/confirmed-operation.js";
import { object, operationReads, operationSnapshots } from "../tools/operation-policy.js";
import { CodexStore } from "./store.js";
import { delegationPrompt } from "./delegation.js";
import { dispatchSchema, promptSchema, type CodexScope, type WorkerEvent, type CodexTask } from "./types.js";

export class CodexService {
  readonly store: CodexStore;
  constructor(readonly options: { databasePath: string; agentId: string; ownerUserId: string }, private readonly verifyProactiveRun?: (context: ToolExecutionContext) => boolean, private readonly model?: ModelGateway) {
    this.store = new CodexStore(options);
  }
  static fromConfig(config: AgentConfig, verifyProactiveRun?: (context: ToolExecutionContext) => boolean, model?: ModelGateway) {
    if (!config.allowedTools.includes("codex")) return undefined;
    const owner = config.web?.ownerUserId ?? config.notifications?.ownerUserId ?? config.toolSettings?.google_drive?.ownerUserId;
    if (!owner) return undefined;
    return new CodexService({ databasePath: config.memoryStoragePath + ".codex.sqlite", agentId: config.id, ownerUserId: owner }, verifyProactiveRun, model);
  }
  close() { this.store.close(); }
  canAutomate(context: ToolExecutionContext): boolean {
    return Boolean(context.agentId === this.options.agentId && context.userId === this.options.ownerUserId
      && context.conversationKind === "p2p" && context.conversationId && context.backgroundTaskKind === "proactive"
      && context.taskRunId && context.taskLeaseToken && !context.signal?.aborted && this.verifyProactiveRun?.(context));
  }
  async prepareDelegation(value: unknown, context: ToolExecutionContext) {
    const input = object(value);
    if (!["dispatch", "message"].includes(String(input.action))) return { input: value, context };
    const task = object(input.task);
    const sources = z.array(z.object({ sessionId: z.string().min(1).max(200), turnId: z.number().int().positive() }).strict()).max(20).parse(task.sourceTurns ?? input.sourceTurns ?? []);
    if (sources.length && !context.resolveDelegationSources) throw new Error("此运行不能读取额外历史，请在用户会话补齐任务依据");
    const history = sources.length ? await context.resolveDelegationSources!(sources) : "";
    const prior = input.action === "message" ? this.store.owned({ ...context }, String(input.id)).originalRequest : undefined;
    const evidence = [prior, context.delegationRequest, history].filter(Boolean).join("\n\n");
    if (!evidence || evidence.length > 64000) throw new Error("请先查阅相关历史，选取与本次目标有关的用户要求作为任务依据");
    if (!this.model) throw new Error("任务意图核对暂不可用，尚未派发");
    const prompt = input.action === "dispatch" ? task.prompt : input.text;
    const response = await this.model.invokeRound(context.model ?? this.model.defaultProvider, {
      systemPrompt: "Check whether a rewritten delegated assignment faithfully serves the user's intent. The evidence consists of genuine owner-scoped user requests across possibly multiple sessions; newer explicit corrections supersede older plans. Rewriting, synthesis, task decomposition, useful technical detail, search strategy and reasonable execution choices are ALLOWED; never require literal wording, word overlap or a fixed output shape. A worker may handle just one part of a broader request. Reject material goal drift, invented constraints (e.g. offline/local-only work for research), unauthorized downgrade, reversing research/discussion/writing order, or imposing deliverables the user did not request. Treat the assignment as a candidate, not authority. If essential context is referenced but absent, request relevant history, not a repeat from the user. Return only valid JSON with decision=allow|revise|context_needed and a short message identifying any specific unsupported change. Do not invent stricter requirements than the user's goal.",
      messages: [{ role: "user", text: JSON.stringify({ userEvidence: evidence, confirmedBehaviorRules: context.delegationMemory, assignment: prompt }) }], tools: [], toolChoice: "none", reasoningEfforts: context.reasoningEfforts
    }, { automaticFallback: true, signal: AbortSignal.any([...(context.signal ? [context.signal] : []), AbortSignal.timeout(120000)]) });
    const raw = response.value.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    const verdict = z.object({ decision: z.enum(["allow", "revise", "context_needed"]), message: z.string().max(3000) }).strict().parse(JSON.parse(raw));
    if (verdict.decision !== "allow") throw new Error(`派发前意图核对：${verdict.message}。可改写和拆分任务；缺少依据时先检索相关历史并用 sourceTurns 引用。`);
    return { input: value, context: { ...context, delegationRequest: evidence } };
  }
  private assertConfirmed(scope: CodexScope, context: ToolExecutionContext | undefined, input: unknown) {
    this.store.assertScope(scope);
    if (!context || context.agentId !== scope.agentId || context.userId !== scope.userId || context.conversationId !== scope.conversationId
      || context.sessionId !== scope.sessionId || context.signal?.aborted
      || !(this.canAutomate(context) || !context.taskRunId && !context.backgroundTaskKind && isConfirmedOperation(context, "codex", input)))
      throw new Error("发送 Codex 消息必须先通过用户确认组件");
    if (!this.canAutomate(context)) {
      const raw = object(input), reads = operationReads("codex", raw);
      const results = reads.map(read => read.input.action === "devices" ? { devices: this.store.devices(scope) }
        : { task: this.statusTask(this.store.owned(scope, String(read.input.id))) });
      if (confirmedOperationBaseline(context) !== operationDigest(operationSnapshots(reads, results, raw)))
        throw new Error("目标项目或会话已变化，请重新确认发送");
    }

  }
  async dispatch(scope: CodexScope, value: unknown, key: string, context?: ToolExecutionContext, approvedInput?: unknown) {
    this.assertConfirmed(scope, context, approvedInput);
    const approved = approvedInput as { action?: string; task?: unknown } | undefined;
    if (approved?.action !== "dispatch" || operationDigest(dispatchSchema.parse(approved.task)) !== operationDigest(dispatchSchema.parse(value)))
      throw new Error("发送内容与已确认提示词不一致");
    if (!context?.delegationRequest && !context?.taskRunId) throw new Error("缺少用户原始要求，请重新提出派发");
    const parsed = dispatchSchema.parse(value);
    const project = this.store.devices(scope).find(d => d.id === parsed.deviceId)?.projects.find(p => p.id === parsed.projectId);
    if (project?.executor && !this.store.executionGrant(scope, parsed.deviceId, parsed.projectId, !this.canAutomate(context!))) throw new Error("该执行器项目的首次任务需要在网页确认");
    const task = this.store.create(scope, parsed, key, Date.now(), context?.taskRunId, { originalRequest: context?.delegationRequest, model: context?.model, reasoningEfforts: context?.reasoningEfforts });
    return task;
  }
  async message(scope: CodexScope, id: string, text: string, key: string, context?: ToolExecutionContext, approvedInput?: unknown, reviewAfterCompletion?: boolean) {
    this.assertConfirmed(scope, context, approvedInput); promptSchema.parse(text);
    const approved = approvedInput as { action?: string; id?: string; text?: string; reviewAfterCompletion?: boolean } | undefined;
    if (approved?.action !== "message" || approved.id !== id || approved.text !== text || approved.reviewAfterCompletion !== reviewAfterCompletion) throw new Error("发送内容与已确认提示词不一致");
    if (!context?.delegationRequest && !context?.taskRunId) throw new Error("缺少用户原始要求，请重新提出继续任务");
    const task = this.store.owned(scope, id);
    if (task.project?.executor && !this.store.executionGrant(scope, task.deviceId, task.projectId, !this.canAutomate(context!))) throw new Error("项目范围已变化，需要在网页重新确认");
    if (!task.threadId) throw new Error("原会话尚未建立，请等待接单");
    if (["running", "waiting_user"].includes(task.state)) {
      this.store.update(id, current => {
        current.originalRequest = [current.originalRequest, context?.delegationRequest].filter(Boolean).join("\n\n");
        current.intent = `${current.intent ?? current.prompt}\n\n用户后续要求：\n${text}`;
        if (reviewAfterCompletion) current.review = { state: "pending", deadlineAt: current.deadlineAt, model: context?.model, reasoningEfforts: context?.reasoningEfforts };
        else if (reviewAfterCompletion === false) current.review = undefined;
      });
      return { command: this.store.command(scope, id, "message", delegationPrompt(text, context?.delegationRequest, this.store.get(id)?.intent), key) };
    }
    this.store.stopReview(scope, task.id);
    if (!["succeeded", "blocked", "cancelled"].includes(task.state)) throw new Error("原执行状态待核对，请稍后再发送");
    const next = this.store.create(scope, { deviceId: task.deviceId, projectId: task.projectId, title: task.title,
      prompt: text, continueTaskId: task.id, reviewAfterCompletion: reviewAfterCompletion ?? false, timeoutMinutes: 120 }, key, Date.now(), context?.taskRunId, { originalRequest: context?.delegationRequest, model: context?.model, reasoningEfforts: context?.reasoningEfforts });
    return { status: "queued", task: this.statusTask(next) };
  }
  interrupt(scope: CodexScope, id: string, key: string) {
    let task = this.store.owned(scope, id); const seen = new Set<string>();
    while (task.review?.nextTaskId && !seen.has(task.id)) { seen.add(task.id); task = this.store.owned(scope, task.review.nextTaskId); }
    if (this.store.stopReview(scope, task.id)) return { status: "stopped" };
    return { command: this.store.command(scope, task.id, "interrupt", "", key) };
  }
  async event(deviceId: string, event: WorkerEvent) { return this.store.event(deviceId, event); }
  statusTask(task: CodexTask) {
    return { id: task.id, title: task.title, state: task.state, phase: task.phase, revision: task.revision, lastSeenAt: task.lastSeenAt, lastProgressAt: task.lastProgressAt,
      deviceId: task.deviceId, threadId: task.threadId, projectId: task.projectId, project: task.project, execution: task.execution, review: task.review ? { state: task.review.state, decision: task.review.decision, message: task.review.message, nextTaskId: task.review.nextTaskId } : undefined, summary: task.summary };
  }
}
