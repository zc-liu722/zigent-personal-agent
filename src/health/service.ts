import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { HealthAccessConfig, HealthReceiverConfig } from "../config.js";
import { HealthStore } from "./store.js";
import { HealthItemLimitError, MAX_HEALTH_BODY_BYTES, MAX_HEALTH_OBSERVATIONS_PER_BATCH } from "./limits.js";

// Only fixed codes may leave the receiver; parsing messages can contain private data.
const validationReasons = new Set([
  "INVALID_HEADERS", "INVALID_PAYLOAD", "INVALID_FIELD", "INVALID_TIMESTAMP", "INVALID_DEPTH",
  "INVALID_NUMBER", "INVALID_METRIC", "INVALID_METRIC_VALUE", "INVALID_INTERVAL",
  "INVALID_WORKOUT_QUANTITY", "INVALID_WORKOUT", "INVALID_OBSERVATION_SIZE", "INVALID_ITEM_LIMIT"
]);

export type HealthScope = { agentId: string; userId: string; principalId?: string; conversationKind?: "p2p" | "group" };
export class UserHealthAccess {
  private constructor(readonly config: HealthAccessConfig, readonly store: HealthStore) {}
  static async create(config: HealthAccessConfig): Promise<UserHealthAccess> {
    if (!config.allowedAgentId || !config.ownerUserId) throw new Error("HEALTH_OWNER_REQUIRED");
    return new UserHealthAccess(config, await HealthStore.open(config.storagePath, config.allowedAgentId));
  }
  isAuthorized(scope: HealthScope): boolean {
    return scope.agentId === this.config.allowedAgentId
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
  private rejectionCleanup?: ReturnType<typeof setInterval>;
  private constructor(readonly config: HealthReceiverConfig, readonly store: HealthStore,
    private readonly accounts: Array<{ agentId: string; ingestToken: string; store: HealthStore }>) {}
  static async create(config: HealthReceiverConfig): Promise<UserHealthReceiver> {
    if (config.listenHost !== "127.0.0.1" || config.ingestToken.length < 32 || /\s/.test(config.ingestToken)
      || !Number.isSafeInteger(config.maxBodyBytes) || config.maxBodyBytes < 1 || config.maxBodyBytes > MAX_HEALTH_BODY_BYTES) throw new Error("INVALID_HEALTH_RECEIVER_CONFIG");
    const sources = [{ agentId: "deepmind", storagePath: config.storagePath, ingestToken: config.ingestToken },
      ...(config.additionalAccounts ?? [])];
    if (new Set(sources.map(account => account.ingestToken)).size !== sources.length
      || sources.some(account => account.ingestToken.length < 32 || /\s/.test(account.ingestToken)))
      throw new Error("INVALID_HEALTH_RECEIVER_CREDENTIALS");
    const accounts: Array<{ agentId: string; ingestToken: string; store: HealthStore }> = [];
    try {
      for (const account of sources) accounts.push({ agentId: account.agentId, ingestToken: account.ingestToken,
        store: await HealthStore.open(account.storagePath, account.agentId) });
      return new UserHealthReceiver(config, accounts[0]!.store, accounts);
    } catch (error) { for (const account of accounts) account.store.close(); throw error; }
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
    const cleanup = () => { for (const account of this.accounts) {
      try { account.store.pruneRejectedUploads(); }
      catch { console.info("HEALTH_REJECTION_CLEANUP_FAILED", JSON.stringify({ agent: account.agentId })); }
    } };
    cleanup();
    this.rejectionCleanup = setInterval(cleanup, 15 * 60_000);
    this.rejectionCleanup.unref();
  }
  localBaseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("Health receiver is not listening");
    return `http://127.0.0.1:${address.port}`;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rejectionReason: string | undefined;
    let rejectedItemCount: number | undefined;
    let rejectedUploadId: string | undefined;
    let captureRejected: ((reason: string) => void) | undefined;
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/healthz" && request.method === "GET") { json(response, 200, { status: "ok" }); return; }
      if (path !== "/v1/health/auto-export") { json(response, 404, { error: "not_found" }); return; }
      if (request.method !== "POST") { response.setHeader("Allow", "POST"); json(response, 405, { error: "method_not_allowed" }); return; }
      const actual = Buffer.from(request.headers.authorization ?? "");
      // Only the credential selects storage; payloads and headers cannot choose another Agent.
      const account = this.accounts.find(candidate => {
        const expected = Buffer.from(`Bearer ${candidate.ingestToken}`);
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      });
      if (!account) { json(response, 401, { error: "unauthorized" }); return; }
      // Record account routing, transport timings and byte counts only, never
      // credentials, payloads, device identities or health values.
      const startedAt = performance.now();
      const startedAtUtc = new Date().toISOString();
      const mediaType = String(request.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const encoding = String(request.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      const contentType = !mediaType ? "missing" : mediaType === "application/json" ? "json"
        : mediaType === "text/csv" ? "csv" : mediaType === "application/octet-stream" ? "binary" : "other";
      const contentEncoding = ["identity", "gzip", "deflate", "br"].includes(encoding) ? encoding : "other";
      const declared = request.headers["content-length"] === undefined ? undefined : Number(request.headers["content-length"]);
      let length = 0; let readMs: number | undefined; let ingestMs: number | undefined; let reported = false;
      const chunks: Buffer[] = [];
      let capturedBytes = 0;
      let rejectionCapture: string | undefined;
      captureRejected = reason => {
        if (rejectionCapture) return;
        const id = randomUUID();
        try {
          account.store.recordRejectedUpload(id, Buffer.concat(chunks), {
            reason, contentType, contentEncoding, declaredBytes: Number.isSafeInteger(declared) ? declared : null,
            receivedBytes: length, bodyComplete: request.complete && capturedBytes === length && (declared === undefined || declared === length),
            bodyTruncated: capturedBytes < length || !request.complete || (declared !== undefined && capturedBytes < declared), maxBodyBytes: this.config.maxBodyBytes
          });
          rejectedUploadId = id; rejectionCapture = "saved";
        } catch { rejectionCapture = "failed"; }
      };
      const report = (outcome: "completed" | "disconnected") => {
        if (reported) return;
        reported = true;
        console.info("HEALTH_INGEST_TRANSPORT", JSON.stringify({
          agent: account.agentId, startedAtUtc, finishedAtUtc: new Date().toISOString(),
          declaredBytes: declared !== undefined && Number.isSafeInteger(declared) && declared >= 0 ? declared : undefined,
          maxBodyBytes: this.config.maxBodyBytes,
          contentType, contentEncoding,
          rejectionReason,
          rejectedItemCount,
          rejectedUploadId, rejectionCapture,
          maxItems: MAX_HEALTH_OBSERVATIONS_PER_BATCH,
          outcome, status: response.headersSent ? response.statusCode : 0, bytes: length,
          durationMs: Math.round(performance.now() - startedAt), readMs, ingestMs
        }));
      };
      response.once("finish", () => report("completed"));
      response.once("close", () => { if (!response.writableFinished) { captureRejected?.("TRANSPORT_INTERRUPTED"); report("disconnected"); } });
      if (declared !== undefined && Number.isFinite(declared) && declared > this.config.maxBodyBytes) {
        rejectionReason = "BODY_TOO_LARGE"; captureRejected(rejectionReason);
        json(response, 413, { error: "body_too_large", rejectedUploadId }); return;
      }
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
        const captured = bytes.subarray(0, Math.max(0, this.config.maxBodyBytes - capturedBytes));
        chunks.push(captured); capturedBytes += captured.length;
        if (length > this.config.maxBodyBytes) {
          rejectionReason = "BODY_TOO_LARGE"; captureRejected(rejectionReason);
          json(response, 413, { error: "body_too_large", rejectedUploadId }); return;
        }
      }
      readMs = Math.round(performance.now() - startedAt);
      if (contentType !== "json") { rejectionReason = "UNSUPPORTED_CONTENT_TYPE"; captureRejected(rejectionReason); json(response, 415, { error: "json_required", rejectedUploadId }); return; }
      if (contentEncoding !== "identity") { rejectionReason = "UNSUPPORTED_CONTENT_ENCODING"; captureRejected(rejectionReason); json(response, 415, { error: "unsupported_encoding", rejectedUploadId }); return; }
      const raw = Buffer.concat(chunks).toString("utf8");
      const payload: unknown = JSON.parse(raw);
      // Official headers separate exports with differing source/grouping semantics.
      const ingestStartedAt = performance.now();
      let result: ReturnType<HealthStore["ingest"]>;
      try {
        result = account.store.ingest(payload, {
          automationId: header(request, "automation-id", 128),
          aggregation: typeof request.headers["automation-aggregation"] === "string" && request.headers["automation-aggregation"].trim()
            ? header(request, "automation-aggregation", 64) : "Unspecified",
          ...(typeof request.headers["automation-period"] === "string" ? { period: header(request, "automation-period", 128) } : {})
        }, Date.now(), raw);
      } finally { ingestMs = Math.round(performance.now() - ingestStartedAt); }
      json(response, 200, { accepted: true, ...result });
    } catch (error) {
      if (response.destroyed || response.writableEnded) { captureRejected?.("TRANSPORT_INTERRUPTED"); return; }
      const message = error instanceof Error ? error.message : "";
      if (error instanceof SyntaxError || /^INVALID_/.test(message)) {
        rejectionReason = error instanceof SyntaxError ? "INVALID_JSON" : validationReasons.has(message) ? message : "INVALID_REQUEST";
        rejectedItemCount = error instanceof HealthItemLimitError ? error.itemCount : undefined;
        captureRejected?.(rejectionReason);
        json(response, 400, { error: "invalid_request", reason: rejectionReason, rejectedUploadId,
          ...(rejectedItemCount !== undefined ? { itemCount: rejectedItemCount, maxItems: MAX_HEALTH_OBSERVATIONS_PER_BATCH } : {}) });
      }
      else if (message === "BODY_TOO_LARGE") { captureRejected?.("BODY_TOO_LARGE"); json(response, 413, { error: "body_too_large" }); }
      else { captureRejected?.("STORAGE_UNAVAILABLE"); json(response, 503, { error: "storage_unavailable" }); }
      // Never log request headers, bodies, parsing exceptions, or health values.
    }
  }
  async close(): Promise<void> {
    clearInterval(this.rejectionCleanup); this.rejectionCleanup = undefined;
    const server = this.server; this.server = undefined;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const account of this.accounts) account.store.close();
  }
}
