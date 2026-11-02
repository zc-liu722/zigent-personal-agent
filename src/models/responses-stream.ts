import { createResponsesThoughtReader } from "./responses-thoughts.js";
import type { StreamEventReader, StreamUpdate } from "./stream-types.js";
import { tokenCount, validTokenCount } from "./stream-usage.js";
import type { ModelAssistantTextPhase, ModelUrlCitation, ModelWebSearchCall } from "./types.js";
import { nativeWebSearchError } from "./web-search-errors.js";

/** Protocol boundary: converts Responses SSE fields into supplier-neutral stream updates. */
function readResponsesStreamEvent(event: unknown, readThoughts: ReturnType<typeof createResponsesThoughtReader>): StreamUpdate {
  if (!event || typeof event !== "object") return { progress: false };
  const data = event as {
    type?: unknown;
    delta?: unknown;
    item_id?: unknown;
    output_index?: unknown;
    content_index?: unknown;
    summary_index?: unknown;
    annotation?: unknown;
    error?: unknown;
    response?: {
      id?: string;
      error?: unknown;
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown };
      };
    };
    item?: {
      type?: unknown; id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown; status?: unknown; action?: unknown; phase?: unknown; error?: unknown
    };
  };
  const type = typeof data.type === "string" ? data.type : "";
  const delta = typeof data.delta === "string" ? data.delta : "";
  const deltaTypes = new Set([
    "response.output_text.delta",
    "response.refusal.delta",
    "response.reasoning_text.delta",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta"
  ]);
  const isTextDelta = (type === "response.output_text.delta" || type === "response.refusal.delta") && delta.length > 0;
  const thoughts = readThoughts(event as Record<string, unknown>);
  const isProgress = deltaTypes.has(type) && delta.length > 0;
  const itemIsFunctionCall = data.item?.type === "function_call";
  const webSearchEventStatuses: Record<string, ModelWebSearchCall["status"] | undefined> = {
    "response.web_search_call.in_progress": "in_progress",
    "response.web_search_call.searching": "searching",
    "response.web_search_call.completed": "completed"
  };
  const webSearchStatus = webSearchEventStatuses[type];
  const toolKey = String(data.output_index ?? data.item_id ?? data.item?.id ?? data.item?.call_id ?? "tool-0");
  const responseOutput = type === "response.completed" && Array.isArray((data.response as { output?: unknown } | undefined)?.output)
    ? ((data.response as { output: unknown[] }).output)
    : [];
  const completedItem = type === "response.output_item.done" && data.item ? [data.item] : [];
  const responseItems = [data.item, ...responseOutput]
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
  const phaseItems = [
    ...(data.item ? [{ item: data.item as Record<string, unknown>, outputIndex: data.output_index }] : []),
    ...responseOutput.map((item, outputIndex) => ({
      item: item && typeof item === "object" ? item as Record<string, unknown> : {},
      outputIndex
    }))
  ];
  const textItemPhases = phaseItems.flatMap(({ item, outputIndex }) => {
    if (item.type !== "message" || item.phase !== "commentary" && item.phase !== "final_answer") return [];
    const phase = item.phase as ModelAssistantTextPhase;
    const ids = [
      typeof item.id === "string" ? item.id : undefined,
      outputIndex === undefined ? undefined : String(outputIndex)
    ].filter((id): id is string => id !== undefined);
    return [...new Set(ids)].map((itemId) => ({ itemId, phase }));
  });
  const webSearchCalls = responseItems
    .filter((item) => item.type === "web_search_call" && item.status !== "failed")
    .map(normalizeWebSearchCall);
  const failedSearch = responseItems.find((item) => item.type === "web_search_call" && item.status === "failed");
  const responseError = data.response?.error ?? data.error;
  const searchResponseError = responseError && typeof responseError === "object"
    && typeof (responseError as { code?: unknown }).code === "string"
    && /web_search|search_tool/.test((responseError as { code: string }).code);
  const searchError = failedSearch || type === "response.web_search_call.failed" || searchResponseError
    ? nativeWebSearchError(failedSearch?.error ?? responseError) : undefined;
  if (webSearchStatus && webSearchCalls.length === 0) {
    webSearchCalls.push({
      id: typeof data.item_id === "string" ? data.item_id : toolKey,
      status: webSearchStatus,
      sources: []
    });
  }
  const citations = [data.annotation, ...responseItems.flatMap((item) =>
    Array.isArray(item.content) ? item.content.flatMap((content) =>
      content && typeof content === "object" && Array.isArray((content as { annotations?: unknown }).annotations)
        ? (content as { annotations: unknown[] }).annotations
        : []
    ) : []
  )].map(normalizeUrlCitation).filter((citation): citation is ModelUrlCitation => Boolean(citation));
  return {
    assistantText: isTextDelta ? {
      text: delta,
      itemId: String(data.item_id ?? data.output_index ?? "text-0")
    } : undefined,
    textItemPhases: textItemPhases.length > 0 ? textItemPhases : undefined,
    progress: isProgress || thoughts.length > 0 || type === "response.completed" || Boolean(webSearchStatus)
      || type === "response.output_text.annotation.added"
      || Boolean(searchError)
      || responseItems.some((item) => item.type === "web_search_call"),
    completed: type === "response.completed",
    thoughts,
    reasoningContent: thoughts.map((thought) => thought.text).join("") || undefined,
    toolCalls: itemIsFunctionCall && (type === "response.output_item.added" || type === "response.output_item.done")
      ? [{
          key: toolKey,
          id: typeof data.item?.call_id === "string"
            ? data.item.call_id
            : typeof data.item?.id === "string" ? data.item.id : undefined,
          name: typeof data.item?.name === "string" ? data.item.name : undefined,
          arguments: typeof data.item?.arguments === "string" ? data.item.arguments : undefined
        }]
      : type === "response.function_call_arguments.delta" && delta.length > 0
        ? [{ key: toolKey, argumentsDelta: delta }]
        : undefined,
    webSearchCalls: webSearchCalls.length > 0 ? webSearchCalls : undefined,
    webSearchError: searchError,
    citations: citations.length > 0 ? citations : undefined,
    nativeItems: [...completedItem, ...responseOutput],
    generationId: data.response?.id,
    inputTokensReported: validTokenCount(data.response?.usage?.input_tokens),
    outputTokensReported: validTokenCount(data.response?.usage?.output_tokens),
    usage: data.response?.usage ? {
      inputTokens: tokenCount(data.response.usage.input_tokens),
      outputTokens: tokenCount(data.response.usage.output_tokens),
      cachedInputTokens: tokenCount(data.response.usage.input_tokens_details?.cached_tokens),
      cacheHitTokensReported: data.response?.usage?.input_tokens_details?.cached_tokens !== undefined
    } : undefined
  };
}

