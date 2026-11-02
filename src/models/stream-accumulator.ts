import { ModelInvalidResponseError } from "./errors.js";
import type { ModelTextResult, StreamUpdate } from "./stream-types.js";
import { mergeUsage, zeroUsage } from "./stream-usage.js";
import type { ModelAssistantTextPhase, ModelUrlCitation, ModelWebSearchCall } from "./types.js";

/** Aggregates supplier-neutral updates; it never reads bytes or interprets protocol event names. */
export function createStreamAccumulator() {
  let text = "";
  const textItemBuffers = new Map<string, { text: string; phase?: ModelAssistantTextPhase }>();
  const textItemPhases = new Map<string, ModelAssistantTextPhase>();
  let reasoningContent = "";
  let completed = false;
  let stopReason: string | undefined;
  let usage = zeroUsage();
  const pendingToolCalls = new Map<string, { id?: string; name?: string; arguments: string }>();
  const webSearchCalls = new Map<string, ModelWebSearchCall>();
  const webSearchArguments = new Map<string, string>();
  const citations = new Map<string, ModelUrlCitation>();
  const nativeItems = new Map<string, unknown>();

  function apply(update: StreamUpdate): StreamUpdate {
    if (update.stopReason) stopReason = update.stopReason;
    for (const item of update.textItemPhases ?? []) {
      textItemPhases.set(item.itemId, item.phase);
      const existing = textItemBuffers.get(item.itemId);
      if (existing) existing.phase = item.phase;
    }
    if (update.assistantText) {
      text += update.assistantText.text;
      const itemId = update.assistantText.itemId ?? "text-0";
      const existing = textItemBuffers.get(itemId) ?? {
        text: "",
        phase: textItemPhases.get(itemId)
      };
      existing.text += update.assistantText.text;
      textItemBuffers.set(itemId, existing);
      update.assistantText.phase ??= existing.phase;
    }
    if (update.reasoningContent) reasoningContent += update.reasoningContent;
    if (update.completed) completed = true;
    for (const toolCall of update.toolCalls ?? []) {
      const key = !pendingToolCalls.has(toolCall.key)
        && pendingToolCalls.size === 1
        && !toolCall.name
        ? [...pendingToolCalls.keys()][0]!
        : toolCall.key;
      const existing = pendingToolCalls.get(key) ?? { arguments: "" };
      if (toolCall.id) existing.id = toolCall.id;
      if (toolCall.name) existing.name = toolCall.name;
      if (toolCall.arguments !== undefined) existing.arguments = toolCall.arguments;
      if (toolCall.argumentsDelta) existing.arguments += toolCall.argumentsDelta;
      pendingToolCalls.set(key, existing);
    }
    for (const argument of update.webSearchArguments ?? []) {
      const value = `${webSearchArguments.get(argument.id) ?? ""}${argument.delta}`;
      webSearchArguments.set(argument.id, value);
      try {
        const input = JSON.parse(value) as { query?: unknown };
        if (typeof input.query === "string") {
          const existing = webSearchCalls.get(argument.id);
          webSearchCalls.set(argument.id, {
            id: argument.id,
            status: existing?.status ?? "in_progress",
            query: input.query,
            sources: existing?.sources ?? []
          });
        }
      } catch {
        // Anthropic streams tool JSON in fragments; parse once the object is complete.
      }
    }
    for (const searchCall of update.webSearchCalls ?? []) {
      const existing = webSearchCalls.get(searchCall.id);
      webSearchCalls.set(searchCall.id, {
        ...existing,
        ...searchCall,
        sources: searchCall.sources.length > 0 ? searchCall.sources : existing?.sources ?? []
      });
    }
    for (const citation of update.citations ?? []) {
      citations.set(`${citation.url}\0${citation.startIndex ?? ""}\0${citation.endIndex ?? ""}`, citation);
    }
    for (const [index, item] of (update.nativeItems ?? []).entries()) {
      const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
        ? (item as { id: string }).id
        : `${nativeItems.size + index}`;
      nativeItems.set(id, item);
    }
    if (update.usage) {
      usage = mergeUsage(usage, update.usage);
    }
    return { ...update, webSearchCalls: update.webSearchCalls?.map(call => webSearchCalls.get(call.id) ?? call) };
  }
  function result(): ModelTextResult & { completed: boolean } {
    const toolCalls = [...pendingToolCalls.entries()].map(([key, call]) => {
      if (!call.name) throw new ModelInvalidResponseError("Model returned a tool call without a name");
      let input: unknown;
      try {
        input = call.arguments.trim() ? JSON.parse(call.arguments) as unknown : {};
      } catch {
        throw new ModelInvalidResponseError(`Model returned invalid JSON arguments for tool ${call.name}`);
      }
      return { id: call.id ?? key, name: call.name, input, arguments: call.arguments || "{}" };
    });
    const citationList = [...citations.values()];
    return {
      text,
      textItems: [...textItemBuffers.entries()]
        .filter(([, item]) => item.text.length > 0)
        .map(([itemId, item]) => ({ itemId, ...item })),
      completed,
      stopReason,
      usage,
      toolCalls,
      webSearchCalls: [...webSearchCalls.values()],
      citations: citationList,
      reasoningContent: reasoningContent || undefined,
      nativeItems: [...nativeItems.values()]
    };
  }
  return { apply, result, get completed() { return completed; }, complete: () => { completed = true; } };
}
