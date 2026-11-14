import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { AgentConfig, ModelDeployment } from "../config.js";
import type { GeneratedImage, ImageConversationMessage, ImageConversationRequest, ImageConversationResult,
  ImageGenerationAttemptResult, ImageGenerationRequest, ReferenceImage } from "../image-generation.js";
import type { ImageGenerationUsage, TokenUsage } from "../memory/types.js";
import { sniffImageMimeType } from "../media/image-mime.js";
import type { UsageObservation, UsageRecorder } from "../usage/types.js";
import { isCodexAppServerError, type CodexImageRound } from "./codex-contract.js";
import { imageHistoryHash, withImageConversation, type OfficialImageConversation } from "./image-conversation-store.js";
import { effectiveReasoningEffort, savedReasoningEffort } from "./reasoning.js";
import { currentPerformance } from "../performance/store.js";
import { DEFAULT_IMAGE_FINISH_TIMEOUT_MS, DEFAULT_IMAGE_GENERATION_TIMEOUT_MS,
  ImageGenerationTimeoutError, retryImageTimeouts } from "../image-generation-policy.js";

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
  const requestedEffort = effectiveReasoningEffort(selected, { reasoningEfforts: request.reasoningEfforts });
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
  record: UsageRecorder | undefined, invoke: CodexImageRound): Promise<ImageConversationResult> {
  const selected = conversationDriver(config, request);
  config = selected.config;
  const current = request.messages.find(message => message.role === "user" && message.turnId === request.turnId);
  if (!current) throw new Error("Original user message is unavailable for the image conversation");
  let imageCompleted = false;
  return retryImageTimeouts(() => withImageDeadline(config, request.signal, (signal, phases) => withImageConversation(config, { ...request, signal }, async (previous, save, invalidate) => {
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
    return runOfficialImageTurn(invoke, config, current.text, images, history,
      selected.reasoningEfforts, signal, record, previous, state => save({ ...state, throughTurn: request.turnId,
        historyHash: imageHistoryHash(request, request.turnId) }), {
          ...phases, onAttempt: async attempt => {
            imageCompleted = true;
            await request.onAttempt?.(attempt);
          }, invalidate, userSignal: request.signal
        });
  })), { maxRetries: config.imageGenerationRetryAttempts, signal: request.signal, canRetry: () => !imageCompleted });
}

type ImageTurnPhases = { started(): void; rendered(): void };

async function withImageDeadline<T>(config: AgentConfig, signal: AbortSignal | undefined,
  operation: (signal: AbortSignal, phases: ImageTurnPhases) => Promise<T>): Promise<T> {
  const timeoutMs = config.imageGenerationTimeoutMs ?? DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
  const deadline = new AbortController();
  let finishing = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (ms: number, error: Error) => {
    clearTimeout(timer);
    timer = setTimeout(() => deadline.abort(error), ms);
    timer.unref();
  };
  const generation = () => arm(timeoutMs, new ImageGenerationTimeoutError(
    `图片生成等待超时（${Math.ceil(timeoutMs / 1000)} 秒）。`));
  generation();
  const phases: ImageTurnPhases = {
    started: () => { if (finishing) { finishing = false; generation(); } },
    rendered: () => {
      finishing = true;
      arm(DEFAULT_IMAGE_FINISH_TIMEOUT_MS, new DOMException("图片已生成，文字收尾等待超时。", "TimeoutError"));
    }
  };
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try { combined.throwIfAborted(); return await operation(combined, phases); }
  finally { clearTimeout(timer!); }
}

