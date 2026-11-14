import type { RequestRecorder } from "../../usage/types.js";
import { assistantReplayText } from "../../models/search-evidence.js";
import { createHash } from "node:crypto";
import { openAiConversation } from "../../models/provider-formats.js";
import { ModelContextOverflowError } from "../../models/errors.js";
import { AsyncResource } from "node:async_hooks";
import { NativeProcessPool } from "../../models/native-process-pool.js";
import { CodexAppServerError, type CodexImageTask, type CodexPerformance } from "../../models/codex-contract.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelDeployment } from "../../config.js";
import type { TokenUsage } from "../../memory/types.js";
import type {
  ModelAssistantTextItem,
  ModelConversationMessage,
  ModelRoundRequest,
  ModelRoundResult,
  ModelRoundUpdate,
  ModelToolCall,
  ModelToolExecutor,
  ModelWebSearchCall, NativeProcessWarmTarget
} from "../../models/types.js";
import { effectiveReasoningEffort } from "../../models/reasoning.js";
import { modelCapabilities } from "../../models/capabilities.js";
import { networkRetryDelay } from "../../models/network-retry.js";
import { CodexProtocolDiagnostics, codexFailureMetadata } from "./diagnostics.js";

type JsonObject = Record<string, unknown>;
type RuntimeConfig = {
  id: string;
  zenmuxProxyUrl?: string;
  modelConnectTimeoutMs: number;
  modelFirstProgressTimeoutMs: number;
  modelProgressIdleTimeoutMs: number;
  sessionInactivityMinutes?: number;
  modelNetworkRetryAttempts?: number;
  modelRetryDelayMs?: number;
};

type RpcNotification = { method: string; params?: unknown };
type RpcServerRequest = { id: string | number; method: string; params?: unknown };

class JsonLineRpcClient {
  diagnostics = new CodexProtocolDiagnostics();
  private nextId = 1;
  private buffer = "";
  private closedError?: Error;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
    startedAt: number;
  }>();
  onNotification?: (notification: RpcNotification) => void;
  onServerRequest?: (request: RpcServerRequest) => void;
  onClose?: (error: Error) => void;
  private stopping?: Promise<void>;
  readonly finishedTurns = new Map<string, Set<string>>();
  get hasPendingRequests(): boolean { return this.pending.size > 0; }

  get available(): boolean { return !this.closedError && !this.process.killed && this.process.exitCode === null && this.process.signalCode === null; }

  constructor(readonly process: ChildProcessWithoutNullStreams) {
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => { this.diagnostics.stdout(chunk); this.consume(chunk); });
    // Classify into fixed error categories; never relay raw CLI diagnostics.
    process.stderr.on("data", (chunk: string) => this.diagnostics.stderr(chunk));
    process.stdin.on("error", (error) => this.closeWith(error));
    process.on("error", (error) => this.closeWith(error));
    process.on("exit", (code, signal) => {
      this.closeWith(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`));
    });
  }

  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    this.diagnostics.event(method);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Codex app-server request timed out: ${method}`, "unavailable", 504));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, startedAt: performance.now() });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }

  diagnosticSnapshot() {
    return { ...this.diagnostics.snapshot(), available: this.available, pid: this.process.pid,
      exitCode: this.process.exitCode, pendingRequests: this.pending.size,
      oldestRequestMs: this.pending.size ? Math.round(performance.now() - Math.min(...[...this.pending.values()].map(value => value.startedAt))) : null,
      partialLineCharacters: this.buffer.length, stdinBufferedBytes: this.process.stdin.writableLength,
      stdinDestroyed: this.process.stdin.destroyed };
  }

  stop(): Promise<void> { return this.stopping ??= this.stopProcess(); }

  private async stopProcess(): Promise<void> {
    this.closeWith(new Error("Codex app-server connection closed"));
    if (this.process.killed || this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const finished = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.process.kill(); resolve(); }, 3_000);
      this.process.once("exit", finished);
      if (process.platform === "win32" && this.process.pid) {
        // The CLI can own a code-mode host; release its tree before another
        // subscription model session starts in the shared execution flow.
        const killer = spawn("taskkill.exe", ["/pid", String(this.process.pid), "/t", "/f"], {
          stdio: "ignore", windowsHide: true
        });
        killer.on("error", () => this.process.kill());
      } else this.process.kill();
    });
  }

  private write(value: unknown): void {
    if (this.closedError) return;
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: string): void {
    if (this.closedError) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        this.closeWith(new Error("Codex app-server returned invalid JSON"));
        continue;
      }
      if ((typeof message.id === "number") && !("method" in message)) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error && typeof message.error === "object") {
          const error = message.error as JsonObject;
          pending.reject(new Error(typeof error.message === "string" ? error.message : "Codex app-server request failed"));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (typeof message.method !== "string") continue;
      this.diagnostics.event(message.method, message.params);
      if (message.id !== undefined && (typeof message.id === "number" || typeof message.id === "string")) {
        if (this.onServerRequest) this.onServerRequest({ id: message.id, method: message.method, params: message.params });
        else this.respondError(message.id, "The model process has no active turn.");
      } else {
        this.onNotification?.({ method: message.method, params: message.params });
      }
    }
  }

  private closeWith(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose?.(error);
  }
}

function spawnCodex(config: RuntimeConfig, route: ModelDeployment): JsonLineRpcClient {
  const command = route.command ?? "codex";
  const args = route.args?.length ? [...route.args] : ["app-server"];
  const environment: NodeJS.ProcessEnv = { ...process.env, ...(route.codexHome ? { CODEX_HOME: route.codexHome } : {}) };
  if (route.network === "proxy") {
    if (!config.zenmuxProxyUrl) throw new CodexAppServerError("Codex proxy is not configured", "request", 400);
    environment.HTTPS_PROXY = config.zenmuxProxyUrl; environment.HTTP_PROXY = config.zenmuxProxyUrl; environment.ALL_PROXY = config.zenmuxProxyUrl;
    environment.https_proxy = config.zenmuxProxyUrl; environment.http_proxy = config.zenmuxProxyUrl; environment.all_proxy = config.zenmuxProxyUrl;
  }
  // Native executables bypass cmd.exe; bare npm shims still need PATHEXT on Windows.
  return new JsonLineRpcClient(spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: environment,
    shell: process.platform === "win32" && !/\.exe$/i.test(command) }));
}

