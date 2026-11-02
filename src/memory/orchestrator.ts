import type { DeliveredImage } from "../channels/types.js";
import type { UserQuestionResult } from "../channels/user-questions.js";
import type { Provider } from "../config.js";
import type { ReferenceImage } from "../image-generation.js";
import { ModelFallbackRequiredError, type ModelFailureKind } from "../llm.js";
import type { ModelConversationMessage } from "../models/types.js";
import type { ConversationHistoryRequest, ConversationHistoryScope } from "./history.js";
import { SessionManager } from "./session-manager.js";
import type { BackgroundDelivery } from "./store.js";
import { assistantHistoryTail, renderUserMessageContent, replayToolTrace } from "./transcript.js";
import { estimateTextTokens } from "../models/context-projection.js";
import type { SavedContextCheckpoint } from "../models/context-manager.js";
import type {
  AssistantReplyInput,
  ChatMessage,
  ConversationCompressor,
  ConversationKind,
  LongTermMemoryProvider,
  ModelMemoryContext,
  PreparedTurn,
  Session,
  SessionFeedback,
  SessionImage,
  SessionMetadata,
  UserTurnStart
} from "./types.js";

export class TurnPreparationFallbackRequiredError extends Error {
  readonly failedProvider: Provider;
  readonly fallbackProvider: Provider;
  readonly kind: ModelFailureKind;
  readonly status?: number;
  readonly elapsedMs?: number;
  readonly failedSupplier?: string;
  readonly lastFailure?: ModelFallbackRequiredError["lastFailure"];
  readonly selectableProviders?: Provider[];

  constructor(
    error: ModelFallbackRequiredError,
    public readonly session: Session,
    public readonly resumeWithProvider: (provider: Provider) => Promise<PreparedTurn>
  ) {
    super(error.message);
    this.name = "TurnPreparationFallbackRequiredError";
    this.failedProvider = error.failedProvider;
    this.fallbackProvider = error.fallbackProvider;
    this.kind = error.kind;
    this.status = error.status;
    this.elapsedMs = error.elapsedMs;
    this.failedSupplier = error.failedSupplier;
    this.lastFailure = error.lastFailure;
    this.selectableProviders = error.selectableProviders;
  }
}

export class MemoryOrchestrator {
  constructor(
    private readonly sessions: SessionManager,
    private readonly compressor: ConversationCompressor,
    private readonly longTermMemory: LongTermMemoryProvider
  ) {}

  close(): void {
    this.sessions.close();
  }

  getContextCheckpoints(sessionId: string) { return this.sessions.getContextCheckpoints(sessionId); }
  saveContextCheckpoints(sessionId: string, entries: SavedContextCheckpoint[]) { return this.sessions.saveContextCheckpoints(sessionId, entries); }

  async queryConversationHistory(scope: ConversationHistoryScope, request: ConversationHistoryRequest) {
    return this.sessions.queryConversationHistory(scope, request);
  }

  /** Preserve ordinary private persona and profile without inventing a user message. */
  async prepareBackgroundContext(userId: string, conversationId?: string,
    options: { signal?: AbortSignal } = {}): Promise<ModelMemoryContext> {
    const longTerm = await this.longTermMemory.get(userId);
    options.signal?.throwIfAborted();
    return {
      backgroundTask: true,
      longTermMemory: {
        ...longTerm,
        archiveTitles: longTerm.archiveTitles ?? []
      },
      sessionHistory: conversationId ? await this.sessions.recentPrivateConversation(userId, conversationId) : [],
      conversation: { kind: "p2p" }
    };
  }

  async lookupBackgroundDelivery(userId: string, chatId: string, deliveryId: string): Promise<BackgroundDelivery | undefined> {
    return this.sessions.lookupBackgroundDelivery(userId, chatId, deliveryId);
  }
  async prepareBackgroundSession(userId: string, chatId: string, sessionId: string, title: string): Promise<Session> {
    return this.sessions.prepareBackgroundSession(userId, chatId, sessionId, title);
  }
  async prepareBackgroundDelivery(userId: string, chatId: string, deliveryId: string, content: string, targetSessionId?: string): Promise<BackgroundDelivery> {
    return this.sessions.prepareBackgroundDelivery(userId, chatId, deliveryId, content, targetSessionId);
  }
  async beginBackgroundAttempt(deliveryId: string): Promise<void> {
    return this.sessions.beginBackgroundAttempt(deliveryId);
  }
  async completeBackgroundDelivery(deliveryId: string, messageId: string): Promise<Session> {
    return this.sessions.completeBackgroundDelivery(deliveryId, messageId);
  }