function normalizeWebSearchCall(item: Record<string, unknown>): ModelWebSearchCall {
  const action = item.action && typeof item.action === "object"
    ? item.action as Record<string, unknown>
    : undefined;
  const rawSources = Array.isArray(action?.sources) ? action.sources : [];
  const sources = rawSources.flatMap((source): Array<{ type: "url"; url: string; title?: string }> => {
    if (!source || typeof source !== "object"
      || (source as { type?: unknown }).type !== "url"
      || typeof (source as { url?: unknown }).url !== "string") return [];
    return [{
      type: "url",
      url: (source as { url: string }).url,
      ...(typeof (source as { title?: unknown }).title === "string"
        ? { title: (source as { title: string }).title }
        : {})
    }];
  });
  const rawStatus = item.status;
  const status: ModelWebSearchCall["status"] = rawStatus === "searching" || rawStatus === "completed"
    ? rawStatus
    : "in_progress";
  return {
    id: typeof item.id === "string" ? item.id : "web-search-0",
    status,
    query: typeof action?.query === "string" ? action.query : undefined,
    queries: Array.isArray(action?.queries)
      ? action.queries.filter((query): query is string => typeof query === "string")
      : undefined,
    sources
  };
}

function normalizeUrlCitation(annotation: unknown): ModelUrlCitation | undefined {
  if (!annotation || typeof annotation !== "object") return undefined;
  const value = annotation as Record<string, unknown>;
  if (value.type !== "url_citation" || typeof value.url !== "string") return undefined;
  return {
    type: "url_citation",
    url: value.url,
    title: typeof value.title === "string" ? value.title : undefined,
    startIndex: typeof value.start_index === "number" ? value.start_index : undefined,
    endIndex: typeof value.end_index === "number" ? value.end_index : undefined
  };
}

export function createResponsesStreamReader(): StreamEventReader {
  const readThoughts = createResponsesThoughtReader();
  const emitted = new Map<string, string>();
  return event => {
    const update = readResponsesStreamEvent(event, readThoughts);
    if (!event || typeof event !== "object") return update;
    const data = event as Record<string, unknown>;
    const type = typeof data.type === "string" ? data.type : "";
    const item = data.item && typeof data.item === "object" ? data.item as Record<string, unknown> : undefined;
    const itemId = String(data.item_id ?? item?.id ?? data.output_index ?? "text-0");
    const identity = data.output_index === undefined ? `id:${itemId}` : `index:${String(data.output_index)}`;
    const contentIndex = data.content_index ?? 0;
    const kind = type.startsWith("response.refusal.") ? "refusal" : "output_text";
    const key = `${identity}\0${String(contentIndex)}\0${kind}`;
    if (update.assistantText) {
      emitted.set(key, (emitted.get(key) ?? "") + update.assistantText.text);
      return update;
    }
    let finalText: unknown;
    let finalKind = kind;
    if (type === "response.output_text.done") finalText = data.text;
    else if (type === "response.refusal.done") finalText = data.refusal;
    else if (type === "response.content_part.done" && data.part && typeof data.part === "object") {
      const part = data.part as Record<string, unknown>;
      if (part.type === "output_text") finalText = part.text;
      else if (part.type === "refusal") { finalKind = "refusal"; finalText = part.refusal; }
    } else if (type === "response.output_item.done" && item?.type === "message"
      && (item.role === undefined || item.role === "assistant") && Array.isArray(item.content) && item.content.length === 1) {
      const part = item.content[0];
      if (part && typeof part === "object") {
        const value = part as Record<string, unknown>;
        if (value.type === "output_text") finalText = value.text;
        else if (value.type === "refusal") { finalKind = "refusal"; finalText = value.refusal; }
      }
    }
    if (typeof finalText !== "string") return update;
    const finalKey = `${identity}\0${String(contentIndex)}\0${finalKind}`;
    const previous = emitted.get(finalKey) ?? "";
    if (!finalText.startsWith(previous)) return update;
    const remaining = finalText.slice(previous.length);
    if (!remaining) return update;
    emitted.set(finalKey, finalText);
    return { ...update, progress: true, assistantText: { itemId, text: remaining } };
  };
}
