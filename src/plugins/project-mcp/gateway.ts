import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { LocationReceiverConfig } from "../../config/types.js";
import { data, json } from "../../web/http.js";
import { maxRequestBytes, projectMcpLocalPath, projectMcpPath, projectMcpTokenHeader, projectMcpTools,
  type ProjectMcpTool } from "./contracts.js";
import { projectMcpAuthorized } from "./credential.js";

type Settings = NonNullable<LocationReceiverConfig["projectMcp"]>;
const toolError = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

export function createProjectMcpGateway(settings?: Settings) {
  if (!settings) return undefined;
  const targets = new Map(settings.agents.map(({ id, port }) => [id, port]));
  let active = 0;

  async function call(credential: string, agent: string, tool: ProjectMcpTool, input: unknown, signal: AbortSignal) {
    const port = targets.get(agent);
    if (!port) return { error: "This Agent is outside the project grant." };
    try {
      const response = await fetch(`http://127.0.0.1:${port}${projectMcpLocalPath}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", [projectMcpTokenHeader]: credential },
        body: JSON.stringify({ tool, input }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(34_000)])
      });
      if (response.status === 409 || response.ok) return await response.json() as { result?: Record<string, unknown>; error?: string };
      await response.body?.cancel();
      return { error: response.status === 401 ? "Project access is unauthorized." : "The Agent workspace service is unavailable. Retry shortly." };
    } catch {
      return { error: "The Agent did not confirm the operation. Check the current file before retrying a write." };
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== projectMcpPath) return false;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin !== undefined) { json(res, 403, { error: "Use a server-to-server MCP client." }); return true; }
    const credential = req.headers[projectMcpTokenHeader];
    if (typeof credential !== "string" || !await projectMcpAuthorized(settings.credentialFile, credential)) {
      json(res, 401, { error: "Project access is unauthorized." }); return true;
    }
    if (req.method !== "POST") { res.setHeader("Allow", "POST"); json(res, 405, { error: "Method not allowed." }); return true; }
    if (Number(req.headers["content-length"]) > maxRequestBytes) { json(res, 413, { error: "Project request is too large." }); return true; }
    if (active >= 8) { res.setHeader("Retry-After", "2"); json(res, 429, { error: "Too many project requests." }); return true; }
    active++;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new McpServer({ name: "zigent-projects", version: "1.0.0" });
    res.once("close", () => { active--; void server.close().catch(() => {}); });
    for (const tool of Object.keys(projectMcpTools) as ProjectMcpTool[]) {
      const spec = projectMcpTools[tool];
      server.registerTool(tool, {
        description: spec.description, inputSchema: spec.input,
        annotations: { readOnlyHint: spec.readOnly, destructiveHint: !spec.readOnly, openWorldHint: false }
      }, async (input: { agent?: string }, { signal }: { signal: AbortSignal }): Promise<CallToolResult> => {
        if (!await projectMcpAuthorized(settings.credentialFile, credential)) return toolError("Project access is unauthorized.");
        const { agent } = input;
        if (tool === "list_projects" && !agent) {
          const agents = await Promise.all([...targets.keys()].map(async id => {
            const reply = await call(credential, id, tool, input, signal);
            return reply.result ?? { agent: id, error: reply.error };
          }));
          return { structuredContent: { agents }, content: [{ type: "text", text: JSON.stringify({ agents }) }] };
        }
        if (!agent) return toolError("Select an Agent using list_projects.");
        const result = await call(credential, agent, tool, input, signal);
        if (!result.result) return toolError(result.error ?? "The workspace service returned no result.");
        return { structuredContent: result.result, content: [{ type: "text", text: JSON.stringify(result.result) }] };
      });
    }
    try {
      const payload = await data(req, maxRequestBytes);
      await server.connect(transport);
      await transport.handleRequest(req, res, payload);
    } catch {
      if (!res.headersSent) json(res, 400, { error: "Invalid MCP request." });
      else res.end();
    }
    return true;
  };
}
