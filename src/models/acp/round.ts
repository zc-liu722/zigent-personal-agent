import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { TokenUsage } from "../../memory/types.js";
import type { ModelGatewayConfig } from "../gateway-config.js";
import type { ModelConversationMessage, ModelRoundAdapter, ModelRoundRequest, ModelAssistantTextItem, ModelFunctionTool, ModelToolCall,
  ModelToolExecutionResult, NativeModelMetric, NativeModelWarmRequest } from "../types.js";
import { AcpClient, AcpError } from "./client.js";
import { AcpToolBridge, array, digest, historyDigest, object, runtimeContext, transcriptEntry, type AcpSession } from "./session.js";
import type { AcpWarmPool, AcpLaunch, PreparedAcpProcess } from "./warm-pool.js";
import type { ModelDeployment } from "../../config.js";

export { array, modelOptions, object } from "./session.js";

type AcpConfiguration = {
  sessionId?: string;
  models?: { currentModelId?: string; availableModels?: unknown };
  configOptions?: unknown;
};

type AcpDriver = {
  label: string;
  pool: AcpWarmPool;
  process: AcpLaunch;
  account: string;
  version: string;
  stateKey?: string;
  processIdentity?: string;
  sessionMeta?: object;
  selectModel(client: AcpClient, session: AcpConfiguration & { sessionId: string }, signal: AbortSignal): Promise<void>;
  modelChanged(options: unknown): boolean;
  mountedToolName?(toolCall: unknown): string | undefined;
  usesSystemInstructions?: boolean;
  runtimeContextWindow?: boolean;
};

