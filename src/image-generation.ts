import type { UsageObservation, UsageRecorder } from "./usage/types.js";
import { createHash, randomUUID } from "node:crypto";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { modelCostMultiplier, type AgentConfig, type ModelCostPolicy } from "./config.js";
import type { ImageExperimentVariant, ImageGenerationRecord, ImageGenerationUsage } from "./memory/types.js";
import { SupplierHealthRegistry } from "./models/supplier-health.js";
import { generateCodexImage, converseCodexImages } from "./models/codex-image-generation.js";
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } from "./image-generation-policy.js";

export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536" | "auto";
export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageInputFidelity = "high" | "low";

export type StoredImageSource = {
  readonly provider: "web";
  readonly messageId: string;
  readonly imageKey: string;
};

export type GeneratedImage = {
  readonly data: Buffer;
  readonly mimeType: string;
  /** Links a delivered image back to the generation attempt that produced it. */
  readonly generationId?: string;
  readonly revisedPrompt?: string;
  readonly experimentId?: string;
  readonly variant?: ImageExperimentVariant;
  readonly ordinal?: number;
  readonly sha256?: string;
};

export type ReferenceImage = {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly source?: StoredImageSource;
};

export type ImageGenerationRequest = {
  readonly reasoningEfforts?: Readonly<Record<string, import("./config.js").ReasoningEffort>>;
  readonly prompt: string;
  /** Stable local generation record identity; never sent to the supplier. */
  readonly usageRecordId?: string;
  readonly n?: number;
  readonly size?: ImageSize;
  readonly quality?: ImageQuality;
  readonly inputFidelity?: ImageInputFidelity;
  readonly referenceImages?: readonly ReferenceImage[];
};

export type ImageGenerationResult = {
  readonly kind: "image_generation";
  readonly images: readonly GeneratedImage[];
  readonly generationRecords: readonly ImageGenerationRecord[];
  readonly comparisonIncomplete: boolean;
  readonly text?: string;
};

/** Original application messages; image bytes are loaded only when syncing new history. */
export type ImageConversationMessage = {
  readonly id: string;
  readonly turnId: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly imageIds: readonly string[];
  readonly loadImages?: () => Promise<readonly ReferenceImage[]>;
};
export type ImageConversationRequest = {
  readonly sessionId: string;
  readonly userId: string;
  readonly turnId: number;
  readonly messages: readonly ImageConversationMessage[];
  /** Canonical text-model identity captured by the executor, never tool arguments. */
  readonly selectedModel?: import("./config.js").Provider;
  readonly reasoningEfforts?: ImageGenerationRequest["reasoningEfforts"];
  readonly signal?: AbortSignal;
};
export type ImageConversationResult = { readonly text: string; readonly attempts: readonly ImageGenerationAttemptResult[] };

export type ImageGenerationAttemptResult = {
  readonly generationId?: string;
  readonly model: string;
  readonly supplier: string;
  readonly prompt: string;
  readonly size: ImageSize;
  readonly quality: ImageQuality;
  readonly inputFidelity?: ImageInputFidelity;
  readonly image: GeneratedImage;
  /** Singleton compatibility view; the gateway always enforces one image. */
  readonly images: readonly [GeneratedImage];
  readonly usage: ImageGenerationUsage;
};

export interface ImageGenerator {
  readonly conversation?: (request: ImageConversationRequest) => Promise<ImageConversationResult>;
  metadata?(): { readonly model: string; readonly supplier: string; readonly cost?: ModelCostPolicy };
  generate(request: ImageGenerationRequest): Promise<ImageGenerationAttemptResult>;
}

const DEFAULT_BASE_URL = "https://zenmux.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-image-2.5-sunburst";
const DEFAULT_QUALITY: ImageQuality = "high";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 16;
const DEFAULT_TIMEOUT_MS = DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
const dispatchers = new Map<string, Dispatcher>();
const directDispatchers = new Map<string, Dispatcher>();

function isZenmuxEndpoint(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  return hostname === "zenmux.ai" || hostname.endsWith(".zenmux.ai");
}

