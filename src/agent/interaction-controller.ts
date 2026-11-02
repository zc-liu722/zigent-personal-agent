import { BackgroundDeliveryUncertainError } from "../channels/background-delivery.js";
import { randomUUID } from "node:crypto";
import type { ConversationDiagnostic } from "../audit/diagnostics.js";
import { modelCostMultiplier, type AgentConfig, type Provider } from "../config.js";
import type {
  CommunicationAdapter,
  InboundMessage,
  InteractionAction,
  InteractionActionResult
} from "../channels/communication.js";
import type { GeneratedReply } from "./executor.js";
import type { PreparedTurn, Session, SessionMetadata, SessionImage } from "../memory/types.js";
import { SessionPermissionError } from "../memory/types.js";
import { TurnPreparationFallbackRequiredError, type MemoryOrchestrator } from "../memory/orchestrator.js";
import { ReferenceImageStore } from "../reference-images.js";
import type { ImageGenerator, ReferenceImage } from "../image-generation.js";
import type { VideoGenerator } from "../video-generation.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import { AgentExecutionFallbackRequiredError, type AgentExecutor } from "./executor.js";
import { AgentRunSession } from "./run-session.js";
import { AgentRunInterruption } from "./interruption.js";
import { agentCommandHelp, parseAgentCommand } from "./commands.js";
import type { NotificationService } from "../notifications/service.js";
import { enqueueReplyNotification } from "../notifications/reply.js";
import { OperationConfirmations, type OperationScope } from "../channels/operation-confirmations.js";
import type { AgentToolSet } from "../tools/registry.js";
import { UserQuestions } from "../channels/user-questions.js";
import type { OperationDraft } from "../tools/operation-policy.js";

const FALLBACK_REQUEST_TTL_MS = 10 * 60_000;
export const IMAGE_MESSAGE_DEBOUNCE_MS = 3_000;

type ImageMessageDebounce = {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
};

type PendingFallback = {
  userId: string;
  conversationId: string;
  session: Session;
  fallbackProvider: Provider;
  failedProvider: Provider;
  selectableProviders?: Provider[];
  createdAt: number;
  continueTask: (provider: Provider) => Promise<void>;
  controller?: AbortController;
  cancelTask: () => Promise<void>;
};

export type InteractionControllerOptions = {
  onDiagnostic?: (message: InboundMessage, event: ConversationDiagnostic) => void;
  onUserMessage?: (message: InboundMessage, signal: AbortSignal) => Promise<void>;
  restoreOperationContext?: (scope: OperationScope) => Partial<ToolExecutionContext>;
  /** Domain reference state is separate from session summaries and instructions. */
  workspaceContext?: (message: InboundMessage, turn: PreparedTurn) => Promise<string | undefined>;
  toolContext?: (
    message: InboundMessage,
    turn: PreparedTurn
  ) => Partial<ToolExecutionContext>;
  /** Allows deterministic tests while keeping the production quiet window at three seconds. */
  imageMessageDebounceMs?: number;
};

export type AgentInteractionRuntime = {
  fileWorkbench?: import("../file-workbench/service.js").FileWorkbench;
  performance?: import("../performance/store.js").PerformanceStore;
  config: Pick<AgentConfig, "id" | "name" | "failureMessage" | "sessionInactivityMinutes"> & Partial<Pick<AgentConfig, "memoryStoragePath">>;
  tools?: AgentToolSet;
  model: {
    readonly defaultProvider: Provider;
    resetCircuit?(provider?: Provider): void;
    warmContextPolicy?(provider: Provider): void;
  };
  agent: Pick<AgentExecutor, "run">;
  memory: MemoryOrchestrator;
  imageGeneration: ImageGenerator;
  videoGeneration: VideoGenerator;
  notifications?: NotificationService;
};

export class AgentInteractionController {
  private readonly operations?: OperationConfirmations;
  private readonly questions?: UserQuestions;
  private readonly referenceImages = new ReferenceImageStore();
  private readonly inactivityTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingFallbacks = new Map<string, PendingFallback>();
  private readonly conversationTasks = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, { userId: string; controller: AbortController }>();
  private readonly conversationRevisions = new Map<string, number>();
  private readonly pendingMessages = new Map<string, InboundMessage[]>();
  private readonly imageMessageDebounces = new Map<string, ImageMessageDebounce>();
  private readonly inactivityMs: number;
  private readonly imageMessageDebounceMs: number;

  constructor(
    private readonly runtime: AgentInteractionRuntime,
    private readonly communication: CommunicationAdapter,
    private readonly options: InteractionControllerOptions = {}
  ) {
    this.inactivityMs = runtime.config.sessionInactivityMinutes * 60_000;
    this.imageMessageDebounceMs = options.imageMessageDebounceMs ?? IMAGE_MESSAGE_DEBOUNCE_MS;
    if (communication.sendUserQuestion) this.questions = new UserQuestions(notice => communication.sendUserQuestion!(notice));
    if (runtime.tools && runtime.config.memoryStoragePath && communication.sendOperationConfirmation) {
      this.operations = new OperationConfirmations(`${runtime.config.memoryStoragePath}.confirmations.sqlite`, runtime.tools,
        notice => communication.sendOperationConfirmation!(notice), options.restoreOperationContext);
    }
  }

