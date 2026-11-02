import type { NotificationConfig } from "../notifications/config.js";
import type { GoogleCalendarConfig, GoogleDriveConfig, TodoistConfig } from "../productivity/config.js";
import type { McpOAuthAccount } from "../mcp/account.js";

/** Canonical deployable-model identity, including model family, official version, and supplier. */
export type Provider = string;
export type ModelProtocol = "anthropic-messages" | "openai-responses" | "codex-app-server" | "claude-code";
export type HostedToolName = "web_search";
export type ModelCapabilities = {
  imageInput: boolean;
  functionTools: boolean;
  hostedTools: readonly HostedToolName[];
  /** Hosted capabilities exposed to this model as locally executed function tools. */
  delegatedTools?: readonly HostedToolName[];
  /** Supplier-owned REST services exposed as client function tools. */
  serviceTools?: readonly HostedToolName[];
  /** Whether this route can replay provider-native reasoning state during a tool loop. */
  reasoningReplay: boolean;
};
export type WebSearchConfig = {
  search_context_size?: "low" | "medium" | "high";
  filters?: { allowed_domains?: readonly string[] };
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
  external_web_access?: boolean;
  /** Canonical model identity used when a route delegates web search. */
  delegateModel?: Provider;
};
export type XmindToolConfig = {
  account: McpOAuthAccount;
  serverUrl: string;
};
export type AgentToolSettings = {
  codex?: { agentId: string; ownerUserId: string };
  web_search?: WebSearchConfig;
  xmind?: XmindToolConfig;
  notion?: { account: McpOAuthAccount; serverUrl: string; proxyUrl?: string; callbackUrl?: string };
  google_calendar?: GoogleCalendarConfig;
  google_drive?: GoogleDriveConfig;
  todoist?: TodoistConfig;
};

export type ModelCostPolicy =
  | { type: "free" }
  | { type: "subscription" }
  | { type: "official"; multiplier?: number };

export function modelCostMultiplier(cost: ModelCostPolicy | undefined): number {
  if (!cost) return 1;
  return cost.type === "official" ? cost.multiplier ?? 1 : 0;
}

export type ModelSupplier = {
  id: string;
  transport: "http" | "codex-app-server" | "claude-code";
  apiKey?: string;
  endpoints: Partial<Record<ModelProtocol | "openai-images" | "native-videos" | "web-search", string>>;
  network: "direct" | "proxy";
  cost: ModelCostPolicy;
  imageModel?: string;
  command?: string;
  args?: readonly string[];
  codexHome?: string;
};

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ModelReasoning = {
  levels: ReasoningEffort[];
  mode: "effort" | "fixed";
  sources: string[];
  checkedAt: string;
  note?: string;
};

export type ModelDeployment = {
  /** Canonical model-family/version/supplier identity. */
  name: Provider;
  /** Structured owner/brand metadata used for protocol state and audit. */
  brand: string;
  /** Structured connection and health-domain identifier. */
  supplier: string;
  apiKey?: string;
  apiModel: string;
  baseUrl?: string;
  protocol: ModelProtocol;
  network: "direct" | "proxy";
  cost: ModelCostPolicy;
  command?: string;
  args?: readonly string[];
  codexHome?: string;
  maxTokens?: number;
  context?: ModelContextConfig;
  reasoningEffort?: ReasoningEffort;
  reasoning?: ModelReasoning;
  capabilities?: ModelCapabilities;
  webSearch?: {
    supplier: string;
    url: string;
    apiKey: string;
    network: "direct" | "proxy";
    cost: ModelCostPolicy;
  };
};

/** Supplier limits take precedence; missing route limits use the exact manufacturer's specification. */
export type ModelContextConfig = {
  windowTokens: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  strategy: "summary" | "openai-native" | "anthropic-native" | "runtime";
  confidence: "verified" | "conservative";
  limitSource?: "supplier" | "manufacturer" | "runtime";
  sources: string[];
  checkedAt: string;
  note?: string;
  discoveryUrl?: string;
  triggerRatio?: number;
  keepRecentTokens?: number;
  summaryTokens?: number;
  safetyTokens?: number;
  protectedTools?: string[];
};