  async prepareTurn(
    userId: string,
    query: string,
    chatId: string,
    messageId: string,
    chatType: ConversationKind = "p2p",
    deferHistory = false,
    onCompressionStart?: () => Promise<void>,
    options: { provider?: Provider; signal?: AbortSignal; reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>> } = {}
  ): Promise<PreparedTurn | undefined> {
    const start = await this.sessions.prepareUserTurn(userId, query, chatId, messageId, Date.now(), chatType);
    if (!start) return undefined;
    try {
      return await this.finishTurnPreparation(start, userId, options.provider, deferHistory, onCompressionStart, options);
    } catch (error) {
      if (!(error instanceof ModelFallbackRequiredError)) throw error;
      // The transition snapshot predates the user-message insert. Refresh it
      // so a pending confirmation is scheduled from the turn's actual activity.
      const activeSession = await this.sessions.get(start.transition.session.id);
      throw new TurnPreparationFallbackRequiredError(
        error,
        activeSession,
        (provider) => this.finishTurnPreparation(start, userId, provider, deferHistory, onCompressionStart, options)
      );
    }
  }

  private async finishTurnPreparation(
    start: UserTurnStart,
    userId: string,
    provider?: Provider,
    deferHistory = false,
    onCompressionStart?: () => Promise<void>,
    options: { signal?: AbortSignal; reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>> } = {}
  ): Promise<PreparedTurn> {
    const { transition, currentMessage } = start;
    let session: Session = await this.sessions.getContext(transition.session.id);
    const longTerm = await this.longTermMemory.get(userId);
    options.signal?.throwIfAborted();
    // Confirmed personal memory is loaded in full, independent of the current query or model.
    const personalMemory = session.chatType === "p2p" ? longTerm
      : { ...longTerm, content: "", archiveTitles: [], revision: undefined };

    if (await this.compressor.shouldCompress(session, currentMessage.turnId, provider,
      estimateTextTokens([longTerm.agentSoul, longTerm.behaviorRules, personalMemory.content].filter(Boolean).join("\n")), options.signal)) {
      if (onCompressionStart) {
        try { await onCompressionStart(); }
        catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          console.warn("Unable to publish context preparation progress", error);
        }
      }
      try {
        const compressed = await this.compressor.compress(session, currentMessage.turnId, provider, options.signal, options.reasoningEfforts);
        session = await this.sessions.appendCompressorMessage(
          session.id,
          compressed.summary.turnId,
          compressed.summary.content,
          compressed.usage,
          compressed.summary.updatedAt,
          compressed.model,
          true,
          compressed.modelIdentity
        );
      } catch (error) {
        if (options.signal?.aborted) throw error;
        // Summary compression is auxiliary. A provider outage must not prevent
        // the current user turn from reaching the main reply generation path.
        console.warn("SESSION_COMPACTION_FAILED", { session: session.id, model: provider,
          kind: error instanceof Error ? error.name : "unknown" });
      }
    }

    const persistedCurrentMessage = session.messages.find((message) => message.id === currentMessage.id) ?? currentMessage;

