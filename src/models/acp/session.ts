import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assistantReplayText } from "../search-evidence.js";
import type { ModelConversationMessage, ModelFunctionTool, ModelToolExecutionResult } from "../types.js";

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object) : [];
export const modelOptions = (options: unknown) =>
  array(options).filter(item => item.category === "model" || item.id === "model");

export type AcpToolHandler = (id: string | number, name: string, input: Record<string, unknown>) =>
  Promise<ModelToolExecutionResult | undefined>;

/** The HTTP endpoint and exact tool definitions belong to the supplier session.
 * Capture the current handler before reading the body, and recheck its identity
 * before dispatch. An old connection may never carry work into a later turn. */
export class AcpToolBridge {
  private readonly token = randomBytes(32).toString("hex");
  private readonly server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 },
    (req, res) => { void this.handle(req, res); });
  private readonly sockets = new Set<IncomingMessage["socket"]>();
  handler?: AcpToolHandler;

  constructor(private readonly definitions: ReadonlyMap<string, ModelFunctionTool>) {
    this.server.on("connection", socket => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
  }

  async listen() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("ACP tool bridge has no port");
    return [{ type: "http", name: "zigent", url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${this.token}` }] }];
  }

  async close(): Promise<void> {
    this.handler = undefined;
    if (this.server.listening) await new Promise<void>(resolve => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  unbind(): void {
    this.handler = undefined;
    // Tool callbacks in flight were captured by the previous handler.
    // Ending their socket also prevents HTTP keep-alive reuse across turns.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const handler = this.handler;
    const reply = (status: number, body?: object) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body && JSON.stringify(body));
    };
    if (req.url !== "/mcp" || req.headers.authorization !== `Bearer ${this.token}`) { reply(403); return; }
    if (req.method !== "POST") { reply(405); return; }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { reply(413); return; }
        chunks.push(chunk);
      }
      const { id, method, params } = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (id === undefined) { reply(202); return; }
      if (typeof id !== "string" && typeof id !== "number") { reply(400); return; }
      const response = (result: object) => reply(200, { jsonrpc: "2.0", id, result });
      const error = (code: number, message: string) => reply(200, { jsonrpc: "2.0", id, error: { code, message } });
      if (method === "initialize") {
        const version = object(params).protocolVersion;
        response({ protocolVersion: version === "2025-06-18" ? version : "2025-03-26", capabilities: { tools: {} },
          serverInfo: { name: "zigent", version: "1.0.0" } });
      } else if (method === "ping") response({});
      else if (method === "tools/list") response({ tools: [...this.definitions.values()].map(tool =>
        ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })) });
      else if (method === "tools/call") {
        const { name, arguments: input } = object(params);
        if (!handler || this.handler !== handler
          || typeof name !== "string" || !this.definitions.has(name)) { error(-32601, "Tool unavailable"); return; }
        if (input !== undefined && input !== object(input)) { error(-32602, "Expected an argument object"); return; }
        const result = await handler(id, name, object(input));
        if (!result) { error(-32602, "Tool unavailable or request ID was reused"); return; }
        response({ content: [{ type: "text", text: result.text }, ...(result.images ?? []).map(image => ({
          type: "image", mimeType: image.mimeType, data: image.data.toString("base64")
        }))], isError: result.failed });
      } else error(-32601, "Method unavailable");
    } catch { if (!res.headersSent) reply(400); }
  }
}

export type AcpSession = {
  id: string;
  binding: string;
  conversationKey?: string;
  sessionKey?: string;
  bridge?: AcpToolBridge;
  closeBridge(): Promise<void>;
  confirmed: boolean;
};

export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function transcriptEntry(message: ModelConversationMessage) {
  if (message.role === "assistant") return { role: message.role, text: assistantReplayText(message),
    toolCalls: message.toolCalls.map(call => ({ id: call.id, name: call.name, arguments: call.arguments })) };
  if (message.role === "tool") return message;
  return { role: message.role, text: message.text };
}
export const runtimeContext = (message: ModelConversationMessage): boolean =>
  message.role === "user" && (message.contextRole === "pinned" || message.contextRole === "volatile");

export function historyDigest(messages: readonly ModelConversationMessage[]): string {
  return digest(messages.filter(message => !runtimeContext(message)).map(message => message.role === "user"
    ? [transcriptEntry(message), (message.images ?? []).map(image => [image.mimeType,
      createHash("sha256").update(image.data).digest("hex")])]
    : transcriptEntry(message)));
}
