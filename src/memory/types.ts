import type { Provider } from "../config.js";
import type { ModelConversationMessage, ModelTool } from "../models/types.js";
import type { AgentActivityItem } from "../agent/transcript.js";

export type ChatRole = "user" | "assistant" | "compressor";
export type SessionStatus = "active" | "pending" | "closed";
export type ConversationKind = "p2p" | "group" | "unknown";

export class SessionPermissionError extends Error {
  constructor(message = "Only the member who started this group topic can manage it") {
    super(message);
    this.name = "SessionPermissionError";
  }
}

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Provider-reported cache writes without a retention-duration breakdown. */
  cacheWriteTokens?: number;
  cacheWriteTokens5m?: number;
  cacheWriteTokens1h?: number;
  /** Whether the provider explicitly returned its cached-input usage field. */
  cacheHitTokensReported?: boolean;
};

export type ImageGenerationUsage = {
  model: string;
  modelSupplier?: string;
  modelCostMultiplier?: number;
  inputTokens: number;
  inputTextTokens: number;
  inputImageTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  outputTextTokens: number;
  outputImageTokens: number;
  estimated?: boolean;
  /** Price-relevant provider metadata only; no prompt or image content. */
  billingDetails?: { breakdownComplete: boolean; cacheBilling: "none" | "split"; cachedTextTokens?: number; cachedImageTokens?: number };
};

export type ImageExperimentVariant = "raw_user_prompt" | "art_directed_rewrite";
export type ImageGenerationStatus = "success" | "failed";

export type SessionImage = {
  id: string;
  messageId: string;
  sessionId: string;
  turnId: number;
  ordinal: number;
  /** Present only when this conversation image came from an image-generation attempt. */
  generationId?: string;
  source: { provider: "web"; messageId: string; imageKey: string };
  description?: string;
  descriptionModel?: string;
  hotThroughCompletion: number;
  mimeType?: string;
  sha256?: string;
  createdAt: number;
};

/**
 * One independently billed image request. Experiment fields are optional only
 * when reading rows created before the dual-variant experiment migration.
 */
export type ImageGenerationRecord = ImageGenerationUsage & {
  generationId?: string;
  experimentId?: string;
  variant?: ImageExperimentVariant;
  ordinal?: number;
  sessionId?: string;
  turnId?: number;
  inputPrompt?: string;
  revisedPrompt?: string;
  size?: string;
  quality?: string;
  inputFidelity?: "high" | "low";
  status?: ImageGenerationStatus;
  error?: string;
  imageSha256?: string;
  createdAt?: number;
};

export type VideoGenerationRecord = {
  generationId?: string;
  sessionId?: string;
  turnId?: number;
  model: string;
  modelSupplier?: string;
  modelCostMultiplier?: number;
  duration: number;
  outputSeconds: number;
  resolution: "480p" | "768p" | "2k";
  inputImageCount: number;
  createdAt?: number;
};

/** Real form answers attached to the original user turn, independently of a completed assistant reply. */
export type UserQuestionAnswer = {
  question: string;
  selectedOptionIds: string[];
  selectedOptions: string[];
  text?: string;
};

export type ChatMessage = TokenUsage & {
  id: string;
  messageId?: string;
  turnId: number;
  role: ChatRole;
  content: string;
  questionAnswers?: UserQuestionAnswer[];
  /** Persisted only for user messages. Never sent to the model verbatim. */
  senderUserId?: string;
  /** Stable anonymous label derived within a group session, such as 群成员 1. */
  speakerLabel?: string;
  /** Assistant/tool exchanges before the terminal round. Their visible prose may also be included in content. */
  toolTrace?: ModelConversationMessage[];
  /** Chronological assistant prose, provider-exposed thoughts, commentary, route events and tool activity. */
  activityTrace?: AgentActivityItem[];
  /** Durable references to original images in the authenticated web asset library. */
  inputImageRefs?: Array<{ provider: "web"; messageId: string; imageKey: string }>;
  /** Images belonging to this message, ordered as they appeared in it. */
  images?: SessionImage[];
  /** Actual API model used for the invocation that produced this usage. */
  model?: string;
  modelName?: string;
  modelBrand?: string;
  modelSupplier?: string;
  /** Multiplier applied to official list pricing; zero means the route is free. */
  modelCostMultiplier?: number;
  createdAt: number;
};

