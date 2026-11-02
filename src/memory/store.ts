import { prepareSql, closeSqlite, sqliteTransaction } from "../sqlite.js";
import { BackgroundDeliveryUncertainError } from "../channels/background-delivery.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelConversationMessage } from "../models/types.js";
import { isSearchEvidence } from "../models/search-evidence.js";
import type { AgentActivityItem } from "../agent/transcript.js";
import type { DeliveredImage } from "../channels/types.js";
import type {
  AssistantReplyInput,
  ChatMessage,
  ChatRole,
  ConversationKind,
  ImageGenerationUsage,
  ImageGenerationRecord,
  ModelUsageIdentity,
  Session,
  SessionMetadata,
  SessionContext,
  SessionFeedback,
  SessionStatus,
  SessionTransition,
  TokenUsage,
  UserTurnStart,
  UserQuestionAnswer,
  VideoGenerationRecord
} from "./types.js";
import { SessionPermissionError } from "./types.js";
import type { SessionImage } from "./types.js";
import { renderUserMessageContent } from "./transcript.js";
import type { SavedContextCheckpoint } from "../models/context-manager.js";
import { isContextEvidence } from "../models/context-evidence.js";
import { queryConversationHistory, type ConversationHistoryRequest, type ConversationHistoryScope } from "./history.js";
import { initializeHistorySearch, closeHistorySearch } from "./history-search.js";

export type BackgroundDelivery = {
  session: Session;
  status: "pending" | "attempted" | "delivered" | "uncertain";
  content: string;
  attemptCount: number;
  firstAttemptAt?: number;
  messageId?: string;
};
type BackgroundDeliveryRow = {
  user_id: string; chat_id: string; session_id: string; message_id: string | null;
  status: BackgroundDelivery["status"]; content: string; attempt_count: number; first_attempt_at: number | null;
};

type SessionRow = {
  session_id: string;
  user_id: string;
  chat_id: string;
  chat_type: ConversationKind | null;
  initial_user_preview: string;
  status: SessionStatus;
  created_at: number;
  last_active_at: number;
  feedback_rating: SessionFeedback["rating"] | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_input_tokens: number;
};

type MessageRow = {
  id: string;
  message_id: string | null;
  session_id: string;
  turn_id: number;
  role: ChatRole;
  content: string;
  sender_user_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  cache_hit_tokens_reported: number;
  model_id: string | null;
  model_name: string | null;
  model_brand: string | null;
  model_supplier: string | null;
  model_cost_multiplier: number | null;
  tool_trace_json: string | null;
  activity_trace_json: string | null;
  input_image_refs_json: string | null;
  question_answers_json: string | null;
  created_at: number;
};

type SessionFeedbackRow = {
  user_id: string;
  rating: SessionFeedback["rating"];
};

type ImageGenerationRow = {
  generation_id: string;
  session_id: string;
  turn_id: number;
  model_id: string;
  model_supplier: string | null;
  model_cost_multiplier: number | null;
  input_tokens: number;
  billing_details_json?: string | null;
  input_text_tokens: number;
  input_image_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  output_text_tokens: number;
  output_image_tokens: number;
  estimated: number;
  experiment_id: string | null;
  variant: ImageGenerationRecord["variant"] | null;
  ordinal: number | null;
  input_prompt: string | null;
  revised_prompt: string | null;
  size: string | null;
  quality: string | null;
  input_fidelity: ImageGenerationRecord["inputFidelity"] | null;
  status: ImageGenerationRecord["status"] | null;
  error: string | null;
  image_sha256: string | null;
  created_at: number;
};

type MessageImageRow = {
  image_id: string;
  message_id: string;
  session_id: string;
  turn_id: number;
  ordinal: number;
  generation_id: string | null;
  source_provider: "web";
  source_message_id: string;
  source_image_key: string;
  description: string | null;
  description_model: string | null;
  hot_through_completion: number;
  mime_type: string | null;
  sha256: string | null;
  created_at: number;
};

type VideoGenerationRow = {
  generation_id: string;
  session_id: string;
  turn_id: number;
  record_json: string;
  created_at: number;
};

