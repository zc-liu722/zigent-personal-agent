import { mcpTextParts } from "../mcp/content.js";
import type { McpOAuthAccount } from "../mcp/account.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { notionFetch, withNotionConnection, notionAuthorizationInProgress } from "./connection.js";
import {
  FileNotionOAuthProvider,
  NOTION_MCP_SERVER_URL
} from "./oauth.js";

export type NotionCapability = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  destructive: boolean;
};

export type NotionCallResult = {
  operation: string;
  content: string;
  truncated: boolean;
  resources: Array<{ title: string; url: string }>;
};

export type NotionMcpGateway = {
  listCapabilities(signal?: AbortSignal): Promise<NotionCapability[]>;
  call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<NotionCallResult>;
};

export class NotionAuthorizationRequiredError extends Error {
  constructor() {
    super("Notion 尚未授权或授权已失效");
    this.name = "NotionAuthorizationRequiredError";
  }
}

export class NotionPermissionError extends Error {
  constructor() { super("Notion 当前账号或工作区无权访问该页面。请检查页面共享权限、所选工作区及管理员限制；需要切换账号或重新连接时使用 authorize。"); }
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

const MAX_CONTENT_CHARACTERS = 80_000;
const CALL_TIMEOUT_MS = 60_000;
const CAPABILITY_CACHE_MS = 5 * 60_000;
const KNOWN_READ_OPERATIONS = [
  /^(?:notion_)?(?:search|fetch|get_self|get_users|get_user|get_teams|query_data_sources|query_database)$/i
];
const KNOWN_DESTRUCTIVE_OPERATIONS = [
  /(?:^|_)(?:delete|remove|clear|archive|move)(?:_|$)/i
];

export function safeNotionUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && /(^|\.)(notion\.so|notion\.site|notion\.com)$/.test(url.hostname)
      && !/oauth|authorize|callback|token/i.test(url.pathname);
  } catch { return false; }
}

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

function toCapability(tool: McpTool): NotionCapability {
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
    if (/token|secret|cookie|authorization/i.test(key) || key === "_meta" || key === "data") return undefined;
    if (typeof entry === "string" && entry.length > MAX_CONTENT_CHARACTERS) {
      return `${entry.slice(0, MAX_CONTENT_CHARACTERS)}\n[内容过长，已截断]`;
    }
    return entry;
  }, 2);
}

