import type { UsageObservation, UsageRecorder } from "./usage/types.js";
import { randomUUID } from "node:crypto";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { modelCostMultiplier, type AgentConfig } from "./config.js";
import type { ReferenceImage } from "./image-generation.js";
import type { VideoGenerationRecord } from "./memory/types.js";
import { SupplierHealthRegistry } from "./models/supplier-health.js";

export type VideoResolution = "480p" | "768p" | "2k";
export type VideoRatio = "adaptive" | "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";
export type VideoPromptExpansion = "balanced" | "quality";

export type GeneratedVideo = {
  readonly url?: string;
  readonly data?: Buffer;
  readonly mimeType: string;
  readonly fileName: string;
  readonly jobId: string;
};

export type VideoGenerationRequest = {
  readonly prompt: string;
  readonly duration?: number;
  readonly resolution?: VideoResolution;
  readonly ratio?: VideoRatio;
  readonly watermark?: boolean;
  readonly firstFrame?: ReferenceImage;
  readonly lastFrame?: ReferenceImage;
  readonly referenceImages?: readonly ReferenceImage[];
  readonly promptExpansion?: VideoPromptExpansion;
  readonly signal?: AbortSignal;
};

export type VideoGenerationResult = {
  readonly kind: "video_generation";
  readonly model: string;
  readonly supplier: string;
  readonly duration: number;
  readonly resolution: VideoResolution;
  readonly ratio: VideoRatio;
  readonly videos: readonly [GeneratedVideo];
  readonly generationRecord: VideoGenerationRecord;
};

export interface VideoGenerator {
  generate(request: VideoGenerationRequest): Promise<VideoGenerationResult>;
}

const DEFAULT_BASE_URL = "https://zenmux.ai/api/v1";
const DEFAULT_MODEL = "minimax/minimax-h3-max";
const DEFAULT_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 15_000;
const MAX_INLINE_VIDEO_BYTES = 30 * 1024 * 1024;
const dispatchers = new Map<string, Dispatcher>();
const directDispatchers = new Map<string, Dispatcher>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZenmuxEndpoint(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "zenmux.ai" || hostname.endsWith(".zenmux.ai");
}

function dispatcherFor(
  config: AgentConfig,
  url: string,
  proxy: boolean,
  network = config.videoGeneration?.network
): Dispatcher | undefined {
  const shouldProxy = network
    ? network === "proxy"
    : isZenmuxEndpoint(url);
  if (!shouldProxy) return undefined;
  const timeoutMs = config.videoGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (proxy) {
    if (!config.zenmuxProxyUrl) return undefined;
    const key = `${config.zenmuxProxyUrl}\0${timeoutMs}`;
    const existing = dispatchers.get(key);
    if (existing) return existing;
    const dispatcher = new ProxyAgent({
      uri: config.zenmuxProxyUrl,
      connectTimeout: timeoutMs,
      proxyTls: { timeout: timeoutMs },
      requestTls: { timeout: timeoutMs }
    });
    dispatchers.set(key, dispatcher);
    return dispatcher;
  }
  const key = String(timeoutMs);
  const existing = directDispatchers.get(key);
  if (existing) return existing;
  const dispatcher = new Agent({
    connect: { timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });
  directDispatchers.set(key, dispatcher);
  return dispatcher;
}

function isLocalProxy(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isConnectionRefused(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const details = current && typeof current === "object" ? current as Record<string, unknown> : undefined;
    if (details?.code === "ECONNREFUSED"
      || (current instanceof Error && /econnrefused|connection refused/i.test(current.message))) return true;
    current = details?.cause;
  }
  return false;
}

async function videoFetch(
  config: AgentConfig,
  url: string,
  init: RequestInit,
  network = config.videoGeneration?.network
): Promise<Response> {
  const proxyDispatcher = dispatcherFor(config, url, true, network);
  const directDispatcher = dispatcherFor(config, url, false, network);
  if (!proxyDispatcher) {
    return fetch(url, directDispatcher
      ? { ...init, dispatcher: directDispatcher } as RequestInit & { dispatcher?: Dispatcher }
      : init);
  }
  try {
    return await fetch(url, { ...init, dispatcher: proxyDispatcher } as RequestInit & { dispatcher?: Dispatcher });
  } catch (error) {
    if (!config.zenmuxProxyUrl || !isLocalProxy(config.zenmuxProxyUrl) || !isConnectionRefused(error)) throw error;
    console.warn("Local Zenmux proxy is unavailable; retrying video request without proxy", {
      proxyUrl: config.zenmuxProxyUrl,
      endpoint: url
    });
    return fetch(url, directDispatcher
      ? { ...init, dispatcher: directDispatcher } as RequestInit & { dispatcher?: Dispatcher }
      : init);
  }
}

function abortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Video generation was cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (isRecord(payload) && typeof payload.detail === "string") return payload.detail;
  if (isRecord(payload) && typeof payload.error === "string") return payload.error;
  return fallback;
}

