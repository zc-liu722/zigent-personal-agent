import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CodexService } from "./service.js";
import { PROJECT_LIMIT, projectSchema, workerEventSchema } from "./types.js";
import { spaceReadiness } from "../project-spaces/service.js";

function json(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); }
async function body(req: IncomingMessage, limit = 65536) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("Invalid content type");
  const parts: Buffer[] = []; let length = 0;
  for await (const chunk of req) { const data = Buffer.from(chunk); length += data.length; if (length > limit) throw new Error("Body exceeds limit"); parts.push(data); }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}
const lease = { taskId: z.string().uuid(), attempt: z.number().int().positive(), leaseToken: z.string().uuid() };
export function createCodexHttp(services: ReadonlyMap<string, CodexService>) {
  const streams = new Set<ServerResponse>();
  const polls = new Set<ServerResponse>();
  const sweep = setInterval(() => { for (const service of services.values()) service.store.sweep(); }, 15000); sweep.unref();
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = /^\/v1\/codex\/([a-z][a-z0-9-]*)\/([a-z-]+)$/.exec(url.pathname);
    if (!match) return false;
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const service = services.get(match[1]!);
    if (!service) { json(res, 404, { error: "not_found" }); return true; }
    if (req.headers.origin || req.headers.cookie) { json(res, 403, { error: "device_endpoint_only" }); return true; }
    const path = match[2]!;
    try {
      if (path === "pair" && req.method === "POST") {
        const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
        if (!service.store.limit("registration:" + ip, 10)) { json(res, 429, { error: "rate_limited" }); return true; }
        const input = z.object({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().trim().min(1).max(80), projects: z.array(projectSchema).max(PROJECT_LIMIT) }).strict().parse(await body(req, 4 * 1024 * 1024));
        if (new Set(input.projects.map(project => project.id)).size !== input.projects.length) throw new Error("Duplicate project IDs");
        json(res, 200, service.store.pairRequest(input)); return true;
      }
      const credential = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const device = service.store.authenticate(credential, path === "pair-status");
      if (!device) { json(res, 401, { error: "unauthorized" }); return true; }
      if (path === "pair-status" && req.method === "GET") { json(res, 200, { paired: service.store.paired(device.id), deviceId: device.id }); return true; }
      if (path === "events" && req.method === "GET") {
        if (streams.size >= 40) { json(res, 429, { error: "too_many_connections" }); return true; }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
        res.write("retry: 3000\nevent: ready\ndata: {}\n\n"); streams.add(res);
        let cursor = service.store.cursor();
        const timer = setInterval(() => {
          if (!service.store.authenticate(credential)) { res.end(); return; }
          const next = service.store.cursor();
          if (cursor !== next) { cursor = next; if (!res.write("id: " + next + "\nevent: change\ndata: {}\n\n")) res.end(); }
        }, 1000);
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 15000);
        res.on("close", () => { clearInterval(timer); clearInterval(heartbeat); streams.delete(res); }); return true;
      }
      if (path === "commands" && req.method === "GET") { json(res, 200, { commands: service.store.commands(device.id) }); return true; }
      // Retired snapshot clients must not recreate the obsolete database or upload data.
      if (path.startsWith("files-")) { json(res, 410, { error: "retired", replacement: "project_files uses registered bidirectional spaces" }); return true; }
      if (req.method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const input = await body(req, path === "projects" ? 4 * 1024 * 1024 : path === "event" ? 1024 * 1024 : 65536);
      if (path === "space-readiness") {
        const parsed = z.object({ projectId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/) }).strict().parse(input);
        if (!device.projects.some(p => p.id === parsed.projectId && p.executor === "windows-codex")) throw new Error("Unregistered executor project");
        json(res, 200, await spaceReadiness(service.options.agentId, parsed.projectId)); return true;
      }
      if (path === "projects") { const parsed = z.object({ projects: z.array(projectSchema).max(PROJECT_LIMIT) }).strict().parse(input); service.store.projects(device.id, parsed.projects); json(res, 200, { ok: true }); return true; }
      if (path === "claim") {
        z.object({ protocol: z.literal("text-v1") }).strict().parse(input);
        const next = service.store.nextQueued(device.id);
        if (next?.project?.executor) {
          if (next.project.executor !== "windows-codex") throw new Error("Claude account admission is closed");
          if (!service.store.executionGrant({ agentId: service.options.agentId, userId: service.options.ownerUserId, conversationKind: "p2p" }, next.deviceId, next.projectId)) {
            if (next.phase !== "等待网页确认") service.store.update(next.id, task => { task.phase = "等待网页确认"; task.revision++; });
            json(res, 200, { task: null }); return true;
          }
          const ready = await spaceReadiness(service.options.agentId, next.projectId);
          if (ready.state !== "ready") {
            const phase = ready.state === "conflict" ? "同步冲突" : "正在同步";
            if (next.phase !== phase) service.store.update(next.id, task => { task.phase = phase; task.revision++; });
            json(res, 200, { task: null }); return true;
          }
        }
        json(res, 200, { task: service.store.claim(device.id) ?? null }); return true;
      }
      if (path === "heartbeat") {
        const parsed = z.object({ tasks: z.array(z.object({ id: z.string().uuid(), attempt: lease.attempt, leaseToken: lease.leaseToken }).strict()).max(2) }).strict().parse(input);
        json(res, 200, { tasks: service.store.heartbeat(device.id, parsed.tasks) }); return true;
      }
      if (path === "event") { json(res, 200, await service.event(device.id, workerEventSchema.parse(input))); return true; }
      if (path === "command-ack") { const parsed = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), failed: z.boolean().optional() }).strict().parse(input); service.store.acknowledgeCommand(device.id, parsed.id, parsed.failed); json(res, 200, { ok: true }); return true; }
      if (path === "task") {
        const parsed = z.object({ id: z.string().uuid() }).strict().parse(input), task = service.store.get(parsed.id);
        if (!task || task.deviceId !== device.id) { json(res, 404, { error: "not_found" }); return true; }
        json(res, 200, { task }); return true;
      }
      if (path === "reconcile") {
        const parsed = z.object({ taskId: lease.taskId, attempt: lease.attempt, threadId: z.string().max(128).optional(), state: z.enum(["running", "completed", "stopped"]) }).strict().parse(input);
        json(res, 200, service.store.reconcile(device.id, parsed.taskId, parsed)); return true;
      }
      json(res, 404, { error: "not_found" }); return true;
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof z.ZodError ? 400 : 409, { error: error instanceof z.ZodError ? "invalid_request" : "operation_requires_reconciliation" });
      else res.end(); return true;
    }
  }
  return { handle, close() { clearInterval(sweep); for (const stream of streams) stream.end(); streams.clear(); for (const poll of polls) poll.end(); polls.clear(); } };
}