  async close(): Promise<void> {
    for (const timer of this.inactivityTimers.values()) clearTimeout(timer);
    this.inactivityTimers.clear();
    for (const run of this.activeRuns.values()) run.controller.abort(new AgentRunInterruption("service_shutdown"));
    await this.questions?.close();
    for (const key of this.imageMessageDebounces.keys()) this.finishImageQuietPeriod(key);
    await Promise.allSettled([...this.conversationTasks.values()]);
    await this.operations?.close();
    // Completing an interrupted run may have scheduled a final timer.
    for (const timer of this.inactivityTimers.values()) clearTimeout(timer);
    this.inactivityTimers.clear();
  }

  async start(): Promise<void> {
    for (const session of await this.runtime.memory.getActiveSessions()) {
      this.scheduleSessionEnd(session);
    }
  }

  get activeConversationCount(): number { return this.conversationTasks.size; }

  /** Stop the owner's current turn; the caller waits for its transport task to settle. */
  cancelReply(userId: string, conversationId: string): void {
    const run = this.activeRuns.get(conversationId);
    if (run?.userId === userId) run.controller.abort(new AgentRunInterruption("user_stop"));
  }

  /** Read-only display data from the original conversation's saved task proposal. */
  operationTaskPreview(userId: string, conversationId: string, principalId: string | undefined, id: string) {
    return this.operations?.taskPreview(userId, conversationId, principalId, id);
  }

  /** Trusted management surfaces share the conversation's durable consent queue. */
  async proposeOperation(draft: OperationDraft, context: ToolExecutionContext): Promise<{ proposalId: string }> {
    if (!this.operations || context.agentId !== this.runtime.config.id || !context.userId
      || context.conversationKind !== "p2p" || !context.conversationId || context.taskRunId || context.backgroundTaskKind)
      throw new Error("变更确认只能在本人私聊中发起。");
    return this.runForConversation(context.conversationId, () => this.operations!.offer(draft, context));
  }

  /** Register the actual task session before any tool can publish an interaction. */
  async prepareBackgroundSession(input: { userId: string; conversationId: string; sessionId: string; title: string }): Promise<Session> {
    return this.runForConversation(input.conversationId, async () => {
      const session = await this.runtime.memory.prepareBackgroundSession(input.userId, input.conversationId, input.sessionId, input.title);
      await this.communication.prepareBackgroundSession?.(session);
      this.scheduleSessionEnd(session);
      return session;
    });
  }

  /** Joins the ordinary conversation queue; it never aborts a user turn. */
  async deliverBackgroundResult(input: {
    userId: string;
    conversationId: string;
    idempotencyKey: string;
    title: string;
    text: string;
    replyDurationMs?: number;
    snapshot?: import("./transcript.js").AgentRunSnapshot;
    scheduleReminder?: import("../channels/change-preview.js").CalendarPreviewState;
    targetSessionId?: string;
    beforeSend?: () => Promise<void>;
    onSession?: (session: Session) => Promise<void>;
  }): Promise<{ sessionId: string; messageId: string }> {
    const work = () => this.runForConversation(input.conversationId, async () => {
      if (!this.communication.sendBackgroundResult) {
        throw new Error("Background delivery is unavailable on this channel");
      }
      const existing = await this.runtime.memory.lookupBackgroundDelivery(
        input.userId, input.conversationId, input.idempotencyKey
      );
      if (existing?.status === "delivered" && existing.messageId) {
        await input.onSession?.(existing.session);
        return { sessionId: existing.session.id, messageId: existing.messageId };
      }
      if (existing?.status === "uncertain") throw new BackgroundDeliveryUncertainError();
      // An attempted send may already exist remotely. Reconcile that immutable
      // UUID and original session even if newer data has since superseded it.
      if (existing?.status !== "attempted") await input.beforeSend?.();
      const pending = existing ?? await this.runtime.memory.prepareBackgroundDelivery(
        input.userId, input.conversationId, input.idempotencyKey, input.text, input.targetSessionId
      );
      if (pending.status !== "attempted") await input.beforeSend?.();
      await this.runtime.memory.beginBackgroundAttempt(input.idempotencyKey);
      const delivered = await this.communication.sendBackgroundResult({
        agentId: this.runtime.config.id, userId: input.userId,
        conversationKind: pending.session.chatType === "p2p" || pending.session.chatType === "group" ? pending.session.chatType : undefined,
        conversationId: input.conversationId,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
        text: pending.content,
        replyDurationMs: input.replyDurationMs,
        snapshot: input.snapshot,
        scheduleReminder: input.scheduleReminder,
        session: pending.session
      });
      if (!delivered?.messageId) throw new Error("Background transport did not return a delivered message ID");
      const session = await this.runtime.memory.completeBackgroundDelivery(
        input.idempotencyKey, delivered.messageId
      );
      await input.onSession?.(session);
      this.scheduleSessionEnd(session);
      return { sessionId: session.id, messageId: delivered.messageId };
    });
    return this.runtime.performance ? this.runtime.performance.activity(() => this.runtime.performance!.scope(work)) : work();
  }

