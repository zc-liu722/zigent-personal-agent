import type { StreamEventReader, StreamUpdate } from "./stream-types.js";
import { anthropicUsage, validTokenCount, type AnthropicUsage } from "./stream-usage.js";
import type { ModelUrlCitation } from "./types.js";
import { nativeWebSearchError } from "./web-search-errors.js";

function normalizeAnthropicCitation(citation: unknown): ModelUrlCitation | undefined {
  if (!citation || typeof citation !== "object") return undefined;
  const value = citation as Record<string, unknown>;
  if (value.type !== "web_search_result_location" || typeof value.url !== "string") return undefined;
  return {
    type: "url_citation",
    url: value.url,
    title: typeof value.title === "string" ? value.title : undefined
  };
}

function anthropicSearchSources(content: unknown): Array<{ type: "url"; url: string; title?: string }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): Array<{ type: "url"; url: string; title?: string }> => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (value.type !== "web_search_result" || typeof value.url !== "string") return [];
    return [{
      type: "url",
      url: value.url,
      ...(typeof value.title === "string" ? { title: value.title } : {})
    }];
  });
}

type AnthropicStreamBlock = {
  content: Record<string, unknown>;
  inputJson: string;
};

function completeAnthropicBlock(block: AnthropicStreamBlock): Record<string, unknown> {
  if (!block.inputJson) return { ...block.content };
  try {
    return { ...block.content, input: JSON.parse(block.inputJson) as unknown };
  } catch {
    return { ...block.content };
  }
}