const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS agent_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    agent_id TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    chat_type TEXT NOT NULL DEFAULT 'p2p' CHECK (chat_type IN ('p2p', 'group')),
    initial_user_preview TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'closed')),
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    feedback_rating TEXT CHECK (
      feedback_rating IS NULL OR feedback_rating IN ('satisfied', 'dissatisfied')
    ),
    total_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_input_tokens >= 0),
    total_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_output_tokens >= 0),
    total_cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_cached_input_tokens >= 0)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_last_active
    ON sessions (user_id, last_active_at DESC);

  CREATE INDEX IF NOT EXISTS idx_sessions_chat_last_active
    ON sessions (chat_id, last_active_at DESC);

  CREATE INDEX IF NOT EXISTS idx_sessions_feedback
    ON sessions (feedback_rating);

  CREATE TABLE IF NOT EXISTS session_feedback (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('satisfied', 'dissatisfied')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL CHECK (turn_id > 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'compressor')),
    content TEXT NOT NULL,
    sender_user_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
    cache_hit_tokens_reported INTEGER NOT NULL DEFAULT 0 CHECK (cache_hit_tokens_reported IN (0, 1)),
    model_id TEXT,
    model_name TEXT,
    model_brand TEXT,
    model_supplier TEXT,
    model_cost_multiplier REAL,
    tool_trace_json TEXT,
    activity_trace_json TEXT,
    input_image_refs_json TEXT,
    question_answers_json TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, turn_id, role)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_turn
    ON messages (session_id, turn_id, created_at);

  CREATE TABLE IF NOT EXISTS context_checkpoints (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    model_name TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, model_name)
  );

  CREATE TABLE IF NOT EXISTS session_rewinds (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    through_turn INTEGER NOT NULL,
    usage_json TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS background_deliveries (
    delivery_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT,
    status TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    first_attempt_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS message_images (
    image_id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL CHECK (turn_id > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    generation_id TEXT REFERENCES image_generations(generation_id) ON DELETE SET NULL,
    source_provider TEXT NOT NULL CHECK (source_provider = 'web'),
    source_message_id TEXT NOT NULL,
    source_image_key TEXT NOT NULL,
    description TEXT,
    description_model TEXT,
    hot_through_completion INTEGER NOT NULL CHECK (hot_through_completion >= 0),
    mime_type TEXT,
    sha256 TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, ordinal),
    UNIQUE (generation_id),
    UNIQUE (session_id, source_provider, source_message_id, source_image_key)
  );

  CREATE INDEX IF NOT EXISTS idx_message_images_session_turn
    ON message_images (session_id, turn_id, ordinal);

  CREATE TABLE IF NOT EXISTS image_generations (
    generation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL CHECK (turn_id > 0),
    model_id TEXT NOT NULL,
    model_supplier TEXT,
    model_cost_multiplier REAL,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    input_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_text_tokens >= 0),
    input_image_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_image_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    output_text_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_text_tokens >= 0),
    output_image_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_image_tokens >= 0),
    estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
    experiment_id TEXT,
    variant TEXT CHECK (variant IS NULL OR variant IN ('raw_user_prompt', 'art_directed_rewrite')),
    ordinal INTEGER CHECK (ordinal IS NULL OR ordinal IN (1, 2)),
    input_prompt TEXT,
    revised_prompt TEXT,
    size TEXT,
    quality TEXT,
    input_fidelity TEXT CHECK (input_fidelity IS NULL OR input_fidelity IN ('high', 'low')),
    status TEXT CHECK (status IS NULL OR status IN ('success', 'failed')),
    error TEXT,
    image_sha256 TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_image_generations_session_turn
    ON image_generations (session_id, turn_id, created_at);

  CREATE TABLE IF NOT EXISTS video_generations (
    generation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL CHECK (turn_id > 0),
    record_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_video_generations_session_turn
    ON video_generations (session_id, turn_id, created_at);
`;

function preview(text: string): string {
  return Array.from(text.trim()).slice(0, 15).join("");
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

function parseToolTrace(value: string | null): ModelConversationMessage[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const valid = parsed.every((message) => {
      if (!message || typeof message !== "object" || !("role" in message)) return false;
      const item = message as Record<string, unknown>;
      if (item.role === "tool") {
        return typeof item.toolCallId === "string"
          && typeof item.value === "string"
          && typeof item.failed === "boolean";
      }
      if (item.role !== "assistant" || typeof item.text !== "string" || !Array.isArray(item.toolCalls)) return false;
      if (item.searchEvidence !== undefined && !isSearchEvidence(item.searchEvidence)) return false;
      return item.toolCalls.every((call) => Boolean(call) && typeof call === "object"
        && typeof (call as Record<string, unknown>).id === "string"
        && typeof (call as Record<string, unknown>).name === "string"
        && typeof (call as Record<string, unknown>).arguments === "string");
    });
    return valid ? parsed as ModelConversationMessage[] : undefined;
  } catch {
    return undefined;
  }
}

function parseActivityTrace(value: string | null): AgentActivityItem[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as AgentActivityItem[] : undefined;
  } catch {
    return undefined;
  }
}

function parseInputImageRefs(value: string | null): ChatMessage["inputImageRefs"] {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as NonNullable<ChatMessage["inputImageRefs"]> : undefined;
  } catch {
    return undefined;
  }
}

function parseQuestionAnswers(value: string | null): UserQuestionAnswer[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(answer => answer && typeof answer === "object"
      && typeof answer.question === "string" && Array.isArray(answer.selectedOptionIds)
      && answer.selectedOptionIds.every((id: unknown) => typeof id === "string")
      && Array.isArray(answer.selectedOptions) && answer.selectedOptions.every((label: unknown) => typeof label === "string")
      && (answer.text === undefined || typeof answer.text === "string"))) return;
    return parsed as UserQuestionAnswer[];
  } catch { return undefined; }
}

export class SQLiteMemoryStore {
  private database?: DatabaseSync;

  constructor(
    private readonly filePath: string,
    private readonly agentId: string
  ) {}

  async initialize(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.database = new DatabaseSync(this.filePath);
    this.database.exec(schema);
    this.claimOrVerifyOwnership();
    this.migrateSchema();
    initializeHistorySearch(this.database);
  }

  close(): void {
    if (this.database) closeHistorySearch(this.database);
    if (this.database) closeSqlite(this.database);
    this.database = undefined;
  }

  private claimOrVerifyOwnership(): void {
    const row = prepareSql(this.db(), "SELECT agent_id FROM agent_metadata WHERE singleton = 1").get() as
      | { agent_id: string }
      | undefined;
    if (row && row.agent_id !== this.agentId) {
      if (this.database) closeSqlite(this.database);
      this.database = undefined;
      throw new Error(`SQLite memory belongs to agent ${row.agent_id}; ${this.agentId} cannot open it`);
    }
    if (!row) {
      prepareSql(this.db(), "INSERT INTO agent_metadata (singleton, agent_id) VALUES (1, ?)").run(this.agentId);
    }
  }

  async lookupBackgroundDelivery(userId: string, chatId: string, deliveryId: string): Promise<BackgroundDelivery | undefined> {
    const row = prepareSql(this.db(), "SELECT * FROM background_deliveries WHERE delivery_id=?")
      .get(deliveryId) as BackgroundDeliveryRow | undefined;
    if (!row) return undefined;
    if (row.user_id !== userId || row.chat_id !== chatId) throw new Error("Background delivery scope mismatch");
    return {
      session: this.loadSession(row.session_id),
      status: row.status,
      messageId: row.message_id ?? undefined,
      content: row.content,
      attemptCount: row.attempt_count,
      firstAttemptAt: row.first_attempt_at ?? undefined
    };
  }

  /** Reserve a stable, empty task session without closing or resuming the originating chat. */
  async prepareBackgroundSession(userId: string, chatId: string, sessionId: string, title: string, now = Date.now()): Promise<Session> {
    return this.transaction(() => {
      const existing = this.sessionRow(sessionId);
      if (existing) {
        if (existing.user_id !== userId || existing.chat_id !== chatId || existing.chat_type !== "p2p")
          throw new Error("Background session ownership mismatch");
      } else {
        prepareSql(this.db(), `INSERT INTO sessions
          (session_id,user_id,chat_id,chat_type,initial_user_preview,status,created_at,last_active_at)
          VALUES (?,?,?,'p2p',?,'active',?,?)`).run(sessionId, userId, chatId, preview(title), now, now);
      }
      return this.loadSession(sessionId);
    });
  }

  /** Reserve the original ordinary session and immutable message before an external send. */
  async prepareBackgroundDelivery(
    userId: string, chatId: string, deliveryId: string, content: string,
    inactivityMs: number, now = Date.now(), targetSessionId?: string
  ): Promise<BackgroundDelivery> {
    const existing = await this.lookupBackgroundDelivery(userId, chatId, deliveryId);
    if (existing) return existing;
    return this.transaction(() => {
      const current = this.currentSessionRow(chatId);
      if (current && (current.user_id !== userId || current.chat_type !== "p2p")) {
        throw new Error("Background delivery requires the owner private conversation");
      }
      const target = targetSessionId ? this.sessionRow(targetSessionId) : undefined;
      if (targetSessionId && (!target || target.user_id !== userId || target.chat_id !== chatId || target.chat_type !== "p2p")) throw new Error("Background target session is unavailable");
      const sessionId = target?.session_id ?? this.getOrCreateSessionInTransaction(
        userId, chatId, "主动任务", inactivityMs, now, "p2p"
      ).session.id;
      const session = this.loadSession(sessionId);
      prepareSql(this.db(), `
        INSERT INTO background_deliveries (delivery_id, user_id, chat_id, session_id, status, content)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `).run(deliveryId, userId, chatId, session.id, content);
      return { session, status: "pending", content, attemptCount: 0 };
    });
  }

  async beginBackgroundAttempt(deliveryId: string, now = Date.now()): Promise<void> {
    const uncertain = this.transaction(() => {
      const row = prepareSql(this.db(), "SELECT * FROM background_deliveries WHERE delivery_id=?")
        .get(deliveryId) as BackgroundDeliveryRow | undefined;
      if (!row) throw new Error("Background delivery was not reserved");
      if (row.status === "delivered") return false;
      if (row.status === "uncertain" || row.attempt_count >= 3 ||
          row.first_attempt_at !== null && now - row.first_attempt_at > 5 * 60_000) {
        prepareSql(this.db(), "UPDATE background_deliveries SET status='uncertain' WHERE delivery_id=?").run(deliveryId);
        return true;
      }
      prepareSql(this.db(), `UPDATE background_deliveries SET status='attempted',
        attempt_count=attempt_count+1, first_attempt_at=COALESCE(first_attempt_at,?) WHERE delivery_id=?`)
        .run(now, deliveryId);
      return false;
    });
    if (uncertain) throw new BackgroundDeliveryUncertainError();
  }

  async completeBackgroundDelivery(
    deliveryId: string, messageId: string, now = Date.now()
  ): Promise<Session> {
    return this.transaction(() => {
      const link = prepareSql(this.db(), "SELECT * FROM background_deliveries WHERE delivery_id=?")
        .get(deliveryId) as BackgroundDeliveryRow | undefined;
      if (!link) throw new Error("Background delivery was not reserved");
      if (link.status === "delivered") return this.loadSession(link.session_id);
      const next = prepareSql(this.db(), "SELECT COALESCE(MAX(turn_id),0)+1 AS n FROM messages WHERE session_id=?")
        .get(link.session_id) as { n: number };
      this.insertMessage(link.session_id, next.n, "assistant", link.content, emptyUsage(), now, messageId);
      prepareSql(this.db(), "UPDATE sessions SET last_active_at=? WHERE session_id=?").run(now, link.session_id);
      prepareSql(this.db(), "UPDATE background_deliveries SET status='delivered', message_id=? WHERE delivery_id=?")
        .run(messageId, deliveryId);
      return this.loadSession(link.session_id);
    });
  }

  async getOrCreateSession(
    userId: string,
    chatId: string,
    firstQuery: string,
    inactivityMs: number,
    now: number,
    chatType: ConversationKind = "p2p"
  ): Promise<SessionTransition> {
    return this.transaction(() => this.getOrCreateSessionInTransaction(
      userId,
      chatId,
      firstQuery,
      inactivityMs,
      now,
      chatType
    ));
  }

  async prepareUserTurn(
    userId: string,
    chatId: string,
    content: string,
    messageId: string,
    inactivityMs: number,
    now: number,
    chatType: ConversationKind = "p2p"
  ): Promise<UserTurnStart | undefined> {
    return this.transaction(() => {
      const duplicate = prepareSql(this.db(), "SELECT 1 FROM messages WHERE message_id = ? LIMIT 1").get(messageId);
      if (duplicate) return undefined;

      const transition = this.getOrCreateSessionInTransaction(userId, chatId, content, inactivityMs, now, chatType);
      const currentMessage = this.appendUserMessageInTransaction(
        transition.session.id,
        content,
        now,
        messageId,
        userId
      );
      return { transition, currentMessage };
    });
  }

  /** Create an empty session immediately, without inventing a model/user turn. */
  async startNewSession(userId: string, chatId: string, now: number, chatType: ConversationKind = "p2p"): Promise<SessionTransition> {
    return this.transaction(() => {
      const current = this.currentSessionRow(chatId);
      if (current) {
        this.assertCanManageSession(current, userId);
        prepareSql(this.db(), "UPDATE sessions SET status = 'closed' WHERE session_id = ?").run(current.session_id);
      }
      const transition = this.getOrCreateSessionInTransaction(userId, chatId, "", 0, now, chatType);
      return { ...transition, previousSession: current ? this.loadSessionMetadata(current.session_id) : undefined };
    });
  }

  async markPendingIfInactive(
    sessionId: string,
    expectedLastActiveAt: number,
    inactivityMs: number,
    now: number
  ): Promise<SessionMetadata | undefined> {
    return this.transaction(() => {
      const row = this.sessionRow(sessionId);
      if (
        !row
        || row.status !== "active"
        || row.last_active_at !== expectedLastActiveAt
        || now - row.last_active_at < inactivityMs
      ) {
        return undefined;
      }
      prepareSql(this.db(), "UPDATE sessions SET status = 'pending' WHERE session_id = ?").run(sessionId);
      return this.loadSessionMetadata(sessionId);
    });
  }

  async getActiveSessions(): Promise<SessionMetadata[]> {
    await this.initialize();
    const rows = prepareSql(this.db(), "SELECT * FROM sessions WHERE status = 'active'").all() as unknown as SessionRow[];
    return rows.map((row) => this.loadSessionMetadata(row.session_id));
  }

  async appendUserMessage(
    sessionId: string,
    content: string,
    now: number,
    messageId?: string,
    senderUserId?: string
  ): Promise<ChatMessage> {
    return this.transaction(() => this.appendUserMessageInTransaction(sessionId, content, now, messageId, senderUserId));
  }

  async recordInputImageRefs(
    sessionId: string,
    turnId: number,
    refs: ReadonlyArray<NonNullable<ChatMessage["inputImageRefs"]>[number]>
  ): Promise<SessionImage[]> {
    if (refs.some(ref => ref.provider !== "web")) throw new Error("Unsupported image source");
    const refsJson = JSON.stringify(refs);
    return this.transaction(() => {
      const result = prepareSql(this.db(), `
        UPDATE messages SET input_image_refs_json = ?
        WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'user'
      `).run(refsJson, sessionId, turnId);
      if (result.changes !== 1) throw new Error(`User message for turn ${turnId} does not exist`);
      const message = prepareSql(this.db(), `SELECT id, created_at FROM messages
        WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'user'`).get(sessionId, turnId) as { id: string; created_at: number };
      const completed = this.completedTurnCount(sessionId);
      refs.forEach((ref, index) => this.insertMessageImage(
        message.id, sessionId, turnId, index + 1, ref, completed + 1, message.created_at
      ));
      return (prepareSql(this.db(), `SELECT * FROM message_images WHERE message_id = ? ORDER BY ordinal`)
        .all(message.id) as unknown as MessageImageRow[]).map(row => this.mapMessageImage(row));
    });
  }

  async recordUserQuestionAnswers(sessionId: string, turnId: number, answers: readonly UserQuestionAnswer[]): Promise<void> {
    return this.transaction(() => {
      const previous = prepareSql(this.db(), `SELECT question_answers_json FROM messages
        WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'user'`).get(sessionId, turnId) as
        { question_answers_json: string | null } | undefined;
      if (!previous) throw new Error("User question answers require an existing user turn");
      prepareSql(this.db(), `UPDATE messages SET question_answers_json = ?
        WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'user'`)
        .run(JSON.stringify([...(parseQuestionAnswers(previous.question_answers_json) ?? []), ...answers]), sessionId, turnId);
    });
  }

  async recordImageDeliveries(
    sessionId: string,
    turnId: number,
    deliveries: readonly DeliveredImage[]
  ): Promise<void> {
    return this.transaction(() => {
      for (const delivery of deliveries) {
        if (delivery.provider !== "web") throw new Error("Unsupported image delivery source");
        if (!delivery.generationId) throw new Error(`Image delivery for turn ${turnId} has no generation ID`);
        const generation = prepareSql(this.db(), `SELECT generation_id FROM image_generations
          WHERE generation_id = ? AND session_id = ? AND turn_id = ? AND status = 'success'`)
          .get(delivery.generationId, sessionId, turnId) as { generation_id: string } | undefined;
        if (!generation) throw new Error(`Image delivery for turn ${turnId} did not match generation ${delivery.generationId}`);
        const message = prepareSql(this.db(), `SELECT id, created_at FROM messages
          WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'assistant'`).get(sessionId, turnId) as { id: string; created_at: number };
        this.insertMessageImage(
          message.id,
          sessionId,
          turnId,
          deliveries.indexOf(delivery) + 1,
          { provider: delivery.provider, messageId: delivery.messageId, imageKey: delivery.imageKey },
          this.completedTurnCount(sessionId),
          message.created_at,
          delivery.sha256,
          generation.generation_id
        );
      }
    });
  }

  async reactivateImages(sessionId: string, imageIds: readonly string[], currentTurnId: number): Promise<SessionImage[]> {
    return this.transaction(() => {
      const completed = this.completedTurnCount(sessionId);
      const rows: MessageImageRow[] = [];
      for (const imageId of imageIds) {
        const row = prepareSql(this.db(), `SELECT * FROM message_images WHERE image_id = ? AND session_id = ?
          AND EXISTS (SELECT 1 FROM messages m WHERE m.id=message_images.message_id AND m.deleted_at IS NULL)`)
          .get(imageId, sessionId) as unknown as MessageImageRow | undefined;
        if (!row) throw new Error(`Session image ${imageId} is not available`);
        prepareSql(this.db(), `UPDATE message_images SET hot_through_completion = ? WHERE image_id = ?`)
          .run(completed + 1, imageId);
        rows.push({ ...row, hot_through_completion: completed + 1, turn_id: currentTurnId || row.turn_id });
      }
      return rows.map((row) => this.mapMessageImage(row));
    });
  }

  async appendAssistantMessage(input: AssistantReplyInput & { createdAt: number }): Promise<SessionMetadata> {
    const { sessionId, turnId, content, usage, createdAt: now, model, imageUsages, modelIdentity,
      toolTrace, activityTrace, videoUsages } = input;
    const serializedTraces = {
      tool: toolTrace?.length ? JSON.stringify(toolTrace) : null,
      activity: activityTrace?.length ? JSON.stringify(activityTrace) : null
    };
    return this.transaction(() => {
      this.updateUserUsage(sessionId, turnId, usage, model, modelIdentity);
      this.insertMessage(sessionId, turnId, "assistant", content, {
        inputTokens: 0,
        outputTokens: usage.outputTokens,
        cachedInputTokens: 0,
        cacheHitTokensReported: usage.cacheHitTokensReported
      }, now, undefined, model, modelIdentity, toolTrace, activityTrace, undefined, serializedTraces);
      for (const imageUsage of imageUsages ?? []) {
        this.insertImageGeneration(sessionId, turnId, imageUsage, now);
      }
      for (const videoUsage of videoUsages ?? []) this.insertVideoGeneration(sessionId, turnId, videoUsage, now);
      this.addSessionUsage(sessionId, usage);
      prepareSql(this.db(), "UPDATE sessions SET last_active_at = ? WHERE session_id = ?").run(now, sessionId);
      return this.loadSessionMetadata(sessionId);
    });
  }

  async appendCompressorMessage(
    sessionId: string,
    turnId: number,
    content: string,
    usage: TokenUsage,
    now: number,
    model?: string,
    contextOnly = false,
    modelIdentity?: ModelUsageIdentity
  ): Promise<Session> {
    return this.transaction(() => {
      this.insertMessage(sessionId, turnId, "compressor", content, usage, now, undefined, model, modelIdentity);
      this.addSessionUsage(sessionId, usage);
      return this.loadSession(sessionId, contextOnly);
    });
  }

  async getSession(sessionId: string): Promise<Session> {
    await this.initialize();
    return this.loadSession(sessionId);
  }

  async getRecentUserRequests(sessionId: string, throughTurn: number): Promise<Array<{ turnId: number; content: string; createdAt: number }>> {
    await this.initialize();
    const rows = prepareSql(this.db(), `SELECT turn_id, content, created_at FROM messages
      WHERE deleted_at IS NULL AND session_id = ? AND role = 'user' AND turn_id <= ?
      ORDER BY turn_id DESC, created_at DESC, rowid DESC LIMIT 6`).all(sessionId, throughTurn) as
      Array<{ turn_id: number; content: string; created_at: number }>;
    return rows.reverse().map(row => ({ turnId: Number(row.turn_id), content: row.content, createdAt: Number(row.created_at) }));
  }

  async getContextCheckpoints(sessionId: string): Promise<SavedContextCheckpoint[]> {
    await this.initialize();
    const rows = prepareSql(this.db(), "SELECT model_name,payload_json FROM context_checkpoints WHERE session_id=?")
      .all(sessionId) as { model_name: string; payload_json: string }[];
    return rows.flatMap(row => {
      try {
        const checkpoint = JSON.parse(row.payload_json) as SavedContextCheckpoint["checkpoint"];
        if (!checkpoint || !Array.isArray(checkpoint.hashes) || !checkpoint.hashes.length
          || !checkpoint.hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
          || typeof checkpoint.promptHash !== "string" || typeof checkpoint.binding !== "string"
          || !Array.isArray(checkpoint.anchors) || checkpoint.anchors.some(message => message.role !== "user" || message.images?.length)
          || typeof checkpoint.summary !== "string" && !Array.isArray(checkpoint.native)) return [];
        if (checkpoint.evidence !== undefined && !isContextEvidence(checkpoint.evidence)) return [];
        if (checkpoint.generation !== undefined && (!Number.isSafeInteger(checkpoint.generation) || checkpoint.generation < 1)) return [];
        if (checkpoint.stats !== undefined && (!checkpoint.stats
          || ![checkpoint.stats.createdAt, checkpoint.stats.before, checkpoint.stats.after, checkpoint.stats.durationMs,
            checkpoint.stats.generation].every(value => Number.isSafeInteger(value) && value >= 0)
          || !["threshold", "overflow", "source_rebuild"].includes(checkpoint.stats.reason)
          || !["summary", "openai-native", "anthropic-native", "runtime"].includes(checkpoint.stats.strategy))) return [];
        return [{ model: row.model_name, checkpoint }];
      } catch { return []; }
    });
  }

  async saveContextCheckpoints(sessionId: string, entries: SavedContextCheckpoint[]): Promise<void> {
    await this.initialize();
    return this.transaction(() => {
      if (!this.sessionRow(sessionId)) throw new Error("Context checkpoint session no longer exists");
      prepareSql(this.db(), "DELETE FROM context_checkpoints WHERE session_id=?").run(sessionId);
      for (const entry of entries) {
        const json = JSON.stringify(entry.checkpoint);
        if (Buffer.byteLength(json) > 10 * 1024 * 1024) continue;
        prepareSql(this.db(), "INSERT INTO context_checkpoints(session_id,model_name,payload_json,updated_at) VALUES (?,?,?,?)")
          .run(sessionId, entry.model, json, Date.now());
      }
    });
  }

  /** Rewind the same private session. The caller durably reserves this boundary before retrying. */
  async rewindSession(userId: string, sessionId: string, fromTurn: number): Promise<void> {
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (!session || session.user_id !== userId || session.chat_type !== "p2p" || !Number.isSafeInteger(fromTurn) || fromTurn < 1) {
        throw new Error("Rewind unavailable");
      }
      prepareSql(this.db(), "DELETE FROM context_checkpoints WHERE session_id=?").run(sessionId);
      // Retain discarded turns and their image/tool/activity records for private diagnostics.
      // Keep accumulated token and generation usage: those calls have already been billed.
      const prior = prepareSql(this.db(), "SELECT usage_json FROM session_rewinds WHERE session_id=?").get(sessionId) as { usage_json: string } | undefined;
      const rows = prepareSql(this.db(), "SELECT * FROM messages WHERE session_id=? AND turn_id>=? AND deleted_at IS NULL").all(sessionId,fromTurn) as unknown as MessageRow[];
      const usage = rows.map(row => {
        const { inputTokens, outputTokens, cachedInputTokens, cacheHitTokensReported, model, modelName, modelBrand, modelSupplier, modelCostMultiplier } = this.mapMessage(row);
        return { inputTokens, outputTokens, cachedInputTokens, cacheHitTokensReported, model, modelName, modelBrand, modelSupplier, modelCostMultiplier };
      });
      prepareSql(this.db(), `INSERT INTO session_rewinds(session_id,through_turn,usage_json) VALUES (?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET through_turn=MAX(through_turn,excluded.through_turn),usage_json=excluded.usage_json`)
        .run(sessionId,rows.reduce((max,row) => Math.max(max,row.turn_id),0),JSON.stringify([...(prior ? JSON.parse(prior.usage_json) : []),...usage]));
      prepareSql(this.db(), `UPDATE messages SET deleted_at=?, rewind_from_turn=?
        WHERE session_id=? AND turn_id>=? AND deleted_at IS NULL`).run(Date.now(), fromTurn, sessionId, fromTurn);
      const first = prepareSql(this.db(), "SELECT content FROM messages WHERE deleted_at IS NULL AND session_id=? AND role='user' ORDER BY turn_id LIMIT 1")
        .get(sessionId) as { content: string } | undefined;
      prepareSql(this.db(), "UPDATE sessions SET initial_user_preview=? WHERE session_id=?").run(first ? preview(first.content) : "", sessionId);
    });
  }

  /** Copy through a reply, or up to an editable prompt, without counting inherited usage twice. */
  async branchSession(userId: string, sourceId: string, messageId: string, chatId: string,
    messageIds: Record<string, string>, now = Date.now()): Promise<Session> {
    return this.transaction(() => {
      const source = this.sessionRow(sourceId);
      if (!source || source.user_id !== userId || source.chat_type !== "p2p" || this.currentSessionRow(chatId)) throw new Error("Branch unavailable");
      const boundary = prepareSql(this.db(), "SELECT turn_id,role FROM messages WHERE deleted_at IS NULL AND session_id=? AND id=? AND role IN ('user','assistant')")
        .get(sourceId, messageId) as { turn_id: number; role: "user" | "assistant" } | undefined;
      if (!boundary) throw new Error("Branch point unavailable");
      const through = boundary.turn_id - (boundary.role === "user" ? 1 : 0);
      const { session } = this.getOrCreateSessionInTransaction(userId, chatId, "", 0, now, "p2p");
      const rows = prepareSql(this.db(), "SELECT * FROM messages WHERE deleted_at IS NULL AND session_id=? AND turn_id<=? ORDER BY turn_id,created_at")
        .all(sourceId, through) as unknown as MessageRow[];
      for (const row of rows) {
        const id = randomUUID();
        prepareSql(this.db(), `INSERT INTO messages (id,message_id,session_id,turn_id,role,content,sender_user_id,
          model_id,model_name,model_brand,model_supplier,model_cost_multiplier,tool_trace_json,activity_trace_json,input_image_refs_json,question_answers_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,
            messageIds[row.message_id ?? ""] ?? messageIds[`history:${createHash("sha256").update(row.id).digest("hex")}`] ?? randomUUID(),
            session.id,row.turn_id,row.role,row.content,row.sender_user_id,row.model_id,row.model_name,row.model_brand,
            row.model_supplier,row.model_cost_multiplier,row.tool_trace_json,row.activity_trace_json,row.input_image_refs_json,row.question_answers_json,row.created_at);
        // Source image references remain valid; generation billing belongs to the source session.
        prepareSql(this.db(), `INSERT INTO message_images (image_id,message_id,session_id,turn_id,ordinal,source_provider,
          source_message_id,source_image_key,description,description_model,hot_through_completion,mime_type,sha256,created_at)
          SELECT lower(hex(randomblob(16))),?,?,turn_id,ordinal,source_provider,source_message_id,source_image_key,
            description,description_model,hot_through_completion,mime_type,sha256,created_at
          FROM message_images WHERE message_id=?`).run(id,session.id,row.id);
      }
      const first = rows.find(row => row.role === "user");
      prepareSql(this.db(), "UPDATE sessions SET initial_user_preview=? WHERE session_id=?").run(first ? preview(first.content) : "", session.id);
      return this.loadSession(session.id);
    });
  }

  async resumeSession(chatId: string, sessionId: string, now: number): Promise<SessionMetadata> {
    return this.transaction(() => {
      const target = this.sessionRow(sessionId);
      if (!target || target.chat_id !== chatId) throw new Error("The previous session is unavailable");

      const current = this.currentSessionRow(chatId);
      if (current && current.session_id !== target.session_id) {
        prepareSql(this.db(), "UPDATE sessions SET status = 'closed' WHERE session_id = ?").run(current.session_id);
      }
      prepareSql(this.db(), `
        UPDATE sessions SET status = 'active', last_active_at = ? WHERE session_id = ?
      `).run(now, target.session_id);
      return this.loadSessionMetadata(target.session_id);
    });
  }

  async closeCurrentSession(chatId: string, actorUserId?: string): Promise<Session | undefined> {
    return this.transaction(() => {
      const current = this.currentSessionRow(chatId);
      if (!current) return undefined;
      this.assertCanManageSession(current, actorUserId);
      prepareSql(this.db(), "UPDATE sessions SET status = 'closed' WHERE session_id = ?").run(current.session_id);
      return this.loadSession(current.session_id);
    });
  }

  async recordFeedback(
    chatId: string,
    userId: string,
    sessionId: string,
    rating: SessionFeedback["rating"]
  ): Promise<SessionFeedback> {
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (!session || session.chat_id !== chatId) throw new Error("The session is unavailable");
      const now = Date.now();
      prepareSql(this.db(), `
        INSERT INTO session_feedback (session_id, user_id, rating, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id, user_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
      `).run(sessionId, userId, rating, now, now);
      return { userId, rating };
    });
  }

  async deleteSession(chatId: string, sessionId: string, actorUserId?: string): Promise<void> {
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (!session || session.chat_id !== chatId) throw new Error("The session is unavailable");
      this.assertCanManageSession(session, actorUserId);
      prepareSql(this.db(), "DELETE FROM sessions WHERE session_id = ?").run(sessionId);
    });
  }

  async getSessionsForUser(userId: string): Promise<Session[]> {
    await this.initialize();
    const rows = prepareSql(this.db(), `
      SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active_at DESC
    `).all(userId) as unknown as SessionRow[];
    return rows.map((row) => this.loadSession(row.session_id));
  }

  async queryConversationHistory(scope: ConversationHistoryScope, request: ConversationHistoryRequest) {
    await this.initialize();
    return queryConversationHistory(this.db(), this.agentId, scope, request);
  }

  /** Bounded conversation continuity for an already-authorized task; no tool traces, assets or other chats. */
  async recentPrivateConversation(userId: string, chatId: string, now = Date.now()): Promise<ModelConversationMessage[]> {
    await this.initialize();
    const rows = prepareSql(this.db(), `SELECT m.role,substr(m.content,1,1000) AS content,m.question_answers_json FROM messages m
      JOIN sessions s ON s.session_id=m.session_id
      WHERE m.deleted_at IS NULL AND s.user_id=? AND s.chat_id=? AND s.chat_type='p2p' AND s.status IN ('active','pending') AND m.role IN ('user','assistant')
      AND m.created_at>=? AND m.created_at<=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 6`)
      .all(userId, chatId, now - 24 * 60 * 60 * 1000, now) as Array<{ role: "user" | "assistant"; content: string; question_answers_json: string | null }>;
    return rows.reverse().map(row => row.role === "user" ? { role: "user", text: renderUserMessageContent({
      content: row.content, questionAnswers: parseQuestionAnswers(row.question_answers_json)
    }).slice(0, 1000) }
      : { role: "assistant", text: row.content, toolCalls: [] });
  }

  private db(): DatabaseSync {
    if (!this.database) throw new Error("SQLite memory store is not initialized");
    return this.database;
  }

  private migrateSchema(): void {
    this.migrateSessionScope();
    const sessionColumns = prepareSql(this.db(), "PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "chat_type")) {
      // Existing rows predate group-awareness. Keep them unknown until a new
      // inbound message confirms whether the chat is p2p or group.
      this.db().exec("ALTER TABLE sessions ADD COLUMN chat_type TEXT");
    }
    this.db().exec(`
      CREATE TABLE IF NOT EXISTS session_feedback (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        rating TEXT NOT NULL CHECK (rating IN ('satisfied', 'dissatisfied')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, user_id)
      )
    `);
    this.db().exec(`
      INSERT OR IGNORE INTO session_feedback (session_id, user_id, rating, created_at, updated_at)
      SELECT session_id, user_id, feedback_rating, last_active_at, last_active_at
      FROM sessions WHERE feedback_rating IS NOT NULL
    `);
    const columns = prepareSql(this.db(), "PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    // Additive migration keeps message IDs, uniqueness constraints and image references intact.
    if (!columns.some(column => column.name === "deleted_at"))
      this.db().exec("ALTER TABLE messages ADD COLUMN deleted_at INTEGER");
    if (!columns.some(column => column.name === "rewind_from_turn"))
      this.db().exec("ALTER TABLE messages ADD COLUMN rewind_from_turn INTEGER");
    this.db().exec(`CREATE INDEX IF NOT EXISTS idx_messages_active_session_turn
      ON messages (session_id, turn_id, created_at) WHERE deleted_at IS NULL`);
    if (!columns.some((column) => column.name === "message_id")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN message_id TEXT");
    }
    if (!columns.some((column) => column.name === "cache_hit_tokens_reported")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN cache_hit_tokens_reported INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "model_id")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN model_id TEXT");
    }
    if (!columns.some((column) => column.name === "model_name")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN model_name TEXT");
    }
    if (!columns.some((column) => column.name === "model_brand")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN model_brand TEXT");
    }
    if (!columns.some((column) => column.name === "model_supplier")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN model_supplier TEXT");
    }
    if (!columns.some((column) => column.name === "model_cost_multiplier")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN model_cost_multiplier REAL");
    }
    if (!columns.some((column) => column.name === "tool_trace_json")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN tool_trace_json TEXT");
    }
    if (!columns.some((column) => column.name === "activity_trace_json")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN activity_trace_json TEXT");
    }
    if (!columns.some((column) => column.name === "input_image_refs_json")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN input_image_refs_json TEXT");
    }
    if (!columns.some((column) => column.name === "question_answers_json")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN question_answers_json TEXT");
    }
    if (!columns.some((column) => column.name === "sender_user_id")) {
      this.db().exec("ALTER TABLE messages ADD COLUMN sender_user_id TEXT");
    }
    const imageColumns = prepareSql(this.db(), "PRAGMA table_info(image_generations)").all() as Array<{ name: string }>;
    if (!imageColumns.some((column) => column.name === "model_supplier")) {
      this.db().exec("ALTER TABLE image_generations ADD COLUMN model_supplier TEXT");
    }
    if (!imageColumns.some((column) => column.name === "model_cost_multiplier")) {
      this.db().exec("ALTER TABLE image_generations ADD COLUMN model_cost_multiplier REAL");
    }
    const imageMigrations: ReadonlyArray<readonly [string, string]> = [
      ["experiment_id", "TEXT"], ["variant", "TEXT"], ["ordinal", "INTEGER"],
      ["input_prompt", "TEXT"], ["revised_prompt", "TEXT"], ["size", "TEXT"],
      ["quality", "TEXT"], ["input_fidelity", "TEXT"], ["status", "TEXT"], ["error", "TEXT"], ["image_sha256", "TEXT"],
      ["billing_details_json", "TEXT"]
    ];
    for (const [name, type] of imageMigrations) {
      if (!imageColumns.some((column) => column.name === name)) {
        this.db().exec(`ALTER TABLE image_generations ADD COLUMN ${name} ${type}`);
      }
    }
    this.db().exec(`
      CREATE INDEX IF NOT EXISTS idx_image_generations_experiment
      ON image_generations (experiment_id, ordinal)
    `);
    this.db().exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id
      ON messages (message_id)
      WHERE message_id IS NOT NULL
    `);
    const messageImageColumns = prepareSql(this.db(), "PRAGMA table_info(message_images)").all() as Array<{ name: string }>;
    if (!messageImageColumns.some((column) => column.name === "generation_id")) {
      this.db().exec("ALTER TABLE message_images ADD COLUMN generation_id TEXT REFERENCES image_generations(generation_id) ON DELETE SET NULL");
    }
    this.db().exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_message_images_generation
      ON message_images (generation_id)
      WHERE generation_id IS NOT NULL
    `);
  }

  private migrateSessionScope(): void {
    this.transaction(() => {
      this.db().exec("DROP INDEX IF EXISTS idx_sessions_one_current_per_user");
      prepareSql(this.db(), `
        UPDATE sessions AS older
        SET status = 'closed'
        WHERE older.status IN ('active', 'pending')
          AND EXISTS (
            SELECT 1
            FROM sessions AS newer
            WHERE newer.chat_id = older.chat_id
              AND newer.status IN ('active', 'pending')
              AND (
                newer.last_active_at > older.last_active_at
                OR (newer.last_active_at = older.last_active_at AND newer.created_at > older.created_at)
                OR (
                  newer.last_active_at = older.last_active_at
                  AND newer.created_at = older.created_at
                  AND newer.session_id > older.session_id
                )
              )
          )
      `).run();
      this.db().exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_one_current_per_chat
          ON sessions (chat_id)
          WHERE status IN ('active', 'pending')
      `);
    });
  }

  private transaction<T>(operation: () => T): T {
    return sqliteTransaction(this.db(), operation);
  }

  private currentSessionRow(chatId: string): SessionRow | undefined {
    return prepareSql(this.db(), `
      SELECT * FROM sessions WHERE chat_id = ? AND status IN ('active', 'pending') LIMIT 1
    `).get(chatId) as unknown as SessionRow | undefined;
  }

  private assertCanManageSession(session: SessionRow, actorUserId?: string): void {
    if (session.chat_type === "group" && session.user_id !== actorUserId) {
      throw new SessionPermissionError();
    }
  }

  private getOrCreateSessionInTransaction(
    userId: string,
    chatId: string,
    firstQuery: string,
    inactivityMs: number,
    now: number,
    chatType: ConversationKind
  ): SessionTransition {
    const current = this.currentSessionRow(chatId);
    if (current?.status === "active" && now - current.last_active_at < inactivityMs) {
      if (current.chat_type !== chatType) {
        prepareSql(this.db(), "UPDATE sessions SET chat_type = ? WHERE session_id = ?").run(chatType, current.session_id);
      }
      return {
        session: this.loadSessionMetadata(current.session_id),
        createdNew: false,
        shouldSendSessionEndedCard: false
      };
    }

    const shouldSendSessionEndedCard = current?.status === "active";
    if (current) {
      prepareSql(this.db(), "UPDATE sessions SET status = 'closed' WHERE session_id = ?").run(current.session_id);
    }

    const sessionId = randomUUID();
    prepareSql(this.db(), `
      INSERT INTO sessions (
        session_id, user_id, chat_id, chat_type, initial_user_preview, status, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(sessionId, userId, chatId, chatType, preview(firstQuery), now, now);

    return {
      session: this.loadSessionMetadata(sessionId),
      previousSession: current ? this.loadSessionMetadata(current.session_id) : undefined,
      createdNew: true,
      shouldSendSessionEndedCard
    };
  }

  private appendUserMessageInTransaction(
    sessionId: string,
    content: string,
    now: number,
    messageId?: string,
    senderUserId?: string
  ): ChatMessage {
    const session = this.sessionRow(sessionId);
    if (!session || session.status !== "active") throw new Error(`Active session ${sessionId} does not exist`);
    const next = prepareSql(this.db(), `
      SELECT MAX(COALESCE(MAX(turn_id), 0), COALESCE((SELECT through_turn FROM session_rewinds WHERE session_id=?),0)) + 1 AS turn_id
      FROM messages WHERE session_id = ?
    `).get(sessionId,sessionId) as { turn_id: number };
    const message = this.insertMessage(
      sessionId,
      Number(next.turn_id),
      "user",
      content,
      emptyUsage(),
      now,
      messageId,
      undefined,
      undefined,
      undefined,
      undefined,
      senderUserId ?? session.user_id
    );
    prepareSql(this.db(), `UPDATE sessions SET last_active_at = ?, initial_user_preview =
      CASE WHEN initial_user_preview = '' THEN ? ELSE initial_user_preview END WHERE session_id = ?`)
      .run(now, preview(content), sessionId);
    return message;
  }

  private sessionRow(sessionId: string): SessionRow | undefined {
    return prepareSql(this.db(), "SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as unknown as SessionRow | undefined;
  }

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata> {
    await this.initialize();
    return this.loadSessionMetadata(sessionId);
  }

  private loadSessionMetadata(sessionId: string): SessionMetadata {
    const row = this.sessionRow(sessionId);
    if (!row) throw new Error(`Session ${sessionId} does not exist`);
    return {
      id: row.session_id, userId: row.user_id, chatId: row.chat_id,
      chatType: row.chat_type === "p2p" || row.chat_type === "group" ? row.chat_type : "unknown",
      initialUserPreview: row.initial_user_preview, createdAt: Number(row.created_at),
      lastActiveAt: Number(row.last_active_at), status: row.status,
      totalInputTokens: Number(row.total_input_tokens), totalOutputTokens: Number(row.total_output_tokens),
      totalCachedInputTokens: Number(row.total_cached_input_tokens)
    };
  }

  /** Model input only: preserve old image positions, but never load their compressed text or audit payloads. */
  async getContextSession(sessionId: string): Promise<SessionContext> {
    await this.initialize();
    return this.loadSession(sessionId, true);
  }

  private loadSession(sessionId: string, contextOnly: true): SessionContext;
  private loadSession(sessionId: string, contextOnly?: boolean): Session;
  private loadSession(sessionId: string, contextOnly = false): Session {
    const row = this.sessionRow(sessionId);
    if (!row) throw new Error(`Session ${sessionId} does not exist`);
    const latestSummary = contextOnly ? prepareSql(this.db(), `SELECT * FROM messages
      WHERE deleted_at IS NULL AND session_id = ? AND role = 'compressor' ORDER BY turn_id DESC, created_at DESC LIMIT 1`)
      .get(sessionId) as MessageRow | undefined : undefined;
    const boundary = latestSummary?.turn_id ?? 1;
    const messageRows = prepareSql(this.db(), `
      SELECT ${contextOnly ? `id, message_id, session_id, turn_id, role,
        CASE WHEN turn_id >= ${Number(boundary)} THEN content ELSE '' END AS content,
        sender_user_id, input_tokens, output_tokens, cached_input_tokens, cache_hit_tokens_reported,
        model_id, model_name, model_brand, model_supplier, model_cost_multiplier,
        CASE WHEN turn_id >= ${Number(boundary)} THEN tool_trace_json ELSE NULL END AS tool_trace_json,
        CASE WHEN turn_id >= ${Number(boundary)} THEN (
          SELECT json_group_array(json(a.value)) FROM json_each(messages.activity_trace_json) a
          WHERE json_extract(a.value,'$.type')='tool' AND json_extract(a.value,'$.name')='web_search'
        ) ELSE NULL END AS activity_trace_json, input_image_refs_json,
        CASE WHEN turn_id >= ${Number(boundary)} THEN question_answers_json ELSE NULL END AS question_answers_json, created_at` : "*"} FROM messages
      WHERE deleted_at IS NULL AND session_id = ? ${contextOnly ? `AND (turn_id >= ${Number(boundary)} OR EXISTS
        (SELECT 1 FROM message_images WHERE message_images.message_id = messages.id))` : ""}
      ORDER BY turn_id, CASE role WHEN 'user' THEN 0 WHEN 'compressor' THEN 1 ELSE 2 END, created_at
    `).all(sessionId) as unknown as MessageRow[];
    const imageRows = prepareSql(this.db(), `SELECT * FROM message_images WHERE session_id = ?
      AND EXISTS (SELECT 1 FROM messages m WHERE m.id=message_images.message_id AND m.deleted_at IS NULL)
      ORDER BY turn_id, ordinal`).all(sessionId) as unknown as MessageImageRow[];
    const imagesByMessage = new Map<string, SessionImage[]>();
    for (const row of imageRows) {
      const entries = imagesByMessage.get(row.message_id) ?? [];
      entries.push(this.mapMessageImage(row));
      imagesByMessage.set(row.message_id, entries);
    }
    const chatType: ConversationKind = row.chat_type === "p2p" || row.chat_type === "group"
      ? row.chat_type
      : "unknown";
    const rawMessages = messageRows.map((message) => ({
      ...this.mapMessage(message),
      images: imagesByMessage.get(message.id)
    }));
    const participantLabels = new Map<string, string>();
    if (chatType === "group") {
      // Labels remain stable even when the first appearance is before the summary boundary.
      const participants = contextOnly ? prepareSql(this.db(), `SELECT sender_user_id AS senderUserId FROM messages
        WHERE deleted_at IS NULL AND session_id=? AND role='user' AND sender_user_id IS NOT NULL
        GROUP BY sender_user_id ORDER BY MIN(turn_id), MIN(created_at)`).all(sessionId) as {senderUserId: string}[] : rawMessages.filter(message => message.role === "user");
      for (const message of participants) {
        if (!message.senderUserId || participantLabels.has(message.senderUserId)) continue;
        participantLabels.set(message.senderUserId, `群成员 ${participantLabels.size + 1}`);
      }
    }
    const messages = rawMessages.map((message) => message.role === "user" && chatType === "group"
      ? {
          ...message,
          speakerLabel: message.senderUserId
            ? participantLabels.get(message.senderUserId)
            : "群成员（历史身份未知）"
        }
      : message);
    const imageUsages = contextOnly ? undefined : (prepareSql(this.db(), `
      SELECT * FROM image_generations
      WHERE session_id = ?
      ORDER BY turn_id, created_at, generation_id
    `).all(sessionId) as unknown as ImageGenerationRow[]).map((image) => this.mapImageGeneration(image));
    const videoUsages = contextOnly ? undefined : (prepareSql(this.db(), `SELECT * FROM video_generations WHERE session_id = ?
      ORDER BY turn_id, created_at, generation_id`).all(sessionId) as unknown as VideoGenerationRow[])
      .flatMap((video) => this.mapVideoGeneration(video));
    const summaryMessage = latestSummary ? this.mapMessage(latestSummary) : [...messages].reverse().find((message) => message.role === "compressor");
    const rewound = contextOnly ? undefined : prepareSql(this.db(), "SELECT usage_json FROM session_rewinds WHERE session_id=?").get(sessionId) as { usage_json: string } | undefined;
    const feedbacks = contextOnly ? [] : (prepareSql(this.db(), `SELECT user_id, rating FROM session_feedback
      WHERE session_id = ? ORDER BY updated_at, user_id`).all(sessionId) as unknown as SessionFeedbackRow[])
      .map((feedback) => ({ userId: feedback.user_id, rating: feedback.rating }));
    return {
      id: row.session_id,
      userId: row.user_id,
      chatId: row.chat_id,
      chatType,
      initialUserPreview: row.initial_user_preview,
      createdAt: Number(row.created_at),
      lastActiveAt: Number(row.last_active_at),
      status: row.status,
      messages,
      ...(contextOnly ? { readScope: "model-context", completedTurns: this.completedTurnCount(sessionId) } : {}),
      summary: summaryMessage
        ? { content: summaryMessage.content, updatedAt: summaryMessage.createdAt, turnId: summaryMessage.turnId }
        : undefined,
      feedback: contextOnly ? undefined : feedbacks[0] ?? (row.feedback_rating ? { rating: row.feedback_rating } : undefined),
      feedbacks,
      totalInputTokens: Number(row.total_input_tokens),
      totalOutputTokens: Number(row.total_output_tokens),
      totalCachedInputTokens: Number(row.total_cached_input_tokens),
      ...(rewound ? { rewoundUsage: JSON.parse(rewound.usage_json) as Session["rewoundUsage"] } : {}),
      imageUsages,
      videoUsages
    };
  }

  private mapMessage(row: MessageRow): ChatMessage {
    return {
      id: row.id,
      messageId: row.message_id ?? undefined,
      turnId: Number(row.turn_id),
      role: row.role,
      content: row.content,
      senderUserId: row.sender_user_id ?? undefined,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      cacheHitTokensReported: Boolean(row.cache_hit_tokens_reported),
      model: row.model_id ?? undefined,
      modelName: row.model_name ?? undefined,
      modelBrand: row.model_brand ?? undefined,
      modelSupplier: row.model_supplier ?? undefined,
      modelCostMultiplier: row.model_cost_multiplier ?? undefined,
      toolTrace: parseToolTrace(row.tool_trace_json),
      activityTrace: parseActivityTrace(row.activity_trace_json),
      inputImageRefs: parseInputImageRefs(row.input_image_refs_json),
      questionAnswers: row.role === "user" ? parseQuestionAnswers(row.question_answers_json) : undefined,
      createdAt: Number(row.created_at)
    };
  }

  private mapMessageImage(row: MessageImageRow): SessionImage {
    if (row.source_provider !== "web") throw new Error("Unsupported session image source");
    return {
      id: row.image_id,
      messageId: row.message_id,
      sessionId: row.session_id,
      turnId: Number(row.turn_id),
      ordinal: Number(row.ordinal),
      generationId: row.generation_id ?? undefined,
      source: { provider: row.source_provider, messageId: row.source_message_id, imageKey: row.source_image_key },
      description: row.description ?? undefined,
      descriptionModel: row.description_model ?? undefined,
      hotThroughCompletion: Number(row.hot_through_completion),
      mimeType: row.mime_type ?? undefined,
      sha256: row.sha256 ?? undefined,
      createdAt: Number(row.created_at)
    };
  }

  private completedTurnCount(sessionId: string): number {
    const row = prepareSql(this.db(), `SELECT COUNT(*) AS count FROM messages
      WHERE deleted_at IS NULL AND session_id = ? AND role = 'assistant'`).get(sessionId) as { count: number };
    return Number(row.count);
  }

  private insertMessageImage(
    messageId: string,
    sessionId: string,
    turnId: number,
    ordinal: number,
    source: NonNullable<ChatMessage["inputImageRefs"]>[number],
    hotThroughCompletion: number,
    createdAt: number,
    sha256?: string,
    generationId?: string
  ): void {
    prepareSql(this.db(), `INSERT OR IGNORE INTO message_images (
      image_id, message_id, session_id, turn_id, ordinal, generation_id, source_provider,
      source_message_id, source_image_key, hot_through_completion, sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`img_${randomUUID()}`, messageId, sessionId, turnId, ordinal, generationId ?? null, source.provider,
        source.messageId, source.imageKey, hotThroughCompletion, sha256 ?? null, createdAt);
  }

  private mapImageGeneration(row: ImageGenerationRow): ImageGenerationRecord {
    return {
      generationId: row.generation_id,
      experimentId: row.experiment_id ?? undefined,
      variant: row.variant ?? undefined,
      ordinal: row.ordinal ?? undefined,
      sessionId: row.session_id,
      turnId: Number(row.turn_id),
      inputPrompt: row.input_prompt ?? undefined,
      revisedPrompt: row.revised_prompt ?? undefined,
      size: row.size ?? undefined,
      quality: row.quality ?? undefined,
      inputFidelity: row.input_fidelity ?? undefined,
      status: row.status ?? undefined,
      error: row.error ?? undefined,
      imageSha256: row.image_sha256 ?? undefined,
      createdAt: Number(row.created_at),
      model: row.model_id,
      modelSupplier: row.model_supplier ?? undefined,
      modelCostMultiplier: row.model_cost_multiplier ?? undefined,
      inputTokens: Number(row.input_tokens),
      inputTextTokens: Number(row.input_text_tokens),
      inputImageTokens: Number(row.input_image_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens),
      outputTextTokens: Number(row.output_text_tokens),
      outputImageTokens: Number(row.output_image_tokens),
      estimated: Boolean(row.estimated),
      ...(row.billing_details_json ? {billingDetails:JSON.parse(row.billing_details_json) as ImageGenerationRecord["billingDetails"]} : {})
    };
  }

  private mapVideoGeneration(row: VideoGenerationRow): VideoGenerationRecord[] {
    try {
      const record = JSON.parse(row.record_json) as VideoGenerationRecord;
      return [{
        ...record,
        generationId: row.generation_id,
        sessionId: row.session_id,
        turnId: Number(row.turn_id),
        createdAt: Number(row.created_at)
      }];
    } catch {
      return [];
    }
  }

  private insertVideoGeneration(
    sessionId: string,
    turnId: number,
    record: VideoGenerationRecord,
    now: number
  ): void {
    const generationId = record.generationId ?? `video_${randomUUID()}`;
    prepareSql(this.db(), `INSERT OR IGNORE INTO video_generations (
      generation_id, session_id, turn_id, record_json, created_at
    ) VALUES (?, ?, ?, ?, ?)`)
      .run(generationId, sessionId, turnId, JSON.stringify({ ...record, generationId }), now);
  }

  private insertMessage(
    sessionId: string,
    turnId: number,
    role: ChatRole,
    content: string,
    usage: TokenUsage,
    now: number,
    messageId?: string,
    model?: string,
    modelIdentity?: ModelUsageIdentity,
    toolTrace?: readonly ModelConversationMessage[],
    activityTrace?: readonly AgentActivityItem[],
    senderUserId?: string,
    serializedTraces?: { tool: string | null; activity: string | null }
  ): ChatMessage {
    const id = randomUUID();
    prepareSql(this.db(), `
      INSERT INTO messages (
        id, message_id, session_id, turn_id, role, content, sender_user_id,
        input_tokens, output_tokens, cached_input_tokens, cache_hit_tokens_reported, model_id,
        model_name, model_brand, model_supplier, model_cost_multiplier, tool_trace_json,
        activity_trace_json, input_image_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      messageId ?? null,
      sessionId,
      turnId,
      role,
      content,
      senderUserId ?? null,
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedInputTokens,
      usage.cacheHitTokensReported ? 1 : 0,
      model ?? null,
      modelIdentity?.name ?? null,
      modelIdentity?.brand ?? null,
      modelIdentity?.supplier ?? null,
      modelIdentity?.costMultiplier ?? null,
      serializedTraces ? serializedTraces.tool : toolTrace && toolTrace.length > 0 ? JSON.stringify(toolTrace) : null,
      serializedTraces ? serializedTraces.activity : activityTrace && activityTrace.length > 0 ? JSON.stringify(activityTrace) : null,
      null,
      now
    );
    return {
      id, messageId, turnId, role, content, ...usage, model,
      senderUserId,
      toolTrace: toolTrace ? [...toolTrace] : undefined,
      activityTrace: activityTrace ? [...activityTrace] : undefined,
      modelName: modelIdentity?.name,
      modelBrand: modelIdentity?.brand,
      modelSupplier: modelIdentity?.supplier,
      modelCostMultiplier: modelIdentity?.costMultiplier,
      createdAt: now
    };
  }

  private updateUserUsage(
    sessionId: string,
    turnId: number,
    usage: TokenUsage,
    model?: string,
    modelIdentity?: ModelUsageIdentity
  ): void {
    const result = prepareSql(this.db(), `
      UPDATE messages
      SET input_tokens = ?, cached_input_tokens = ?, cache_hit_tokens_reported = ?, model_id = ?,
          model_name = ?, model_brand = ?, model_supplier = ?, model_cost_multiplier = ?
      WHERE deleted_at IS NULL AND session_id = ? AND turn_id = ? AND role = 'user'
    `).run(
      usage.inputTokens,
      usage.cachedInputTokens,
      usage.cacheHitTokensReported ? 1 : 0,
      model ?? null,
      modelIdentity?.name ?? null,
      modelIdentity?.brand ?? null,
      modelIdentity?.supplier ?? null,
      modelIdentity?.costMultiplier ?? null,
      sessionId,
      turnId
    );
    if (result.changes !== 1) throw new Error(`User message for turn ${turnId} does not exist`);
  }

  private insertImageGeneration(
    sessionId: string,
    turnId: number,
    usage: ImageGenerationRecord,
    now: number
  ): void {
    prepareSql(this.db(), `
      INSERT OR IGNORE INTO image_generations (
        generation_id, session_id, turn_id, model_id, model_supplier, model_cost_multiplier,
        input_tokens, input_text_tokens, input_image_tokens, cached_input_tokens,
        output_tokens, output_text_tokens, output_image_tokens, estimated,
        experiment_id, variant, ordinal, input_prompt, revised_prompt, size, quality, input_fidelity,
        status, error, image_sha256, created_at, billing_details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      usage.generationId ?? randomUUID(),
      sessionId,
      turnId,
      usage.model,
      usage.modelSupplier ?? null,
      usage.modelCostMultiplier ?? null,
      usage.inputTokens,
      usage.inputTextTokens,
      usage.inputImageTokens,
      usage.cachedInputTokens,
      usage.outputTokens,
      usage.outputTextTokens,
      usage.outputImageTokens,
      usage.estimated ? 1 : 0,
      usage.experimentId ?? null,
      usage.variant ?? null,
      usage.ordinal ?? null,
      usage.inputPrompt ?? null,
      usage.revisedPrompt ?? null,
      usage.size ?? null,
      usage.quality ?? null,
      usage.inputFidelity ?? null,
      usage.status ?? null,
      usage.error ?? null,
      usage.imageSha256 ?? null,
      usage.createdAt ?? now,
      usage.billingDetails ? JSON.stringify(usage.billingDetails) : null
    );
  }

  async appendImageGenerationRecords(
    sessionId: string,
    turnId: number,
    records: readonly ImageGenerationRecord[],
    now = Date.now()
  ): Promise<void> {
    await this.initialize();
    this.transaction(() => {
      for (const record of records) {
        if (record.sessionId !== undefined && record.sessionId !== sessionId) {
          throw new Error("Image generation record sessionId does not match its persistence context");
        }
        if (record.turnId !== undefined && record.turnId !== turnId) {
          throw new Error("Image generation record turnId does not match its persistence context");
        }
        this.insertImageGeneration(sessionId, turnId, record, now);
      }
    });
  }

  private addSessionUsage(sessionId: string, usage: TokenUsage): void {
    prepareSql(this.db(), `
      UPDATE sessions
      SET total_input_tokens = total_input_tokens + ?,
          total_output_tokens = total_output_tokens + ?,
          total_cached_input_tokens = total_cached_input_tokens + ?
      WHERE session_id = ?
    `).run(usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, sessionId);
  }
}
