import type { AgentConfig } from "../config.js";

export type ModelGatewayConfig = Pick<
  AgentConfig,
  | "id"
  | "providerOrder"
  | "providers"
  | "modelOrder"
  | "models"
  | "zenmuxProxyUrl"
  | "modelConnectTimeoutMs"
  | "modelFirstProgressTimeoutMs"
  | "modelProgressIdleTimeoutMs"
  | "modelCircuitBreakerMs"
  | "modelRetryAttempts"
  | "modelNetworkRetryAttempts"
  | "modelRetryDelayMs"
  | "toolSettings"
  | "memoryContextWindowTokens"
  | "memoryCompressionRatio"
>;
