import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { AgentConfig, ModelDeployment } from "../config.js";
import type { GeneratedImage, ImageConversationMessage, ImageConversationRequest, ImageConversationResult,
  ImageGenerationAttemptResult, ImageGenerationRequest, ReferenceImage } from "../image-generation.js";
import type { ImageGenerationUsage, TokenUsage } from "../memory/types.js";
import { sniffImageMimeType } from "../media/image-mime.js";
import type { UsageObservation, UsageRecorder } from "../usage/types.js";
import { invokeCodexAppServerRound } from "./codex-app-server.js";
import { imageHistoryHash, withImageConversation, type OfficialImageConversation } from "./image-conversation-store.js";
import { effectiveReasoningEffort, savedReasoningEffort } from "./reasoning.js";
import { currentPerformance } from "../performance/store.js";
import { DEFAULT_IMAGE_GENERATION_TIMEOUT_MS } from "../image-generation-policy.js";

const MAX_BYTES = 10 * 1024 * 1024;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function imageDriver(config: AgentConfig): ModelDeployment {
  const route = config.imageGeneration, driver = route?.driver;
  if (!route || !driver || driver.protocol !== "codex-app-server" || driver.cost.type !== "subscription"
    || route.cost?.type !== "subscription" || driver.supplier !== route.supplier || route.model !== "gpt-image-2") {
    throw new Error("ChatGPT image generation requires a configured subscription driver and gpt-image-2");
  }
  return driver;
}

/** Follow the selected GPT version through its explicitly configured ChatGPT
 * subscription route. Other suppliers remain separate identities and prices.
 */
function conversationDriver(config: AgentConfig, request: ImageConversationRequest): {
  config: AgentConfig; reasoningEfforts: ImageGenerationRequest["reasoningEfforts"];
} {
  const fallback = imageDriver(config);
  const defaultDriver = { config, reasoningEfforts: { ...request.reasoningEfforts,
    [fallback.name]: savedReasoningEffort(fallback, request.reasoningEfforts?.[fallback.name])
      ?? fallback.reasoningEffort ?? "high" } };
  const selected = config.models?.find(model => model.name === request.selectedModel);
  if (selected?.brand !== "openai" || !selected.name.startsWith("gpt-")) return defaultDriver;
  const familyVersion = selected.name.slice(0, selected.name.lastIndexOf("-"));
  const driver = config.models?.find(model => model.brand === "openai"
    && model.name.slice(0, model.name.lastIndexOf("-")) === familyVersion
    && model.apiModel === selected.apiModel.replace(/^openai\//, "")
    && model.supplier === fallback.supplier && model.protocol === "codex-app-server" && model.cost.type === "subscription");
  if (!driver) return defaultDriver;
  const requestedEffort = effectiveReasoningEffort(selected, { messages: [], tools: [], reasoningEfforts: request.reasoningEfforts });
  const effort = savedReasoningEffort(driver, requestedEffort);
  return {
    config: { ...config, imageGeneration: { ...config.imageGeneration!, driver } },
    // Reuse a cross-supplier preference only when this exact destination route
    // supports it. Never persist derived choices or mutate deployment defaults.
    reasoningEfforts: effort ? { ...request.reasoningEfforts, [driver.name]: effort } : request.reasoningEfforts
  };
}

async function readOfficialImage(item: Record<string, unknown>, workspace: string): Promise<GeneratedImage> {
  const failure = object(item.failure);
  if (failure.type === "usageLimitExceeded") throw new Error("ChatGPT image generation usage limit exceeded");
  if (item.failure || item.status !== "completed") throw new Error("ChatGPT image generation did not complete successfully");
  let data: Buffer;
  if (typeof item.result === "string" && item.result) {
    const encoded = item.result.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[a-z0-9+/=\s]+$/i.test(encoded)) {
      throw new Error("ChatGPT returned an invalid or oversized image");
    }
    data = Buffer.from(encoded, "base64");
  } else if (typeof item.savedPath === "string") {
    const path = relative(workspace, item.savedPath);
    if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")
      || (await stat(item.savedPath)).size > MAX_BYTES) throw new Error("ChatGPT returned an invalid image path");
    data = await readFile(item.savedPath);
  } else throw new Error("ChatGPT returned no image data");
  const mimeType = sniffImageMimeType(data);
  if (!mimeType || !data.length || data.length > MAX_BYTES) throw new Error("ChatGPT returned an invalid image");
  return { data, mimeType, ...(typeof item.revisedPrompt === "string" ? { revisedPrompt: item.revisedPrompt } : {}) };
}

function imageUsage(item: Record<string, unknown>, model: string, supplier: string): ImageGenerationUsage {
  const reported = object(item.usage), inputs = object(reported.input_tokens_details), outputs = object(reported.output_tokens_details);
  const input = count(reported.input_tokens), output = count(reported.output_tokens);
  // Numeric legacy columns require placeholders. estimated=true means these are
  // missing counters, and they are never submitted as provider-reported tokens.
  return { model, modelSupplier: supplier, modelCostMultiplier: 0,
    inputTokens: input ?? 0, outputTokens: output ?? 0, cachedInputTokens: count(inputs.cached_tokens) ?? count(reported.cached_input_tokens) ?? 0,
    inputTextTokens: count(inputs.text_tokens) ?? 0, inputImageTokens: count(inputs.image_tokens) ?? 0,
    outputTextTokens: count(outputs.text_tokens) ?? 0, outputImageTokens: count(outputs.image_tokens) ?? 0,
    estimated: input === undefined || output === undefined,
    billingDetails: { breakdownComplete: [inputs.text_tokens, inputs.image_tokens, outputs.text_tokens, outputs.image_tokens].every(value => count(value) !== undefined), cacheBilling: "none" } };
}

