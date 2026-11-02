import type { TokenUsage } from "../memory/types.js";

export type AnthropicUsage = {
  input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown;
  cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown };
};
export function validTokenCount(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
export function tokenCount(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0; }
export function anthropicUsage(usage: AnthropicUsage): TokenUsage {
  const read = tokenCount(usage.cache_read_input_tokens), write = tokenCount(usage.cache_creation_input_tokens);
  const hour = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens);
  return { inputTokens: tokenCount(usage.input_tokens) + read + write, outputTokens: tokenCount(usage.output_tokens),
    cachedInputTokens: read, cacheHitTokensReported: usage.cache_read_input_tokens !== undefined,
    ...(write ? { cacheWriteTokens5m: Math.max(0, write - hour), cacheWriteTokens1h: hour } : {}) };
}
export function mergeUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const result = { ...previous, ...next };
  for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens5m", "cacheWriteTokens1h"] as const) {
    if (previous?.[field] !== undefined || next[field] !== undefined) result[field] = Math.max(previous?.[field] ?? 0, next[field] ?? 0);
  }
  result.cacheHitTokensReported = previous?.cacheHitTokensReported || next.cacheHitTokensReported;
  return result;
}

export const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