function readableContent(result: Record<string, unknown>): { content: string; truncated: boolean } {
  const parts = mcpTextParts(result.content, "Notion 内容");
  if (result.structuredContent !== undefined) parts.push(safeJson(result.structuredContent));
  if (parts.length === 0) parts.push("Notion 未返回可读取的文本内容；不要将附件或空结果当作完整笔记。");
  const full = parts.filter(Boolean).join("\n\n");
  if (full.length <= MAX_CONTENT_CHARACTERS) return { content: full, truncated: false };
  return {
    content: `${full.slice(0, MAX_CONTENT_CHARACTERS)}\n\n[Notion 返回内容过长，已截断；请缩小读取或修改范围]`,
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
    safeNotionUrl(entry)
  );
  if (url) {
    const title = [record.title, record.name].find((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
    found.set(url, title?.trim() ?? "Notion 内容");
  }
  for (const [key, entry] of Object.entries(record)) {
    if (/token|secret|cookie|authorization/i.test(key) || key === "_meta") continue;
    collectResources(entry, found, depth + 1);
  }
  return found;
}

function validateOperation(operation: string): string {
  const value = operation.trim();
  if (!value || value.length > 200) throw new Error("Notion operation must be a non-empty capability name");
  return value;
}

export function createNotionMcpGateway(
  account: McpOAuthAccount,
  serverUrl = NOTION_MCP_SERVER_URL,
  proxyUrl?: string,
  callbackUrl?: string
): NotionMcpGateway {
  const { storagePath } = account;
  if (serverUrl !== NOTION_MCP_SERVER_URL) throw new Error("Notion 必须使用官方云端 MCP 地址");
  const request = notionFetch(proxyUrl);
  let capabilityCache: { loadedAt: number; capabilities: NotionCapability[] } | undefined;

  async function withClient<T>(
    signal: AbortSignal | undefined,
    action: (client: Client) => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted();
    if (await notionAuthorizationInProgress(storagePath)) throw new NotionAuthorizationRequiredError();
    return withNotionConnection(storagePath, async () => {
      if (await notionAuthorizationInProgress(storagePath)) throw new NotionAuthorizationRequiredError();
      const provider = new FileNotionOAuthProvider(account, undefined, callbackUrl);
      await provider.selectServer(serverUrl);
      if (!(await provider.tokens())) throw new NotionAuthorizationRequiredError();
      const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider, fetch: request });
      const client = new Client({ name: "zigent-notion", version: "1.0.0" });
      try {
        await client.connect(transport, { signal, timeout: CALL_TIMEOUT_MS });
        return await action(client);
      } catch (error) {
        if (error instanceof UnauthorizedError || error instanceof InvalidGrantError || (error instanceof StreamableHTTPError && error.code === 401)) {
          capabilityCache = undefined;
          await provider.invalidateCredentials("tokens");
          throw new NotionAuthorizationRequiredError();
        }
        if (error instanceof StreamableHTTPError && error.code === 403) throw new NotionPermissionError();
        if (error instanceof NotionPermissionError) throw error;
        signal?.throwIfAborted();
        throw new Error("Notion 请求未完成，可能受网络、限流或服务状态影响。请稍后重试；修改结果不确定时先读取页面核实，勿直接重复写入。");
      } finally {
        await client.close().catch(() => undefined);
      }
    }, signal);
  }

  async function tools(client: Client, signal?: AbortSignal): Promise<McpTool[]> {
    const found: McpTool[] = [];
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: CALL_TIMEOUT_MS });
      found.push(...result.tools as McpTool[]);
      cursor = result.nextCursor;
      if (cursor && (cursors.has(cursor) || found.length > 500)) throw new Error("Notion capability pagination failed");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return found;
  }

  async function listCapabilities(signal?: AbortSignal): Promise<NotionCapability[]> {
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
      if (!capability) throw new Error("Requested Notion capability is unavailable; refresh capabilities and try again");
      return withClient(signal, async (client) => {
        const result = await client.callTool({ name: capability.name, arguments: args }, undefined, {
          signal,
          timeout: CALL_TIMEOUT_MS
        }) as Record<string, unknown>;
        if (result.isError) {
          const text = readableContent(result).content;
          if (/unauthorized|invalid_grant|invalid.{0,10}token|token.{0,10}(expired|invalid)/i.test(text)) {
            throw new UnauthorizedError();
          }
          if (/restricted_resource|object_not_found|permission|forbidden|could not find|not found|not.{0,10}shared/i.test(text)) throw new NotionPermissionError();
          throw new Error("Notion operation failed");
        }
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

function destructiveArguments(args: Record<string, unknown>, depth = 0): boolean {
  if (args.in_trash === true || args.archived === true || args.allow_deleting_content === true
    || (typeof args.command === "string" && /^(delete_content|replace_content|move|archive|delete)$/.test(args.command))) return true;
  // Some Notion tools wrap their command payload in `data` (object or JSON string).
  if (depth >= 3) return false;
  let nested = args.data;
  if (typeof nested === "string") { try { nested = JSON.parse(nested); } catch { return false; } }
  return !!nested && typeof nested === "object" && !Array.isArray(nested)
    && destructiveArguments(nested as Record<string, unknown>, depth + 1);
}

export function notionOperationSafety(capability: Pick<NotionCapability, "name" | "readOnly" | "destructive">, args: Record<string, unknown> = {}): {
  readOnly: boolean;
  requiresConfirmation: boolean;
} {
  const name = normalizedOperation(capability.name);
  const destructive = destructiveArguments(args) || capability.destructive || KNOWN_DESTRUCTIVE_OPERATIONS.some(pattern => pattern.test(name));
  return {
    readOnly: !destructive && capability.readOnly,
    requiresConfirmation: destructive
  };
}
