import type { ReferenceImage as ModelInputImage } from "../image-generation.js";
import { assistantReplayText, renderSearchEvidence } from "./search-evidence.js";
import type {
  ModelConversationMessage,
  ModelFunctionTool,
  ModelRouteMetadata,
  ModelTool,
  ModelWebSearchTool
} from "./types.js";

function imageDataUrl(image: ModelInputImage): string {
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

function openAiUserContent(text: string, images: readonly ModelInputImage[]): unknown {
  if (images.length === 0) return text;
  return [
    { type: "input_text", text },
    ...images.map((image) => ({ type: "input_image", image_url: imageDataUrl(image) }))
  ];
}

function anthropicUserContent(text: string, images: readonly ModelInputImage[]): unknown {
  if (images.length === 0) return text;
  return [
    { type: "text", text },
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.data.toString("base64") }
    }))
  ];
}

export function openAiToolDefinitions(definitions: readonly ModelTool[], route?: ModelRouteMetadata): Array<Record<string, unknown>> {
  return definitions.map((definition) => definition.type === "web_search"
    ? route?.supplier === "volcengine-official" ? {
        type: "web_search",
        sources: ["doubao"]
      } : {
        type: "web_search",
        ...(definition.search_context_size ? { search_context_size: definition.search_context_size } : {}),
        ...(definition.filters ? { filters: definition.filters } : {}),
        ...(definition.user_location ? { user_location: definition.user_location } : {}),
        ...(definition.external_web_access !== undefined
          ? { external_web_access: definition.external_web_access }
          : {})
      }
    : {
        type: "function",
        name: definition.name,
        description: definition.description,
        parameters: definition.input_schema
      });
}

export function delegatedWebSearchDefinition(): ModelFunctionTool {
  return {
    type: "function",
    name: "web_search",
    description: [
      "Search the public web for current or externally verifiable information.",
      "Prefer this tool over browser automation for public research.",
      "Call this when the answer depends on recent events, prices, rules, product updates, or sources the user asked you to verify.",
      "If the user provides one or more URLs, include each exact URL in the query together with the user's information need and any useful keywords; when no URL is provided, use an appropriate keyword query.",
      "Use returned evidence and source links; do not present snippets, user-provided material or inference as original-page verification."
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "A concise, standalone web retrieval query. Include every exact URL supplied by the user together with their information need and any useful keywords; otherwise use an appropriate keyword query."
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  };
}

function anthropicWebSearchDefinition(definition: ModelWebSearchTool): Record<string, unknown> {
  return {
    type: "web_search_20250305",
    name: "web_search",
    ...(definition.filters?.allowed_domains
      ? { allowed_domains: definition.filters.allowed_domains }
      : {}),
    ...(definition.user_location ? { user_location: definition.user_location } : {})
  };
}

export function anthropicToolDefinitions(definitions: readonly ModelTool[]): Array<Record<string, unknown>> {
  return definitions.map((definition) => definition.type === "web_search"
    ? anthropicWebSearchDefinition(definition)
    : {
        name: definition.name,
        description: definition.description,
        input_schema: definition.input_schema
      });
}

function nativeStateMatches(
  message: Extract<ModelConversationMessage, { role: "assistant" }>,
  route?: ModelRouteMetadata
): boolean {
  const state = message.nativeState;
  return Boolean(state && route
    && state.protocol === route.protocol
    && state.brand === route.brand
    && state.supplier === route.supplier
    && state.apiModel === route.apiModel);
}

export function anthropicConversation(
  messages: readonly ModelConversationMessage[],
  route?: ModelRouteMetadata
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "user") {
      output.push({ role: "user", content: anthropicUserContent(message.text, message.images ?? []) });
      continue;
    }
    if (message.role === "assistant") {
      output.push({
        role: "assistant",
        content: nativeStateMatches(message, route) ? [...message.nativeState!.items,
          ...(message.searchEvidence ? [{ type: "text", text: renderSearchEvidence(message.searchEvidence) }] : [])] : [
          ...(assistantReplayText(message) ? [{ type: "text", text: assistantReplayText(message) }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.input }))
        ]
      });
      continue;
    }
    const toolResult = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.value,
      ...(message.failed ? { is_error: true } : {})
    };
    const previous = output.at(-1) as { role?: unknown; content?: unknown } | undefined;
    if (previous?.role === "user" && Array.isArray(previous.content)
      && previous.content.every((item) => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "tool_result")) {
      previous.content.push(toolResult);
    } else {
      output.push({ role: "user", content: [toolResult] });
    }
  }
  return output;
}

export function openAiConversation(
  messages: readonly ModelConversationMessage[],
  route?: ModelRouteMetadata
): Array<Record<string, unknown>> {
  return messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === "user") {
      return [{ role: "user", content: openAiUserContent(message.text, message.images ?? []) }];
    }
    if (message.role === "tool") {
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.value }];
    }
    if (nativeStateMatches(message, route)) {
      return [...message.nativeState!.items.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
      ), ...(message.searchEvidence ? [{ role: "assistant", content: renderSearchEvidence(message.searchEvidence) }] : [])];
    }
    const textItems = [...(message.textItems?.length
      ? message.textItems
      : message.text ? [{ text: message.text }] : []),
      ...(message.searchEvidence ? [{ text: renderSearchEvidence(message.searchEvidence) }] : [])];
    return [
      ...textItems.map((item) => ({
        role: "assistant",
        content: item.text,
        ...(item.phase ? { phase: item.phase } : {})
      })),
      ...message.toolCalls.map((call) => ({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments
      }))
    ];
  });
}