export type ModelUsageIdentity = {
  model: string;
  name: string;
  brand: string;
  supplier: string;
  costMultiplier: number;
};

/** Named fields shared by the completed-reply write path across memory layers. */
export type AssistantReplyInput = {
  sessionId: string;
  turnId: number;
  content: string;
  usage: TokenUsage;
  createdAt?: number;
  model?: string;
  imageUsages?: readonly ImageGenerationUsage[];
  modelIdentity?: ModelUsageIdentity;
  toolTrace?: readonly ModelConversationMessage[];
  activityTrace?: readonly AgentActivityItem[];
  videoUsages?: readonly VideoGenerationRecord[];
};

export type SessionSummary = {
  content: string;
  updatedAt: number;
  /** First retained turn N; this checkpoint covers complete turns before N. */
  turnId: number;
};

export type SessionFeedback = {
  userId?: string;
  rating: "satisfied" | "dissatisfied";
};

/** State and ownership only; contains no conversation payload. */
export type SessionMetadata = Pick<Session, "id" | "userId" | "chatId" | "chatType" | "initialUserPreview" | "createdAt" | "lastActiveAt" | "status" | "totalInputTokens" | "totalOutputTokens" | "totalCachedInputTokens">;

export type Session = {
  id: string;
  /** User who opened the session; session continuity itself is scoped by chatId. */
  userId: string;
  chatId: string;
  chatType?: ConversationKind;
  initialUserPreview: string;
  createdAt: number;
  lastActiveAt: number;
  status: SessionStatus;
  messages: ChatMessage[];
  /** Total completed replies, including turns before the model-context boundary. */
  completedTurns?: number;
  summary?: SessionSummary;
  feedback?: SessionFeedback;
  feedbacks?: SessionFeedback[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  /** Billed invocations removed from the active conversation by an edit; never model context. */
  rewoundUsage?: Array<Pick<ChatMessage, "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheHitTokensReported" |
    "model" | "modelName" | "modelBrand" | "modelSupplier" | "modelCostMultiplier">>;
  imageUsages?: ImageGenerationRecord[];
  videoUsages?: VideoGenerationRecord[];
};

/** A model-input snapshot, not an audit/history result. Older image-bearing messages
 * are positional shells with empty text; all other compressed messages are absent.
 * Activity, billing records and feedback are intentionally omitted.
 */
export type SessionContext = Session & { readScope: "model-context"; completedTurns: number };

export type SessionTransition = {
  session: SessionMetadata;
  previousSession?: SessionMetadata;
  createdNew: boolean;
  shouldSendSessionEndedCard: boolean;
};

export type UserTurnStart = {
  transition: SessionTransition;
  currentMessage: ChatMessage;
};

export type LongTermMemory = {
  agentSoul?: string;
  behaviorRules: string;
  content: string;
  archiveTitles?: string[];
  /** Revision of the authoritative Markdown snapshot. */
  revision?: string;
};

export type ModelMemoryContext = {
  /** Trusted runtime mode, used to keep account-tool guidance read-only in scheduled runs. */
  backgroundTask?: boolean;
  /** Live domain state, refreshed independently of lossy conversation summaries. */
  workspaceContext?: string;
  longTermMemory: LongTermMemory;
  sessionSummary?: string;
  sessionHistory: ModelConversationMessage[];
  conversation?: {
    kind: ConversationKind;
    currentSpeakerLabel?: string;
  };
  tools?: ModelTool[];
};

export type PreparedTurn = {
  session: Session;
  transition: SessionTransition;
  currentMessage: ChatMessage;
  context: ModelMemoryContext;
};

export type CompressionResult = {
  modelIdentity?: ModelUsageIdentity;
  summary: SessionSummary;
  usage: TokenUsage;
  model?: string;
};

export interface ConversationCompressor {
  shouldCompress(session: Session, currentTurnId: number, provider?: Provider, overhead?: number, signal?: AbortSignal): boolean | Promise<boolean>;
  compress(session: Session, currentTurnId: number, provider?: Provider, signal?: AbortSignal,
    reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>>): Promise<CompressionResult>;
}

export interface LongTermMemoryProvider {
  get(userId: string): Promise<LongTermMemory>;
}
