import type { ModelCapabilities, ModelDeployment } from "../config.js";
import type { ModelRoundRequest } from "./types.js";

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  imageInput: false,
  functionTools: true,
  hostedTools: [],
  delegatedTools: [],
  reasoningReplay: false
};

export function modelCapabilities(route: ModelDeployment): ModelCapabilities {
  const capabilities = route.capabilities ?? DEFAULT_CAPABILITIES;
  return {
    ...capabilities,
    delegatedTools: capabilities.delegatedTools ?? [],
    serviceTools: capabilities.serviceTools ?? []
  };
}

export function requestedCapabilities(request: ModelRoundRequest): {
  imageInput: boolean;
  functionTools: boolean;
  hostedTools: string[];
} {
  return {
    imageInput: request.messages.some((message) => message.role === "user" && Boolean(message.images?.length)),
    functionTools: request.tools.some((tool) => tool.type === "function"),
    hostedTools: request.tools.filter((tool) => tool.type !== "function").map((tool) => tool.type)
  };
}

export function routeSupportsRequest(route: ModelDeployment, request: ModelRoundRequest): boolean {
  const available = modelCapabilities(route);
  const required = requestedCapabilities(request);
  const supportsHostedTool = (tool: string): boolean =>
    available.hostedTools.includes(tool as "web_search")
    || Boolean((available.delegatedTools?.includes(tool as "web_search")
      || available.serviceTools?.includes(tool as "web_search")) && available.functionTools);
  return (!required.imageInput || available.imageInput)
    && (!required.functionTools || available.functionTools)
    && required.hostedTools.every(supportsHostedTool);
}

export function missingCapabilities(route: ModelDeployment, request: ModelRoundRequest): string[] {
  const available = modelCapabilities(route);
  const required = requestedCapabilities(request);
  const supportsHostedTool = (tool: string): boolean =>
    available.hostedTools.includes(tool as "web_search")
    || Boolean((available.delegatedTools?.includes(tool as "web_search")
      || available.serviceTools?.includes(tool as "web_search")) && available.functionTools);
  return [
    ...(required.imageInput && !available.imageInput ? ["image_input"] : []),
    ...(required.functionTools && !available.functionTools ? ["function_tools"] : []),
    ...required.hostedTools.filter((tool) => !supportsHostedTool(tool))
  ];
}