/** Protocol boundary: converts Anthropic SSE fields into the same supplier-neutral stream updates. */
function readAnthropicMessagesStreamEvent(
  event: unknown,
  blocks = new Map<string, AnthropicStreamBlock>()
): StreamUpdate {
  if (!event || typeof event !== "object") return { progress: false };
  const data = event as {
    type?: unknown;
    index?: unknown;
    message?: { id?: string; usage?: AnthropicUsage };
    usage?: AnthropicUsage;
    content_block?: {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      text?: unknown;
      input?: unknown;
      tool_use_id?: unknown;
      content?: unknown;
      citations?: unknown;
    };
    delta?: {
      stop_reason?: string;
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      signature?: unknown;
      partial_json?: unknown;
      citation?: unknown;
    };
  };
  const type = typeof data.type === "string" ? data.type : "";
  const blockKey = String(data.index ?? 0);
  if (type === "content_block_start" && data.content_block) {
    blocks.set(blockKey, {
      content: { ...data.content_block },
      inputJson: ""
    });
  }
  const activeBlock = blocks.get(blockKey);
  const deltaType = typeof data.delta?.type === "string" ? data.delta.type : "";
  if (activeBlock) {
    if (deltaType === "text_delta" && typeof data.delta?.text === "string") {
      activeBlock.content.text = `${String(activeBlock.content.text ?? "")}${data.delta.text}`;
    }
    if (deltaType === "thinking_delta" && typeof data.delta?.thinking === "string") {
      activeBlock.content.thinking = `${String(activeBlock.content.thinking ?? "")}${data.delta.thinking}`;
    }
    if (deltaType === "signature_delta" && typeof data.delta?.signature === "string") {
      activeBlock.content.signature = `${String(activeBlock.content.signature ?? "")}${data.delta.signature}`;
    }
    if (deltaType === "input_json_delta" && typeof data.delta?.partial_json === "string") {
      activeBlock.inputJson += data.delta.partial_json;
    }
    if (deltaType === "citations_delta" && data.delta?.citation && typeof data.delta.citation === "object") {
      const existing = Array.isArray(activeBlock.content.citations) ? activeBlock.content.citations : [];
      activeBlock.content.citations = [...existing, data.delta.citation];
    }
  }
  const text = deltaType === "text_delta" && typeof data.delta?.text === "string"
    ? data.delta.text
    : type === "content_block_start" && data.content_block?.type === "text" && typeof data.content_block.text === "string"
      ? data.content_block.text
      : undefined;
  const hasThinkingProgress = deltaType === "thinking_delta"
    && typeof data.delta?.thinking === "string"
    && data.delta.thinking.length > 0;
  const hasToolProgress = deltaType === "input_json_delta"
    && typeof data.delta?.partial_json === "string"
    && data.delta.partial_json.length > 0;
  const hasClientToolProgress = hasToolProgress && activeBlock?.content.type === "tool_use";
  const hasSearchProgress = hasToolProgress
    && activeBlock?.content.type === "server_tool_use"
    && activeBlock.content.name === "web_search";
  const usage = data.message?.usage ?? data.usage;
  const initialThinking = type === "content_block_start" && data.content_block?.type === "thinking"
    ? (data.content_block as { thinking?: unknown }).thinking : undefined;
  const thinking = hasThinkingProgress ? data.delta?.thinking as string
    : typeof initialThinking === "string" ? initialThinking : undefined;
  const isSearchStart = type === "content_block_start"
    && data.content_block?.type === "server_tool_use"
    && data.content_block.name === "web_search";
  const initialSearchQuery = isSearchStart && data.content_block?.input
    && typeof data.content_block.input === "object"
    && typeof (data.content_block.input as { query?: unknown }).query === "string"
      ? (data.content_block.input as { query: string }).query
      : undefined;
  const isSearchResult = type === "content_block_start"
    && data.content_block?.type === "web_search_tool_result";
  const searchContent = data.content_block?.content;
  const searchError = isSearchResult && searchContent && typeof searchContent === "object"
    && !Array.isArray(searchContent)
    && (searchContent as { type?: unknown }).type === "web_search_tool_result_error"
      ? nativeWebSearchError(searchContent) : undefined;
  const searchId = typeof data.content_block?.id === "string"
    ? data.content_block.id
    : typeof data.content_block?.tool_use_id === "string"
      ? data.content_block.tool_use_id
      : typeof activeBlock?.content.id === "string"
        ? activeBlock.content.id
      : `web-search-${String(data.index ?? 0)}`;
  const searchSources = isSearchResult ? anthropicSearchSources(data.content_block?.content) : [];
  const blockCitations = Array.isArray(data.content_block?.citations) ? data.content_block.citations : [];
  const citations = [data.delta?.citation, ...blockCitations]
    .map(normalizeAnthropicCitation)
    .filter((citation): citation is ModelUrlCitation => Boolean(citation));
  const completedNativeItems = type === "content_block_stop" && activeBlock
    ? [completeAnthropicBlock(activeBlock)]
    : type === "message_stop"
      ? [...blocks.values()].map(completeAnthropicBlock)
      : undefined;
  if (type === "content_block_stop") blocks.delete(blockKey);
  if (type === "message_stop") blocks.clear();
  return {
    stopReason: data.delta?.stop_reason,
    progress: Boolean(text?.length) || Boolean(thinking?.length) || hasToolProgress
      || isSearchStart || isSearchResult || type === "message_stop",
    completed: type === "message_stop",
    thoughts: thinking ? [{
      text: thinking,
      itemId: data.index !== undefined ? String(data.index) : undefined,
      source: "summary"
    }] : undefined,
    assistantText: text ? {
      text,
      itemId: data.index !== undefined ? String(data.index) : undefined
    } : undefined,
    reasoningContent: thinking,
    webSearchArguments: hasSearchProgress
      ? [{ id: searchId, delta: data.delta?.partial_json as string }]
      : undefined,
    webSearchCalls: isSearchStart ? [{
      id: searchId,
      status: "in_progress",
      ...(initialSearchQuery ? { query: initialSearchQuery } : {}),
      sources: []
    }] : isSearchResult && !searchError ? [{
      id: searchId,
      status: "completed",
      sources: searchSources
    }] : undefined,
    webSearchError: searchError,
    citations: citations.length > 0 ? citations : undefined,
    nativeItems: completedNativeItems,
    toolCalls: data.content_block?.type === "tool_use" ? [{
      key: String(data.index ?? 0),
      id: typeof data.content_block.id === "string" ? data.content_block.id : undefined,
      name: typeof data.content_block.name === "string" ? data.content_block.name : undefined,
      arguments: data.content_block.input && typeof data.content_block.input === "object"
        && Object.keys(data.content_block.input as Record<string, unknown>).length > 0
        ? JSON.stringify(data.content_block.input)
        : undefined
    }] : hasClientToolProgress ? [{
      key: String(data.index ?? 0),
      argumentsDelta: data.delta?.partial_json as string
    }] : undefined,
    generationId: data.message?.id,
    inputTokensReported: validTokenCount(usage?.input_tokens),
    outputTokensReported: validTokenCount(usage?.output_tokens),
    usage: usage ? anthropicUsage(usage) : undefined
  };
}

export function createAnthropicStreamReader(): StreamEventReader {
  const blocks = new Map<string, AnthropicStreamBlock>();
  return event => readAnthropicMessagesStreamEvent(event, blocks);
}