async function runOfficialImageTurn(invoke: CodexImageRound, config: AgentConfig, text: string, images: readonly ReferenceImage[], history: readonly unknown[],
  reasoningEfforts: ImageGenerationRequest["reasoningEfforts"], signal: AbortSignal | undefined, record: UsageRecorder | undefined,
  previous?: OfficialImageConversation, save?: (state: { threadId: string; totalUsage?: TokenUsage }) => void,
  lifecycle?: ImageTurnPhases & { onAttempt?: ImageConversationRequest["onAttempt"]; invalidate?: () => void; userSignal?: AbortSignal }): Promise<ImageConversationResult> {
  const driver = imageDriver(config), route = config.imageGeneration!;
  const attempts: ImageGenerationAttemptResult[] = [];
  images.forEach(inputImage);
  let officialText = "";
  let persistenceFailed = false;
  try { await invoke(config, driver, {
    messages: [{ role: "user", text, images }], tools: [], reasoningEffort: "default", reasoningEfforts
  }, signal,
  meter => record?.({ ...meter, model: driver.name, apiModel: driver.apiModel, supplier: driver.supplier, cost: driver.cost, kind: "text" }), {
    prompt: text, threadId: previous?.threadId, usageBaseline: previous?.totalUsage, history, ephemeral: !save,
    started: lifecycle?.started, rendered: lifecycle?.rendered,
    imageCompleted: async (item, workspace) => {
        const generationId = randomUUID(), model = route.modelName ?? route.model;
        const usage = imageUsage(item, model, driver.supplier);
        const metering: UsageObservation = { id: `image:${driver.supplier}:${generationId}`, mediaRecordId: generationId,
          model, apiModel: route.model, supplier: driver.supplier, cost: { type: "subscription" }, kind: "image",
          createdAt: Date.now(), outcome: "failed", outputImages: 0,
          generationId: typeof item.id === "string" ? item.id : undefined,
          ...(!usage.estimated ? { usage, imageUsage: { ...usage, ...usage.billingDetails }, usageComplete: usage.billingDetails?.breakdownComplete } : {}) };
        try {
          const image = await readOfficialImage(item, workspace);
          metering.outcome = "completed"; metering.outputImages = 1;
          const attempt: ImageGenerationAttemptResult = { generationId, model, supplier: driver.supplier, prompt: text,
            size: "auto", quality: "auto", image, images: [image], usage };
          try { await lifecycle?.onAttempt?.(attempt); }
          catch (error) { persistenceFailed = true; throw error; }
          attempts.push(attempt);
        } finally { record?.(metering); }
    },
    complete: async (_items, _workspace, reply, state) => {
      if (!attempts.length && !reply.trim()) throw new Error("The official image conversation returned no reply");
      officialText = reply;
      save?.(state);
    }
  }, currentPerformance()); } catch (error) {
    // Image success is independent of text completion. Do not reuse an uncertain
    // supplier thread, and never turn a persisted image into a generation failure.
    if (!attempts.length || persistenceFailed || lifecycle?.userSignal?.aborted) {
      if (!persistenceFailed && !lifecycle?.userSignal?.aborted && isCodexAppServerError(error) && error.status === 504)
        throw new ImageGenerationTimeoutError(error.message);
      throw error;
    }
    lifecycle?.invalidate?.();
    officialText = "图片已生成，文字回复未完成。";
  }
  return { text: officialText, attempts };
}

/** Compatibility entry point for explicit standalone gateway callers. */
export async function generateCodexImage(config: AgentConfig, request: ImageGenerationRequest,
  record: UsageRecorder | undefined, invoke: CodexImageRound): Promise<ImageGenerationAttemptResult> {
  let imageCompleted = false;
  const result = await retryImageTimeouts(() => withImageDeadline(config, request.signal, (signal, phases) =>
    runOfficialImageTurn(invoke, config, request.prompt, request.referenceImages ?? [], [], request.reasoningEfforts, signal, record, undefined, undefined,
      { ...phases, userSignal: request.signal, onAttempt: async () => { imageCompleted = true; } })),
    { maxRetries: config.imageGenerationRetryAttempts, signal: request.signal, canRetry: () => !imageCompleted });
  if (result.attempts.length !== 1) throw new Error("The official image conversation did not return a single image");
  return result.attempts[0]!;
}