function requestDispatcher(config: AgentConfig, url: string): Dispatcher | undefined {
  const shouldProxy = config.imageGeneration?.network
    ? config.imageGeneration.network === "proxy"
    : isZenmuxEndpoint(url);
  if (!config.zenmuxProxyUrl || !shouldProxy) return undefined;
  const timeoutMs = config.imageGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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

function directRequestDispatcher(config: AgentConfig, url: string): Dispatcher | undefined {
  const proxyRoute = config.imageGeneration?.network
    ? config.imageGeneration.network === "proxy"
    : isZenmuxEndpoint(url);
  if (!proxyRoute) return undefined;
  const timeoutMs = config.imageGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
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

function isProxyConnectionRefused(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const details = current instanceof Error
      ? { message: current.message, cause: current.cause }
      : current && typeof current === "object"
        ? current as { message?: unknown; code?: unknown; cause?: unknown }
        : undefined;
    if (details && (details.code === "ECONNREFUSED"
      || (typeof details.message === "string" && /econnrefused|connection refused/i.test(details.message)))) {
      return true;
    }
    current = details?.cause;
  }
  return false;
}

async function fetchImageRequest(
  config: AgentConfig,
  url: string,
  init: RequestInit
): Promise<Response> {
  const dispatcher = requestDispatcher(config, url);
  const directDispatcher = directRequestDispatcher(config, url);
  if (!dispatcher) {
    return fetch(url, directDispatcher
      ? { ...init, dispatcher: directDispatcher } as RequestInit & { dispatcher?: Dispatcher }
      : init);
  }

  try {
    return await fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher?: Dispatcher });
  } catch (error) {
    if (!config.zenmuxProxyUrl || !isLocalProxy(config.zenmuxProxyUrl) || !isProxyConnectionRefused(error)) {
      throw error;
    }
    console.warn("Local Zenmux proxy is unavailable; retrying image request without proxy", {
      proxyUrl: config.zenmuxProxyUrl,
      endpoint: url
    });
    return fetch(url, directDispatcher
      ? { ...init, dispatcher: directDispatcher } as RequestInit & { dispatcher?: Dispatcher }
      : init);
  }
}

function imageMimeType(value: string | null | undefined): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mime?.startsWith("image/") ? mime : "image/png";
}

function parseDataUri(value: string): { data: Buffer; mimeType: string } | undefined {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return undefined;
  const data = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  return data.length > 0 ? { data, mimeType: imageMimeType(match[1]) } : undefined;
}

async function readImageUrl(config: AgentConfig, value: string): Promise<GeneratedImage> {
  const timeoutMs = config.imageGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataUri = parseDataUri(value);
  if (dataUri) {
    if (dataUri.data.byteLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 10 MB image limit");
    return dataUri;
  }
  let response: Response;
  try {
    response = await fetchImageRequest(config, value, {
      ...(config.imageGeneration?.apiKey && isZenmuxEndpoint(value)
        ? { headers: { Authorization: `Bearer ${config.imageGeneration.apiKey}` } }
        : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Unable to download generated image: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`Unable to download generated image (HTTP ${response.status})`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 10 MB image limit");
  const data = Buffer.from(await response.arrayBuffer());
  if (data.byteLength === 0) throw new Error("Generated image is empty");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 10 MB image limit");
  return { data, mimeType: imageMimeType(response.headers.get("content-type")) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(payload: unknown): string {
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 500);
  return "Image generation request failed";
}

function requestErrorText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error && current.message) messages.push(current.message);
    const details = current && typeof current === "object" ? current as Record<string, unknown> : undefined;
    if (typeof details?.code === "string") messages.push(details.code);
    current = details?.cause;
  }
  return [...new Set(messages)].join("; ") || String(error);
}

function referenceImageFilename(index: number, mimeType: string): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/", 2)[1] || "png";
  return `reference-${index}.${extension}`;
}

function streamingImagePayload(raw: string): Record<string, unknown> {
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(payload) || typeof payload.type !== "string" || !payload.type.endsWith(".completed")) continue;
    if (typeof payload.b64_json !== "string" && typeof payload.url !== "string") {
      throw new Error("Image generation stream completed without an image");
    }
    return {
      ...(typeof payload.id === "string" ? { id: payload.id } : {}),
      data: [{
        ...(typeof payload.b64_json === "string" ? { b64_json: payload.b64_json } : {}),
        ...(typeof payload.url === "string" ? { url: payload.url } : {}),
        ...(typeof payload.revised_prompt === "string" ? { revised_prompt: payload.revised_prompt } : {})
      }],
      ...(isRecord(payload.usage) ? { usage: payload.usage } : {})
    };
  }
  throw new Error("Image generation stream ended without a completed image");
}

function nonNegativeToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function estimatePromptTokens(prompt: string): number {
  return Math.max(1, Math.ceil(Array.from(prompt).length / 4));
}

function estimateImageOutputTokens(size: ImageSize, imageCount: number): number {
  // Provider-specific fallback used only when the image API omits usage.
  const tokensPerImage = size === "1024x1024" || size === "auto" ? 1_767 : 1_367;
  return tokensPerImage * imageCount;
}

