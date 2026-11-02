import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ModelDeployment } from "../config.js";
import type { TokenUsage } from "../memory/types.js";
import type { RequestRecorder } from "../usage/types.js";
import { ModelHardStopError } from "./errors.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import { effectiveReasoningEffort } from "./reasoning.js";
import { assistantReplayText } from "./search-evidence.js";
import type { ModelRoundRequest, ModelRoundResult, ModelRoundUpdate } from "./types.js";

const MAX_BYTES = 2 * 1024 * 1024;
const stop = (message: string): ModelHardStopError => new ModelHardStopError("boundary-violation", message);

/** JSON-lines over a pinned, forced-command SSH account; never receives OAuth credentials. */
export async function invokeClaudeCodeRound(
  config: ModelGatewayConfig,
  route: ModelDeployment,
  request: ModelRoundRequest,
  onUpdate?: (update: ModelRoundUpdate) => void,
  signal?: AbortSignal,
  record?: RequestRecorder
): Promise<ModelRoundResult> {
  if (route.cost.type !== "subscription" || !route.command || !route.args?.length || route.apiKey || route.baseUrl) {
    throw stop("Claude 隔离接口配置无效");
  }
  // No tool definitions or native session identifiers enter this first admission stage.
  if (request.tools.length || request.adapterTools?.length || request.messages.some(m =>
    m.role === "tool" || m.role === "assistant" && (m.toolCalls.length || m.nativeState)
    || m.role === "user" && m.images?.length)) throw stop("Claude 当前接入仅支持纯文本任务");
  signal?.throwIfAborted();
  const taskId = randomUUID();
  const deadline = Date.now() + Math.min(config.modelProgressIdleTimeoutMs, 15 * 60_000);
  const payload = JSON.stringify({ protocol: "zigent-claude-v1", op: "run", taskId,
    agentId: config.id, route: route.name, model: route.apiModel,
    effort: effectiveReasoningEffort(route, request), deadline,
    systemPrompt: request.systemPrompt ?? "",
    messages: request.messages.filter(m => m.role !== "tool").map(m => ({ role: m.role,
      text: m.role === "assistant" ? assistantReplayText(m) : m.text })) });
  if (Buffer.byteLength(payload) > MAX_BYTES) throw stop("Claude 任务超过接口大小限制");
  const started = Date.now();
  let submitted = false;
  let metered = false;
  let observedUsage: TokenUsage | undefined;
  try {
    return await new Promise<ModelRoundResult>((resolve, reject) => {
      // In particular, do not inherit API keys, provider overrides or Claude config paths.
      const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "HOME", "TEMP", "TMP"]
        .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
      const child = spawn(route.command!, [...route.args!], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let total = 0;
      let settled = false;
      let result: ModelRoundResult | undefined;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        child.kill();
        reject(error);
      };
      const unknown = (): ModelHardStopError => new ModelHardStopError("result-unknown", `Claude 任务结果未确认，已停止自动重试（${taskId}）`);
      const abort = (): void => fail(submitted ? unknown() : stop("Claude 任务已取消"));
      const timer = setTimeout(() => fail(submitted ? unknown() : stop("Claude 隔离接口连接超时")), deadline - Date.now());
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => fail(submitted ? unknown() : stop("Claude 隔离接口无法启动")));
      child.stdin.on("error", () => fail(submitted ? unknown() : stop("Claude 任务未提交")));
      // stderr can contain private CLI output. Drain it without exposing it to logs/UI.
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        total += Buffer.byteLength(chunk);
        if (total > MAX_BYTES) { fail(unknown()); return; }
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0 && !settled) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.protocol !== "zigent-claude-v1" || event.taskId !== taskId || result) throw unknown();
            if (event.type === "error") {
              fail(event.kind === "result-unknown" ? unknown() : stop("Claude 隔离环境尚未获准运行")); return;
            }
            if (event.type === "text" && typeof event.text === "string") {
              onUpdate?.({ provider: route.name, name: route.name, brand: route.brand, supplier: route.supplier, apiModel: route.apiModel, protocol: route.protocol, cost: route.cost, capabilities: route.capabilities!, type: "assistant_text.delta", text: event.text });
            } else if (event.type === "result") {
              const usage = event.usage as Record<string, unknown> | undefined;
              const valid = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
              if (event.model !== route.apiModel || typeof event.text !== "string" || !usage
                || !valid(usage.inputTokens) || !valid(usage.outputTokens) || !valid(usage.cachedInputTokens)
                || !valid(usage.cacheWriteTokens5m) || !valid(usage.cacheWriteTokens1h)) throw unknown();
              const tokens = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
                cachedInputTokens: usage.cachedInputTokens, cacheWriteTokens5m: usage.cacheWriteTokens5m,
                cacheWriteTokens1h: usage.cacheWriteTokens1h, cacheHitTokensReported: true };
              observedUsage = tokens;
              result = { text: event.text, textItems: [{ text: event.text, phase: "final_answer" }],
                usage: tokens, toolCalls: [], webSearchCalls: [], citations: [] };
            } else throw unknown();
          } catch (error) { fail(error instanceof ModelHardStopError ? error : unknown()); }
        }
      });
      child.once("close", code => {
        if (settled) return;
        if (code !== 0 || !result || buffer.trim()) { fail(unknown()); return; }
        settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
        record?.({ createdAt: started, usage: result.usage, usageComplete: true, outcome: "completed" });
        metered = true;
        resolve(result);
      });
      submitted = true; // A pipe write may have reached the remote even when its callback fails.
      child.stdin.end(`${payload}\n`);
      if (signal?.aborted) abort();
    });
  } catch (error) {
    if (!metered) record?.({ createdAt: started, usage: observedUsage, usageComplete: Boolean(observedUsage), outcome: "failed" });
    throw error;
  }
}