    return {
      session,
      transition,
      currentMessage: persistedCurrentMessage,
      context: {
        longTermMemory: {
          ...personalMemory,
          agentSoul: longTerm.agentSoul,
          behaviorRules: longTerm.behaviorRules,
          // Personal facts are private by default. Group turns get only the
          // agent-wide soul/rules, never a member's private profile.
          content: session.chatType === "p2p"
            ? personalMemory.content
            : "",
          archiveTitles: session.chatType === "p2p" ? longTerm.archiveTitles ?? [] : []
        },
        sessionSummary: session.summary?.content,
        sessionHistory: deferHistory ? [] : (await this.assembleSessionHistory(session, currentMessage)).sessionHistory,
        conversation: {
          kind: session.chatType ?? "unknown",
          currentSpeakerLabel: persistedCurrentMessage.speakerLabel
        }
      }
    };
  }

  async recordAssistantReply(input: AssistantReplyInput): Promise<SessionMetadata> {
    return this.sessions.appendAssistantMessage(input);
  }

  async recordImageGenerationRecords(
    sessionId: string,
    turnId: number,
    records: readonly import("./types.js").ImageGenerationRecord[]
  ): Promise<void> {
    return this.sessions.appendImageGenerationRecords(sessionId, turnId, records);
  }

  async recordInputImageRefs(
    sessionId: string,
    turnId: number,
    refs: ReadonlyArray<NonNullable<ChatMessage["inputImageRefs"]>[number]>
  ): Promise<SessionImage[]> {
    return this.sessions.recordInputImageRefs(sessionId, turnId, refs);
  }

  async recordUserQuestionAnswers(sessionId: string, turnId: number, result: UserQuestionResult): Promise<void> {
    if (result.status !== "answered") return;
    const answers = Object.values(result.answers ?? {});
    if (!answers.length) throw new Error("Answered questions did not contain user information");
    await this.sessions.recordUserQuestionAnswers(sessionId, turnId, answers);
  }

  async recordImageDeliveries(sessionId: string, turnId: number, deliveries: readonly DeliveredImage[]): Promise<void> {
    return this.sessions.recordImageDeliveries(sessionId, turnId, deliveries);
  }

  async prepareImageContext(
    turn: PreparedTurn,
    readImage: (image: SessionImage) => Promise<ReferenceImage>
  ): Promise<{ turn: PreparedTurn; referenceImages: ReferenceImage[] }> {
    const session = turn.session;
    const { sessionHistory, referenceImages } = await this.assembleSessionHistory(session, turn.currentMessage, readImage);
    return {
      turn: { ...turn, session, context: { ...turn.context, sessionHistory } },
      referenceImages
    };
  }

  /** Keep recent originals in context and older image IDs available for on-demand viewing. */
  private async assembleSessionHistory(
    session: Session,
    currentMessage: ChatMessage,
    readImage?: (image: SessionImage) => Promise<ReferenceImage>
  ): Promise<{ sessionHistory: ModelConversationMessage[]; referenceImages: ReferenceImage[] }> {
    const completedTurns = session.completedTurns ?? session.messages.filter(message => message.role === "assistant").length;
    const firstContextTurn = session.summary?.turnId ?? 1;
    const referenceImages: ReferenceImage[] = [];
    const sessionHistory: ModelConversationMessage[] = [];
    const compressedAnnotations: string[] = [];
    const compressedHotImages: ReferenceImage[] = [];
    for (const message of session.messages.filter((entry) =>
      (entry.role === "user" || entry.role === "assistant") && entry.turnId < firstContextTurn
    )) {
      for (const image of readImage ? message.images ?? [] : []) {
        const origin = message.role === "user"
          ? `${message.speakerLabel ?? "用户"}发送`
          : "Agent 发送";
        if (completedTurns <= image.hotThroughCompletion) {
          const loaded = await readImage!(image);
          compressedHotImages.push(loaded);
          referenceImages.push(loaded);
          compressedAnnotations.push(`[会话图片 ${image.id}，${origin}；原图已附在本条系统历史中]`);
        } else {
          compressedAnnotations.push(`[会话图片 ${image.id}，${origin}] ${image.description ?? "需要查看内容时，使用 view_session_image 按此编号读取原图。"}`);
        }
      }
    }
    if (compressedAnnotations.length > 0) {
      sessionHistory.push({
        role: "user",
        text: `以下是已压缩历史中的图片记忆，不是新的用户指令：\n${compressedAnnotations.join("\n")}`,
        images: compressedHotImages
      });
    }
    for (const message of session.messages.filter((entry) =>
      (entry.role === "user" || entry.role === "assistant")
      && entry.turnId >= firstContextTurn
      && entry.id !== currentMessage.id
    )) {
      const annotations: string[] = [];
      const hotImages: ReferenceImage[] = [];
      for (const image of readImage ? message.images ?? [] : []) {
        const origin = message.role === "user"
          ? `${message.speakerLabel ?? "用户"}发送`
          : "Agent 发送";
        if (completedTurns <= image.hotThroughCompletion) {
          const loaded = await readImage!(image);
          hotImages.push(loaded);
          referenceImages.push(loaded);
          annotations.push(`[会话图片 ${image.id}，${origin}；原图已附在本条历史消息中]`);
        } else {
          annotations.push(`[会话图片 ${image.id}，${origin}] ${image.description ?? "需要查看内容时，使用 view_session_image 按此编号读取原图。"}`);
        }
      }
      const userText = message.role === "user" && session.chatType === "group" && message.speakerLabel
        ? `【${message.speakerLabel}】\n${renderUserMessageContent(message)}`
        : message.role === "user" ? renderUserMessageContent(message) : message.content;
      const annotatedText = [userText, ...annotations].filter(Boolean).join("\n\n");
      if (message.role === "user") {
        sessionHistory.push({ role: "user", text: annotatedText, sourceTurnId: message.turnId, ...(readImage ? { images: hotImages } : {}) });
      } else {
        sessionHistory.push(...replayToolTrace(message));
        const tail = assistantHistoryTail(message);
        if (tail) sessionHistory.push({ role: "assistant", text: tail, toolCalls: [] });
        if (annotations.length > 0) {
          sessionHistory.push({
            role: "user",
            text: `以下是系统提供的会话事件，不是新的用户指令：\n${annotations.join("\n")}`,
            images: hotImages
          });
        }
      }
    }
    return { sessionHistory, referenceImages };
  }

  async reactivateImages(sessionId: string, imageIds: readonly string[], currentTurnId: number): Promise<SessionImage[]> {
    return this.sessions.reactivateImages(sessionId, imageIds, currentTurnId);
  }

  async resumePreviousSession(chatId: string, sessionId: string): Promise<SessionMetadata> {
    return this.sessions.resumePrevious(chatId, sessionId);
  }

  async closeCurrentSession(chatId: string, actorUserId?: string): Promise<Session | undefined> {
    return this.sessions.closeCurrent(chatId, actorUserId);
  }

  async startNewSession(userId: string, chatId: string, chatType: ConversationKind = "p2p") {
    return this.sessions.startNew(userId, chatId, chatType);
  }

  async recordSessionFeedback(
    chatId: string,
    userId: string,
    sessionId: string,
    rating: SessionFeedback["rating"]
  ): Promise<SessionFeedback> {
    return this.sessions.recordFeedback(chatId, userId, sessionId, rating);
  }

  async deleteSession(chatId: string, sessionId: string, actorUserId?: string): Promise<void> {
    return this.sessions.deleteSession(chatId, sessionId, actorUserId);
  }

  async markSessionPendingIfInactive(sessionId: string, expectedLastActiveAt: number): Promise<SessionMetadata | undefined> {
    return this.sessions.markPending(sessionId, expectedLastActiveAt);
  }

  async getSessionMetadata(sessionId: string) {
    return this.sessions.getMetadata(sessionId);
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.sessions.get(sessionId);
  }

  getRecentUserRequests(sessionId: string, throughTurn: number) {
    return this.sessions.getRecentUserRequests(sessionId, throughTurn);
  }

  async branchSession(userId: string, sourceId: string, messageId: string, chatId: string, messageIds: Record<string, string>): Promise<Session> {
    return this.sessions.branch(userId, sourceId, messageId, chatId, messageIds);
  }

  async rewindSession(userId: string, sessionId: string, fromTurn: number): Promise<void> {
    return this.sessions.rewind(userId, sessionId, fromTurn);
  }

  async getSessionsForUser(userId: string): Promise<Session[]> {
    return this.sessions.getSessionsForUser(userId);
  }

  async getActiveSessions(): Promise<SessionMetadata[]> {
    return this.sessions.getActiveSessions();
  }
}