const validToken = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const delegatedSearch: ModelFunctionTool = { type: "function", name: "web_search",
  description: "Search the web using Zigent and return sources.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } };
const MAX_OPEN_SESSIONS = 4;

function toolDefinitions(route: ModelDeployment, request: Pick<ModelRoundRequest, "tools" | "adapterTools" | "toolChoice">) {
  const mounted = request.toolChoice === "none" ? [] : (request.adapterTools ?? request.tools);
  return new Map(mounted.flatMap(tool => tool.type === "function" ? [[tool.name, tool] as const]
    : tool.type === "web_search" && route.capabilities?.delegatedTools?.includes("web_search") ? [[delegatedSearch.name, delegatedSearch] as const] : []));
}

function sessionBinding(driver: AcpDriver, route: ModelDeployment,
  request: Pick<ModelRoundRequest, "systemPrompt" | "capabilityVersions" | "instructionRevision">, definitions: ReadonlyMap<string, ModelFunctionTool>,
  conversationKey?: string) {
  return digest(["zigent-acp-v1", driver.version, driver.account, route.name, route.apiModel, conversationKey,
    request.systemPrompt, request.instructionRevision, driver.sessionMeta, driver.stateKey, driver.processIdentity, Object.entries(request.capabilityVersions ?? {}).sort(([a], [b]) => a.localeCompare(b)), [...definitions.values()]]);
}

function canClose(process: PreparedAcpProcess) {
  return process.initialization.agentCapabilities?.sessionCapabilities?.close !== undefined;
}

async function closeSession(process: PreparedAcpProcess, session: AcpSession): Promise<boolean> {
  session.bridge?.unbind();
  process.sessions.delete(session.id);
  process.changedConfigurations.delete(session.id);
  try {
    if (!canClose(process)) return process.openedSessions < MAX_OPEN_SESSIONS;
    await process.client.request("session/close", { sessionId: session.id }, AbortSignal.timeout(3000));
    return true;
  } catch { return false; }
  finally { await session.closeBridge(); }
}

async function openSession(driver: AcpDriver, process: PreparedAcpProcess, binding: string,
  definitions: ReadonlyMap<string, ModelFunctionTool>, signal: AbortSignal, measure: ModelRoundRequest["measureNative"],
  chat: { conversationKey?: string; sessionKey?: string }, previous?: string) {
  const { client, workspace, initialization } = process;
  if (definitions.size && !initialization.agentCapabilities?.mcpCapabilities?.http) {
    throw new AcpError("configuration", `${driver.label} CLI 缺少 HTTP MCP 能力，请检查服务端安装版本。`);
  }
  const bridge = definitions.size ? new AcpToolBridge(definitions) : undefined;
  let id: string | undefined;
  try {
    const mcpServers = await bridge?.listen() ?? [];
    signal.throwIfAborted();
    const params = { cwd: workspace, mcpServers, ...(driver.sessionMeta ? { _meta: driver.sessionMeta } : {}) };
    let session: AcpConfiguration | undefined;
    if (previous && !process.sessions.has(previous) && initialization.agentCapabilities?.loadSession) {
      const started = performance.now();
      try {
        const method = initialization.agentCapabilities.sessionCapabilities?.resume !== undefined ? "session/resume" : "session/load";
        session = await client.request<AcpConfiguration>(method, { ...params, sessionId: previous }, signal);
        // ACP v1 load/resume can omit the ID because the client supplied it.
        id = session.sessionId ?? previous;
        if (id !== previous) throw new AcpError("connection", "ACP returned an unexpected session ID.");
        measure?.("model.native_session_load", performance.now() - started);
      } catch (error) {
        measure?.("model.native_session_load", performance.now() - started, "error");
        signal.throwIfAborted();
        // Explicit rejection is safe to rebuild before sending new input.
        // A timeout or a mismatched session identity retires the connection.
        if (!(error instanceof AcpError) || error.acpFailure !== "model" || error.rpcCode === undefined || id) throw error;
      }
    }
    if (!session) {
      const started = performance.now();
      try {
        session = await client.request<AcpConfiguration>("session/new", params, signal);
        id = session.sessionId;
        if (typeof id !== "string" || !id) throw new AcpError("connection", `${driver.label} CLI 未返回会话 ID。`);
        measure?.("model.native_session_create", performance.now() - started);
      } catch (error) {
        measure?.("model.native_session_create", performance.now() - started, "error");
        throw error;
      }
    }
    if (!id) throw new AcpError("connection", `${driver.label} CLI 未返回会话 ID。`);
    const configureStarted = performance.now();
    try {
      await driver.selectModel(client, { ...session, sessionId: id }, signal);
      signal.throwIfAborted();
      measure?.("model.native_configure", performance.now() - configureStarted);
    } catch (error) {
      measure?.("model.native_configure", performance.now() - configureStarted, "error");
      throw error;
    }
    if (process.sessions.has(id)) throw new AcpError("connection", `${driver.label} CLI 返回了已占用的会话 ID。`);
    const loaded = id === previous;
    const state: AcpSession = { id, binding, ...chat, bridge, confirmed: loaded, closeBridge: () => bridge?.close() ?? Promise.resolve() };
    process.openedSessions++;
    process.sessions.set(id, state);
    return state;
  } catch (error) {
    await bridge?.close();
    throw error;
  }
}

async function checkoutSession(driver: AcpDriver, process: PreparedAcpProcess, binding: string,
  definitions: ReadonlyMap<string, ModelFunctionTool>, signal: AbortSignal, measure: ModelRoundRequest["measureNative"],
  chat: { conversationKey?: string; sessionKey?: string }, previous?: string, warm = false) {
  const started = performance.now();
  const matches = (session: AcpSession) => session.binding === binding && !process.changedConfigurations.has(session.id)
    && (session.sessionKey === chat.sessionKey || !session.confirmed && !session.sessionKey);
  const existing = chat.conversationKey && [...process.sessions.values()].find(session =>
    matches(session) && (session.confirmed ? warm || session.id === previous : !previous || warm));
  if (existing) {
    process.sessions.delete(existing.id);
    process.sessions.set(existing.id, existing);
    existing.sessionKey ??= chat.sessionKey;
    measure?.("model.native_session_reuse", performance.now() - started);
    return existing;
  }
  // Incompatible workers for this same conversation can be closed immediately.
  // The stable supplier conversation may still be loaded below using its saved ID.
  if (chat.conversationKey) for (const session of process.sessions.values()) {
    if (session.conversationKey === chat.conversationKey && !await closeSession(process, session)) return undefined;
  }
  signal.throwIfAborted();
  // Cursor has no session/close in the deployed build. Bound its number of
  // created sessions and rotate that process when it needs another slot.
  if (!canClose(process) && process.openedSessions >= MAX_OPEN_SESSIONS) return undefined;
  while (process.sessions.size >= MAX_OPEN_SESSIONS) {
    if (!await closeSession(process, process.sessions.values().next().value!)) return undefined;
    signal.throwIfAborted();
  }
  return openSession(driver, process, binding, definitions, signal, measure, chat, previous);
}

async function acquireProcess(driver: AcpDriver, target: ReturnType<AcpWarmPool["target"]>, signal: AbortSignal) {
  let lease = await driver.pool.acquire(target, signal);
  if (lease.process.identity !== driver.processIdentity) {
    await lease.release(false);
    lease = await driver.pool.acquire(target, signal);
    if (lease.process.identity !== driver.processIdentity) {
      await lease.release(false);
      throw new AcpError("connection", `${driver.label} CLI 账户或配置已更改，请重试。`);
    }
  }
  return lease;
}

export async function prepareAcpConversation(driver: AcpDriver, config: ModelGatewayConfig, route: ModelDeployment,
  request: NativeModelWarmRequest, signal: AbortSignal): Promise<void> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.modelConnectTimeoutMs)]);
  const definitions = toolDefinitions(route, request);
  const binding = sessionBinding(driver, route, request, definitions, request.conversationKey);
  const target = driver.pool.target(driver.process, config.modelConnectTimeoutMs);
  const lease = await acquireProcess(driver, target, deadline);
  let keep = false;
  try {
    deadline.throwIfAborted();
    const session = await checkoutSession(driver, lease.process, binding, definitions, deadline, request.measureNative, request, undefined, true);
    keep = Boolean(session);
  } finally { await lease.release(keep); }
}

