import { randomUUID } from "node:crypto";

// Protocol names are an allowlist, not arbitrary supplier strings. Payloads,
// reasoning, tool arguments/results, paths and raw stderr never enter logs.
// The one exception is a rejected request: a 400 body is the only place the
// supplier names what it refused, so a bounded excerpt is kept for it after
// credentials, absolute paths and opaque blobs are removed.
const methods = new Set([
  "initialize", "account/read", "model/list", "modelProvider/capabilities/read",
  "thread/start", "thread/resume", "thread/inject_items", "turn/start", "turn/interrupt",
  "thread/started", "thread/status/changed", "thread/tokenUsage/updated", "thread/compacted",
  "turn/started", "turn/completed", "turn/diff/updated", "turn/plan/updated",
  "item/started", "item/completed", "item/tool/call", "serverRequest/resolved",
  "item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress", "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "model/rerouted", "modelProvider/authRecoveryStarted", "modelProvider/authRecoveryCompleted",
  "model/safetyBuffering/updated", "error", "warning", "configWarning", "deprecationNotice"
]);
const itemTypes = new Set([
  "agentMessage", "reasoning", "plan", "dynamicToolCall", "mcpToolCall", "webSearch",
  "commandExecution", "fileChange", "imageGeneration", "contextCompaction", "userMessage",
  "hookPrompt", "functionCallOutput", "collabAgentToolCall", "subAgentActivity", "imageView",
  "sleep", "enteredReviewMode", "exitedReviewMode"
]);
const errorKinds = new Set([
  "contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "rateLimitExceeded",
  "serverOverloaded", "flexUnavailable", "internalServerError", "modelNotFound", "cyberPolicy",
  "misalignmentPolicyViolation", "tooManyDenials", "unauthorized", "badRequest",
  "threadRollbackFailed", "sandboxError", "httpConnectionFailed", "responseStreamConnectionFailed",
  "responseStreamDisconnected", "responseTooManyFailedAttempts", "other"
]);
const tags: ReadonlyArray<readonly [string, RegExp]> = [
  ["timeout", /timed?\s*out|timeout/i], ["reconnecting", /reconnect|retrying|retry attempt/i],
  ["stream-disconnected", /stream.{0,50}(disconnect|closed|error|failed|reset)/i],
  ["connection", /connection.{0,40}(reset|closed|refused|failed)|connect error|os error 100[56]\d/i],
  ["tls", /\btls\b|\bssl\b|certificate/i], ["dns", /\bdns\b|name resolution/i],
  ["authentication", /unauthorized|authentication|token.{0,25}(expired|refresh.*fail)/i],
  ["rate-limit", /rate.?limit|too many requests|\b429\b/i],
  ["upstream-5xx", /\b50[0-9]\b/], ["context-limit", /context.{0,30}(exceed|limit|window)/i],
  ["process-exit", /app-server exited/i], ["invalid-json", /invalid JSON/i]
];
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function classify(text: string): string[] { return tags.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag); }
// A rejected request is the one failure whose cause lives in the response text.
// Keep a bounded, redacted excerpt so the next occurrence is answerable, while
// credentials, host paths, identities and opaque blobs stay out of the log.
const redactions: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]"],
  [/\b(?:jwt|token|secret|password|api[_-]?key|authorization)\s*[=:]\s*[^\s,;"'}]+/gi, "[REDACTED]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  [/[A-Za-z]:\\[^\s"',;)\]}]+/g, "[PATH]"],
  [/(?:^|[\s"'(=])\/(?:[\w.-]+\/)+[\w.-]*/g, "[PATH]"],
  [/\b[0-9a-f]{32,}\b/gi, "[HASH]"],
  [/\b[A-Za-z0-9+/]{60,}={0,2}/g, "[BLOB]"]
];
const excerptLimit = 400;
/** Fixed-order redaction followed by whitespace collapse and a length cap. */
export function rejectedBodyExcerpt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const [pattern, replacement] of redactions) text = text.replace(pattern, replacement);
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > excerptLimit ? `${compact.slice(0, excerptLimit)}…` : compact;
}
/** The rejected body may arrive as the error message or on a detail object. */
function rejectedBodyText(error: Record<string, unknown>, details: Record<string, unknown> | undefined): string | undefined {
  for (const candidate of [details?.message, details?.body, details?.responseBody, error.body, error.responseBody, error.message]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}
export function codexFailureMetadata(value: unknown) {
  const error = object(value), info = error?.codexErrorInfo;
  const infoObject = object(info);
  const kind = typeof info === "string" && errorKinds.has(info) ? info
    : Object.keys(infoObject ?? {}).find(key => errorKinds.has(key)) ?? "unknown";
  const details = object(infoObject?.[kind]);
  const status = details?.httpStatusCode ?? error?.status;
  const rejected = status === 400 ? rejectedBodyExcerpt(error ? rejectedBodyText(error, details) : undefined) : undefined;
  return { kind, ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    tags: classify(typeof error?.message === "string" ? error.message : ""),
    ...(rejected ? { rejectedBody: rejected } : {}) };
}

/** Bounded metadata retained in memory and emitted only at lifecycle boundaries. */
export class CodexProtocolDiagnostics {
  readonly callId = randomUUID();
  private readonly started = performance.now();
  private lastStdout?: number;
  private lastStderr?: number;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private stderrSuffix = "";
  private readonly stderrTags = new Set<string>();
  private lastStderrMatch?: { tags: string[]; atMs: number };
  private readonly counts = new Map<string, number>();
  private readonly recent: Array<{ event: string; atMs: number; count: number }> = [];
  private readonly activeItems = new Map<string, { type: string; startedAt: number }>();
  private untrackedItems = 0;
  private lastError?: ReturnType<typeof codexFailureMetadata> & { willRetry: boolean | null; atMs: number };
  private threadStatus = "unknown";

  stdout(chunk: string): void { this.lastStdout = performance.now(); this.stdoutBytes += Buffer.byteLength(chunk); }
  stderr(chunk: string): void {
    this.lastStderr = performance.now(); this.stderrBytes += Buffer.byteLength(chunk);
    // Bounded overlap handles split log chunks. Only enum tags survive snapshots.
    const text = this.stderrSuffix + chunk;
    const matched = classify(text);
    for (const tag of matched) this.stderrTags.add(tag);
    if (matched.length) this.lastStderrMatch = { tags: matched, atMs: Math.round(performance.now() - this.started) };
    this.stderrSuffix = text.slice(-256);
  }
  event(method: string, params?: unknown): void {
    const name = methods.has(method) ? method : "other";
    const data = object(params), item = object(data?.item);
    const kind = typeof item?.type === "string" && itemTypes.has(item.type) ? item.type : "other";
    const event = name === "item/started" || name === "item/completed" ? `${name}:${kind}` : name;
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
    const atMs = Math.round(performance.now() - this.started), last = this.recent.at(-1);
    if (last?.event === event) { last.atMs = atMs; last.count++; }
    else { this.recent.push({ event, atMs, count: 1 }); if (this.recent.length > 24) this.recent.shift(); }
    if (typeof item?.id === "string") {
      if (name === "item/started" && !this.activeItems.has(item.id)) {
        if (this.activeItems.size < 32) this.activeItems.set(item.id, { type: kind, startedAt: performance.now() });
        else this.untrackedItems++;
      } else if (name === "item/completed") this.activeItems.delete(item.id);
    }
    if (name === "thread/status/changed") {
      const type = object(data?.status)?.type;
      this.threadStatus = typeof type === "string" && ["notLoaded", "idle", "active", "systemError"].includes(type) ? type : "unknown";
    }
    if (name === "error" || name === "turn/completed" && object(data?.turn)?.error) {
      this.lastError = { ...codexFailureMetadata(name === "error" ? data?.error : object(data?.turn)?.error),
        willRetry: typeof data?.willRetry === "boolean" ? data.willRetry : null, atMs };
    }
  }
  snapshot() {
    const now = performance.now();
    return { callId: this.callId, elapsedMs: Math.round(now - this.started),
      stdoutBytes: this.stdoutBytes, stderrBytes: this.stderrBytes,
      stdoutIdleMs: this.lastStdout === undefined ? null : Math.round(now - this.lastStdout),
      stderrIdleMs: this.lastStderr === undefined ? null : Math.round(now - this.lastStderr),
      stderrTags: [...this.stderrTags], lastStderrMatch: this.lastStderrMatch, threadStatus: this.threadStatus,
      activeItems: [...this.activeItems.values()].map(item => ({ type: item.type, ageMs: Math.round(now - item.startedAt) })),
      untrackedItems: this.untrackedItems,
      events: Object.fromEntries(this.counts), recent: this.recent, lastError: this.lastError };
  }
}
