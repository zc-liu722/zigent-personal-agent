import type { DeliveredImage } from "../channels/types.js";
import type { ModelConversationMessage } from "../models/types.js";
import type { SavedContextCheckpoint } from "../models/context-manager.js";
import type { ConversationHistoryRequest, ConversationHistoryScope } from "./history.js";
import { type BackgroundDelivery, SQLiteMemoryStore } from "./store.js";
import type {
  AssistantReplyInput,
  ChatMessage,
  ConversationKind,
  Session,
  SessionContext,
  SessionFeedback,
  SessionImage,
  SessionMetadata,
  SessionTransition,
  TokenUsage,
  UserQuestionAnswer,
  UserTurnStart
} from "./types.js";

export class SessionManager {
  constructor(private readonly store: SQLiteMemoryStore, private readonly inactivityMs: number) {}

  close(): void {
    this.store.close();
  }

  getContextCheckpoints(sessionId: string) { return this.store.getContextCheckpoints(sessionId); }
  saveContextCheckpoints(sessionId: string, entries: SavedContextCheckpoint[]) { return this.store.saveContextCheckpoints(sessionId, entries); }

  async getOrCreateForQuery(
    userId: string,
    query: string,
    chatId: string,
    now = Date.now(),
    chatType: ConversationKind = "p2p"
  ): Promise<SessionTransition> {
    return this.store.getOrCreateSession(userId, chatId, query, this.inactivityMs, now, chatType);
  }

  async prepareUserTurn(
    userId: string,
    query: string,
    chatId: string,
    messageId: string,
    now = Date.now(),
    chatType: ConversationKind = "p2p"
  ): Promise<UserTurnStart | undefined> {
    return this.store.prepareUserTurn(userId, chatId, query, messageId, this.inactivityMs, now, chatType);
  }

  async lookupBackgroundDelivery(userId: string, chatId: string, deliveryId: string): Promise<BackgroundDelivery | undefined> {
    return this.store.lookupBackgroundDelivery(userId, chatId, deliveryId);
  }
  async prepareBackgroundSession(userId: string, chatId: string, sessionId: string, title: string): Promise<Session> {
    return this.store.prepareBackgroundSession(userId, chatId, sessionId, title);
  }
  async prepareBackgroundDelivery(userId: string, chatId: string, deliveryId: string, content: string, targetSessionId?: string): Promise<BackgroundDelivery> {
    return this.store.prepareBackgroundDelivery(userId, chatId, deliveryId, content, this.inactivityMs, Date.now(), targetSessionId);
  }
  async beginBackgroundAttempt(deliveryId: string): Promise<void> {
    return this.store.beginBackgroundAttempt(deliveryId);
  }
  async completeBackgroundDelivery(deliveryId: string, messageId: string): Promise<Session> {
    return this.store.completeBackgroundDelivery(deliveryId, messageId);
  }

  async markPending(sessionId: string, expectedLastActiveAt: number, now = Date.now()): Promise<SessionMetadata | undefined> {
    return this.store.markPendingIfInactive(sessionId, expectedLastActiveAt, this.inactivityMs, now);
  }

  async getActiveSessions(): Promise<SessionMetadata[]> {
    return this.store.getActiveSessions();
  }

  async appendUserMessage(
    sessionId: string,
    content: string,
    now = Date.now(),
    messageId?: string,
    senderUserId?: string
  ): Promise<ChatMessage> {
    return this.store.appendUserMessage(sessionId, content, now, messageId, senderUserId);
  }

  async appendAssistantMessage(input: AssistantReplyInput): Promise<SessionMetadata> {
    return this.store.appendAssistantMessage({ ...input, createdAt: input.createdAt ?? Date.now() });
  }

  async appendImageGenerationRecords(
    sessionId: string,
    turnId: number,
    records: readonly import("./types.js").ImageGenerationRecord[]
  ): Promise<void> {
    return this.store.appendImageGenerationRecords(sessionId, turnId, records);
  }

  async recordInputImageRefs(
    sessionId: string,
    turnId: number,
    refs: ReadonlyArray<NonNullable<ChatMessage["inputImageRefs"]>[number]>
  ): Promise<SessionImage[]> {
    return this.store.recordInputImageRefs(sessionId, turnId, refs);
  }

  async recordUserQuestionAnswers(sessionId: string, turnId: number, answers: readonly UserQuestionAnswer[]): Promise<void> {
    return this.store.recordUserQuestionAnswers(sessionId, turnId, answers);
  }

  async recordImageDeliveries(sessionId: string, turnId: number, deliveries: readonly DeliveredImage[]): Promise<void> {
    return this.store.recordImageDeliveries(sessionId, turnId, deliveries);
  }

  async reactivateImages(sessionId: string, imageIds: readonly string[], currentTurnId: number): Promise<SessionImage[]> {
    return this.store.reactivateImages(sessionId, imageIds, currentTurnId);
  }

  async appendCompressorMessage(
    sessionId: string,
    turnId: number,
    content: string,
    usage: TokenUsage,
    now = Date.now(),
    model?: string,
    contextOnly = false,
    modelIdentity?: import("./types.js").ModelUsageIdentity
  ): Promise<Session> {
    return this.store.appendCompressorMessage(sessionId, turnId, content, usage, now, model, contextOnly, modelIdentity);
  }

  async getContext(sessionId: string): Promise<SessionContext> {
    return this.store.getContextSession(sessionId);
  }

  async getMetadata(sessionId: string) {
    return this.store.getSessionMetadata(sessionId);
  }

  async get(sessionId: string): Promise<Session> {
    return this.store.getSession(sessionId);
  }

  getRecentUserRequests(sessionId: string, throughTurn: number) {
    return this.store.getRecentUserRequests(sessionId, throughTurn);
  }

  async branch(userId: string, sourceId: string, messageId: string, chatId: string, messageIds: Record<string, string>): Promise<Session> {
    return this.store.branchSession(userId, sourceId, messageId, chatId, messageIds);
  }

  async rewind(userId: string, sessionId: string, fromTurn: number): Promise<void> {
    return this.store.rewindSession(userId, sessionId, fromTurn);
  }

  async resumePrevious(chatId: string, sessionId: string, now = Date.now()): Promise<SessionMetadata> {
    return this.store.resumeSession(chatId, sessionId, now);
  }

  async closeCurrent(chatId: string, actorUserId?: string): Promise<Session | undefined> {
    return this.store.closeCurrentSession(chatId, actorUserId);
  }

  async startNew(userId: string, chatId: string, chatType: ConversationKind = "p2p"): Promise<SessionTransition> {
    return this.store.startNewSession(userId, chatId, Date.now(), chatType);
  }

  async recordFeedback(
    chatId: string,
    userId: string,
    sessionId: string,
    rating: SessionFeedback["rating"]
  ): Promise<SessionFeedback> {
    return this.store.recordFeedback(chatId, userId, sessionId, rating);
  }

  async deleteSession(chatId: string, sessionId: string, actorUserId?: string): Promise<void> {
    return this.store.deleteSession(chatId, sessionId, actorUserId);
  }

  async getSessionsForUser(userId: string): Promise<Session[]> {
    return this.store.getSessionsForUser(userId);
  }

  async queryConversationHistory(scope: ConversationHistoryScope, request: ConversationHistoryRequest) {
    return this.store.queryConversationHistory(scope, request);
  }

  async recentPrivateConversation(userId: string, chatId: string): Promise<ModelConversationMessage[]> {
    return this.store.recentPrivateConversation(userId, chatId);
  }
}
