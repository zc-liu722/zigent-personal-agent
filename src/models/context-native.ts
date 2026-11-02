import type { ModelDeployment } from "../config.js";
import type { TokenUsage } from "../memory/types.js";
import type { RequestRecorder } from "../usage/types.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import { modelRequestDispatcher } from "./http-transport.js";
import { buildProtocolRequest, anthropicMessagesEndpoint, responseEndpoint } from "./protocol-adapters.js";
import { anthropicUsage, tokenCount, validTokenCount, type AnthropicUsage } from "./stream-usage.js";
import { addTokenUsage } from "./context-summary.js";
import { ModelContextOverflowError, ModelError, ModelInvalidResponseError } from "./errors.js";
import type { ModelRoundRequest } from "./types.js";

/** Explicit route capability only. A protocol-compatible endpoint does not imply this support. */
export async function compactNative(config: ModelGatewayConfig, route: ModelDeployment,
  request: ModelRoundRequest, summaryTokens: number, signal?: AbortSignal, record?: RequestRecorder
): Promise<{ items: Record<string, unknown>[]; usage: TokenUsage }> {
  const openai = route.context?.strategy === "openai-native" && route.protocol === "openai-responses";
  const anthropic = route.context?.strategy === "anthropic-native" && route.protocol === "anthropic-messages";
  if (!openai && !anthropic) throw new ModelError("Native compaction is not enabled on this exact route");
  const transport = buildProtocolRequest(route, request, false);
  const { stream: _stream, ...payload } = transport.payload;
  const started = Date.now();
  let usage: TokenUsage | undefined;
  try {
    const response = await fetch(openai ? `${responseEndpoint(route.baseUrl!)}/compact` : anthropicMessagesEndpoint(route.baseUrl!), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${route.apiKey}`,
        ...transport.headers, ...(anthropic ? { "anthropic-beta": "compact-2026-09-04" } : {}) },
      body: JSON.stringify(openai ? { model: route.apiModel, input: payload.input, instructions: request.systemPrompt }
        : { ...payload, max_tokens: summaryTokens, compaction: { type: "summarize" }, stream: false }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.modelProgressIdleTimeoutMs)])
        : AbortSignal.timeout(config.modelProgressIdleTimeoutMs),
      ...({ dispatcher: modelRequestDispatcher(config, transport.url, route.network) } as object)
    });
    if (!response.ok) {
      const body = await response.text();
      if ([400, 413, 422].includes(response.status) && /context|too long|too many tokens/i.test(body)) throw new ModelContextOverflowError();
      throw new ModelError(`Native compaction returned HTTP ${response.status}`, response.status);
    }
    const data = await response.json() as { output?: unknown; content?: unknown; stop_reason?: string;
      usage?: AnthropicUsage & { input_tokens_details?: { cached_tokens?: number }; iterations?: AnthropicUsage[] } };
    if (data.usage && validTokenCount(data.usage.input_tokens) && validTokenCount(data.usage.output_tokens)) usage = anthropic ? anthropicUsage(data.usage) : {
      inputTokens: tokenCount(data.usage.input_tokens), outputTokens: tokenCount(data.usage.output_tokens),
      cachedInputTokens: tokenCount(data.usage.input_tokens_details?.cached_tokens),
      cacheHitTokensReported: data.usage.input_tokens_details?.cached_tokens !== undefined };
    if (anthropic && data.usage?.iterations?.length) {
      usage = data.usage.iterations.reduce((total, iteration) => addTokenUsage(total, anthropicUsage(iteration)),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    }
    const blocks = openai ? data.output : data.content;
    if (!Array.isArray(blocks) || !blocks.length || anthropic && data.stop_reason !== "compaction"
      || blocks.some(block => !block || typeof block !== "object" || Array.isArray(block))
      || !blocks.some(block => block.type === "compaction" && (openai
        ? typeof block.encrypted_content === "string" && block.encrypted_content.length > 0
        : typeof block.content === "string" && block.content.trim().length > 0 && typeof block.signature === "string" && block.signature.length > 0))) {
      throw new ModelInvalidResponseError("Native compaction did not return a complete checkpoint");
    }
    if (!usage) throw new ModelInvalidResponseError("Native compaction omitted token usage");
    record?.({ createdAt: started, usage, usageComplete: true, outcome: "completed" });
    return { items: openai ? blocks : [{ role: "assistant", content: blocks }], usage };
  } catch (error) {
    record?.({ createdAt: started, usage, usageComplete: Boolean(usage), outcome: "failed" });
    throw error;
  }
}
