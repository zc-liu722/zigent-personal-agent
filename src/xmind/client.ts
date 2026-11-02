import { mcpTextParts } from "../mcp/content.js";
import type { McpOAuthAccount } from "../mcp/account.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  FileXmindOAuthProvider,
  XMIND_MCP_SERVER_URL
} from "./oauth.js";

export type XmindCapability = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
};

export type XmindCallResult = {
  operation: string;
  content: string;
  truncated: boolean;
  resources: Array<{ title: string; url: string }>;
};

export type XmindMcpGateway = {
  listCapabilities(signal?: AbortSignal): Promise<XmindCapability[]>;
  call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<XmindCallResult>;
};

export class XmindAuthorizationRequiredError extends Error {
  constructor() {
    super("XMind 尚未授权或授权已失效");
    this.name = "XmindAuthorizationRequiredError";
  }
}

type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
};

const MAX_CONTENT_CHARACTERS = 240_000;
const CALL_TIMEOUT_MS = 60_000;
const CAPABILITY_CACHE_MS = 5 * 60_000;
const KNOWN_READ_OPERATIONS = [
  /(?:^|_)list_(?:mind_?maps?|sheets?)(?:_|$)/i,
  /(?:^|_)read_mind_?map(?:_|$)/i,
  /(?:^|_)get_topic(?:_|$)/i
];
const KNOWN_DESTRUCTIVE_OPERATIONS = [
  /(?:^|_)(?:delete|remove|clear)(?:_|$)/i,
  /(?:^|_)edit_mind_?map(?:_|$)/i
];

function normalizedOperation(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isReadOnly(tool: McpTool): boolean {
  const name = normalizedOperation(tool.name);
  return KNOWN_READ_OPERATIONS.some((pattern) => pattern.test(name)) || tool.annotations?.readOnlyHint === true;
}

function isDestructive(tool: McpTool): boolean {
  const name = normalizedOperation(tool.name);
  return KNOWN_DESTRUCTIVE_OPERATIONS.some((pattern) => pattern.test(name)) || tool.annotations?.destructiveHint === true;
}

function toCapability(tool: McpTool): XmindCapability {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    readOnly: isReadOnly(tool),
    destructive: isDestructive(tool)
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (key, entry) => {
    if (/token|secret|cookie|authorization/i.test(key) || key === "_meta") return undefined;
    if (typeof entry === "string" && entry.length > MAX_CONTENT_CHARACTERS) {
      return `${entry.slice(0, MAX_CONTENT_CHARACTERS)}\n[内容过长，已截断]`;
    }
    return entry;
  }, 2);
}

function readableContent(result: Record<string, unknown>): { content: string; truncated: boolean } {
  const parts = mcpTextParts(result.content, "XMind 内容");
  if (result.structuredContent !== undefined) parts.push(safeJson(result.structuredContent));
  if (parts.length === 0) parts.push(safeJson(result));
  const full = parts.filter(Boolean).join("\n\n");
  if (full.length <= MAX_CONTENT_CHARACTERS) return { content: full, truncated: false };
  return {
    content: `${full.slice(0, MAX_CONTENT_CHARACTERS)}\n\n[XMind 返回内容过长，已截断；请缩小读取或修改范围]`,
    truncated: true
  };
}

function collectResources(value: unknown, found = new Map<string, string>(), depth = 0): Map<string, string> {
  if (depth > 6 || found.size >= 8) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectResources(item, found, depth + 1);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const record = value as Record<string, unknown>;
  const url = [record.url, record.uri, record.href].find((entry): entry is string =>
    typeof entry === "string" && /^https:\/\//i.test(entry)
  );
  if (url) {
    const title = [record.title, record.name].find((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    found.set(url, title?.trim() ?? "XMind 内容");
  }
  for (const [key, entry] of Object.entries(record)) {
    if (/token|secret|cookie|authorization/i.test(key) || key === "_meta") continue;
    collectResources(entry, found, depth + 1);
  }
  return found;
}

function validateOperation(operation: string): string {
  const value = operation.trim();
  if (!value || value.length > 200) throw new Error("XMind operation must be a non-empty capability name");
  return value;
}

export function createXmindMcpGateway(
  account: McpOAuthAccount,
  serverUrl = XMIND_MCP_SERVER_URL
): XmindMcpGateway {
  let capabilityCache: { loadedAt: number; capabilities: XmindCapability[] } | undefined;

  async function withClient<T>(
    signal: AbortSignal | undefined,
    action: (client: Client) => Promise<T>
  ): Promise<T> {
    const provider = new FileXmindOAuthProvider(account);
    await provider.selectServer(serverUrl);
    if (!(await provider.tokens())) throw new XmindAuthorizationRequiredError();
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider });
    const client = new Client({ name: "zigent-xmind", version: "1.0.0" });
    try {
      await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
      return await action(client);
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        throw new XmindAuthorizationRequiredError();
      }
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async function tools(client: Client, signal?: AbortSignal): Promise<McpTool[]> {
    const result = await client.listTools(undefined, { signal, timeout: CALL_TIMEOUT_MS });
    return result.tools as McpTool[];
  }

  async function listCapabilities(signal?: AbortSignal): Promise<XmindCapability[]> {
    if (capabilityCache && Date.now() - capabilityCache.loadedAt < CAPABILITY_CACHE_MS) {
      return capabilityCache.capabilities;
    }
    const capabilities = await withClient(signal, async (client) =>
      (await tools(client, signal)).map(toCapability)
    );
    capabilityCache = { loadedAt: Date.now(), capabilities };
    return capabilities;
  }

  return {
    listCapabilities,
    call: async (operation, args, signal) => {
      const requested = validateOperation(operation);
      const capability = (await listCapabilities(signal)).find((candidate) => candidate.name === requested);
      if (!capability) throw new Error("Requested XMind capability is unavailable; refresh capabilities and try again");
      return withClient(signal, async (client) => {
        const result = await client.callTool({ name: capability.name, arguments: args }, undefined, {
          signal,
          timeout: CALL_TIMEOUT_MS
        }) as Record<string, unknown>;
        if (result.isError) throw new Error(`XMind could not complete ${capability.name}`);
        const readable = readableContent(result);
        return {
          operation: capability.name,
          ...readable,
          resources: [...collectResources(result)].map(([url, title]) => ({ title, url }))
        };
      });
    }
  };
}

export function xmindOperationSafety(capability: Pick<XmindCapability, "name" | "readOnly" | "destructive">): {
  readOnly: boolean;
  requiresConfirmation: boolean;
} {
  const name = normalizedOperation(capability.name);
  return {
    readOnly: capability.readOnly,
    requiresConfirmation: !capability.readOnly && (
      capability.destructive || KNOWN_DESTRUCTIVE_OPERATIONS.some((pattern) => pattern.test(name))
    )
  };
}
