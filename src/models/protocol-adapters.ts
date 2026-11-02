import { effectiveReasoningEffort } from "./reasoning.js";
import type { ModelDeployment, ModelProtocol } from "../config.js";
import {
  anthropicConversation,
  anthropicToolDefinitions,
  delegatedWebSearchDefinition,
  openAiConversation,
  openAiToolDefinitions
} from "./provider-formats.js";
import type { ModelRoundRequest, ModelRouteMetadata, ModelTool } from "./types.js";

export type ProtocolRequest = {
  url: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  protocol: ModelProtocol;
};

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function responseEndpoint(baseUrl: string): string {
  return `${normalizedBaseUrl(baseUrl)}/responses`;
}

export function anthropicMessagesEndpoint(baseUrl: string): string {
  const normalized = normalizedBaseUrl(baseUrl);
  return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}

function metadata(route: ModelDeployment): ModelRouteMetadata {
  return {
    name: route.name,
    brand: route.brand,
    supplier: route.supplier,
    apiModel: route.apiModel,
    protocol: route.protocol,
    cost: route.cost,
    capabilities: route.capabilities ?? {
      imageInput: false,
      functionTools: true,
      hostedTools: [],
      delegatedTools: [],
      reasoningReplay: false
    }
  };
}

function toolsForRoute(route: ModelRouteMetadata, tools: readonly ModelTool[]): ModelTool[] {
  return tools.map((tool) => tool.type === "web_search"
    && (route.capabilities.delegatedTools?.includes("web_search")
      || route.capabilities.serviceTools?.includes("web_search"))
    ? delegatedWebSearchDefinition()
    : tool);
}

export function buildProtocolRequest(
  route: ModelDeployment,
  request: ModelRoundRequest,
  includeReasoningSummary: boolean
): ProtocolRequest {
  if (route.protocol === "codex-app-server" || route.protocol === "claude-code") {
    throw new Error("Official-client routes require their dedicated transport");
  }
  if (!route.baseUrl || !route.apiKey) {
    throw new Error(`${route.name} is missing HTTP transport configuration`);
  }
  const routeMetadata = metadata(route);
  const effort = effectiveReasoningEffort(route, request);
  const nativeMoonshot = route.supplier === "moonshot-official" || route.supplier === "kimicode";
  // Moonshot Responses does not accept tool_choice=none; omitting tool definitions
  // is its supported way to request a text-only continuation after a tool result.
  const routeTools = nativeMoonshot && request.toolChoice === "none"
    ? [] : toolsForRoute(routeMetadata, request.tools);
  if (route.protocol === "anthropic-messages") {
    const hasHostedSearch = routeTools.some((tool) => tool.type === "web_search");
    const hasFunctionTools = routeTools.some((tool) => tool.type === "function");
    return {
      protocol: route.protocol,
      url: anthropicMessagesEndpoint(route.baseUrl),
      headers: {
        "x-api-key": route.apiKey,
        "anthropic-version": "2023-06-01",
        ...(request.nativeContext?.route === route.name && route.context?.strategy === "anthropic-native"
          ? { "anthropic-beta": "compact-2026-09-04" } : {})
      },
      payload: {
        model: route.apiModel,
        max_tokens: request.maxOutputTokens ?? route.maxTokens ?? 4096,
        ...(route.supplier === "deepseek-official" && route.reasoning ? {
          thinking: { type: effort === "none" ? "disabled" : "enabled" }
        } : routeMetadata.capabilities.reasoningReplay && route.supplier !== "deepseek-official" ? {
          thinking: {
            type: "adaptive",
            display: includeReasoningSummary ? "summarized" : "omitted"
          }
        } : {}),
        ...(route.supplier === "deepseek-official" && effort === "none" ? {} : { output_config: { effort } }),
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages: request.nativeContext?.route === route.name && request.nativeContext.protocol === route.protocol
          ? request.nativeContext.items : anthropicConversation(request.messages, routeMetadata),
        ...(routeTools.length > 0 ? {
          tools: anthropicToolDefinitions(routeTools),
          ...(request.toolChoice === "none" ? { tool_choice: { type: "none" } } : hasHostedSearch && hasFunctionTools
            ? { tool_choice: { type: request.toolChoice === "required" ? "any" : "auto", disable_parallel_tool_use: true } }
            : request.toolChoice === "required" ? { tool_choice: { type: "any" } } : {})
        } : {}),
        stream: true
      }
    };
  }

  const include = [
    ...(route.supplier !== "volcengine-official" && routeTools.some((tool) => tool.type === "web_search")
      ? ["web_search_call.action.sources"] : []),
    ...(routeMetadata.capabilities.reasoningReplay && !nativeMoonshot ? ["reasoning.encrypted_content"] : [])
  ];
  return {
    protocol: route.protocol,
    url: responseEndpoint(route.baseUrl),
    ...(route.supplier === "kimicode" ? {
      headers: { Authorization: `Bearer ${route.apiKey}`, "User-Agent": "zigent/0.1.0" }
    } : {}),
    payload: {
      model: route.apiModel,
      ...(request.maxOutputTokens ?? route.maxTokens ? { max_output_tokens: request.maxOutputTokens ?? route.maxTokens } : {}),
      ...(request.systemPrompt ? { instructions: request.systemPrompt } : {}),
      ...(route.supplier === "volcengine-official" ? route.reasoning ? {
        thinking: { type: effort === "minimal" ? "disabled" : "enabled" },
        reasoning: { effort }
      } : {} : {
        reasoning: {
          effort,
          ...(includeReasoningSummary && !nativeMoonshot ? { summary: "auto" } : {})
        }
      }),
      input: request.nativeContext?.route === route.name && request.nativeContext.protocol === route.protocol
        ? request.nativeContext.items : openAiConversation(request.messages, routeMetadata),
      ...(routeTools.length > 0 ? {
        tools: openAiToolDefinitions(routeTools, routeMetadata),
        tool_choice: request.toolChoice ?? "auto"
      } : {}),
      ...(include.length > 0 ? { include } : {}),
      store: false,
      stream: true
    }
  };
}