function imageGenerationUsage(
  payload: Record<string, unknown>,
  model: string,
  prompt: string,
  size: ImageSize,
  imageCount: number
): ImageGenerationUsage {
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  const inputDetails = usage && isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const outputDetails = usage && isRecord(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
  const inputTokens = nonNegativeToken(usage?.input_tokens) ?? estimatePromptTokens(prompt);
  const outputTokens = nonNegativeToken(usage?.output_tokens) ?? estimateImageOutputTokens(size, imageCount);
  const inputTextTokens = nonNegativeToken(inputDetails?.text_tokens) ?? inputTokens;
  const inputImageTokens = nonNegativeToken(inputDetails?.image_tokens) ?? Math.max(0, inputTokens - inputTextTokens);
  const cachedInputTokens = nonNegativeToken(inputDetails?.cached_tokens)
    ?? nonNegativeToken(usage?.cached_input_tokens)
    ?? nonNegativeToken(usage?.cache_read_input_tokens)
    ?? 0;
  const outputImageTokens = nonNegativeToken(outputDetails?.image_tokens) ?? outputTokens;
  const outputTextTokens = nonNegativeToken(outputDetails?.text_tokens) ?? Math.max(0, outputTokens - outputImageTokens);
  return {
    model,
    inputTokens,
    inputTextTokens,
    inputImageTokens,
    cachedInputTokens,
    outputTokens,
    outputTextTokens,
    outputImageTokens,
    estimated: nonNegativeToken(usage?.input_tokens) === undefined || nonNegativeToken(usage?.output_tokens) === undefined,
    billingDetails: {
      breakdownComplete: [inputDetails?.text_tokens,inputDetails?.image_tokens,outputDetails?.text_tokens,outputDetails?.image_tokens].every(value => nonNegativeToken(value) !== undefined),
      cacheBilling: "none"
    }
  };
}

export class ImageGenerationGateway implements ImageGenerator {
  readonly conversation?: ImageGenerator["conversation"];
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly supplier: string;

  constructor(
    private readonly config: AgentConfig,
    private readonly supplierHealth = new SupplierHealthRegistry(),
    private readonly recordUsage?: UsageRecorder
  ) {
    if (config.imageGeneration?.transport === "codex-app-server") {
      this.conversation = request => converseCodexImages(config, request, this.recordUsage);
    }
    this.baseUrl = config.imageGeneration?.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.imageGeneration?.model ?? DEFAULT_MODEL;
    this.supplier = config.imageGeneration?.supplier
      ?? (isZenmuxEndpoint(this.baseUrl) ? "zenmux" : "image-generation");
  }

  metadata(): { readonly model: string; readonly supplier: string; readonly cost?: ModelCostPolicy } {
    return { model: this.config.imageGeneration?.modelName ?? this.model, supplier: this.supplier, cost: this.config.imageGeneration?.cost };
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationAttemptResult> {
    const timeoutMs = this.config.imageGenerationTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const apiKey = this.config.imageGeneration?.apiKey;
    const prompt = request.prompt;
    if (!prompt.trim()) throw new Error("Image prompt must not be empty");
    if (request.n !== undefined && request.n !== 1) throw new Error("Image generation requires n=1");
    const n = 1;
    const size = request.size ?? "1024x1024";
    const quality = request.quality ?? DEFAULT_QUALITY;
    const referenceImages = request.referenceImages ?? [];
    if (referenceImages.length > MAX_REFERENCE_IMAGES) {
      throw new Error(`Image generation accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
    for (const image of referenceImages) {
      if (!image.mimeType.startsWith("image/")) throw new Error("Reference image MIME type is invalid");
      if (image.data.byteLength === 0) throw new Error("Reference image is empty");
      if (image.data.byteLength > MAX_IMAGE_BYTES) throw new Error("Reference image exceeds the 10 MB limit");
    }
    if (this.config.imageGeneration?.transport === "codex-app-server") {
      return generateCodexImage(this.config, request, this.recordUsage);
    }
    if (!apiKey) throw new Error("Image generation is not configured; set ZENMUX_API_KEY or <AGENT>_ZENMUX_API_KEY");
    const isEdit = referenceImages.length > 0;
    const endpoint = `${this.baseUrl.replace(/\/+$/, "")}/images/${isEdit ? "edits" : "generations"}`;
    const body: BodyInit = isEdit
      ? (() => {
          const form = new FormData();
          form.set("model", this.model);
          form.set("prompt", prompt);
          form.set("n", String(n));
          form.set("size", size);
          form.set("quality", quality);
          if (request.inputFidelity) form.set("input_fidelity", request.inputFidelity);
          form.set("stream", "true");
          form.set("partial_images", "1");
          referenceImages.forEach((image, index) => {
            form.append(
              "image[]",
              new Blob([new Uint8Array(image.data)], { type: image.mimeType }),
              referenceImageFilename(index + 1, image.mimeType)
            );
          });
          return form;
        })()
      : JSON.stringify({ model: this.model, prompt, n, size, quality });
    const metering: UsageObservation = {
      id: `image:${this.supplier}:${request.usageRecordId ?? randomUUID()}`, mediaRecordId:request.usageRecordId,
      model:this.config.imageGeneration?.modelName ?? this.model,apiModel:this.model,supplier:this.supplier,cost:this.config.imageGeneration?.cost,
      kind:"image",createdAt:Date.now(),outcome:"failed",outputImages:0
    };
    let recorded=false;
    const flush=()=>{if (!recorded) {recorded=true;this.recordUsage?.(metering);}};
    try {
      let response: Response;
      try {
        response = await fetchImageRequest(this.config, endpoint, {
          method: "POST",
          headers: isEdit
            ? { Authorization: `Bearer ${apiKey}` }
            : { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(`Image generation request failed: ${requestErrorText(error)}`);
      }
      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(`Image generation response failed: ${requestErrorText(error)}`);
      }
      let payload: unknown;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        payload = streamingImagePayload(raw);
      } else {
        try {
          payload = raw ? JSON.parse(raw) as unknown : undefined;
        } catch {
          payload = raw;
        }
      }
      if (!response.ok) {
        metering.outcome = "rejected";
        this.supplierHealth.markFailure(this.supplier, this.config.modelCircuitBreakerMs);
        throw new Error(`${errorText(payload)} (HTTP ${response.status})`);
      }
      this.supplierHealth.markSuccess(this.supplier);
      if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error("Image generation returned an invalid response");
      const meteredUsage = imageGenerationUsage(payload, this.model, prompt, size, payload.data.length);
      metering.usage=meteredUsage; metering.imageUsage={...meteredUsage,...meteredUsage.billingDetails};
      metering.usageComplete=!meteredUsage.estimated; metering.estimatedTokens=meteredUsage.estimated;
      metering.outputImages=payload.data.filter(item => isRecord(item) && (typeof item.url === "string" || typeof item.b64_json === "string")).length;
      metering.outcome=metering.outputImages > 0 ? "completed" : "failed";
      metering.generationId=typeof payload.id === "string" ? payload.id : response.headers.get("x-generation-id") ?? undefined;
      flush();
      const images: GeneratedImage[] = [];
      for (const item of payload.data) {
        if (!isRecord(item)) continue;
        const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : undefined;
        if (typeof item.url === "string") images.push({ ...(await readImageUrl(this.config, item.url)), revisedPrompt });
        else if (typeof item.b64_json === "string") {
          const data = Buffer.from(item.b64_json, "base64");
          if (data.length === 0) throw new Error("Image generation returned an empty image");
          if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("Generated image exceeds the 10 MB image limit");
          images.push({ data, mimeType: "image/png", revisedPrompt });
        }
      }
      if (images.length === 0) throw new Error("Image generation returned no usable images");
      if (images.length !== 1) throw new Error(`Image generation expected exactly one image, received ${images.length}`);
      return {
        model: this.model,
        supplier: this.supplier,
        prompt,
        size,
        quality,
        inputFidelity: isEdit ? request.inputFidelity : undefined,
        image: images[0]!,
        images: [images[0]!],
        usage: {
          ...imageGenerationUsage(payload, this.model, prompt, size, images.length),
          modelSupplier: this.supplier,
          modelCostMultiplier: modelCostMultiplier(this.config.imageGeneration?.cost)
        }
      };
    } finally { flush(); }
  }
}

export function isImageGenerationResult(value: unknown): value is ImageGenerationResult {
  return isRecord(value)
    && value.kind === "image_generation"
    && Array.isArray(value.images)
    && value.images.every((image) => isRecord(image) && Buffer.isBuffer(image.data))
    && Array.isArray(value.generationRecords);
}

export function imageResultForModel(value: ImageGenerationResult): Record<string, unknown> {
  return {
    kind: value.kind,
    ...(value.text ? { text: value.text } : {}),
    comparisonIncomplete: value.comparisonIncomplete,
    images: value.images.map((image, index) => ({
      index: index + 1,
      mimeType: image.mimeType,
      revisedPrompt: image.revisedPrompt,
      variant: image.variant,
      ordinal: image.ordinal,
      sha256: image.sha256
    })),
    generations: value.generationRecords.map((record) => ({
      variant: record.variant,
      ordinal: record.ordinal,
      status: record.status,
      revisedPrompt: record.revisedPrompt,
      inputFidelity: record.inputFidelity,
      error: record.error
    }))
  };
}

export function imageSha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