async function initialize(rpc: JsonLineRpcClient, timeoutMs: number) {
  await rpc.request("initialize", { clientInfo: { name: "zigent", title: "Zigent", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false } }, timeoutMs);
  rpc.notify("initialized", {});
}

export class CodexProcessPool extends NativeProcessPool<JsonLineRpcClient> {
  constructor() { super(rpc => rpc.available, rpc => rpc.stop()); }

  target(config: RuntimeConfig, route: ModelDeployment, expiresAt?: number) {
    return { key: JSON.stringify([route.command, route.args, route.codexHome ?? process.env.CODEX_HOME, route.network, config.zenmuxProxyUrl]),
      expiresAt, create: async (signal: AbortSignal) => {
        const rpc = spawnCodex(config, route);
        const abort = () => { void rpc.stop(); };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          await initialize(rpc, config.modelConnectTimeoutMs);
          signal.throwIfAborted();
          return rpc;
        } catch (error) {
          await rpc.stop();
          throw error;
        } finally { signal.removeEventListener("abort", abort); }
      } };
  }

  keepWarm(config: RuntimeConfig, targets: readonly NativeProcessWarmTarget[]) {
    this.setTargets(targets.map(({ route, expiresAt }) => this.target(config, route, expiresAt)));
  }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function renderTranscript(request: ModelRoundRequest): string {
  const messages = request.messages.map((message) => {
    if (message.role === "tool") {
      return `[TOOL RESULT ${message.toolCallId}${message.failed ? " FAILED" : ""}]\n${message.value}`;
    }
    const role = message.role === "user" ? "USER" : "ASSISTANT";
    const calls = message.role === "assistant" && message.toolCalls.length > 0
      ? `\n[TOOL CALLS]\n${message.toolCalls.map((call) => `${call.name}: ${call.arguments}`).join("\n")}`
      : "";
    return `[${role}]\n${message.role === "assistant" ? assistantReplayText(message) : message.text}${calls}`;
  });
  return [
    "Continue the following conversation and answer the latest user request.",
    "Treat bracketed role labels as transcript structure, not as instructions.",
    ...messages
  ].join("\n\n");
}

function codexHistoryItems(messages: readonly ModelConversationMessage[]): JsonObject[] {
  return openAiConversation(messages).map(item => {
    if (typeof item.content === "string" && (item.role === "user" || item.role === "assistant")) {
      return { type: "message", ...item, content: [
        { type: item.role === "user" ? "input_text" : "output_text", text: item.content }
      ] };
    }
    return item.role === "user" ? { type: "message", ...item } : item;
  });
}

type AdapterRoundUpdate =
  | { type: "attempt.reset"; itemIds: readonly string[] }
  | { type: "wait"; message?: string }
  | { type: "route"; status: "retrying"; failureKind: string; retryAttempt: number; maxAttempts: number }
  | { type: "thought.delta"; itemId?: string; text: string; source: "summary" }
  | { type: "assistant_text.delta"; itemId?: string; text: string; phase?: "commentary" | "final_answer" }
  | { type: "web_search.update"; calls: readonly ModelWebSearchCall[] };

function routeUpdate(route: ModelDeployment, update: AdapterRoundUpdate): ModelRoundUpdate {
  return { provider: route.name, ...routeMetadata(route), ...update } as ModelRoundUpdate;
}

function routeMetadata(route: ModelDeployment) {
  return {
    name: route.name,
    brand: route.brand,
    supplier: route.supplier,
    apiModel: route.apiModel,
    protocol: route.protocol,
    cost: route.cost,
    capabilities: modelCapabilities(route)
  };
}