async function responsePayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) as unknown : undefined;
  } catch {
    return raw.slice(0, 500);
  }
}

function firstFrameContent(image: ReferenceImage): Record<string, unknown> {
  return imageContent(image, "first_frame");
}

function imageDataUri(image: ReferenceImage): string {
  if (!image.mimeType.startsWith("image/") || image.data.byteLength === 0) {
    throw new Error("Video reference image is invalid");
  }
  return `data:${image.mimeType};base64,${image.data.toString("base64")}`;
}

function imageContent(image: ReferenceImage, role: "first_frame" | "last_frame" | "reference_image"): Record<string, unknown> {
  return { type: "image_url", role, image_url: { url: imageDataUri(image) } };
}

function videoMimeType(value: string | null): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime?.startsWith("video/") ? mime : "video/mp4";
}

function videoFileName(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (name && /\.[a-z0-9]{2,5}$/i.test(name)) return name.slice(-120);
  } catch {
    // Fall through to the stable default.
  }
  return "generated-video.mp4";
}

async function readVideo(
  config: AgentConfig,
  url: string,
  jobId: string,
  signal?: AbortSignal,
  network = config.videoGeneration?.network,
  apiKey = config.videoGeneration?.apiKey
): Promise<GeneratedVideo> {
  const dataUri = url.match(/^data:(video\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (dataUri) {
    const data = Buffer.from(dataUri[2].replace(/\s/g, ""), "base64");
    if (data.byteLength === 0) throw new Error("Generated video is empty");
    if (data.byteLength > MAX_INLINE_VIDEO_BYTES) {
      throw new Error("Generated video exceeds the 30 MB inline delivery limit and has no download URL");
    }
    return {
      data,
      mimeType: videoMimeType(dataUri[1]),
      fileName: "generated-video.mp4",
      jobId
    };
  }
  const timeoutMs = config.videoGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await videoFetch(config, url, {
    headers: apiKey && isZenmuxEndpoint(url)
      ? { Authorization: `Bearer ${apiKey}` }
      : undefined,
    signal: abortSignal(timeoutMs, signal)
  }, network);
  if (!response.ok) throw new Error(`Unable to download generated video (HTTP ${response.status})`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_INLINE_VIDEO_BYTES) {
    response.body?.cancel().catch(() => undefined);
    return { url, mimeType: videoMimeType(response.headers.get("content-type")), fileName: videoFileName(url), jobId };
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength === 0) throw new Error("Generated video is empty");
  return {
    url,
    ...(data.byteLength <= MAX_INLINE_VIDEO_BYTES ? { data } : {}),
    mimeType: videoMimeType(response.headers.get("content-type")),
    fileName: videoFileName(url),
    jobId
  };
}

export class VideoGenerationGateway implements VideoGenerator {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly supplier: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly supplierHealth = new SupplierHealthRegistry(),
    private readonly recordUsage?: UsageRecorder
  ) {
    this.baseUrl = config.videoGeneration?.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.videoGeneration?.model ?? DEFAULT_MODEL;
    this.supplier = config.videoGeneration?.supplier ?? (isZenmuxEndpoint(this.baseUrl) ? "zenmux" : "video-generation");
  }

  async generate(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const references = request.referenceImages ?? [];
    if (references.length > 9) throw new Error("MiniMax H3 accepts at most 9 reference images");
    if (references.length > 0 && (request.firstFrame || request.lastFrame)) {
      throw new Error("Reference-image mode cannot be combined with first/last-frame mode");
    }
    if (request.lastFrame && !request.firstFrame) {
      throw new Error("A last frame requires a first frame");
    }
    if (this.config.videoGeneration?.official) return this.meterGeneration(request,true);
    const resolution = request.resolution ?? "768p";
    const ratio = request.ratio ?? "16:9";
    const needsOfficialRoute = references.length > 0
      || Boolean(request.lastFrame)
      || resolution === "2k"
      || !["16:9", "9:16", "1:1"].includes(ratio)
      || request.promptExpansion !== undefined
      || (request.duration ?? 5) === 4;
    if (needsOfficialRoute) {
      throw new Error("This request requires the MiniMax official route; configure MINIMAX_API_KEY");
    }
    return this.meterGeneration(request,false);
  }

  private async meterGeneration(request:VideoGenerationRequest,official:boolean): Promise<VideoGenerationResult> {
    let metering: UsageObservation | undefined;
    let recorded=false;
    const meter = (event:UsageObservation,flush=false) => { metering=event;if (flush && !recorded) {recorded=true;this.recordUsage?.(event);} };
    try { return await (official ? this.generateOfficial(request,meter) : this.generateZenmux(request,meter)); }
    finally { if (metering && !recorded) this.recordUsage?.(metering); }
  }

  private async generateOfficial(request: VideoGenerationRequest,meter:(event:UsageObservation,flush?:boolean)=>void): Promise<VideoGenerationResult> {
    const official = this.config.videoGeneration?.official;
    if (!official) {
      throw new Error("MiniMax official video generation is not configured; set MINIMAX_API_KEY");
    }
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Video prompt must not be empty");
    if (prompt.length > 7_000) throw new Error("MiniMax video prompt must not exceed 7000 characters");
    const duration = request.duration ?? 5;
    const resolution = request.resolution ?? "768p";
    const ratio = request.ratio ?? "16:9";
    const references = request.referenceImages ?? [];
    for (const image of [...references, ...(request.firstFrame ? [request.firstFrame] : []), ...(request.lastFrame ? [request.lastFrame] : [])]) {
      if (image.data.byteLength > 30 * 1024 * 1024) {
        throw new Error("Each MiniMax video input image must not exceed 30 MB");
      }
    }
    const useHighResolutionModel = resolution === "2k" || duration === 4;
    if (useHighResolutionModel && resolution === "480p") {
      throw new Error("MiniMax H3 does not support 480p; use 768p when duration is 4 seconds");
    }
    if (useHighResolutionModel && request.promptExpansion !== undefined) {
      throw new Error("prompt expansion is only available with MiniMax H3 Max, not the MiniMax H3 route");
    }
    const model = useHighResolutionModel ? official.highResolutionModel : official.model;
    const endpoint = `${official.baseUrl.replace(/\/+$/, "")}/video_generation`;
    const timeoutMs = this.config.videoGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const content = [
      { type: "text", text: prompt },
      ...references.map((image) => imageContent(image, "reference_image")),
      ...(request.firstFrame ? [imageContent(request.firstFrame, "first_frame")] : []),
      ...(request.lastFrame ? [imageContent(request.lastFrame, "last_frame")] : [])
    ];
    const body = {
      model,
      content,
      duration,
      resolution: resolution === "2k" ? "2K" : resolution.toUpperCase(),
      ratio: request.firstFrame || request.lastFrame ? "adaptive" : ratio,
      aigc_watermark: request.watermark ?? false,
      ...(!useHighResolutionModel && request.promptExpansion
        ? { extra: { prompt_expansion_mode: request.promptExpansion } }
        : {})
    };
    if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024 * 1024) {
      throw new Error("MiniMax video request exceeds the official 64 MB request-body limit; use fewer or smaller images");
    }
    const metering:UsageObservation={ id:`video:${official.supplier}:${randomUUID()}`,
      model:useHighResolutionModel ? official.highResolutionModelName ?? model : official.modelName ?? model,apiModel:model,
      supplier:official.supplier,cost:official.cost,kind:"video",createdAt:Date.now(),outcome:"failed",outputVideos:0 };
    meter(metering);
    let response: Response;
    try {
      response = await videoFetch(this.config, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${official.apiKey}` },
        body: JSON.stringify(body),
        signal: abortSignal(timeoutMs, request.signal)
      }, official.network);
    } catch (error) {
      this.supplierHealth.markFailure(official.supplier, this.config.modelCircuitBreakerMs);
      throw new Error(`MiniMax video generation request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload = await responsePayload(response);
    if (!response.ok) {
      metering.outcome="rejected";
      this.supplierHealth.markFailure(official.supplier, this.config.modelCircuitBreakerMs);
      throw new Error(`${errorMessage(payload, "MiniMax video generation request failed")} (HTTP ${response.status})`);
    }
    if (!isRecord(payload) || typeof payload.task_id !== "string") {
      throw new Error("MiniMax video generation returned no task id");
    }
    const jobId = payload.task_id;
    metering.id=`video:${official.supplier}:${jobId}`; metering.mediaRecordId=jobId;
    let mayPollImmediately = true;
    while (true) {
      request.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`MiniMax video generation timed out after ${timeoutMs} ms`);
      if (mayPollImmediately) mayPollImmediately = false;
      else await pause(Math.min(POLL_INTERVAL_MS, remaining), request.signal);
      const statusResponse = await videoFetch(this.config, `${official.baseUrl.replace(/\/+$/, "")}/query/video_generation/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${official.apiKey}` },
        signal: abortSignal(Math.max(1, deadline - Date.now()), request.signal)
      }, official.network);
      payload = await responsePayload(statusResponse);
      if (!statusResponse.ok) {
        this.supplierHealth.markFailure(official.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(`${errorMessage(payload, "Unable to read MiniMax video task status")} (HTTP ${statusResponse.status})`);
      }
      const task = isRecord(payload) && isRecord(payload.task) ? payload.task : undefined;
      if (task?.status === "succeeded") {
        const contentResult = isRecord(task.content) ? task.content : undefined;
        const videoUrl = typeof contentResult?.url === "string" ? contentResult.url : undefined;
        this.supplierHealth.markSuccess(official.supplier);
        const usage = isRecord(task.usage) ? task.usage : undefined;
        const outputSeconds = Number(usage?.output_seconds ?? task.duration ?? duration);
        const inputImageCount = Number(usage?.input_image_count
          ?? references.length + (request.firstFrame ? 1 : 0) + (request.lastFrame ? 1 : 0));
        const generationRecord: VideoGenerationRecord = {
          generationId: jobId,
          model: useHighResolutionModel
            ? official.highResolutionModelName ?? official.highResolutionModel
            : official.modelName ?? official.model,
          modelSupplier: official.supplier,
          modelCostMultiplier: modelCostMultiplier(official.cost),
          duration,
          outputSeconds: Number.isFinite(outputSeconds) && outputSeconds >= 0 ? outputSeconds : duration,
          resolution,
          inputImageCount: Number.isFinite(inputImageCount) && inputImageCount >= 0 ? inputImageCount : 0
        };
        metering.outcome="completed"; metering.outputVideos=1; metering.outputSeconds=generationRecord.outputSeconds;
        metering.videoUsage={outputSeconds:generationRecord.outputSeconds,resolution,inputImageCount:generationRecord.inputImageCount};
        meter(metering,true);
        if (!videoUrl) throw new Error("MiniMax video generation succeeded without a video URL");
        const video = await readVideo(this.config, videoUrl, jobId, request.signal, official.network);
        return {
          kind: "video_generation",
          model,
          supplier: official.supplier,
          duration,
          resolution,
          ratio: request.firstFrame || request.lastFrame ? "adaptive" : ratio,
          videos: [video],
          generationRecord
        };
      }
      if (task?.status === "failed" || task?.status === "cancelled") {
        this.supplierHealth.markFailure(official.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(errorMessage(payload, `MiniMax video generation ${task.status}`));
      }
    }
  }

  private async generateZenmux(request: VideoGenerationRequest,meter:(event:UsageObservation,flush?:boolean)=>void): Promise<VideoGenerationResult> {
    const apiKey = this.config.videoGeneration?.apiKey;
    if (!apiKey) throw new Error("Video generation is not configured; set ZENMUX_API_KEY or <AGENT>_ZENMUX_API_KEY");
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Video prompt must not be empty");
    const duration = request.duration ?? 5;
    const resolution = request.resolution ?? "768p";
    const ratio = request.ratio ?? "16:9";
    const timeoutMs = this.config.videoGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/videos`;
    const content = [
      { type: "text", text: prompt },
      ...(request.firstFrame ? [firstFrameContent(request.firstFrame)] : [])
    ];
    const metering:UsageObservation={id:`video:${this.supplier}:${randomUUID()}`,
      model:this.config.videoGeneration?.modelName ?? this.model,apiModel:this.model,supplier:this.supplier,cost:this.config.videoGeneration?.cost,
      kind:"video",createdAt:Date.now(),outcome:"failed",outputVideos:0};
    meter(metering);
    let response: Response;
    try {
      response = await videoFetch(this.config, endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: this.model,
          content,
          duration,
          resolution,
          ratio,
          watermark: request.watermark ?? false
        }),
        signal: abortSignal(timeoutMs, request.signal)
      });
    } catch (error) {
      this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
      throw new Error(`Video generation request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload = await responsePayload(response);
    if (!response.ok) {
      metering.outcome="rejected";
      this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
      throw new Error(`${errorMessage(payload, "Video generation request failed")} (HTTP ${response.status})`);
    }
    if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id) {
      throw new Error("Video generation returned no task id");
    }
    const jobId = payload.id;
    metering.id=`video:${this.supplier}:${jobId}`; metering.mediaRecordId=jobId; metering.generationId=jobId;
    let mayPollImmediately = true;
    while (true) {
      request.signal?.throwIfAborted();
      if (isRecord(payload) && payload.status === "succeeded") break;
      if (isRecord(payload) && payload.status === "failed") {
        this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(errorMessage(payload, "Video generation failed"));
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Video generation timed out after ${timeoutMs} ms`);
      if (mayPollImmediately) mayPollImmediately = false;
      else await pause(Math.min(POLL_INTERVAL_MS, remaining), request.signal);
      const pollResponse = await videoFetch(this.config, `${endpoint}/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: abortSignal(Math.max(1, deadline - Date.now()), request.signal)
      });
      payload = await responsePayload(pollResponse);
      if (!pollResponse.ok) {
        this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(`${errorMessage(payload, "Unable to read video task status")} (HTTP ${pollResponse.status})`);
      }
    }
    const contentResult = isRecord(payload.content) ? payload.content : undefined;
    const videoUrl = typeof contentResult?.video_url === "string" ? contentResult.video_url : undefined;
    const usage=isRecord(payload.usage) ? payload.usage : undefined;
    const outputSeconds=typeof usage?.output_seconds === "number" && Number.isFinite(usage.output_seconds) && usage.output_seconds >= 0 ? usage.output_seconds : duration;
    const inputImageCount=typeof usage?.input_image_count === "number" && Number.isSafeInteger(usage.input_image_count) && usage.input_image_count >= 0 ? usage.input_image_count : request.firstFrame ? 1 : 0;
    metering.outcome="completed"; metering.outputVideos=1; metering.outputSeconds=outputSeconds;
    metering.videoUsage={outputSeconds,resolution,inputImageCount};
    meter(metering,true);
    if (!videoUrl) throw new Error("Video generation succeeded without a video URL");
    const video = await readVideo(this.config, videoUrl, jobId, request.signal);
    this.supplierHealth.markSuccess(this.supplier);
    return {
      kind: "video_generation",
      model: this.model,
      supplier: this.supplier,
      duration,
      resolution,
      ratio,
      videos: [video],
      generationRecord: {
        generationId: jobId,
        model: this.config.videoGeneration?.modelName ?? this.model,
        modelSupplier: this.supplier,
        modelCostMultiplier: modelCostMultiplier(this.config.videoGeneration?.cost),
        duration,
        outputSeconds,
        resolution,
        inputImageCount
      }
    };
  }
}

export function isVideoGenerationResult(value: unknown): value is VideoGenerationResult {
  return isRecord(value)
    && value.kind === "video_generation"
    && Array.isArray(value.videos)
    && value.videos.length === 1
    && value.videos.every((video) => isRecord(video)
      && (Buffer.isBuffer(video.data) || typeof video.url === "string"));
}

export function videoResultForModel(value: VideoGenerationResult): Record<string, unknown> {
  return {
    kind: value.kind,
    model: value.model,
    supplier: value.supplier,
    duration: value.duration,
    resolution: value.resolution,
    ratio: value.ratio,
    billedOutputSeconds: value.generationRecord.outputSeconds,
    videos: value.videos.map((video) => ({
      ...(video.url ? { url: video.url } : {}),
      mimeType: video.mimeType,
      fileName: video.fileName
    }))
  };
}
