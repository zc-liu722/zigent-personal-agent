import type { ModelCapabilities, ModelCostPolicy, ModelProtocol, Provider, WebSearchConfig } from "../config.js";
import type { ReferenceImage } from "../image-generation.js";
import type { TokenUsage } from "../memory/types.js";

export type ModelFunctionTool = {
  type: "function";
  /** Host execution starts after an adapter releases its own model session. */
  deferExecution?: boolean;
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type ModelWebSearchTool = WebSearchConfig & {
  type: "web_search";
};

export type ModelHostedTool = ModelWebSearchTool;
export type ModelTool = ModelFunctionTool | ModelHostedTool;

export type ModelToolCall = {
  id: string;
  name: string;
  input: unknown;
  arguments: string;
};

export type ModelWebSearchCall = {
  id: string;
  status: "in_progress" | "searching" | "completed";
  query?: string;
  queries?: readonly string[];
  sources: readonly { type: "url"; url: string; title?: string }[];
};

export type ModelUrlCitation = {
  type: "url_citation";
  url: string;
  title?: string;
  startIndex?: number;
  endIndex?: number;
};

/** Portable execution evidence, independent of opaque reasoning replay support. */
export type ModelSearchEvidence = {
  version: 1;
  model: string;
  origin: "provider" | "saved_activity";
  calls: readonly ModelWebSearchCall[];
  citations: readonly ModelUrlCitation[];
};

export type ModelAssistantTextPhase = "commentary" | "final_answer";
export type ModelThoughtSource = "reasoning" | "summary" | "thinking";

export type ModelAssistantTextItem = {
  /** Stable supplier item identity shared by streaming deltas and the completed text. */
  itemId?: string;
  text: string;
  phase?: ModelAssistantTextPhase;
};

export type ModelNativeState = {
  protocol: ModelProtocol;
  brand: string;
  supplier: string;
  apiModel: string;
  /** Opaque provider output items replayed only to the exact same route. */
  items: readonly unknown[];
};

/** A completed native chat thread for one Zigent session, never shared with other runs. */
export type CodexChatThread = {
  threadId: string;
  binding: string;
  totalUsage?: TokenUsage;
};

export type CodexChatRequest = {
  previous?: CodexChatThread;
  /** Consume the durable pointer before sending any new input to the old thread. */
  consumePrevious(threadId: string): Promise<boolean>;
};

export type AcpChatSession = {
  sessionId: string;
  binding: string;
  historyDigest: string;
  contextRevision?: string;
};

export type AcpChatRequest = {
  /** The channel's conversation key also exists for a draft before its first user turn. */
  conversationKey: string;
  previous?: AcpChatSession;
  sessionKey: string;
  consumePrevious(session: AcpChatSession): Promise<boolean>;
};

export type NativeProcessWarmTarget = { route: import("../config.js").ModelDeployment; expiresAt?: number };
export type NativeModelWarmRequest = Pick<ModelRoundRequest,
  "systemPrompt" | "tools" | "adapterTools" | "reasoningEfforts" | "capabilityVersions" | "measureNative" | "instructionRevision">
  & { conversationKey: string; sessionKey?: string };

export type NativeModelMetric = Extract<import("../performance/metrics.js").LatencyMetric, `model.native_${string}` | `model.codex_${string}`>;
export type NativeModelMeasurement = (metric: NativeModelMetric, ms: number, outcome?: "ok" | "error" | "cancelled") => void;

export type ModelConversationMessage =
  | {
      role: "user";
      text: string;
      images?: readonly ReferenceImage[];
      /** Ephemeral browser observations; excluded from saved image references. */
      visualObservation?: boolean;
      /** Runtime-owned projection metadata, never serialized as user instructions. */
      contextRole?: "pinned" | "current" | "volatile";
      sourceTurnId?: number;
    }
  | {
      role: "assistant";
      text: string;
      provider?: Provider;
      modelProtocol?: ModelProtocol;
      reasoningContent?: string;
      textItems?: readonly ModelAssistantTextItem[];
      nativeState?: ModelNativeState;
      searchEvidence?: ModelSearchEvidence;
      toolCalls: readonly ModelToolCall[];
    }
  | {
      role: "tool";
      toolCallId: string;
      value: string;
      failed: boolean;
    };

/** Host contract for a leased native model adapter. */
export type ModelRoundAdapter = (config: import("./gateway-config.js").ModelGatewayConfig,
  route: import("../config.js").ModelDeployment, request: ModelRoundRequest,
  onUpdate?: (update: ModelRoundUpdate) => void, signal?: AbortSignal,
  record?: import("../usage/types.js").RequestRecorder, executeTool?: ModelToolExecutor) => Promise<ModelRoundResult>;

export type NativeModelService = {
  invoke: ModelRoundAdapter;
  keepWarm?(config: Parameters<ModelRoundAdapter>[0], targets: readonly NativeProcessWarmTarget[]): void;
  prepare?(config: Parameters<ModelRoundAdapter>[0], route: import("../config.js").ModelDeployment,
    request: NativeModelWarmRequest, signal: AbortSignal): Promise<void>;
};

/** Older component versions remain callable by journaled turns. */
export type AcpModelService = Partial<NativeModelService> & {
  invokeCursorRound?: ModelRoundAdapter;
  invokeAntigravityRound?: ModelRoundAdapter;
};

export type ModelRoundRequest = {
  codexChat?: CodexChatRequest;
  acpChat?: AcpChatRequest;
  /** Identifies the active compression checkpoint and projection changes. */
  contextRevision?: string;
  instructionRevision?: string;
  capabilityVersions?: Readonly<Record<string, string>>;
  measureNative?: NativeModelMeasurement;
  beforeNativePrompt?: () => void;
  codexModel?: ModelRoundAdapter;
  cursorModel?: ModelRoundAdapter;
  antigravityModel?: ModelRoundAdapter;
  /** Host-owned serializer from the turn's leased component generation. */
  protocolAdapter?: typeof import("../plugins/model-http/protocol.js").buildProtocolRequest;
  systemPrompt?: string;
  messages: readonly ModelConversationMessage[];
  tools: readonly ModelTool[];
  /** Function tools exposed to agent-runtime transports that own their tool loop. */
  adapterTools?: readonly ModelTool[];
  reasoningEffort?: "default" | "maximum";
  /** Immutable per-model user preferences captured at turn start, including fallback routes. */
  reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>>;
  toolChoice?: "auto" | "required" | "none";
  /** Run-owned cache; exact-route checkpoints never replace the original transcript. */
  contextState?: import("./context-manager.js").ContextRunState;
  /** Supplier-native compacted input, created only inside the matching route invocation. */
  nativeContext?: { route: string; protocol: ModelProtocol; items: readonly Record<string, unknown>[] };
  maxOutputTokens?: number;
  onContextProgress?: () => void;
};

export type ModelToolExecutionResult = {
  text: string;
  failed: boolean;
  /** The host saved this result; rebuild the adapter invocation before further model work. */
  refreshTools?: boolean;
  images?: readonly ReferenceImage[];
};

export type ModelToolExecutor = (call: ModelToolCall) => Promise<ModelToolExecutionResult>;

export type ModelRouteMetadata = {
  name: Provider;
  brand: string;
  supplier: string;
  apiModel: string;
  protocol: ModelProtocol;
  cost: ModelCostPolicy;
  capabilities: ModelCapabilities;
};

export type ModelRoundUpdate = ModelRouteMetadata & {
  provider: Provider;
} & (
  | { type: "attempt.reset"; itemIds?: readonly string[] }
  /** A recoverable wait notice; an absent message removes the existing notice. */
  | { type: "wait"; message?: string }
  | { type: "visual.preparing"; itemId: string }
  | {
      type: "route";
      status: "connecting" | "connected" | "retrying" | "failed" | "switching";
      failureKind?: string;
      retryAttempt?: number;
      maxAttempts?: number;
    }
  | {
      /** Provider-exposed thought text, normalized from reasoning, summaries, or thinking blocks. */
      type: "thought.delta";
      itemId?: string;
      text: string;
      source: ModelThoughtSource;
    }
  | {
      type: "assistant_text.delta";
      itemId?: string;
      text: string;
      phase?: ModelAssistantTextPhase;
    }
  | {
      type: "web_search.update";
      calls: readonly ModelWebSearchCall[];
    }
);

export type ModelRoundResult = {
  codexThread?: CodexChatThread;
  acpSession?: AcpChatSession;
  /** A supplier ended before host callbacks finished; consume their saved results in another round. */
  requiresContinuation?: boolean;
  text: string;
  textItems: readonly ModelAssistantTextItem[];
  usage: TokenUsage;
  toolCalls: ModelToolCall[];
  webSearchCalls: ModelWebSearchCall[];
  citations: ModelUrlCitation[];
  reasoningContent?: string;
  nativeState?: ModelNativeState;
  stopReason?: string;
  contextWindowTokens?: number;
};
