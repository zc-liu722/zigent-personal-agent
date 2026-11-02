import { ProxyAgent, type Dispatcher } from "undici";
import type { ModelDeployment } from "../config.js";
import type { TokenUsage } from "../memory/types.js";
import type { RequestRecorder } from "../usage/types.js";
import { ModelConnectionError, ModelError, ModelInvalidResponseError, ModelRequestAbortedError, ModelTimeoutError, ModelWebSearchError, ProviderUnavailableError, classifyModelFailure } from "./errors.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import { readModelStream } from "./model-stream.js";
import { isNetworkFailure, networkRetryDelay } from "./network-retry.js";
import type { ModelTextResult, StreamEventReader, StreamUpdate } from "./stream-types.js";
import { mergeUsage } from "./stream-usage.js";
import { ModelContextOverflowError } from "./errors.js";

const zenmuxProxyDispatchers = new Map<string, Dispatcher>();

function isZenmuxEndpoint(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "zenmux.ai" || hostname.endsWith(".zenmux.ai");
}

function safeModelEndpoint(url: string): string {
  const endpoint = new URL(url);
  return `${endpoint.origin}${endpoint.pathname}`;
}

function safeErrorMessage(error: { message?: unknown }): string | undefined {
  if (typeof error.message !== "string") return undefined;
  // HTTP error bodies may contain provider diagnostics or echoed request data.
  const httpFailure = error.message.match(/^Model returned (\d{3}):/);
  return httpFailure ? `Model returned HTTP ${httpFailure[1]}` : error.message.slice(0, 500);
}

function modelErrorChain(error: unknown): Array<Record<string, string | number | undefined>> {
  const chain: Array<Record<string, string | number | undefined>> = [];
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const details = current as {
      name?: unknown;
      code?: unknown;
      syscall?: unknown;
      address?: unknown;
      port?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    chain.push({
      name: typeof details.name === "string" ? details.name : undefined,
      code: typeof details.code === "string" || typeof details.code === "number"
        ? String(details.code)
        : undefined,
      syscall: typeof details.syscall === "string" ? details.syscall : undefined,
      address: typeof details.address === "string" ? details.address : undefined,
      port: typeof details.port === "number" ? details.port : undefined,
      message: safeErrorMessage(details)
    });
    current = details.cause;
  }
  return chain;
}

export function modelRequestDispatcher(
  config: Pick<ModelGatewayConfig, "zenmuxProxyUrl" | "modelConnectTimeoutMs">,
  url: string,
  network?: ModelDeployment["network"]
): Dispatcher | undefined {
  const shouldProxy = network ? network === "proxy" : isZenmuxEndpoint(url);
  if (!config.zenmuxProxyUrl || !shouldProxy) return undefined;
  const dispatcherKey = `${config.zenmuxProxyUrl}\0${config.modelConnectTimeoutMs}`;
  const existing = zenmuxProxyDispatchers.get(dispatcherKey);
  if (existing) return existing;
  const dispatcher = new ProxyAgent({
    uri: config.zenmuxProxyUrl,
    connectTimeout: config.modelConnectTimeoutMs,
    proxyTls: { timeout: config.modelConnectTimeoutMs },
    requestTls: { timeout: config.modelConnectTimeoutMs }
  });
  zenmuxProxyDispatchers.set(dispatcherKey, dispatcher);
  return dispatcher;
}

