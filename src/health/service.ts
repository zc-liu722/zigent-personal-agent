import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { HealthAccessConfig, HealthReceiverConfig } from "../config.js";
import { HealthStore } from "./store.js";

export type HealthScope = { agentId: string; userId: string; principalId?: string; conversationKind?: "p2p" | "group" };
export class UserHealthAccess {
  private constructor(readonly config: HealthAccessConfig, readonly store: HealthStore) {}
  static async create(config: HealthAccessConfig): Promise<UserHealthAccess> {
    if (config.allowedAgentId !== "deepmind" || !config.ownerUserId) throw new Error("HEALTH_OWNER_REQUIRED");
    return new UserHealthAccess(config, await HealthStore.open(config.storagePath));
  }
  isAuthorized(scope: HealthScope): boolean {
    return scope.agentId === "deepmind" && scope.agentId === this.config.allowedAgentId
      && scope.userId === this.config.ownerUserId && scope.conversationKind === "p2p"
      && (!this.config.ownerPrincipalId || this.config.ownerPrincipalId === scope.principalId);
  }
  close(): void { this.store.close(); }
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
function header(request: IncomingMessage, name: string, max: number): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_HEADERS");
  return value.trim();
}
export class UserHealthReceiver {
  private server?: Server;
  private constructor(readonly config: HealthReceiverConfig, readonly store: HealthStore) {}
  static async create(config: HealthReceiverConfig): Promise<UserHealthReceiver> {
    if (config.listenHost !== "127.0.0.1" || config.ingestToken.length < 32 || /\s/.test(config.ingestToken)
      || !Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1 || config.maxBodyBytes > 4 * 1024 * 1024) throw new Error("INVALID_HEALTH_RECEIVER_CONFIG");
    return new UserHealthReceiver(config, await HealthStore.open(config.storagePath));
  }
  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => { void this.handle(request, response); });
    // An approximately 2 MB health export has taken over 30 seconds to arrive
    // through the tunnel. Keep a bounded deadline for slow, valid uploads.
    server.requestTimeout = 120_000; server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.listenPort, this.config.listenHost, () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
  }
  localBaseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Health receiver is not listening");
    return `http://127.0.0.1:${address.port}`;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz" && request.method === "GET") { json(response, 200, { status: "ok" }); return; }
      if (path !== "/v1/health/auto-export") { json(response, 404, { error: "not_found" }); return; }
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); json(response, 405, { error: "method_not_allowed" }); return; }
      const actual = Buffer.from(request.headers.authorization ?? ""); const expected = Buffer.from(`Bearer ${this.config.ingestToken}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { json(response, 401, { error: "unauthorized" }); return; }
      // Record transport timings and byte counts only, never headers, payloads,
      // identifiers, or health values. A disconnect may happen before ingest.
      const startedAt = performance.now();
      const startedAtUtc = new Date().toISOString();
      let length = 0; let readMs: number | undefined; let ingestMs: number | undefined; let reported = false;
      const report = (outcome: "completed" | "disconnected") => {
        if (reported) return;
        reported = true;
        console.info("HEALTH_INGEST_TRANSPORT", JSON.stringify({
          startedAtUtc, finishedAtUtc: new Date().toISOString(),
          outcome, status: response.headersSent ? response.statusCode : 0, bytes: length,
          durationMs: Math.round(performance.now() - startedAt), readMs, ingestMs
        }));
      };
      response.once("finish", () => report("completed"));
      response.once("close", () => { if (!response.writableFinished) report("disconnected"); });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) { json(response, 415, { error: "json_required" }); return; }
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") { json(response, 415, { error: "unsupported_encoding" }); return; }
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > this.config.maxBodyBytes) { json(response, 413, { error: "body_too_large" }); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
        if (length > this.config.maxBodyBytes) { json(response, 413, { error: "body_too_large" }); return; }
        chunks.push(bytes);
      }
      readMs = Math.round(performance.now() - startedAt);
      const raw = Buffer.concat(chunks).toString("utf8");
      const payload: unknown = JSON.parse(raw);
      // Official headers separate exports with differing source/grouping semantics.
      const ingestStartedAt = performance.now();
      let result: ReturnType<HealthStore["ingest"]>;
      try {
        result = this.store.ingest(payload, {
          automationId: header(request, "automation-id", 128),
          aggregation: typeof request.headers["automation-aggregation"] === "string" && request.headers["automation-aggregation"].trim()
            ? header(request, "automation-aggregation", 64) : "Unspecified",
          ...(typeof request.headers["automation-period"] === "string" ? { period: header(request, "automation-period", 128) } : {})
        }, Date.now(), raw);
      } finally { ingestMs = Math.round(performance.now() - ingestStartedAt); }
      json(response, 200, { accepted: true, ...result });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const message = error instanceof Error ? error.message : "";
      if (error instanceof SyntaxError || /^INVALID_/.test(message)) json(response, 400, { error: "invalid_request" });
      else if (message === "BODY_TOO_LARGE") json(response, 413, { error: "body_too_large" });
      else json(response, 503, { error: "storage_unavailable" });
      // Never log request headers, bodies, parsing exceptions, or health values.
    }
  }
  async close(): Promise<void> {
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    this.store.close();
  }
}