function inputImage(image: ReferenceImage) {
  if (!image.mimeType.startsWith("image/") || !image.data.length || image.data.length > MAX_BYTES) throw new Error("Invalid conversation image");
  return { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data.toString("base64")}` };
}

async function originalHistory(messages: readonly ImageConversationMessage[], previous?: OfficialImageConversation): Promise<unknown[]> {
  const items: unknown[] = [];
  for (const message of messages) {
    const images = previous && message.role === "assistant" && message.turnId === previous.throughTurn
      ? [] : await message.loadImages?.() ?? [];
    const content: unknown[] = message.text ? [{ type: message.role === "user" ? "input_text" : "output_text", text: message.text }] : [];
    if (message.role === "user") content.push(...images.map(inputImage));
    if (content.length) items.push({ type: "message", role: message.role, content });
    if (message.role === "assistant" && images.length) items.push({ type: "message", role: "user", content: [
      { type: "input_text", text: "Images attached to the preceding assistant message." }, ...images.map(inputImage)
    ] });
  }
  return items;
}

/** Let the official persistent conversation interpret original user language and
 * choose generation, editing, references, or a text-only answer. No visual prompt is authored here.
 */
export async function converseCodexImages(config: AgentConfig, request: ImageConversationRequest,
  record?: UsageRecorder): Promise<ImageConversationResult> {
  const selected = conversationDriver(config, request);
  config = selected.config;
  const current = request.messages.find(message => message.role === "user" && message.turnId === request.turnId);
  if (!current) throw new Error("Original user message is unavailable for the image conversation");
  return withImageDeadline(config, request.signal, signal => withImageConversation(config, { ...request, signal }, async (previous, save) => {
    const pending = request.messages.filter(message => message.turnId < request.turnId && (!previous
      || message.turnId > previous.throughTurn || message.turnId === previous.throughTurn && message.role === "assistant"));
    const measurement = currentPerformance();
    const prepare = async () => {
      const prepared = await Promise.all([current.loadImages?.() ?? [], originalHistory(pending, previous)]);
      signal.throwIfAborted();
      return prepared;
    };
    const [images, history] = await (measurement
      ? measurement.store.measure("media.image_context", imageDriver(config).name, prepare) : prepare());
    return runOfficialImageTurn(config, current.text, images, history,
      selected.reasoningEfforts, signal, record, previous, state => save({ ...state, throughTurn: request.turnId,
        historyHash: imageHistoryHash(request, request.turnId) }));
  }));
}

async function withImageDeadline<T>(config: AgentConfig, signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = config.imageGenerationTimeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException(
    `图片生成等待超时（${Math.ceil(timeoutMs / 1000)} 秒）。本轮不会自动重新生成，请重试。`, "TimeoutError"
  )), timeoutMs);
  timer.unref();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try { combined.throwIfAborted(); return await operation(combined); }
  finally { clearTimeout(timer); }
}

async function runOfficialImageTurn(config: AgentConfig, text: string, images: readonly ReferenceImage[], history: readonly unknown[],
  reasoningEfforts: ImageGenerationRequest["reasoningEfforts"], signal: AbortSignal | undefined, record: UsageRecorder | undefined,
  previous?: OfficialImageConversation, save?: (state: { threadId: string; totalUsage?: TokenUsage }) => void): Promise<ImageConversationResult> {
  const driver = imageDriver(config), route = config.imageGeneration!;
  const attempts: ImageGenerationAttemptResult[] = [];
  images.forEach(inputImage);
  let officialText = "";
  await invokeCodexAppServerRound(config, driver, {
    messages: [{ role: "user", text, images }], tools: [], reasoningEffort: "default", reasoningEfforts
  }, undefined, signal, undefined,
  meter => record?.({ ...meter, model: driver.name, apiModel: driver.apiModel, supplier: driver.supplier, cost: driver.cost, kind: "text" }), {
    prompt: text, threadId: previous?.threadId, usageBaseline: previous?.totalUsage, history, ephemeral: !save,
    complete: async (items, workspace, reply, state) => {
      if (!items.length && !reply.trim()) throw new Error("The official image conversation returned no reply");
      officialText = reply;
      for (const item of items) {
        const generationId = randomUUID(), model = route.modelName ?? route.model;
        const usage = imageUsage(item, model, driver.supplier);
        const metering: UsageObservation = { id: `image:${driver.supplier}:${generationId}`, mediaRecordId: generationId,
          model, apiModel: route.model, supplier: driver.supplier, cost: { type: "subscription" }, kind: "image",
          createdAt: Date.now(), outcome: "failed", outputImages: 0,
          generationId: typeof item.id === "string" ? item.id : undefined,
          ...(!usage.estimated ? { usage, imageUsage: { ...usage, ...usage.billingDetails }, usageComplete: usage.billingDetails?.breakdownComplete } : {}) };
        try {
          const image = await readOfficialImage(item, workspace);
          attempts.push({ generationId, model, supplier: driver.supplier, prompt: text, size: "auto", quality: "auto", image, images: [image], usage });
          metering.outcome = "completed"; metering.outputImages = 1;
        } finally { record?.(metering); }
      }
      save?.(state);
    }
  });
  return { text: officialText, attempts };
}

/** Compatibility entry point for explicit standalone gateway callers. */
export async function generateCodexImage(config: AgentConfig, request: ImageGenerationRequest,
  record?: UsageRecorder): Promise<ImageGenerationAttemptResult> {
  const result = await withImageDeadline(config, undefined, signal =>
    runOfficialImageTurn(config, request.prompt, request.referenceImages ?? [], [], request.reasoningEfforts, signal, record));
  if (result.attempts.length !== 1) throw new Error("The official image conversation did not return a single image");
  return result.attempts[0]!;
}