async function requestStreamTextOnce(
  config: ModelGatewayConfig,
  url: string,
  token: string,
  payload: unknown,
  readEvent: StreamEventReader,
  providerHeaders?: Record<string, string>,
  onUpdate?: (update: StreamUpdate) => void,
  network?: ModelDeployment["network"],
  signal?: AbortSignal,
  record?: RequestRecorder
): Promise<ModelTextResult> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const startedAt = Date.now();
  let timeoutKind: "first-progress" | "progress-idle" | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let phase = "awaiting-response-headers";
  let responseStatus: number | undefined;
  let metered: TokenUsage | undefined;
  let generationId: string | undefined;
  let completed = false, inputReported = false, outputReported = false;
  let streamCompleted = false;
  let searchError: StreamUpdate["webSearchError"];
  const observeUsage = (update: StreamUpdate): void => {
    streamCompleted ||= Boolean(update.completed);
    if (update.webSearchError) searchError = update.webSearchError;
    if (update.generationId) generationId = update.generationId;
    inputReported ||= Boolean(update.inputTokensReported);
    outputReported ||= Boolean(update.outputTokensReported);
    if (update.usage) metered = mergeUsage(metered, update.usage);
    onUpdate?.(update);
  };

  const armProgressTimer = (kind: "first-progress" | "progress-idle", timeoutMs: number): void => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      timeoutKind = kind;
      controller.abort();
    }, timeoutMs);
  };
  armProgressTimer("first-progress", config.modelFirstProgressTimeoutMs);

  const markProgress = (): void => {
    armProgressTimer("progress-idle", config.modelProgressIdleTimeoutMs);
  };

  try {
    signal?.throwIfAborted();
    const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(providerHeaders ?? { Authorization: `Bearer ${token}` })
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      dispatcher: modelRequestDispatcher(config, url, network)
    };
    const response = await fetch(url, requestInit);
    responseStatus = response.status;
    generationId = response.headers.get("x-generation-id") ?? undefined;
    phase = response.ok ? "streaming-response" : "reading-error-response";
    if (!response.ok) {
      const raw = await response.text();
      // Kimi distinguishes an account's smaller context entitlement (403) from
      // missing model access. Only the explicit numeric context restriction is
      // recoverable; ordinary authorization errors retain their normal handling.
      const accountContext = response.status === 403
        ? raw.match(/current plan supports only .{0,80}?up to\s+(\d+(?:\.\d+)?)\s*([km])\s+context/i) : null;
      if (accountContext || [400, 413, 422].includes(response.status)
        && /context[_ -]?(?:length|window|limit)|maximum context|model token limit|prompt.{0,30}too long|input.{0,30}(?:too long|exceeds)|too many tokens/i.test(raw)) {
        const reported = raw.match(/(?:maximum context length is|context window(?: is|:)?|model token limit:|max(?:imum)?[_ ]context[_ ](?:length|tokens)["': ]+)\s*([\d,]+)/i)?.[1];
        const window = accountContext ? Number(accountContext[1]) * (accountContext[2]!.toLowerCase() === "m" ? 1048576 : 1024)
          : reported ? Number(reported.replace(/,/g, "")) : undefined;
        throw new ModelContextOverflowError(window && Number.isSafeInteger(window) && window >= 4096 ? window : undefined);
      }
      const message = `Model returned ${response.status}: ${raw.slice(0, 500)}`;
      throw isUnavailableStatus(response.status)
        ? new ProviderUnavailableError(message, response.status)
        : new ModelError(message, response.status);
    }
    if (!response.body) {
      throw new ModelInvalidResponseError("Model returned an empty response stream", response.status);
    }

    const result = await readModelStream(response.body, readEvent, markProgress, observeUsage);
    streamCompleted ||= result.completed;
    if (searchError) throw new ModelWebSearchError(searchError.code, searchError.retryable);
    if (!result.completed) {
      throw new ModelInvalidResponseError("Model response stream ended before completion", response.status);
    }
    if (!result.text.trim() && result.toolCalls.length === 0) {
      throw new ModelInvalidResponseError("Model returned no text in its response stream", response.status);
    }
    phase = "completed";
    completed = true;
    return result;
  } catch (error) {
    console.warn("Model request failed", {
      agentId: config.id,
      endpoint: safeModelEndpoint(url),
      proxyEnabled: Boolean(config.zenmuxProxyUrl && (network ? network === "proxy" : isZenmuxEndpoint(url))),
      phase,
      responseStatus,
      elapsedMs: Date.now() - startedAt,
      timeoutKind,
      errorChain: modelErrorChain(error)
    });
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (error instanceof ModelError) throw error;
    if (timeoutKind === "first-progress") {
      throw new ModelTimeoutError(
        `Model produced no progress for ${config.modelFirstProgressTimeoutMs} ms after the request started`,
        "first-progress-timeout"
      );
    }
    if (timeoutKind === "progress-idle") {
      throw new ModelTimeoutError(
        `Model produced no progress for ${config.modelProgressIdleTimeoutMs} ms while streaming`,
        "stream-idle-timeout"
      );
    }
    if (isTransportTimeoutError(error)) {
      throw new ModelTimeoutError("Model transport timed out", "transport-timeout");
    }
    if (isAbortError(error)) {
      throw new ModelRequestAbortedError("Model request was aborted before the progress timeout elapsed");
    }
    throw new ModelConnectionError(`Model connection failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (progressTimer) clearTimeout(progressTimer);
    signal?.removeEventListener("abort", abortFromCaller);
    record?.({ createdAt: startedAt, usage: metered, usageComplete: streamCompleted && inputReported && outputReported, generationId,
      outcome: completed ? "completed" : responseStatus && responseStatus >= 400 ? "rejected" : "failed" });
  }
}

function isRetryableModelError(error: unknown): error is ModelError {
  if (error instanceof ModelWebSearchError) return error.retryable;
  if (!(error instanceof ProviderUnavailableError)) return false;
  if (
    error instanceof ModelConnectionError
    || error instanceof ModelTimeoutError
    || error instanceof ModelRequestAbortedError
    || error instanceof ModelInvalidResponseError
  ) return true;
  return error.status === undefined
    || error.status === 408
    || error.status === 425
    || error.status === 429
    || error.status >= 500;
}

export async function requestStreamText(
  config: ModelGatewayConfig,
  url: string,
  token: string,
  payload: unknown,
  createReader: () => StreamEventReader,
  providerHeaders?: Record<string, string>,
  onUpdate?: (update: StreamUpdate) => void,
  network?: ModelDeployment["network"],
  signal?: AbortSignal,
  record?: RequestRecorder
): Promise<ModelTextResult> {
  const ordinaryAttempts = Math.max(1, config.modelRetryAttempts ?? 1);
  const proxy = network === "proxy" || !network && isZenmuxEndpoint(url);
  const networkAttempts = 1 + (config.modelNetworkRetryAttempts ?? 5);
  let attempt = 0;
  const observeUpdate = (update: StreamUpdate): void => {
    onUpdate?.(update);
  };

  while (true) {
    signal?.throwIfAborted();
    attempt += 1;
    try {
      return await requestStreamTextOnce(
        config,
        url,
        token,
        payload,
        createReader(),
        providerHeaders,
        observeUpdate,
        network,
        signal,
        record
      );
    } catch (error) {
      const kind = error instanceof ModelError ? classifyModelFailure(error) : undefined;
      const reconnecting = proxy && kind && isNetworkFailure(kind);
      const maxAttempts = reconnecting ? networkAttempts : ordinaryAttempts;
      if (signal?.aborted || !isRetryableModelError(error) || attempt >= maxAttempts) throw error;
      const delayMs = reconnecting ? networkRetryDelay(config.modelRetryDelayMs ?? 1000, attempt)
        : config.modelRetryDelayMs ?? 1000;
      onUpdate?.({ progress: false, reset: true });
      onUpdate?.({
        progress: false,
        retry: {
          attempt: attempt + 1,
          maxAttempts,
          failureKind: classifyModelFailure(error)
        }
      });
      console.warn("Retrying model request", {
        agentId: config.id,
        endpoint: safeModelEndpoint(url),
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs
      });
      if (delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          signal?.throwIfAborted();
          const finish = (): void => {
            signal?.removeEventListener("abort", abort);
            resolve();
          };
          const timer = setTimeout(finish, delayMs);
          const abort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
          };
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    }
  }

  throw new ModelConnectionError("Model request failed after all retry attempts");
}

function isUnavailableStatus(status: number): boolean {
  return status === 401
    || status === 402
    || status === 403
    || status === 404
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function errorChainIncludes(error: unknown, predicate: (details: { name?: unknown; code?: unknown }) => boolean): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    const details = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (predicate(details)) return true;
    current = details.cause;
  }
  return false;
}

function isTransportTimeoutError(error: unknown): boolean {
  const timeoutCodes = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
  return errorChainIncludes(error, (details) =>
    details.name === "TimeoutError" || timeoutCodes.has(String(details.code))
  );
}

function isAbortError(error: unknown): boolean {
  return errorChainIncludes(error, (details) => details.name === "AbortError");
}