/** ACP v1 serializes prompts and completes all updates before replying. Bind
 * callbacks only for the active prompt, using the caller's async context. */
export async function invokeAcpRound(driver: AcpDriver, ...args: Parameters<ModelRoundAdapter>): Promise<Awaited<ReturnType<ModelRoundAdapter>>> {
  const [config, route, request, onUpdate, signal, record, executeTool] = args;
  const { label } = driver;
  signal?.throwIfAborted();
  const setupStarted = performance.now();
  const setupSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(config.modelConnectTimeoutMs)]);
  const measure = request.measureNative;
  const definitions = toolDefinitions(route, request);
  const binding = sessionBinding(driver, route, request, definitions, request.acpChat?.conversationKey);
  const chat = { conversationKey: request.acpChat?.conversationKey, sessionKey: request.acpChat?.sessionKey };
  const current = request.messages.findIndex(message => message.role === "user" && message.contextRole === "current");
  const prefix = current < 0 ? [] : request.messages.slice(0, current);
  const previous = request.acpChat?.previous;
  const compatiblePrevious = current >= 0 && previous?.binding === binding && previous.contextRevision === request.contextRevision &&
    previous.historyDigest === historyDigest(prefix) ? previous : undefined;
  let previousId: string | undefined;
  const target = driver.pool.target(driver.process, config.modelConnectTimeoutMs);
  let lease: Awaited<ReturnType<AcpWarmPool["acquire"]>> | undefined;
  let session: AcpSession | undefined;
  const deferredCalls: ModelToolCall[] = [];
  const toolHistory: ModelConversationMessage[] = [];
  const textItems: ModelAssistantTextItem[] = [];
  let text = "", thought = "", segment = 0;
  let acceptingTools = false;
  let promptStarted: number | undefined;
  let promptFinished = false;
  let completed = false;
  let configurationChanged = false;
  let requiresContinuation = false;
  let pendingTools = 0;
  let toolQueue = Promise.resolve();
  const toolRequests = new Map<string | number, { arguments: string; result: Promise<ModelToolExecutionResult> }>();
  const scope = new AsyncResource("AcpPrompt");
  let endForContinuation!: () => void;
  const continuationReady = new Promise<void>(resolve => { endForContinuation = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: (error: AcpError) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  void stopped.catch(() => undefined);
  const unknown = () => new AcpError("unknown", `${label} 请求结果未确认，请检查额度后手动重试。`);
  const abort = () => { acceptingTools = false; stop(unknown()); };
  const resetTimer = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(abort, ms);
  };
  const finishText = (phase: "commentary" | "final_answer") => {
    if (text.trim()) textItems.push({ itemId: String(segment), text, phase });
    text = "";
    segment++;
  };
  const runTool = async (definition: ModelFunctionTool, input: Record<string, unknown>): Promise<ModelToolExecutionResult> => {
    if (!acceptingTools || signal?.aborted) return { text: "Tool unavailable in this turn.", failed: true };
    finishText("commentary");
    const call: ModelToolCall = { id: randomUUID(), name: definition.name, input, arguments: JSON.stringify(input) };
    if (definition.deferExecution || !executeTool) {
      acceptingTools = false;
      deferredCalls.push(call);
      endForContinuation();
      return { text: "Zigent will execute the tool and continue with its result.", failed: false };
    }
    try {
      const result = await executeTool(call);
      toolHistory.push({ role: "assistant", text: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, value: result.text, failed: result.failed });
      if (result.refreshTools) {
        acceptingTools = false;
        requiresContinuation = true;
        endForContinuation();
      }
      return result;
    } catch {
      abort();
      return { text: "Zigent could not complete this tool request.", failed: true };
    }
  };

  const reported: Partial<TokenUsage> = {};
  let contextWindowTokens: number | undefined;
  const captureUsage = (payload: unknown) => {
    const value = object(payload);
    if (validToken(value.inputTokens)) reported.inputTokens = value.inputTokens;
    if (validToken(value.outputTokens)) reported.outputTokens = value.outputTokens;
    if (validToken(value.cachedReadTokens)) reported.cachedInputTokens = value.cachedReadTokens;
    if (validToken(value.cachedWriteTokens)) reported.cacheWriteTokens = value.cachedWriteTokens;
  };
  const usage = (): TokenUsage | undefined => Object.keys(reported).length ? {
    inputTokens: reported.inputTokens ?? 0, outputTokens: reported.outputTokens ?? 0,
    cachedInputTokens: reported.cachedInputTokens ?? 0, cacheHitTokensReported: reported.cachedInputTokens !== undefined,
    ...(reported.cacheWriteTokens !== undefined ? { cacheWriteTokens: reported.cacheWriteTokens } : {})
  } : undefined;
  const metadata = { provider: route.name, name: route.name, brand: route.brand, supplier: route.supplier,
    apiModel: route.apiModel, protocol: route.protocol, cost: route.cost, capabilities: route.capabilities! };
  let started = Date.now();
  try {
    lease = await acquireProcess(driver, target, setupSignal);
    measure?.(`model.native_acquire_${lease.hit}`, performance.now() - setupStarted);
    if (lease.hit !== "ready") measure?.("model.native_initialize", lease.process.initializeMs);
    setupSignal.throwIfAborted();
    if (compatiblePrevious && await request.acpChat?.consumePrevious(compatiblePrevious)) previousId = compatiblePrevious.sessionId;
    session = await checkoutSession(driver, lease.process, binding, definitions, setupSignal, measure, chat, previousId);
    if (!session) {
      await lease.release(false);
      lease = await acquireProcess(driver, target, setupSignal);
      session = await openSession(driver, lease.process, binding, definitions, setupSignal, measure, chat, previousId);
    }
    const { client, initialization } = lease.process;
    const sessionId = session.id;
    const resumed = Boolean(previousId && session.confirmed && previousId === sessionId);
    const messages = resumed ? request.messages.filter((message, index) => index >= current || runtimeContext(message)) : request.messages;
    if (messages.some(message => message.role === "user" && message.images?.length)
      && !initialization.agentCapabilities?.promptCapabilities?.image) {
      throw new AcpError("configuration", `${label} CLI 缺少图片输入能力，请检查服务端安装版本。`);
    }
    const prompt: Array<Record<string, unknown>> = [{ type: "text", text: [...(driver.usesSystemInstructions ? [] : [request.systemPrompt ?? "",
      "Reply inside Zigent. Use only the zigent MCP tools mounted for this request. Do not use native files, shell, browser or subagents."]),
      resumed ? "This JSON contains the new user input and the current Zigent context. Continue the existing conversation."
        : "The following JSON is the conversation transcript; answer its latest user request and use saved tool results.",
      ...(request.maxOutputTokens ? [`Keep your answer below ${request.maxOutputTokens} tokens.`] : []),
      JSON.stringify(messages.map(transcriptEntry))].join("\n\n") }];
    for (const [index, message] of messages.entries()) if (message.role === "user") {
      for (const image of message.images ?? []) prompt.push({ type: "text", text: `Image from message ${index}:` },
        { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
    }
    setupSignal.throwIfAborted();
    if (!client.available) throw new AcpError("connection", `${label} CLI 连接已关闭。`);
    let firstThought = false;
    client.onMessage = message => scope.runInAsyncScope(() => {
      const params = object(message.params);
      if (message.method === "session/update" && (!acceptingTools || params.sessionId !== sessionId)) {
        client.onIdleMessage?.(message);
        return;
      }
      if (message.method === "session/update" && params.sessionId === sessionId && acceptingTools) {
        const update = object(params.update);
        const content = object(update.content);
        if (update.sessionUpdate === "config_option_update" && driver.modelChanged(update.configOptions)) {
          configurationChanged = true;
          abort();
          return;
        }
        if (pendingTools === 0) resetTimer(config.modelProgressIdleTimeoutMs);
        if (update.sessionUpdate === "agent_message_chunk" && content.type === "text" && typeof content.text === "string") {
          text += content.text;
          onUpdate?.({ ...metadata, type: "assistant_text.delta", itemId: String(segment), text: content.text });
        } else if (update.sessionUpdate === "agent_thought_chunk" && content.type === "text" && typeof content.text === "string") {
          if (!firstThought && content.text.trim()) {
            firstThought = true;
            measure?.("model.native_first_thought", performance.now() - promptStarted!);
          }
          thought += content.text;
          onUpdate?.({ ...metadata, type: "thought.delta", itemId: String(segment), text: content.text, source: "thinking" });
        } else if (update.sessionUpdate === "usage_update") {
          captureUsage(update.usage ?? update);
          if (driver.runtimeContextWindow && validToken(update.size) && update.size >= 4096) contextWindowTokens = update.size;
        }
      } else if (message.id !== undefined && message.method) {
        const envelope = { jsonrpc: "2.0", id: message.id };
        if (message.method === "session/request_permission") {
          const mountedName = driver.mountedToolName?.(params.toolCall);
          const allow = acceptingTools && !signal?.aborted && params.sessionId === sessionId
            && mountedName !== undefined && definitions.has(mountedName);
          const options = array(params.options);
          const selected = (allow ? options.find(option => option.kind === "allow_once") : undefined)
            ?? options.find(option => option.kind === "reject_once");
          client.send({ ...envelope, result: { outcome: typeof selected?.optionId === "string"
            ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } } });
        } else client.send({ ...envelope, error: { code: -32601, message: "Client method unavailable" } });
      }
    });
    if (session.bridge) session.bridge.handler = (id, name, input) => scope.runInAsyncScope(async () => {
      const definition = definitions.get(name);
      if (!definition || !acceptingTools || signal?.aborted) return;
      const argumentsKey = JSON.stringify([name, input]);
      const saved = toolRequests.get(id);
      if (saved) return saved.arguments === argumentsKey ? saved.result : undefined;
      pendingTools++;
      clearTimeout(timer);
      const result = toolQueue.then(() => runTool(definition, input)).finally(() => {
        pendingTools--;
        if (acceptingTools && pendingTools === 0) resetTimer(config.modelProgressIdleTimeoutMs);
      });
      toolQueue = result.then(() => undefined, () => undefined);
      toolRequests.set(id, { arguments: argumentsKey, result });
      return result;
    });
    signal?.addEventListener("abort", abort, { once: true });
    signal?.throwIfAborted();
    resetTimer(config.modelFirstProgressTimeoutMs);
    request.beforeNativePrompt?.();
    promptStarted = performance.now();
    started = Date.now();
    acceptingTools = true;
    const result = await Promise.race([
      client.request<{ stopReason?: string; usage?: unknown; _meta?: unknown }>("session/prompt", { sessionId, prompt }, undefined, () => {
        acceptingTools = false;
        promptFinished = true;
      }),
      continuationReady.then(() => undefined), stopped
    ]);
    acceptingTools = false;
    clearTimeout(timer);
    if (result) {
      if (driver.runtimeContextWindow) {
        const meta = object(result._meta);
        captureUsage(object(meta.antigravity).usage ?? meta.usage);
      }
      captureUsage(result.usage);
      if (result.stopReason !== "end_turn") throw unknown();
      requiresContinuation ||= pendingTools > 0 || toolRequests.size > 0 && !text.trim();
    }
    await Promise.race([toolQueue, stopped]);
    if (configurationChanged) throw unknown();
    signal?.throwIfAborted();
    if (!deferredCalls.length && !requiresContinuation && !text.trim()) throw unknown();
    finishText(deferredCalls.length || requiresContinuation ? "commentary" : "final_answer");
    completed = true;
    const retained = Boolean(request.acpChat && promptFinished && !configurationChanged && !requiresContinuation && !deferredCalls.length);
    session.confirmed = retained;
    return { text: textItems.map(item => item.text).join("\n\n"), textItems,
      ...(retained ? { acpSession: { sessionId, binding, historyDigest: historyDigest([...request.messages, ...toolHistory,
        { role: "assistant", text: textItems.filter(item => item.phase === "final_answer").map(item => item.text.trim()).join("\n\n"), toolCalls: [] }]),
        contextRevision: request.contextRevision } } : {}),
      ...(requiresContinuation ? { requiresContinuation: true } : {}),
      usage: usage() ?? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, toolCalls: deferredCalls,
      webSearchCalls: [], citations: [], ...(contextWindowTokens ? { contextWindowTokens } : {}), ...(thought ? { reasoningContent: thought } : {}),
      stopReason: result?.stopReason ?? "tool_use" };
  } catch (error) {
    signal?.throwIfAborted();
    if (promptStarted !== undefined && (!(error instanceof AcpError) || error.acpFailure !== "unknown")) throw unknown();
    if (setupSignal.aborted && !signal?.aborted) throw new AcpError("connection", `${label} CLI 连接超时。`);
    throw error;
  } finally {
    acceptingTools = false;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    if (lease) {
      const { client } = lease.process;
      client.onMessage = undefined;
      session?.bridge?.unbind();
      if (session && promptStarted !== undefined && !promptFinished) {
        client.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.id } });
      }
      const reusable = completed && promptFinished && !signal?.aborted && !configurationChanged;
      const clean = reusable && session && (session.confirmed || await closeSession(lease.process, session));
      await lease.release(Boolean(clean));
    }
    // A stopped tool may finish an already-journaled operation. Its bridge is
    // closed and the next turn cannot inherit the old callback.
    if (signal?.aborted) await Promise.race([toolQueue, delay(10_000, undefined, { ref: false })]);
    else await toolQueue;
    scope.emitDestroy();
    if (promptStarted !== undefined) record?.({ createdAt: started, usage: usage(),
      usageComplete: reported.inputTokens !== undefined && reported.outputTokens !== undefined, outcome: completed ? "completed" : "failed" });
  }
}