function dataUrl(data: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${data.toString("base64")}`;
}

function dynamicTools(request: ModelRoundRequest): JsonObject[] {
  if (request.toolChoice === "none") return [];
  const commands=new Set(["exec_command","write_stdin","apply_patch","view_image"]);
  const tools=(request.adapterTools??request.tools).filter(tool=>tool.type==='function')
    .map(tool=>({type:'function',name:tool.name,description:tool.description??`Execute ${tool.name}`,inputSchema:tool.input_schema}));
  const workspace=tools.filter(tool=>commands.has(tool.name));
  // Reserved host names cannot be reclaimed by dynamic tools. Keep the official
  // names in a canonical client namespace, never mixed with legacy flat specs.
  return [...tools.filter(tool=>!commands.has(tool.name)),...(workspace.length?[{type:'namespace',name:'workspace',description:'Authorized persistent Agent execution environment; use these instead of host filesystem/command tools.',tools:workspace}]:[])];
}

function webSources(value: unknown): Array<{ type: "url"; url: string; title?: string }> {
  const found = new Map<string, { type: "url"; url: string; title?: string }>();
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    const entry = object(current);
    if (!entry) return;
    if (typeof entry.url === "string" && /^https?:\/\//.test(entry.url)) {
      found.set(entry.url, {
        type: "url",
        url: entry.url,
        ...(typeof entry.title === "string" ? { title: entry.title } : {})
      });
    }
    Object.values(entry).forEach(visit);
  };
  visit(value);
  return [...found.values()];
}

function failureFromTurn(turn: JsonObject): CodexAppServerError {
  const error = object(turn.error);
  const message = typeof error?.message === "string" ? error.message : "Codex turn failed";
  const lower = message.toLowerCase();
  if (lower.includes("usage limit") || lower.includes("rate limit") || lower.includes("quota")) {
    return new CodexAppServerError(message, "rate-limit", 429);
  }
  if (lower.includes("auth") || lower.includes("login") || lower.includes("unauthorized")) {
    return new CodexAppServerError(message, "authentication", 401);
  }
  return new CodexAppServerError(message, "unavailable", 503);
}

/** Only a confirmed failed turn can be continued without replaying the request. */
function retryableTurnFailure(turn: JsonObject): boolean {
  const error = object(turn.error);
  const info = error?.codexErrorInfo;
  const message = typeof error?.message === "string" ? error.message : "";
  if (/usage limit|quota|budget|auth|login|unauthorized|permission|context.{0,20}(window|limit|exceed)/i.test(message)) return false;
  if (typeof info === "string" && info !== "other") {
    if (["rateLimitExceeded", "serverOverloaded", "flexUnavailable", "internalServerError"].includes(info)) return true;
    if (["contextWindowExceeded", "sessionBudgetExceeded", "usageLimitExceeded", "modelNotFound", "cyberPolicy",
      "misalignmentPolicyViolation", "tooManyDenials", "unauthorized", "badRequest", "threadRollbackFailed", "sandboxError"].includes(info)) return false;
  }
  const details = object(info);
  if (details) {
    for (const kind of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]) {
      const failure = object(details[kind]);
      if (!failure) continue;
      const status = failure.httpStatusCode;
      return status == null || status === 408 || status === 429 || typeof status === "number" && status >= 500;
    }
    return false;
  }
  // Older CLI versions may omit codexErrorInfo. Do not treat unknown failures
  // or a process/transport timeout as proof that the native turn has stopped.
  return /at capacity|overload|temporar(?:y|ily) unavailable|service unavailable|internal server error|rate limit|too many requests|stream.{0,30}(disconnect|reset)|connection.{0,20}(reset|closed)|\b(429|500|502|503|504)\b/i.test(message);
}

export async function invokeCodexAppServerRound(
  config: RuntimeConfig,
  route: ModelDeployment,
  request: ModelRoundRequest,
  onUpdate?: (update: ModelRoundUpdate) => void,
  signal?: AbortSignal,
  executeTool?: ModelToolExecutor,
  record?: RequestRecorder,
  imageTask?: CodexImageTask,
  pool?: CodexProcessPool,
  measurement?: CodexPerformance
): Promise<ModelRoundResult> {
  const setupStarted = performance.now();
  const measure = request.measureNative;
  let turnStarted: number | undefined, firstTextRecorded = false, firstThoughtRecorded = false;
  signal?.throwIfAborted();
  let lease: Awaited<ReturnType<CodexProcessPool["acquire"]>> | undefined;
  let rpc: JsonLineRpcClient;
  try {
    lease = await pool?.acquire(pool.target(config, route), signal);
    rpc = lease?.process ?? spawnCodex(config, route);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof CodexAppServerError) throw error;
    throw new CodexAppServerError("Codex app-server could not initialize", "unavailable", 503);
  }
  rpc.diagnostics = new CodexProtocolDiagnostics();
  if (lease) {
    measure?.(`model.native_acquire_${lease.hit}`, performance.now() - setupStarted);
    if (lease.hit === "cold") measure?.("model.native_initialize", performance.now() - setupStarted);
  }
  const prewarmed = lease && lease.hit !== "cold";
  let workspace: string;
  try { workspace = await mkdtemp(join(tmpdir(), `zigent-${config.id}-codex-`)); }
  catch (error) { if (lease) await lease.release(false); else await rpc.stop(); throw error; }
  const callbackScope = new AsyncResource("CodexTurn");
  const textItems = new Map<string, ModelAssistantTextItem>();
  const publishedTexts = new Map<string, string>();
  const reasoning = new Map<string, string>();
  const emitReasoning = (id: string, index: number, value: string, delta: boolean): void => {
    const key = `${id}:${index}`, previous = reasoning.get(key) ?? "";
    const text = delta ? value : value.startsWith(previous) ? value.slice(previous.length) : previous ? "" : value;
    if (!text) return;
    reasoning.set(key, previous + text);
    if (!firstThoughtRecorded && text.trim() && turnStarted !== undefined) {
      firstThoughtRecorded = true;
      measure?.("model.native_first_thought", performance.now() - turnStarted);
    }
    onUpdate?.(routeUpdate(route, { type: "thought.delta", itemId: key, text, source: "summary" }));
  };
  const searchCalls = new Map<string, ModelWebSearchCall>();
  const imageItems = new Map<string, JsonObject>();
  const imageStarted = new Map<string, number>();
  let imageProcessing = Promise.resolve();
  let imageFinishRecorded = false;
  let firstImageStarted = false, lastImageCompleted: number | undefined;
  const usageStartedAt = Date.now();
  let usageReported = false, usageCompleted = false;
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let totalUsage: TokenUsage | undefined;
  let resumedThread = false, turnInputStarted = false;
  let resumeUsage: TokenUsage | undefined;
  let contextWindowTokens: number | undefined;
  let threadId: string | undefined;
  let settled = false, reusable = false, cleanThreadSetup = true;
  let activeTurnId: string | undefined;
  let toolExecutionStarted = false;
  const deferredCalls: ModelToolCall[] = [];
  let activeToolExecutions = 0;
  const pendingToolExecutions = new Set<Promise<void>>();
  let requiresContinuation = false;
  let catalogRefreshRequested = false;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let waitDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const waitDeadlineMs = (config.sessionInactivityMinutes ?? 15) * 60_000;
  let waitNoticeVisible = false, waitDeadlineReached = false;
  let rejectTurn: ((error: Error) => void) | undefined;
  let resolveTurn: (() => void) | undefined;
  let completedTurn: JsonObject | undefined;
  let notifiedTurnError: JsonObject | undefined;
  let finishedTurnIds = new Set<string>();
  let progressAt: number | undefined, timerArmedAt: number | undefined;
  let lastProgress = "none", lastToolFinishedAt: number | undefined;
  let toolCallsStarted = 0, toolCallsFinished = 0, toolCallsFailed = 0;
  const diagnostic = (event: "started" | "timeout" | "recovered" | "failed" | "completed", extra: Record<string, unknown> = {}): void => {
    const now = performance.now();
    console.info("CODEX_RUNTIME_DIAGNOSTIC " + JSON.stringify({
      version: 1, at: new Date().toISOString(), agent: config.id, model: route.name,
      effort: effectiveReasoningEffort(route, request), mode: imageTask ? "image" : "text", event,
      firstProgressTimeoutMs: config.modelFirstProgressTimeoutMs, progressIdleTimeoutMs: config.modelProgressIdleTimeoutMs,
      waitDeadlineMs,
      lastProgress, progressIdleMs: progressAt === undefined ? null : Math.round(now - progressAt),
      timerAgeMs: timerArmedAt === undefined ? null : Math.round(now - timerArmedAt),
      activeToolExecutions, pendingToolExecutions: pendingToolExecutions.size,
      toolCallsStarted, toolCallsFinished, toolCallsFailed,
      lastToolFinishedAgoMs: lastToolFinishedAt === undefined ? null : Math.round(now - lastToolFinishedAt),
      settled, terminalStatus: ["completed", "failed", "interrupted"].includes(String(completedTurn?.status)) ? completedTurn?.status : null,
      protocol: rpc.diagnosticSnapshot(), ...extra
    }));
  };

  const clearProgressTimer = (): void => {
    if (progressTimer) clearTimeout(progressTimer);
    if (waitDeadlineTimer) clearTimeout(waitDeadlineTimer);
    progressTimer = undefined;
    waitDeadlineTimer = undefined;
    timerArmedAt = undefined;
  };
  const clearWaitNotice = (): void => {
    if (!waitNoticeVisible) return;
    waitNoticeVisible = false;
    onUpdate?.(routeUpdate(route, { type: "wait" }));
  };
  const armProgressTimer = (timeoutMs: number, label: string): void => {
    clearProgressTimer();
    // Native rendering can remain silent without a started/progress event. Its
    // caller supplies the image deadline; text-model idle limits do not apply.
    if (imageTask || activeToolExecutions > 0 || settled) return;
    timerArmedAt = performance.now();
    progressTimer = setTimeout(() => {
      diagnostic("timeout", { timeoutKind: label, timeoutMs, recoverable: true });
      waitNoticeVisible = true;
      onUpdate?.(routeUpdate(route, { type: "wait", message:
        `Codex App Server 等待超时：${Math.round(timeoutMs / 1000)} 秒未收到${label === "first progress" ? "首次进展" : "新进展"}，尚未收到回合结束事件。仍在等待回复，无进展满 ${waitDeadlineMs / 60_000} 分钟后结束。` }));
    }, timeoutMs);
    waitDeadlineTimer = setTimeout(() => {
      waitDeadlineReached = true;
      diagnostic("timeout", { timeoutKind: "session inactivity", timeoutMs: waitDeadlineMs, recoverable: false });
      waitNoticeVisible = true;
      onUpdate?.(routeUpdate(route, { type: "wait", message:
        `Codex App Server 已连续 ${waitDeadlineMs / 60_000} 分钟没有进展，且未收到回合结束事件，本次等待已结束。` }));
      // Reaching the session limit ends this wait; never replay an unconfirmed turn.
      rejectTurn?.(new CodexAppServerError("Codex app-server session inactivity timeout", "request", 504));
    }, waitDeadlineMs);
  };
  const markProgress = (source: string): void => {
    if (waitDeadlineReached) return;
    if (waitNoticeVisible) diagnostic("recovered", { progressSource: source });
    clearWaitNotice();
    lastProgress = source; progressAt = performance.now();
    armProgressTimer(config.modelProgressIdleTimeoutMs, "progress idle");
  };
  let rejectSetup: ((error: Error) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => { rejectSetup = reject; });
  void cancelled.catch(() => undefined);
  const abort = (): void => {
    const error = signal?.reason instanceof Error
      ? signal.reason : new DOMException("The model request was aborted", "AbortError");
    rejectSetup?.(error);
    rejectTurn?.(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const requestWhileActive = (method: string, params: unknown, timeoutMs?: number): Promise<unknown> => {
    signal?.throwIfAborted();
    return Promise.race([rpc.request(method, params, timeoutMs), cancelled]);
  };

  const newTurnCompletion = (): Promise<void> => {
    const completion = new Promise<void>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    // Cancellation or process exit may arrive before turn/start returns.
    void completion.catch(() => undefined);
    return completion;
  };
  let turnCompleted = newTurnCompletion();
  rpc.onClose = error => callbackScope.runInAsyncScope(() => rejectTurn?.(error));

  rpc.onServerRequest = serverRequest => callbackScope.runInAsyncScope(() => {
    const params = object(serverRequest.params) ?? {};
    if (settled || catalogRefreshRequested || waitDeadlineReached || !threadId || !turnInputStarted
      || params.threadId !== threadId || typeof params.turnId !== "string"
      || finishedTurnIds.has(params.turnId) || activeTurnId && params.turnId !== activeTurnId) {
      rpc.respondError(serverRequest.id, "The tool request does not belong to an active turn.");
      return;
    }
    activeTurnId ??= params.turnId;
    markProgress("server-request");
    if (serverRequest.method !== "item/tool/call") {
      rpc.respondError(serverRequest.id, `Unsupported server request: ${serverRequest.method}`);
      return;
    }
    const execution = (async () => {
      const name = typeof params.tool === "string" ? params.tool : "unknown";
      const input = params.arguments;
      const call: ModelToolCall = {
        id: typeof params.callId === "string" ? params.callId : String(serverRequest.id),
        name,
        input,
        arguments: JSON.stringify(input ?? {})
      };
      const mounted = (request.adapterTools ?? request.tools).find(tool => tool.type === "function" && tool.name === name);
      if (!mounted || mounted.type !== "function" || request.toolChoice === "none") {
        rpc.respond(serverRequest.id, {
          contentItems: [{ type: "inputText", text: "This tool is unavailable for the current turn." }],
          success: false
        });
        return;
      }
      const deferred = mounted.deferExecution;
      if (deferred) {
        // Release the routing app-server before starting another subscription
        // model session. The shared executor performs this real call afterwards.
        deferredCalls.push(call);
        clearProgressTimer();
        await rpc.request("turn/interrupt", { threadId }, Math.min(config.modelConnectTimeoutMs, 3_000)).catch(() => undefined);
        settled = true;
        usageCompleted = true;
        resolveTurn?.();
        return;
      }
      let executing = false;
      try {
        toolExecutionStarted = true;
        toolCallsStarted++;
        activeToolExecutions++;
        executing = true;
        clearProgressTimer();
        const result = executeTool
          ? await executeTool(call)
          : { text: "This Agent did not provide a tool executor.", failed: true };
        if (result.failed) toolCallsFailed++;
        if (result.refreshTools) {
          // Dynamic tools are fixed at thread/start. The successful loader and its
          // result are already journaled by the host; do not let the old thread
          // keep reasoning or executing with a stale catalog. Replay saved results
          // once in a new invocation with the refreshed definitions.
          requiresContinuation = true;
          if (catalogRefreshRequested) return;
          catalogRefreshRequested = true;
          clearProgressTimer();
          await rpc.request("turn/interrupt", { threadId }, Math.min(config.modelConnectTimeoutMs, 3_000)).catch(() => undefined);
          settled = true;
          usageCompleted = true;
          resolveTurn?.();
          return;
        }
        rpc.respond(serverRequest.id, {
          contentItems: [
            { type: "inputText", text: result.text },
            ...(result.images ?? []).map((image) => ({
              type: "inputImage",
              imageUrl: dataUrl(image.data, image.mimeType)
            }))
          ],
          success: !result.failed
        });
      } catch (error) {
        toolCallsFailed++;
        rpc.respond(serverRequest.id, {
          contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
          success: false
        });
      } finally {
        if (executing) { activeToolExecutions--; toolCallsFinished++; lastToolFinishedAt = performance.now(); }
        markProgress("tool-result");
      }
    })();
    pendingToolExecutions.add(execution);
    void execution.finally(() => pendingToolExecutions.delete(execution)).catch(error => rejectTurn?.(error));
  });

  const publishText = (id: string, text: string, phase?: ModelAssistantTextItem["phase"]): void => {
    if (!text) return;
    publishedTexts.set(id, (publishedTexts.get(id) ?? "") + text);
    if (text.trim() && !firstTextRecorded && turnStarted !== undefined) {
      firstTextRecorded = true;
      measure?.("model.codex_first", performance.now() - turnStarted);
    }
    onUpdate?.(routeUpdate(route, { type: "assistant_text.delta", itemId: id, text, phase }));
  };

  rpc.onNotification = notification => callbackScope.runInAsyncScope(() => {
    if (waitDeadlineReached) return;
    const params = object(notification.params) ?? {};
    if (!threadId || params.threadId !== threadId || !turnInputStarted && notification.method !== "thread/tokenUsage/updated") return;
    const eventTurn = object(params.turn);
    const eventTurnId = typeof params.turnId === "string" ? params.turnId : typeof eventTurn?.id === "string" ? eventTurn.id : undefined;
    if (eventTurnId && (activeTurnId && eventTurnId !== activeTurnId
      || finishedTurnIds.has(eventTurnId) && (notification.method !== "thread/tokenUsage/updated" || activeTurnId !== eventTurnId))) return;
    if (turnInputStarted && eventTurnId) activeTurnId ??= eventTurnId;
    // These documented deltas also prove work is progressing, even when their
    // contents are not rendered. Never publish or retain raw reasoning here.
    if (["item/reasoning/textDelta", "item/reasoning/summaryPartAdded", "item/plan/delta",
      "item/commandExecution/outputDelta", "item/fileChange/outputDelta", "item/fileChange/patchUpdated",
      "item/mcpToolCall/progress", "turn/started", "turn/plan/updated", "turn/diff/updated", "thread/compacted"].includes(notification.method)) {
      markProgress(notification.method);
      return;
    }
    if (notification.method === "item/agentMessage/delta") {
      markProgress(notification.method);
      const id = typeof params.itemId === "string" ? params.itemId : "answer";
      const delta = typeof params.delta === "string" ? params.delta : "";
      const current = textItems.get(id) ?? { text: "" };
      textItems.set(id, { ...current, text: current.text + delta });
      publishText(id, delta, current.phase);
      return;
    }
    if (notification.method === "item/reasoning/summaryTextDelta") {
      markProgress(notification.method);
      const id = typeof params.itemId === "string" ? params.itemId : "reasoning";
      const delta = typeof params.delta === "string" ? params.delta : "";
      emitReasoning(id, typeof params.summaryIndex === "number" ? params.summaryIndex : 0, delta, true);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      markProgress(notification.method);
      const item = object(params.item);
      if (item?.type === "imageGeneration" && imageTask) {
        toolExecutionStarted = true;
        const id = String(item.id), now = performance.now();
        if (notification.method === "item/started" && !imageStarted.has(id) && !imageItems.has(id)) {
          imageStarted.set(id, now);
          imageTask.started?.();
          if (!firstImageStarted && turnStarted !== undefined) {
            firstImageStarted = true;
            measurement?.store.record("media.image_dispatch", now - turnStarted, route.name, "ok", measurement.trace);
          }
        }
        if (notification.method === "item/completed") {
          if (imageItems.has(id)) return;
          imageItems.set(id, item);
          const started = imageStarted.get(id);
          if (started !== undefined) {
            measurement?.store.record("media.image_render", now - started, route.name,
              item.status === "completed" && !item.failure ? "ok" : "error", measurement.trace);
            imageStarted.delete(id);
          }
          lastImageCompleted = now;
          if (item.status === "completed" && !item.failure && imageStarted.size === 0) imageTask.rendered?.();
          if (imageTask.imageCompleted) {
            imageProcessing = imageProcessing.then(() => imageTask.imageCompleted!(item, workspace));
            void imageProcessing.catch(error => rejectTurn?.(error));
          }
        }
      }
      if (item?.type === "reasoning" && notification.method === "item/completed" && Array.isArray(item.summary)) {
        item.summary.forEach((text, index) => {
          if (typeof text === "string") emitReasoning(typeof item.id === "string" ? item.id : "reasoning", index, text, false);
        });
      }
      if (item?.type === "agentMessage") {
        const id = typeof item.id === "string" ? item.id : "answer";
        const phase = item.phase === "commentary" || item.phase === "final_answer" ? item.phase : undefined;
        const previous = textItems.get(id);
        const priorText = previous?.text ?? "", text = typeof item.text === "string" ? item.text : priorText;
        textItems.set(id, { itemId: id, text,
          ...(phase || previous?.phase ? { phase: phase ?? previous?.phase } : {}) });
        const published = publishedTexts.get(id) ?? "";
        if (notification.method === "item/completed" && text.startsWith(published)) {
          publishText(id, text.slice(published.length), phase ?? previous?.phase);
        }
      }
      if (item?.type === "webSearch") {
        const id = typeof item.id === "string" ? item.id : `search-${searchCalls.size + 1}`;
        const call: ModelWebSearchCall = {
          id,
          status: notification.method === "item/completed" ? "completed" : "in_progress",
          ...(typeof item.query === "string" ? { query: item.query } : {}),
          sources: webSources(item.results)
        };
        searchCalls.set(id, call);
        onUpdate?.(routeUpdate(route, { type: "web_search.update", calls: [call] }));
      }
      return;
    }
    if (notification.method === "thread/tokenUsage/updated") {
      markProgress(notification.method);
      const tokenUsage = object(params.tokenUsage);
      if (typeof tokenUsage?.modelContextWindow === "number" && tokenUsage.modelContextWindow >= 4096) {
        contextWindowTokens = tokenUsage.modelContextWindow;
      }
      const last = object(tokenUsage?.total) ?? object(tokenUsage?.last);
      usageReported = Boolean(last);
      const reportedUsage: TokenUsage | undefined = last ? {
        inputTokens: typeof last?.inputTokens === "number" ? last.inputTokens : 0,
        outputTokens: typeof last?.outputTokens === "number" ? last.outputTokens : 0,
        cachedInputTokens: typeof last?.cachedInputTokens === "number" ? last.cachedInputTokens : 0,
        ...(typeof last?.cacheWriteInputTokens === "number" ? { cacheWriteTokens: last.cacheWriteInputTokens } : {}),
        cacheHitTokensReported: last?.cachedInputTokens !== undefined
      } : undefined;
      totalUsage = tokenUsage?.total ? reportedUsage : undefined;
      usage = reportedUsage ?? usage;
      if (resumedThread) {
        if (!turnInputStarted) {
          resumeUsage = totalUsage ?? resumeUsage;
          usageReported = false;
          usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
          return;
        }
        const baseline = resumeUsage;
        const valid = totalUsage && baseline && ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens"].every(key => {
          const field = key as keyof TokenUsage;
          return Number(totalUsage![field] ?? 0) >= Number(baseline[field] ?? 0);
        });
        usageReported = Boolean(valid && tokenUsage?.total);
        if (usageReported && totalUsage && baseline) usage = {
          inputTokens: totalUsage.inputTokens - baseline.inputTokens,
          outputTokens: totalUsage.outputTokens - baseline.outputTokens,
          cachedInputTokens: totalUsage.cachedInputTokens - baseline.cachedInputTokens,
          ...(totalUsage.cacheWriteTokens !== undefined ? { cacheWriteTokens: totalUsage.cacheWriteTokens - (baseline.cacheWriteTokens ?? 0) } : {}),
          cacheHitTokensReported: totalUsage.cacheHitTokensReported
        };
      }
      return;
    }
    if (notification.method === "turn/completed") {
      const turn = object(params.turn) ?? {};
      if (typeof turn.id === "string") {
        if (finishedTurnIds.has(turn.id)) return;
        finishedTurnIds.add(turn.id);
      }
      clearProgressTimer();
      clearWaitNotice();
      completedTurn = { ...turn, error: turn.error ?? notifiedTurnError };
      // Code-mode cells can outlive the supplier turn (including a question
      // waiting for its card). Their results must reach the executor before
      // finalizing, then get a fresh model round instead of a dead RPC reply.
      requiresContinuation ||= turn.status === "completed" && activeToolExecutions > 0;
      settled = true;
      if (turn.status === "completed" || (deferredCalls.length > 0 || catalogRefreshRequested) && turn.status === "interrupted") { usageCompleted = true; resolveTurn?.(); }
      else rejectTurn?.(failureFromTurn(completedTurn));
      return;
    }
    if (notification.method === "error") {
      if (deferredCalls.length || catalogRefreshRequested) return;
      const error = object(params.error);
      // A retry notification leaves the same supplier turn running. Keep its
      // process alive; completion, cancellation and the existing deadlines still
      // settle the request. Older servers may omit the explicit retry flag.
      if (params.willRetry === true || (params.willRetry === undefined
        && typeof error?.message === "string" && /^Reconnecting\.\.\.\s+\d+\/\d+\s*$/i.test(error.message))) {
        markProgress("supplier-retrying");
        return;
      }
      if (!imageTask && retryableTurnFailure({ error })) {
        // The error event precedes turn/completed. Wait for that terminal
        // acknowledgement before opening a continuation on the same thread.
        notifiedTurnError = error;
        markProgress("supplier-terminal-error");
        return;
      }
      rejectTurn?.(new CodexAppServerError(
        typeof error?.message === "string" ? error.message : "Codex app-server reported an error",
        "unavailable",
        503
      ));
    }
  });

  try {
    diagnostic("started");
    signal?.throwIfAborted();
    if (!lease) {
      await requestWhileActive("initialize", { clientInfo: { name: "zigent", title: "Zigent", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false } }, config.modelConnectTimeoutMs);
      rpc.notify("initialized", {});
    }

    if (imageTask) {
      const capabilities = object(await requestWhileActive("modelProvider/capabilities/read", {}, config.modelConnectTimeoutMs));
      if (capabilities?.imageGeneration !== true) {
        throw new CodexAppServerError("Image generation is unavailable for this ChatGPT supplier", "request", 400);
      }
    }

    // These read-only checks do not depend on each other. Both must succeed
    // before creating a thread or sending any model input.
    const [accountIdentity] = await Promise.all([
      (async () => {
        const accountStarted = performance.now();
        const accountResponse = object(await requestWhileActive("account/read", { refreshToken: false }, config.modelConnectTimeoutMs));
        measure?.("model.codex_account", performance.now() - accountStarted);
        const account = object(accountResponse?.account);
        if (account?.type !== "chatgpt") {
          throw new CodexAppServerError(
            "Codex is not logged in with a ChatGPT subscription for this Windows service account",
            "authentication",
            401
          );
        }
        return typeof account.email === "string" ? account.email : undefined;
      })(),
      (async () => {
        let cursor: string | null = null;
        let foundModel = false;
        do {
          const listed = object(await requestWhileActive("model/list", {
            limit: 100,
            includeHidden: false,
            ...(cursor ? { cursor } : {})
          }, config.modelConnectTimeoutMs));
          const models = Array.isArray(listed?.data) ? listed.data : [];
          foundModel ||= models.some((entry) => {
            const model = object(entry);
            return model?.model === route.apiModel || model?.id === route.apiModel;
          });
          cursor = typeof listed?.nextCursor === "string" ? listed.nextCursor : null;
        } while (!foundModel && cursor);
        if (!foundModel) {
          throw new CodexAppServerError(
            `Model ${route.apiModel} is not available to the logged-in ChatGPT account`,
            "request",
            400
          );
        }
      })()
    ]);

    const hasWebSearch = request.toolChoice !== "none" && request.tools.some((tool) => tool.type === "web_search");
    const chat = !imageTask ? request.codexChat : undefined;
    const tools = dynamicTools(request);
    const binding = createHash("sha256").update(JSON.stringify([
      "zigent-chat-v1", config.id, route.name, route.apiModel, route.codexHome ?? process.env.CODEX_HOME,
      accountIdentity, tools, hasWebSearch
    ])).digest("hex");
    const threadParams = {
      model: route.apiModel,
      cwd: workspace,
      approvalPolicy: "never",
      sandbox: imageTask ? "workspace-write" : "read-only",
      developerInstructions: [
        request.systemPrompt,
        "You are serving a personal messaging Agent through Zigent.",
        "Do not use built-in tools that access this app-server host shell/filesystem, built-in sub-agents, or built-in user-input requests. When supplied, workspace.exec_command, workspace.write_stdin, workspace.apply_patch and workspace.view_image are authorized dynamic tools for the Agent execution environment; use those for document/code work.",
        imageTask
          ? "Use the native image_gen.imagegen tool for image requests. Do not use other tools. If image generation fails, report the failure without retrying it in this turn."
          : "Use only the dynamic function tools supplied by Zigent and web search when mounted."
      ].filter(Boolean).join("\n\n"),
      config: { web_search: hasWebSearch ? "live" : "disabled", "features.shell_tool": false, "features.multi_agent": false,
        ...(!imageTask ? { include_permissions_instructions: false, include_environment_context: false } : {}),
        ...(chat ? { "memories.generate_memories": false, "memories.use_memories": false } : {}),
        "features.image_generation": Boolean(imageTask), "features.omit_app_server_notification_media": false },
    };
    const threadStarted = performance.now();
    let started: JsonObject | undefined;
    const previous = chat?.previous;
    if (accountIdentity && chat && previous?.binding === binding && await chat.consumePrevious(previous.threadId)) {
      resumedThread = true;
      resumeUsage = previous.totalUsage;
      try {
        started = object(await requestWhileActive("thread/resume",
          { ...threadParams, threadId: previous.threadId, excludeTurns: true }, config.modelConnectTimeoutMs));
        if (object(started?.thread)?.id !== previous.threadId) throw new Error("Codex resumed an unexpected thread");
      } catch {
        signal?.throwIfAborted();
        // No input has been sent. A missing or incompatible rollout can be rebuilt from Zigent history.
        started = undefined;
        resumedThread = false;
        cleanThreadSetup = false;
        resumeUsage = totalUsage = undefined;
      }
    } else if (imageTask?.threadId) {
      resumedThread = true;
      resumeUsage = imageTask.usageBaseline;
      started = object(await requestWhileActive("thread/resume",
        { ...threadParams, threadId: imageTask.threadId, excludeTurns: true }, config.modelConnectTimeoutMs));
    }
    started ??= object(await requestWhileActive("thread/start", {
      ...threadParams, ephemeral: imageTask?.ephemeral ?? (!imageTask && (!chat || !accountIdentity)), dynamicTools: tools
    }, config.modelConnectTimeoutMs));
    measure?.(resumedThread ? "model.native_session_load" : "model.native_session_create", performance.now() - threadStarted);
    const thread = object(started?.thread);
    threadId = typeof thread?.id === "string" ? thread.id : undefined;
    if (threadId) finishedTurnIds = new Set(rpc.finishedTurns.get(threadId));
    if (!threadId) throw new CodexAppServerError("Codex app-server did not return a thread id", "invalid-response");
    if (imageTask?.history?.length) {
      const inject = () => requestWhileActive("thread/inject_items", { threadId, items: imageTask.history }, config.modelConnectTimeoutMs);
      await (measurement ? measurement.store.measure("media.image_history", route.name, inject) : inject());
    }

    let inputMessages = request.messages;
    let additionalContext: JsonObject | undefined;
    if (chat) {
      const current = request.messages.findIndex(message => message.role === "user" && message.contextRole === "current");
      if (current >= 0) {
        const history = request.messages.slice(0, current).filter(message => message.role !== "user" ||
          message.contextRole !== "pinned" && message.contextRole !== "volatile");
        if (!resumedThread && history.length) {
          await requestWhileActive("thread/inject_items",
            { threadId, items: codexHistoryItems(history) }, config.modelConnectTimeoutMs);
        }
        const runtimeContext = request.messages.flatMap(message => message.role === "user" &&
          (message.contextRole === "pinned" || message.contextRole === "volatile") ? [message.text] : []);
        if (runtimeContext.length) additionalContext = {
          "zigent-turn-context": { kind: "untrusted", value: runtimeContext.join("\n\n") }
        };
        inputMessages = request.messages.slice(current).filter(message => message.role !== "user" ||
          message.contextRole !== "pinned" && message.contextRole !== "volatile");
      }
    }
    const input = [
      { type: "text", text: imageTask?.prompt ?? (chat && inputMessages.length === 1 && inputMessages[0]?.role === "user"
        ? inputMessages[0].text : renderTranscript({ ...request, messages: inputMessages })) },
      ...inputMessages.flatMap((message) => message.role === "user"
        ? (message.images ?? []).map((image) => ({ type: "image", url: dataUrl(image.data, image.mimeType), detail: "original" }))
        : [])
    ];
    armProgressTimer(config.modelFirstProgressTimeoutMs, "first progress");
    turnStarted = performance.now();
    const setupMs = turnStarted - setupStarted;
    measure?.("model.codex_setup", setupMs);
    measure?.(prewarmed ? "model.codex_setup_warm" : "model.codex_setup_cold", setupMs);
    const maxRetries = config.modelNetworkRetryAttempts ?? 5;
    for (let retry = 0; ; retry++) {
      try {
        // turn/start acknowledgement shares the recoverable idle policy. A separate
        // 120-second RPC timer would otherwise kill the same call we keep waiting for.
        if (retry === 0) request.beforeNativePrompt?.();
        turnInputStarted = true;
        const acknowledged = await Promise.race([requestWhileActive("turn/start", {
          threadId,
          ...(additionalContext ? { additionalContext } : {}),
          input: retry === 0 ? input : [{ type: "text", text:
            "Continue the interrupted request from the existing conversation and tool results. Do not restart the task or repeat completed tool calls. If a command is still running, poll its existing session_id instead of launching it again. Finish the original user request." }],
          model: route.apiModel,
          effort: effectiveReasoningEffort(route, request),
          summary: onUpdate ? "auto" : "none"
        }, imageTask ? config.modelFirstProgressTimeoutMs : undefined), turnCompleted]);
        const id = object(object(acknowledged)?.turn)?.id;
        if (typeof id === "string") {
          if (activeTurnId && activeTurnId !== id) throw new CodexAppServerError("Codex returned an unexpected turn ID", "request");
          activeTurnId = id;
        }
        await turnCompleted;
        await Promise.race([Promise.all([...pendingToolExecutions]), cancelled]);
        break;
      } catch (error) {
        if (signal?.aborted || imageTask || !rpc.available || retry >= maxRetries || activeToolExecutions > 0
          || completedTurn?.status !== "failed" || !retryableTurnFailure(completedTurn)) throw error;
        clearProgressTimer();
        const delayMs = networkRetryDelay(config.modelRetryDelayMs ?? 1000, retry + 1);
        // Keep completed tools and commentary. Remove only incomplete answer
        // text so it cannot be appended to the eventual successful answer.
        const discarded = [...textItems].filter(([, item]) => item.phase !== "commentary").map(([id]) => id);
        for (const id of discarded) { textItems.delete(id); publishedTexts.delete(id); }
        if (discarded.length) onUpdate?.(routeUpdate(route, { type: "attempt.reset", itemIds: discarded }));
        onUpdate?.(routeUpdate(route, { type: "route", status: "retrying",
          failureKind: error instanceof CodexAppServerError && error.kind === "rate-limit" ? "rate-limit" : "service-unavailable",
          retryAttempt: retry + 2, maxAttempts: maxRetries + 1 }));
        console.warn("Continuing failed Codex turn with backoff", {
          agentId: config.id, model: route.name, retry: retry + 1, maxRetries, delayMs
        });
        await delay(delayMs, undefined, { signal });
        signal?.throwIfAborted();
        if (!rpc.available) throw error;
        completedTurn = undefined;
        activeTurnId = undefined;
        notifiedTurnError = undefined;
        settled = false;
        turnCompleted = newTurnCompletion();
        armProgressTimer(config.modelFirstProgressTimeoutMs, "first progress");
      }
    }
    if (imageTask && lastImageCompleted !== undefined) {
      measurement?.store.record("media.image_finish", performance.now() - lastImageCompleted, route.name, "ok", measurement.trace);
      imageFinishRecorded = true;
    }
    await imageProcessing;
    const items = [...textItems.values()].filter((item) => item.text.trim());
    const text = items.map((item) => item.text).join("\n\n").trim();
    if (imageTask) await imageTask.complete([...imageItems.values()], workspace, text, { threadId, totalUsage });
    reusable = completedTurn?.status === "completed" && !requiresContinuation && !deferredCalls.length;
    diagnostic("completed");
    return {
      ...(chat && accountIdentity && !requiresContinuation && !deferredCalls.length && completedTurn?.status === "completed"
        ? { codexThread: { threadId, binding, totalUsage } } : {}),
      ...(requiresContinuation ? { requiresContinuation: true } : {}),
      text,
      textItems: items.length > 0 ? items : [{ text }],
      usage,
      contextWindowTokens,
      toolCalls: deferredCalls,
      webSearchCalls: [...searchCalls.values()],
      citations: [],
      ...(reasoning.size > 0 ? { reasoningContent: [...reasoning.values()].join("\n\n") } : {})
    };
  } catch (error) {
    diagnostic("failed", { failure: codexFailureMetadata(error), cancelled: Boolean(signal?.aborted),
      adapterFailureKind: error instanceof CodexAppServerError ? error.kind : "unknown",
      fallbackBlocked: toolExecutionStarted && error instanceof CodexAppServerError
        && ["unavailable", "rate-limit", "invalid-response"].includes(error.kind) });
    if (signal?.aborted) throw signal.reason;
    if (!imageTask && !toolExecutionStarted && (object(completedTurn?.error)?.codexErrorInfo === "contextWindowExceeded"
      || /context.{0,20}(window|length).{0,20}(exceed|limit)|maximum context length/i.test(error instanceof Error ? error.message : ""))) {
      throw new ModelContextOverflowError();
    }
    if (turnInputStarted && !completedTurn && request.beforeNativePrompt) {
      throw new CodexAppServerError("Codex 请求结果未确认，请核对已完成的操作后重新发送。", "result-unknown");
    }
    if (error instanceof CodexAppServerError) {
      if (toolExecutionStarted && (error.kind === "unavailable" || error.kind === "rate-limit" || error.kind === "invalid-response")) {
        throw new CodexAppServerError(
          `${error.message}; automatic fallback is disabled because a tool may already have executed`,
          "request",
          error.status
        );
      }
      throw error;
    }
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexAppServerError(message, settled ? "invalid-response" : "unavailable", settled ? undefined : 503);
  } finally {
    // A turn may finish or disconnect while image persistence is still in flight.
    // Keep its workspace alive until every completion callback has settled.
    await imageProcessing.catch(() => undefined);
    if (imageTask && lastImageCompleted !== undefined && !imageFinishRecorded) measurement?.store.record("media.image_finish",
      performance.now() - lastImageCompleted, route.name, signal?.reason?.name === "AbortError" ? "cancelled" : "error", measurement.trace);
    if (imageTask && !firstImageStarted && turnStarted !== undefined && !usageCompleted) measurement?.store.record("media.image_dispatch",
      performance.now() - turnStarted, route.name, signal?.aborted && signal.reason?.name === "AbortError" ? "cancelled" : "error", measurement.trace);
    for (const started of imageStarted.values()) measurement?.store.record("media.image_render",
      performance.now() - started, route.name, signal?.aborted && signal.reason?.name === "AbortError" ? "cancelled" : "error", measurement.trace);
    record?.({ createdAt: usageStartedAt, usage: usageReported ? usage : undefined, usageComplete: usageCompleted && usageReported,
      outcome: usageCompleted ? "completed" : "failed" });
    settled = true;
    clearProgressTimer();
    if (!waitDeadlineReached || signal?.aborted) clearWaitNotice();
    signal?.removeEventListener("abort", abort);
    rpc.onNotification = rpc.onServerRequest = rpc.onClose = undefined;
    callbackScope.emitDestroy();
    let detached = false;
    if (lease && threadId && reusable && cleanThreadSetup && !signal?.aborted && rpc.available && !rpc.hasPendingRequests) {
      try {
        const response = object(await rpc.request("thread/unsubscribe", { threadId }, Math.min(config.modelConnectTimeoutMs, 3000)));
        detached = ["unsubscribed", "notSubscribed", "notLoaded"].includes(String(response?.status));
        if (detached) {
          rpc.finishedTurns.delete(threadId);
          rpc.finishedTurns.set(threadId, new Set([...finishedTurnIds].slice(-8)));
          if (rpc.finishedTurns.size > 64) rpc.finishedTurns.delete(rpc.finishedTurns.keys().next().value!);
        }
      } catch { /* Retire a server that cannot detach the completed thread. */ }
    }
    if (lease) await lease.release(detached);
    else await rpc.stop();
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}