export type HealthAccessConfig = {
  storagePath: string;
  allowedAgentId: "deepmind";
  ownerUserId: string;
  ownerPrincipalId?: string;
  initialSkillPath?: string;
  publicUrl?: string;
};

export type HealthReceiverConfig = {
  storagePath: string; listenHost: "127.0.0.1"; listenPort: number;
  ingestToken: string; maxBodyBytes: number;
};

export type LocationAccessConfig = {
  storagePath: string;
  publicUrl?: string;
  amapApiKey?: string;
};

export type LocationReceiverConfig = LocationAccessConfig & {
  webProxyPort?: number;
  webProxyRoutes?: Array<{ basePath: string; port: number }>;
  listenHost: "127.0.0.1";
  listenPort: number;
  username: string;
  password: string;
  maxBodyBytes: number;
};

export type WebChannelConfig = {
  listenHost: string; listenPort: number; publicUrl: string; storage: string;
  passwordHash?: string; ownerUserId?: string; ownerPrincipalId?: string;
  speech?: { model: "doubao-seedasr2.0-official"; apiKey: string };
  transcription?: { model: "doubao-seedasr2.0-official"; apiKey: string;
    tos: { accessKeyId: string; accessKeySecret: string; endpoint: string; region: string; bucket: string } };
};

export type AgentConfig = {
  fileWorkbench?: { enabled?: boolean; stateDirectory: string; executionEndpoint?: string; executionPreviousEndpoint?:string; executionToken?: string; executionTokenFile?: string };
  channel?: "web";
  web?: WebChannelConfig;
  id: string;
  name: string;
  /** Ordered canonical deployment identities. */
  modelOrder?: Provider[];
  suppliers?: Record<string, ModelSupplier>;
  models?: ModelDeployment[];
  /** @deprecated Legacy single-route configuration, retained for compatibility. */
  providerOrder: Provider[];
  allowedTools: string[];
  toolSettings?: AgentToolSettings;
  notifications?: NotificationConfig;
  zenmuxProxyUrl?: string;
  imageGeneration?: {
    transport?: "http" | "codex-app-server";
    driver?: ModelDeployment;
    modelName?: string;
    apiKey?: string;
    baseUrl?: string;
    model: string;
    supplier?: string;
    network?: "direct" | "proxy";
    cost?: ModelCostPolicy;
  };
  videoGeneration?: {
    modelName?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    supplier?: string;
    network?: "direct" | "proxy";
    cost?: ModelCostPolicy;
    official?: {
      apiKey: string;
      baseUrl: string;
      model: string;
      highResolutionModel: string;
      supplier: string;
      network: "direct" | "proxy";
      cost: ModelCostPolicy;
      modelName?: string;
      highResolutionModelName?: string;
    };
  };
  xmindAuthorization?: {
    account: McpOAuthAccount;
    serverUrl: string;
    bridgeUrl: string;
    bridgeSecret: string;
    timeoutMs: number;
    proxyUrl?: string;
  };
  notionAuthorization?: {
    account: McpOAuthAccount;
    serverUrl: string;
    bridgeUrl?: string;
    bridgeSecret?: string;
    timeoutMs: number;
    proxyUrl?: string;
  };
  location?: LocationAccessConfig;
  health?: HealthAccessConfig;
  /** Optional legacy data-app credentials for document access and historical images. */
  feishu?: {
    appId: string;
    appSecret: string;
  };
  providers: Record<string, {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens?: number;
    reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  } | undefined>;
  modelConnectTimeoutMs: number;
  modelFirstProgressTimeoutMs: number;
  modelProgressIdleTimeoutMs: number;
  modelCircuitBreakerMs: number;
  modelRetryAttempts?: number;
  modelNetworkRetryAttempts?: number;
  modelRetryDelayMs?: number;
  imageGenerationTimeoutMs?: number;
  videoGenerationTimeoutMs?: number;
  memoryStoragePath: string;
  longTermMemoryPath: string;
  sessionInactivityMinutes: number;
  /** Optional operator cap; otherwise use the selected route's context policy. */
  memoryContextWindowTokens?: number;
  memoryCompressionRatio?: number;
  failureMessage: string;
};

export type Environment = NodeJS.ProcessEnv;
