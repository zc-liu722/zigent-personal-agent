import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelDeployment } from "../config.js";
import type { WebSearchExecutionResult } from "../llm.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import { ModelWebSearchError } from "./errors.js";
import { modelRequestDispatcher } from "./http-transport.js";
import { tokenCount, validTokenCount } from "./stream-usage.js";

type SearchResult = { type: "url"; url: string; title?: string; snippet?: string; content?: string };

function searchResults(value: unknown): SearchResult[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { search_results?: unknown }).search_results)) {
    throw new ModelWebSearchError("invalid_search_response", true);
  }
  return (value as { search_results: unknown[] }).search_results.flatMap((raw): SearchResult[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return [];
    const chunks = Array.isArray(item.chunks) ? item.chunks.flatMap(chunk =>
      chunk && typeof chunk === "object" && typeof (chunk as { text?: unknown }).text === "string"
        ? [(chunk as { text: string }).text] : []).join("\n") : "";
    return [{ type: "url", url: item.url,
      ...(typeof item.title === "string" ? { title: item.title } : {}),
      ...(typeof item.snippet === "string" ? { snippet: item.snippet.slice(0, 3000) } : {}),
      content: (chunks || (typeof item.content === "string" ? item.content : "")).slice(0, 9000)
    }];
  }).slice(0, 5);
}

/** Kimi-owned search services; never call another model or change suppliers after failure. */
export async function executeSupplierWebSearch(config: ModelGatewayConfig, route: ModelDeployment,
  query: string, signal?: AbortSignal): Promise<WebSearchExecutionResult> {
  const service = route.webSearch;
  if (!service) throw new ModelWebSearchError("search_service_not_configured", false);
  const callId = `kimi-search-${randomUUID()}`;
  const attempts = Math.max(1, config.modelRetryAttempts ?? 1);
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(config.modelFirstProgressTimeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(service.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${service.apiKey}`,
          "User-Agent": "zigent/0.1.0", "X-Msh-Tool-Call-Id": callId },
        body: JSON.stringify({ text_query: query, limit: 5, timeout_seconds: 30,
          ...(service.supplier === "kimicode" ? { enable_page_crawling: true } : {}) }),
        signal: requestSignal,
        dispatcher: modelRequestDispatcher(config, service.url, service.network)
      } as RequestInit);
      if (!response.ok) {
        await response.body?.cancel();
        throw new ModelWebSearchError(`http_${response.status}`,
          [408, 425, 429].includes(response.status) || response.status >= 500, response.status);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new ModelWebSearchError("invalid_search_response", true); }
      const evidence = searchResults(payload);
      const sources = [...new Map(evidence.map(({ url, title }) => [url, { type: "url" as const, url, title }])).values()];
      const rawUsage = (payload as { usage?: { input_tokens?: unknown; output_tokens?: unknown; cached_tokens?: unknown } }).usage;
      // REST search normally reports no model tokens; do not invent zero-token usage.
      const usage = rawUsage && validTokenCount(rawUsage.input_tokens) && validTokenCount(rawUsage.output_tokens)
        ? { inputTokens: tokenCount(rawUsage.input_tokens), outputTokens: tokenCount(rawUsage.output_tokens),
          cachedInputTokens: tokenCount(rawUsage.cached_tokens), cacheHitTokensReported: validTokenCount(rawUsage.cached_tokens) }
        : undefined;
      return {
        result: { query, answer: evidence.map(item =>
          [item.title, item.url, item.snippet, item.content].filter(Boolean).join("\n")).join("\n\n"),
          sources, searchSupplier: service.supplier },
        usage,
        webSearchCalls: [{ id: callId, status: "completed", query, sources }],
        citations: sources.map(({ url, title }) => ({ type: "url_citation", url, title }))
      };
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error instanceof ModelWebSearchError ? error
        : new ModelWebSearchError("search_service_connection_failed", true);
      if (!failure.retryable || attempt >= attempts) throw failure;
      await delay(config.modelRetryDelayMs ?? 1000, undefined, { signal });
    }
  }
}