  async handleMessage(message: InboundMessage): Promise<void> {
    const waitStarted = performance.now();
    this.diagnose(message, { phase: "accepted", model: message.model });
    const debounceKey = `${message.conversationId}\0${message.userId}`;
    const messageKey = debounceKey;
    const revision = (this.conversationRevisions.get(messageKey) ?? 0) + 1;
    this.conversationRevisions.set(messageKey, revision);
    const pending = this.pendingMessages.get(messageKey) ?? [];
    pending.push(message);
    this.pendingMessages.set(messageKey, pending);
    const activeRun = this.activeRuns.get(message.conversationId);
    if (activeRun?.userId === message.userId) {
      this.diagnose(message, { phase: "cancel_requested" });
      activeRun.controller.abort(new AgentRunInterruption("new_message"));
    }
    for (const [requestId, pending] of this.pendingFallbacks) {
      if (pending.conversationId === message.conversationId && pending.userId === message.userId) {
        this.pendingFallbacks.delete(requestId);
      }
    }
    if (message.imageOnly) {
      await this.waitForImageQuietPeriod(debounceKey);
    } else {
      this.finishImageQuietPeriod(debounceKey);
    }
    return this.runForConversation(message.conversationId, async () => {
      // When several messages arrive before the active run reaches a safe
      // boundary, an older queued closure yields to the newest one.
      const superseded = this.conversationRevisions.get(messageKey) !== revision;
      this.runtime.performance?.record("turn.serial_wait", performance.now() - waitStarted, "", superseded ? "cancelled" : "ok");
      if (superseded) return;
      const messages = this.pendingMessages.get(messageKey) ?? [message];
      this.pendingMessages.delete(messageKey);
      const coalesced = this.coalesceMessages(messages);
      let nextIndex = 0;
      const controller = new AbortController();
      this.activeRuns.set(message.conversationId, { userId: message.userId, controller });
      this.diagnose(message, { phase: "started" });
      try {
        const preflight = async () => {
          await this.options.onUserMessage?.(message, controller.signal);
          this.diagnose(message, { phase: "message_ready" });
          await this.operations?.supersede(message.userId, message.conversationId);
        };
        if (this.runtime.performance) await this.runtime.performance.measure("turn.preflight", "message", preflight);
        else await preflight();
        for (; nextIndex < coalesced.length; nextIndex++) {
          controller.signal.throwIfAborted();
          await this.processMessage(coalesced[nextIndex]!, controller.signal);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        // Preserve accepted input that a Steer superseded during browser handover.
        // Explicit Stop keeps the same revision and must not requeue that input.
        if (this.conversationRevisions.get(messageKey) !== revision && nextIndex < coalesced.length) {
          this.pendingMessages.set(messageKey, [...coalesced.slice(nextIndex), ...(this.pendingMessages.get(messageKey) ?? [])]);
        }
      } finally {
        this.diagnose(message, { phase: "settled", status: controller.signal.aborted ? "cancelled" : "settled",
          ...(controller.signal.aborted ? { cancellationReason: controller.signal.reason instanceof AgentRunInterruption
            ? controller.signal.reason.kind : "unknown" } : {}) });
        if (this.activeRuns.get(message.conversationId)?.controller === controller) {
          this.activeRuns.delete(message.conversationId);
        }
        if (this.conversationRevisions.get(messageKey) === revision) {
          this.conversationRevisions.delete(messageKey);
        }
      }
    });
  }

  private coalesceMessages(messages: readonly InboundMessage[]): InboundMessage[] {
    const result: InboundMessage[] = [];
    for (let index = 0; index < messages.length;) {
      const first = messages[index]!;
      // Commands remain ordering boundaries. Merging them into prose would
      // accidentally turn /new or /help into model input.
      if (!first.imageOnly && parseAgentCommand(first.text)) {
        result.push(first);
        index += 1;
        continue;
      }
      const group = [first];
      index += 1;
      while (index < messages.length) {
        const next = messages[index]!;
        if (next.userId !== first.userId || !next.imageOnly && parseAgentCommand(next.text)) break;
        group.push(next);
        index += 1;
      }
      if (group.length === 1) {
        result.push(first);
        continue;
      }
      const latest = group[group.length - 1]!;
      const imageOnly = group.every((entry) => entry.imageOnly);
      result.push({
        ...latest,
        text: imageOnly
          ? latest.text
          : group.map((entry) => entry.text.trim()).filter(Boolean).join("\n\n"),
        images: group.flatMap((entry) => [...(entry.images ?? [])]),
        imageOnly
      });
    }
    return result;
  }

  private async processMessage(message: InboundMessage, signal: AbortSignal): Promise<void> {
    const work = () => this.processMeasuredMessage(message, signal);
    return this.runtime.performance ? this.runtime.performance.activity(() => this.runtime.performance!.scope(work)) : work();
  }

  private async processMeasuredMessage(message: InboundMessage, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    let outcome: import("../performance/metrics.js").Outcome = "ok";
    const run = new AgentRunSession(this.communication.createRunChannel(message.conversationId));
    try {
      const command = !message.imageOnly ? parseAgentCommand(message.text) : undefined;
      if (command) {
        await this.executeCommand(command, message, run);
        return;
      }
      this.runtime.model.warmContextPolicy?.(message.model ?? this.runtime.model.defaultProvider);
      const referenceImageKey = `${message.conversationId}\0${message.userId}`;
      const inputImages = [...(message.images ?? [])];
      if (inputImages.length > 0) this.referenceImages.add(referenceImageKey, inputImages);
      const inputText = message.text;
      let turn: PreparedTurn | undefined;
      let activityOpened = false, compressionAnnounced = false;
      try {
        turn = await this.runtime.memory.prepareTurn(
          message.userId,
          inputText,
          message.conversationId,
          message.messageId,
          message.conversationKind ?? "p2p",
          true,
          async () => {
            if (compressionAnnounced) return;
            signal.throwIfAborted();
            if (!activityOpened) { await run.open(); activityOpened = true; }
            signal.throwIfAborted();
            run.receive({ type: "response.completed", itemId: "context-preparation", role: "commentary", text: "正在整理之前的对话，再继续处理。" });
            compressionAnnounced = true;
          },
          { provider: message.model ?? this.runtime.model.defaultProvider, signal, reasoningEfforts: message.reasoningEfforts }
        );
      } catch (error) {
        if (!(error instanceof TurnPreparationFallbackRequiredError)) throw error;
        const interruptedMessage = error.session.messages.find((entry) => entry.messageId === message.messageId);
        const interruptedRefs = inputImages.flatMap((image) => image.source ? [image.source] : []);
        if (interruptedMessage && interruptedRefs.length > 0) {
          await this.runtime.memory.recordInputImageRefs(error.session.id, interruptedMessage.turnId, interruptedRefs);
        }
        await this.requestFallback(
          message.userId,
          message.conversationId,
          error.session,
          error,
          async (resumedTurn, provider) => {
            if (!activityOpened) { await run.open(); activityOpened = true; }
            const prepared = await this.prepareTurnImages(resumedTurn, inputImages, referenceImageKey, signal);
            resumedTurn = prepared.turn;
            await this.generateAndComplete(
              resumedTurn,
              message,
              inputText,
              provider,
              run,
              inputImages,
              prepared.referenceImages,
              referenceImageKey,
              signal
            );
          },
          () => run.cancel(signal.reason)
        );
        return;
      }
      if (!turn) return;
      signal.throwIfAborted();
      this.clearInactivityTimer(turn.session.id);
      if (turn.transition.shouldSendSessionEndedCard && turn.transition.previousSession) {
        await this.runtime.fileWorkbench?.execution.cancelSession(turn.transition.previousSession.id);
        await this.communication.sendSessionEnded(
          turn.transition.previousSession,
          this.runtime.config.name,
          this.runtime.config.sessionInactivityMinutes
        ).catch((error: unknown) => console.error("Unable to send delayed session-end notice", error));
      }
      if (!activityOpened) await run.open();
      signal.throwIfAborted();
      const prepared = await this.prepareTurnImages(turn, inputImages, referenceImageKey, signal);
      turn = prepared.turn;
      await this.generateAndComplete(
        turn,
        message,
        inputText,
        message.model ?? this.runtime.model.defaultProvider,
        run,
        inputImages,
        prepared.referenceImages,
        referenceImageKey,
        signal
      );
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "error";
      if (signal.aborted) {
        await run.cancel(signal.reason).catch((sendError: unknown) => console.warn("Unable to mark interrupted run", sendError));
        return;
      }
      console.error("Unable to answer inbound message", error);
      await run.fail(this.runtime.config.failureMessage)
        .catch((sendError: unknown) => console.error("Unable to send failure message", sendError));
    } finally {
      this.runtime.performance?.record("turn.total", performance.now() - started, message.model ?? this.runtime.model.defaultProvider, outcome);
    }
  }

  private async executeCommand(
    command: NonNullable<ReturnType<typeof parseAgentCommand>>,
    message: InboundMessage,
    run: AgentRunSession
  ): Promise<void> {
    if (command.type === "help") {
      await run.complete(agentCommandHelp());
      return;
    }

    let closed: SessionMetadata | undefined;
    try {
      const transition = await this.runtime.memory.startNewSession(message.userId, message.conversationId, message.conversationKind ?? "p2p");
      closed = transition.previousSession;
    } catch (error) {
      if (!(error instanceof SessionPermissionError)) throw error;
      await run.complete("只有发起当前群话题的成员才能使用 /new；其他成员可以继续对话或等待话题自然结束。");
      return;
    }
    if (closed) {
      this.clearInactivityTimer(closed.id);
      await this.runtime.fileWorkbench?.execution.cancelSession(closed.id);
      await this.communication.sendSessionEnded(
        closed,
        this.runtime.config.name,
        this.runtime.config.sessionInactivityMinutes
      );
    }
    for (const [requestId, pending] of this.pendingFallbacks) {
      if (pending.conversationId === message.conversationId) this.pendingFallbacks.delete(requestId);
    }
    this.referenceImages.clearPrefix(`${message.conversationId}\0`);
    await run.complete(`${this.runtime.config.name}已开启新会话，之前的会话已保留。`);
  }

  async handleAction(userId: string, conversationId: string, action: InteractionAction): Promise<InteractionActionResult> {
    try {
      // Answer outside the conversation queue: the active turn is waiting for this very action.
      if (action.type === "question-answer") {
        if (!this.questions) return { ok: false, message: "此渠道没有可用的提问组件。" };
        return await this.questions.act(userId, conversationId, action);
      }
      if (action.type === "operation-confirmation") {
        if (!this.operations) return { ok: false, message: "此渠道没有可用的变更确认组件。" };
        return await this.runForConversation(conversationId, () => this.operations!.act(userId, conversationId, action.proposalId, action.confirm, action.codexEdits, action.codexEditOnly));
      }
      if (action.type === "model-fallback") {
        this.purgeExpiredFallbacks();
        const pending = this.pendingFallbacks.get(action.requestId);
        if (!pending || pending.userId !== userId || pending.conversationId !== conversationId) {
          return { ok: false, message: "这次模型切换已失效，请重新发送问题" };
        }
        const selected = action.retry ? pending.failedProvider : action.model ?? pending.fallbackProvider;
        if (action.model && !pending.selectableProviders && action.model !== pending.fallbackProvider) {
          return { ok: false, message: "请使用本次请求提供的模型。" };
        }
        if (action.confirm && pending.selectableProviders && !action.retry && !pending.selectableProviders.includes(selected)) {
          return { ok: false, message: "此模型暂不可选，请从模型库选择其他供应商。" };
        }
        if (action.retry && !pending.selectableProviders) return { ok: false, message: "这次请求不支持重新连接。" };
        this.pendingFallbacks.delete(action.requestId);
        if (!action.confirm) {
          this.scheduleSessionEnd(pending.session);
          return { ok: true, message: "已取消模型切换" };
        }
        this.clearInactivityTimer(pending.session.id);
        if (pending.selectableProviders) this.runtime.model.resetCircuit?.(selected);
        const task = this.runForConversation(pending.conversationId, async () => {
            const controller = pending.controller ?? new AbortController();
            this.activeRuns.set(pending.conversationId, { userId: pending.userId, controller });
            try { controller.signal.throwIfAborted(); await pending.continueTask(selected); }
            catch (error) {
              if (!controller.signal.aborted) throw error;
              await pending.cancelTask();
            } finally {
              if (this.activeRuns.get(pending.conversationId)?.controller === controller) this.activeRuns.delete(pending.conversationId);
            }
          });
        this.runInBackground(
          () => task,
          (error) => {
            this.scheduleSessionEnd(pending.session);
            console.error("Unable to complete model fallback task", error);
            void this.communication.sendStandaloneFailure(
              pending.conversationId,
              this.runtime.config.failureMessage
            ).catch((sendError: unknown) => console.error("Unable to send fallback failure message", sendError));
          }
        );
        return { ok: true, message: action.retry ? "正在重新连接" : `已切换到${this.providerName(selected)}继续处理` };
      }
      if (action.type === "resume" || action.type === "delete") {
        // Validate the target before cancellation so forged management actions cannot interrupt a turn.
        const target = await this.runtime.memory.getSessionMetadata(action.sessionId);
        if (target.chatId !== conversationId) return { ok: false, message: "此会话不属于当前对话。" };
        if (action.type === "delete" && target.chatType === "group" && target.userId !== userId) throw new SessionPermissionError();
        const active = this.activeRuns.get(conversationId);
        if (active?.userId === userId) active.controller.abort(new AgentRunInterruption("session_change"));
        for (const [id, pending] of this.pendingFallbacks) {
          if (pending.conversationId === conversationId && pending.userId === userId) this.pendingFallbacks.delete(id);
        }
        // Let cancellation finish before resuming/deleting any session the active tool might still use.
        return await this.runForConversation(conversationId, async () => {
          if (action.type === "resume") {
            const session = await this.runtime.memory.resumePreviousSession(conversationId, action.sessionId);
            this.scheduleSessionEnd(session);
            return { ok: true, message: "已切换到上一话题" };
          }
          await this.runtime.fileWorkbench?.execution.cancelSession(action.sessionId);
          await this.runtime.memory.deleteSession(conversationId, action.sessionId, userId);
          this.clearInactivityTimer(action.sessionId);
          return { ok: true, message: "已删除该会话" };
        });
      }
      await this.runtime.memory.recordSessionFeedback(conversationId, userId, action.sessionId, action.rating);
      return { ok: true, message: "感谢你的反馈" };
    } catch (error) {
      if (error instanceof SessionPermissionError) {
        return { ok: false, message: "只有发起该群话题的成员才能删除会话" };
      }
      console.error("Unable to process interaction action", error);
      return {
        ok: false,
        message: action.type === "resume"
          ? "上一话题已不可用"
          : action.type === "delete" ? "会话删除失败" : "反馈保存失败"
      };
    }
  }

  private async generateAndComplete(
    turn: PreparedTurn,
    message: InboundMessage,
    text: string,
    provider: Provider,
    run: AgentRunSession,
    inputImages: readonly ReferenceImage[],
    referenceImages: ToolExecutionContext["referenceImages"],
    referenceImageKey: string,
    signal?: AbortSignal
  ): Promise<void> {
    let reply: GeneratedReply;
    try {
      const workspaceContext = await this.options.workspaceContext?.(message, turn);
      signal?.throwIfAborted();
      const recentRequests = await this.runtime.memory.getRecentUserRequests(turn.session.id, turn.currentMessage.turnId);
      const delegationRequest = recentRequests.map(entry => `[用户原话 · ${new Date(entry.createdAt).toISOString()} · 会话${turn.session.id} · 第${entry.turnId}轮]
${entry.content}`).join("\n\n");
      const toolContext: ToolExecutionContext = {
        agentId: this.runtime.config.id, userId: message.userId, principalId: message.principalId,
        sessionId: turn.session.id, turnId: turn.currentMessage.turnId, conversationId: message.conversationId,
        conversationKind: message.conversationKind, signal, delegationRequest,
        delegationMemory: turn.context.longTermMemory.behaviorRules,
        resolveDelegationSources: async sources => {
          const excerpts: string[] = [];
          for (const source of sources) {
            const metadata = await this.runtime.memory.getSessionMetadata(source.sessionId);
            if (!metadata || metadata.userId !== message.userId || metadata.chatType !== "p2p" || message.conversationKind !== "p2p") throw new Error("历史依据不可用于当前任务");
            const session = await this.runtime.memory.getSession(source.sessionId);
            const entry = session.messages.find(entry => entry.role === "user" && entry.turnId === source.turnId);
            if (!entry) throw new Error("未找到指定的用户原始要求，请重新查阅历史");
            excerpts.push(`[历史用户要求 · ${new Date(entry.createdAt).toISOString()} · 会话${source.sessionId} · 第${source.turnId}轮]\n${entry.content}${entry.questionAnswers?.length ? "\n用户补充回答：" + JSON.stringify(entry.questionAnswers) : ""}`);
          }
          return [...new Set(excerpts)].join("\n\n");
        },
        ...(this.questions ? { askUserQuestion: async request => {
          const result = await this.questions!.ask(request, {
            userId: message.userId, conversationId: message.conversationId, sessionId: turn.session.id, signal
          });
          // Persist accepted user information before an aborted run can release the conversation queue.
          if (result.status === "answered") await this.runtime.memory.recordUserQuestionAnswers(turn.session.id, turn.currentMessage.turnId, result);
          return result;
        } } : {}),
        ...(this.operations ? { proposeOperation: draft => this.operations!.offer(draft, toolContext),
          proposeTask: async proposal => {
            const result = await this.runtime.tools!.execute("proactive_tasks", { action: "create", title: proposal.title,
              instruction: proposal.instruction, trigger: proposal.trigger, ...(proposal.skill ? { skill: proposal.skill } : {}),
              ...(proposal.deliveryPolicy ? { delivery_policy: proposal.deliveryPolicy } : {}) }, toolContext) as { proposalId: string };
            return { proposalId: result.proposalId };
          } } : {}),
        ...this.options.toolContext?.(message, turn)
      };
      reply = await this.runtime.agent.run(text, { ...turn.context, workspaceContext: [workspaceContext, `Recent user-request evidence for Codex delegation (not the complete intent history). Rewrite and synthesize naturally; if goals or preferences come from older sessions, retrieve conversation_history and cite sourceTurns. Newer explicit corrections supersede older plans:\n${delegationRequest}`].filter(Boolean).join("\n\n") }, provider, {
        beforeFinalReply:()=>this.runtime.fileWorkbench?.deliveryGuidance(turn.session.id,turn.currentMessage.turnId),
        automaticFallback: false,
        signal,
        inputImages,
        contextPersistence: {
          load: () => this.runtime.memory.getContextCheckpoints(turn.session.id),
          save: checkpoints => this.runtime.memory.saveContextCheckpoints(turn.session.id, checkpoints)
        },
        reasoningEfforts: message.reasoningEfforts,
        onEvent: (event) => {
          if (event.type === "model.route") this.diagnose(message, { phase: "model_route", status: event.status,
            model: event.model, supplier: event.supplier, failureKind: event.failureKind, retryAttempt: event.retryAttempt });
          else if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed")
            this.diagnose(message, { phase: event.type.replace(".", "_") as "tool_started" | "tool_completed" | "tool_failed",
              tool: event.name, itemId: event.itemId, ...("durationMs" in event ? { durationMs: event.durationMs } : {}) });
          run.receive(event);
        },
        toolContext: {
          imageGenerator: this.runtime.imageGeneration,
          imageConversation: async () => {
            const session = await this.runtime.memory.getSession(turn.session.id);
            signal?.throwIfAborted();
            return {
              sessionId: session.id, userId: session.userId, turnId: turn.currentMessage.turnId, signal,
              messages: session.messages.filter(entry => (entry.role === "user" || entry.role === "assistant")
                && entry.turnId <= turn.currentMessage.turnId).map(entry => ({
                id: entry.id, turnId: entry.turnId, role: entry.role as "user" | "assistant", text: entry.content,
                imageIds: (entry.images ?? []).map(image => image.id),
                loadImages: () => Promise.all((entry.images ?? []).map(image => this.loadSessionImage(image, referenceImageKey)))
              }))
            };
          },
          videoGenerator: this.runtime.videoGeneration,
          referenceImages,
          viewSessionImages: async (imageIds) => {
            const records = await this.runtime.memory.reactivateImages(
              turn.session.id,
              imageIds,
              turn.currentMessage.turnId
            );
            return Promise.all(records.map(async (image) => ({
              ...(await this.loadSessionImage(image, referenceImageKey)),
              sessionImageId: image.id
            })));
          },
          onImageGenerationRecords: (records) =>
            this.runtime.memory.recordImageGenerationRecords(turn.session.id, turn.currentMessage.turnId, records),
          ...toolContext,
          replyId: run.replyId,
          ...(run.supportsImages ? { presentImages: (images: readonly import("../image-generation.js").GeneratedImage[]) => run.presentImages(images, signal) } : {}),
          ...(run.supportsOutput ? { presentOutput: (output) => run.presentOutput(output, signal) } : {})
        }
      });
      signal?.throwIfAborted();
    } catch (error) {
      if (!(error instanceof AgentExecutionFallbackRequiredError)) throw error;
      await this.requestFallback(
        message.userId,
        message.conversationId,
        turn.session,
        error,
        async reply => this.completeTurn(turn, reply, run, message, signal, referenceImageKey),
        () => run.cancel(signal?.reason)
      );
      return;
    }
    await this.completeTurn(turn, reply, run, message, signal, referenceImageKey);
  }

  private async completeTurn(
    turn: PreparedTurn,
    reply: GeneratedReply,
    run: AgentRunSession,
    message: InboundMessage,
    signal?: AbortSignal,
    referenceImageKey?: string
  ): Promise<void> {
    signal?.throwIfAborted();
    const fileDelivery = this.runtime.fileWorkbench?.deliveries.forTurn(turn.session.id,turn.currentMessage.turnId).at(-1);
    const candidatesPending=!fileDelivery && !this.runtime.fileWorkbench?.deliveryDeferred(turn.session.id,turn.currentMessage.turnId)
      && Boolean(this.runtime.fileWorkbench?.candidatesForTurn(turn.session.id,turn.currentMessage.turnId).length);
    if (candidatesPending || fileDelivery && fileDelivery.status !== "delivered") {
      reply = {...reply,text:candidatesPending?"候选版本已保存，尚未选择最终交付成果。":"文件已保存，交付尚未完成，请使用重试交付。"};
      const last=[...run.auditSnapshot().items].reverse().find(item=>item.type==="response");
      run.receive({type:"response.completed",itemId:last?.id ?? "file-delivery-status",role:"answer",text:reply.text});
    }
    const updatedSession = await this.runtime.memory.recordAssistantReply({
      sessionId: turn.session.id,
      turnId: turn.currentMessage.turnId,
      content: reply.text,
      usage: reply.usage,
      model: reply.model,
      imageUsages: reply.imageUsages,
      modelIdentity: reply.route ? {
        model: reply.route.apiModel,
        name: reply.route.name,
        brand: reply.route.brand,
        supplier: reply.route.supplier,
        costMultiplier: modelCostMultiplier(reply.route.cost)
      } : undefined,
      toolTrace: reply.toolTrace,
      activityTrace: run.auditSnapshot().items,
      videoUsages: reply.videoUsages
    });
    signal?.throwIfAborted();
    this.scheduleSessionEnd(updatedSession);
    enqueueReplyNotification(this.runtime.notifications, {
      agentId: this.runtime.config.id,
      userId: message.userId,
      conversationKind: turn.session.chatType === "p2p" || turn.session.chatType === "group" ? turn.session.chatType : undefined
    }, turn.session.id, turn.currentMessage.turnId, reply);
    const deliveries = await run.complete(reply.text, reply.images, reply.videos, signal);
    if (deliveries.length > 0) {
      await this.runtime.memory.recordImageDeliveries(turn.session.id, turn.currentMessage.turnId, deliveries)
        .catch((error: unknown) => console.warn("Unable to record image delivery references for audit", error));
      if (referenceImageKey) {
        const deliveredReferences = deliveries.flatMap((delivery, index): ReferenceImage[] => {
          const image = reply.images[index];
          return image ? [{
            data: image.data,
            mimeType: image.mimeType,
            source: { provider: delivery.provider, messageId: delivery.messageId, imageKey: delivery.imageKey }
          }] : [];
        });
        this.referenceImages.add(referenceImageKey, deliveredReferences);
      }
    }
  }

  private async prepareTurnImages(
    turn: PreparedTurn,
    currentImages: readonly ReferenceImage[],
    cacheKey: string,
    signal?: AbortSignal
  ): Promise<{ turn: PreparedTurn; referenceImages: ReferenceImage[] }> {
    signal?.throwIfAborted();
    const refs = currentImages.flatMap((image) => image.source ? [image.source] : []);
    if (refs.length > 0) {
      const images = await this.runtime.memory.recordInputImageRefs(turn.session.id, turn.currentMessage.turnId, refs);
      // Keep this turn's snapshot coherent after the targeted insert; no history reload.
      turn.currentMessage.inputImageRefs = [...refs];
      turn.currentMessage.images = images;
      const current = turn.session.messages.find(message => message.id === turn.currentMessage.id);
      if (current) { current.inputImageRefs = [...refs]; current.images = images; }
    }
    if (typeof this.runtime.memory.prepareImageContext !== "function") {
      return { turn, referenceImages: [...currentImages] };
    }
    const prepared = await this.runtime.memory.prepareImageContext(
      turn,
      (image) => {
        signal?.throwIfAborted();
        return this.loadSessionImage(image, cacheKey);
      }
    );
    const unique = new Map<string, ReferenceImage>();
    for (const image of [...prepared.referenceImages, ...currentImages]) {
      const key = image.source ? ReferenceImageStore.sourceKey(image.source) : `inline-${unique.size}`;
      unique.set(key, image);
    }
    return { turn: prepared.turn, referenceImages: [...unique.values()] };
  }

  private async loadSessionImage(image: SessionImage, cacheKey: string): Promise<ReferenceImage> {
    const sourceKey = ReferenceImageStore.sourceKey(image.source);
    const cached = this.referenceImages.get(cacheKey).find((entry) =>
      entry.source && ReferenceImageStore.sourceKey(entry.source) === sourceKey
    );
    if (cached) return cached;
    if (!this.communication.readImage) throw new Error("The communication channel cannot reload historical images");
    const loaded = await this.communication.readImage(image.source);
    this.referenceImages.add(cacheKey, [loaded]);
    return loaded;
  }

  recoveryOptions(userId: string, conversationId: string, requestId: string): { failedProvider: Provider; selectableProviders: Provider[] } | undefined {
    this.purgeExpiredFallbacks();
    const pending = this.pendingFallbacks.get(requestId);
    if (!pending || pending.userId !== userId || pending.conversationId !== conversationId || !pending.selectableProviders) return;
    return { failedProvider: pending.failedProvider, selectableProviders: [...pending.selectableProviders] };
  }

  waitForConversation(conversationId: string): Promise<unknown> {
    return this.conversationTasks.get(conversationId) ?? Promise.resolve();
  }

  private async requestFallback<T>(
    userId: string,
    conversationId: string,
    session: Session,
    error: Pick<AgentExecutionFallbackRequiredError, "failedProvider" | "fallbackProvider" | "kind" | "status" | "elapsedMs" | "failedSupplier" | "lastFailure" | "selectableProviders"> & { resumeWithProvider: (provider: Provider) => Promise<T> },
    finishTask: (value: T, provider: Provider) => Promise<void>,
    cancelTask: () => Promise<void>,
    existingRequestId?: string
  ): Promise<void> {
    this.purgeExpiredFallbacks();
    const requestId = existingRequestId ?? randomUUID();
    this.pendingFallbacks.set(requestId, {
      userId,
      conversationId,
      session,
      fallbackProvider: error.fallbackProvider,
      failedProvider: error.failedProvider,
      selectableProviders: error.selectableProviders,
      createdAt: Date.now(),
      continueTask: async provider => {
        try { await finishTask(await error.resumeWithProvider(provider), provider); }
        catch (next) {
          if (!(next instanceof AgentExecutionFallbackRequiredError) && !(next instanceof TurnPreparationFallbackRequiredError)) throw next;
          // Repeated failures remain in the same preparation/execution phase.
          if (error instanceof AgentExecutionFallbackRequiredError && !(next instanceof AgentExecutionFallbackRequiredError)
            || error instanceof TurnPreparationFallbackRequiredError && !(next instanceof TurnPreparationFallbackRequiredError)) throw next;
          await this.requestFallback(userId, conversationId, session, next as unknown as typeof error, finishTask, cancelTask, requestId);
        }
      },
      controller: this.activeRuns.get(conversationId)?.controller,
      cancelTask
    });
    this.scheduleSessionEnd(session);
    try {
      await this.communication.sendModelFallback({
        requestId,
        conversationId,
        failedProvider: error.failedProvider,
        fallbackProvider: error.fallbackProvider,
        kind: error.kind,
        status: error.status,
        elapsedMs: error.elapsedMs,
        failedSupplier: error.failedSupplier,
        lastFailure: error.lastFailure,
        selectableProviders: error.selectableProviders
      });
    } catch (sendError) {
      this.pendingFallbacks.delete(requestId);
      throw sendError;
    }
  }

  private scheduleSessionEnd(session: SessionMetadata): void {
    this.clearInactivityTimer(session.id);
    if (session.status !== "active" || !session.chatId) return;
    const delay = Math.max(0, this.inactivityMs - (Date.now() - session.lastActiveAt)) + 25;
    const timer = setTimeout(() => {
      this.inactivityTimers.delete(session.id);
      void (async () => {
        const pending = await this.runtime.memory.markSessionPendingIfInactive(session.id, session.lastActiveAt);
        if (!pending) return;
        await this.runtime.fileWorkbench?.execution.cancelSession(pending.id);
        const deliver = () => this.communication.sendSessionEnded(
          pending,
          this.runtime.config.name,
          this.runtime.config.sessionInactivityMinutes
        );
        await (this.runtime.performance ? this.runtime.performance.measure("task.delivery", "session.end", deliver) : deliver());
      })().catch((error: unknown) => {
        console.error("Unable to send session-end notice", error);
      });
    }, delay);
    timer.unref();
    this.inactivityTimers.set(session.id, timer);
  }

  private clearInactivityTimer(sessionId: string): void {
    const timer = this.inactivityTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.inactivityTimers.delete(sessionId);
  }

  private purgeExpiredFallbacks(): void {
    const cutoff = Date.now() - FALLBACK_REQUEST_TTL_MS;
    for (const [requestId, pending] of this.pendingFallbacks) {
      if (pending.createdAt < cutoff) this.pendingFallbacks.delete(requestId);
    }
  }

  private runInBackground(task: () => Promise<void>, onError: (error: unknown) => void): void {
    void Promise.resolve().then(task).catch((error: unknown) => {
      try {
        onError(error);
      } catch (handlerError) {
        console.error("Unable to handle background task failure", handlerError);
      }
    });
  }

  private diagnose(message: InboundMessage, event: ConversationDiagnostic): void {
    try { this.options.onDiagnostic?.(message, event); }
    catch { console.warn("Unable to persist conversation diagnostic metadata"); }
  }

  private runForConversation<T>(conversationId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.conversationTasks.get(conversationId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.then(() => undefined);
    this.conversationTasks.set(conversationId, tail);
    const cleanup = () => {
      if (this.conversationTasks.get(conversationId) === tail) this.conversationTasks.delete(conversationId);
    };
    void tail.then(cleanup, cleanup);
    return current;
  }

  private waitForImageQuietPeriod(key: string): Promise<void> {
    const existing = this.imageMessageDebounces.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.finishImageQuietPeriod(key), this.imageMessageDebounceMs);
      return existing.promise;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const pending: ImageMessageDebounce = {
      timer: setTimeout(() => this.finishImageQuietPeriod(key), this.imageMessageDebounceMs),
      promise,
      resolve
    };
    this.imageMessageDebounces.set(key, pending);
    return promise;
  }

  private finishImageQuietPeriod(key: string): void {
    const pending = this.imageMessageDebounces.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.imageMessageDebounces.delete(key);
    pending.resolve();
  }

  private providerName(provider: Provider): string {
    if (provider === "gpt") return "GPT";
    if (provider === "claude") return "Claude";
    if (provider === "deepseek") return "DeepSeek";
    return provider;
  }
}
