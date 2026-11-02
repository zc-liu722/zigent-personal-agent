import { randomUUID } from "node:crypto";
import { modelCostMultiplier } from "../config.js";
import {
  imageSha256,
  type GeneratedImage,
  type ImageGenerationResult,
  type ImageQuality,
  type ImageSize
} from "../image-generation.js";
import type { ImageExperimentVariant, ImageGenerationRecord } from "../memory/types.js";
import type { ModelFunctionTool } from "../models/types.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./registry.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";

// Keep the legacy database label for backward-compatible delivery correlation.
// It now represents the single, context-resolved, intent-preserving prompt.
const VARIANT = { variant: "raw_user_prompt", ordinal: 1 } as const satisfies {
  variant: ImageExperimentVariant;
  ordinal: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishImages(context: ToolExecutionContext, images: readonly GeneratedImage[]): Promise<void> {
  if (images.length) await context.presentImages?.(images).catch(() => {
    context.signal?.throwIfAborted();
    console.warn("Early image delivery failed; final delivery will retry");
  });
}

export class ImageGenerationError extends Error {
  constructor(readonly generationRecords: readonly ImageGenerationRecord[]) {
    super("Image generation failed");
    this.name = "ImageGenerationError";
  }
}

function imageInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function imageSettings(input: unknown): string {
  const values = imageInput(input);
  const sizeNames: Record<string, string> = {
    "1024x1024": "方图 1024×1024",
    "1536x1024": "横图 1536×1024",
    "1024x1536": "竖图 1024×1536",
    auto: "自动尺寸"
  };
  const qualityNames: Record<string, string> = {
    low: "快速质量",
    medium: "标准质量",
    high: "高质量",
    auto: "自动质量"
  };
  const size = String(values.size ?? "1024x1024");
  const quality = String(values.quality ?? "high");
  const parts = [sizeNames[size] ?? size, qualityNames[quality] ?? quality];
  if (values.input_fidelity === "high") {
    parts.push("高保真参考");
  }
  if (values.input_fidelity === "low") parts.push("灵活参考");
  return parts.join(" · ");
}

function referenceCount(input: unknown): number | undefined {
  const indices = imageInput(input).reference_image_indices;
  return Array.isArray(indices) ? indices.length : undefined;
}

const imageGenerationActivity: ToolActivityPresenter = {
  started: (input) => {
    const values = imageInput(input);
    const prompt = typeof values.prompt === "string" ? values.prompt.trim() : "";
    if (!Object.keys(values).length) return { message: "我正在处理这次图片请求。" };
    const references = referenceCount(input);
    return {
      message: references
        ? `我正参考 ${references} 张图片，把这段描述变成画面。`
        : "我正把这段描述变成一张图片。",
      details: [
        ...(prompt ? [{ label: "画面描述", value: prompt, format: "quote" as const }] : []),
        { label: "生成设置", value: imageSettings(input) }
      ]
    };
  },
  completed: (_input, result) => ({ message: (result as ImageGenerationResult)?.images?.length
    ? "图片已经画好了。" : "图片请求已处理。" }),
  failed: (input, error) => ({
    message: "这次图片没能画出来。",
    details: [
      ...(typeof imageInput(input).prompt === "string"
        ? [{ label: "画面描述", value: String(imageInput(input).prompt), format: "quote" as const }]
        : []),
      { label: "原因", value: error }
    ]
  })
};

export const officialImageConversationDefinition: ModelFunctionTool = {
  type: "function", name: "image_generation", deferExecution: true,
  description: "Hand image requests and follow-up image feedback to the official image conversation. Call with an empty object. The original user messages and images are forwarded automatically; do not rewrite the prompt, classify generate/edit, select references, or invent settings. The official model manages its conversation, decides whether to generate, edit or respond without an image, and handles missing material. Relay its reply and image results to the user. Invoke at most once per turn. On failure, report the reason and wait for a new user request instead of retrying.",
  input_schema: { type: "object", properties: {}, required: [], additionalProperties: false }
};

export function createImageGenerationTool(): AgentToolRegistration {
  return {
    executionMode: "sequential",
    activity: imageGenerationActivity,
    definition: {
      type: "function",
      name: "image_generation",
      description: "Generate or edit one image using a concise prompt that faithfully expresses the user's current intent from the conversation already visible to you. Keep the user's wording and level of specificity; resolve only necessary references or ellipsis, without aesthetic enhancement or invented visual details. For an edit, explicitly select every staged reference image to use by 1-based index. Omit reference_image_indices to generate without reference images.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, description: "A faithful, minimally resolved expression of the user's request using their wording and specificity; include only visual requirements or constraints the user actually stated" },
          size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536", "auto"], default: "1024x1024" },
          quality: { type: "string", enum: ["low", "medium", "high", "auto"], default: "high", description: "Image rendering quality supported by the ZenMux OpenAI Images API; use high by default" },
          input_fidelity: {
            type: "string",
            enum: ["high", "low"],
            description: "For edits: high preserves identity/layout/details; low permits a stronger whole-image style or rendering transformation"
          },
          reference_image_indices: {
            type: "array",
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 16 },
            description: "For edits only: explicit 1-based indices of staged reference images to use. Omit to use no reference images."
          }
        }
      }
    },
    execute: async (input, context): Promise<ImageGenerationResult> => {
      if (!context.imageGenerator) throw new Error("Image generation is not configured for this agent");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("image_generation input must be an object");
      if (context.imageGenerator.conversation) {
        if (Object.keys(input).length) throw new Error("The official image conversation takes no model-authored arguments; call with {}");
        if (!context.imageConversation) throw new Error("Original image conversation context is unavailable");
        const request = await context.imageConversation();
        context.claimImageGeneration?.();
        const result = await context.imageGenerator.conversation({ ...request, selectedModel: context.model,
          reasoningEfforts: context.reasoningEfforts });
        const experimentId = randomUUID(), createdAt = Date.now();
        const images: GeneratedImage[] = [], records: ImageGenerationRecord[] = [];
        for (const [index, attempt] of result.attempts.entries()) {
          const generationId = attempt.generationId ?? randomUUID(), ordinal = index + 1;
          const sha256 = imageSha256(attempt.image.data);
          images.push({ ...attempt.image, generationId, experimentId, variant: VARIANT.variant, ordinal, sha256 });
          records.push({ ...attempt.usage, generationId, experimentId, variant: VARIANT.variant, ordinal,
            sessionId: context.sessionId, turnId: context.turnId, inputPrompt: attempt.prompt,
            revisedPrompt: attempt.image.revisedPrompt, model: attempt.model, modelSupplier: attempt.supplier,
            size: attempt.size, quality: attempt.quality, status: "success", imageSha256: sha256, createdAt });
        }
        if (records.length) await context.onImageGenerationRecords?.(records);
        // Publish through the current authenticated run before the routing model
        // writes its closing reply. Final delivery reuses these same assets.
        await publishImages(context, images);
        return { kind: "image_generation", images, generationRecords: records, comparisonIncomplete: false, text: result.text };
      }
      const values = input as Record<string, unknown>;
      if (typeof values.prompt !== "string" || !values.prompt.trim()) throw new Error("prompt must be a non-empty string");
      if (values.n !== undefined && values.n !== 1) throw new Error("n is deprecated and must be 1");
      const size = values.size === undefined ? undefined : String(values.size);
      if (size !== undefined && !["1024x1024", "1536x1024", "1024x1536", "auto"].includes(size)) {
        throw new Error("size is not supported");
      }
      const quality = values.quality === undefined ? undefined : String(values.quality);
      if (quality !== undefined && !["low", "medium", "high", "auto"].includes(quality)) {
        throw new Error("quality is not supported");
      }
      const inputFidelity = values.input_fidelity === undefined ? undefined : String(values.input_fidelity);
      if (inputFidelity !== undefined && inputFidelity !== "high" && inputFidelity !== "low") {
        throw new Error("input_fidelity is not supported");
      }
      const availableImages = context.referenceImages ?? [];
      const rawIndices = values.reference_image_indices;
      if (rawIndices !== undefined && (!Array.isArray(rawIndices) || rawIndices.length === 0)) {
        throw new Error("reference_image_indices must be a non-empty array");
      }
      const indices = rawIndices as unknown[] | undefined;
      if (indices && (new Set(indices).size !== indices.length || indices.some((index) => !Number.isInteger(index)))) {
        throw new Error("reference_image_indices must contain unique integers");
      }
      const action = context.imageGenerationAction;
      if (action === "generate" && indices) {
        throw new Error("reference_image_indices must be omitted after preparing a new generation");
      }
      if (action === "generate" && inputFidelity !== undefined) {
        throw new Error("input_fidelity must be omitted after preparing a new generation");
      }
      if (action === "edit" && !indices) {
        throw new Error("reference_image_indices must explicitly select at least one image after preparing an edit");
      }
      const referenceImages = indices
        ? indices.map((index) => {
            const position = Number(index);
            const image = availableImages[position - 1];
            if (!image) throw new Error(`Reference image ${position} is not available`);
            return image;
          })
        : [];
      const normalizedSize = (size ?? "1024x1024") as ImageSize;
      const normalizedQuality = (quality ?? "high") as ImageQuality;
      const experimentId = randomUUID();
      const inputPrompt = values.prompt.trim();
      const request = {
        reasoningEfforts: context.reasoningEfforts,
        n: 1 as const,
        size: normalizedSize,
        quality: normalizedQuality,
        referenceImages,
        prompt: inputPrompt,
        ...(referenceImages.length > 0 ? { inputFidelity: (inputFidelity ?? "high") as "high" | "low" } : {})
      };
      context.claimImageGeneration?.();
      const fallbackMetadata = context.imageGenerator.metadata?.() ?? { model: "unknown", supplier: "unknown" };
      const generationId = randomUUID();
      const createdAt = Date.now();
      let attempt;
      try {
        attempt = await context.imageGenerator.generate({...request,usageRecordId:generationId});
      } catch (error) {
        const failedRecord: ImageGenerationRecord = {
          generationId, experimentId, ...VARIANT,
          sessionId: context.sessionId, turnId: context.turnId, inputPrompt,
          model: fallbackMetadata.model, modelSupplier: fallbackMetadata.supplier,
          modelCostMultiplier: modelCostMultiplier(fallbackMetadata.cost),
          size: normalizedSize, quality: normalizedQuality, inputFidelity: request.inputFidelity,
          inputTokens: 0, inputTextTokens: 0, inputImageTokens: 0, cachedInputTokens: 0,
          outputTokens: 0, outputTextTokens: 0, outputImageTokens: 0,
          estimated: true, status: "failed", error: errorMessage(error), createdAt
        };
        await context.onImageGenerationRecords?.([failedRecord]);
        throw new ImageGenerationError([failedRecord]);
      }
      const image = attempt.image ?? attempt.images?.[0];
      if (!image) throw new Error("Image generator returned no image for a successful request");
      const sha256 = imageSha256(image.data);
      const deliveredImage: GeneratedImage = { ...image, generationId, experimentId, ...VARIANT, sha256 };
      const generationRecord: ImageGenerationRecord = {
        ...attempt.usage,
        generationId, experimentId, ...VARIANT,
        sessionId: context.sessionId, turnId: context.turnId,
        inputPrompt, revisedPrompt: image.revisedPrompt,
        model: attempt.model, modelSupplier: attempt.supplier ?? attempt.usage.modelSupplier ?? fallbackMetadata.supplier,
        size: attempt.size ?? normalizedSize, quality: attempt.quality ?? normalizedQuality,
        inputFidelity: attempt.inputFidelity ?? request.inputFidelity,
        status: "success", imageSha256: sha256, createdAt
      };
      await context.onImageGenerationRecords?.([generationRecord]);
      await publishImages(context, [deliveredImage]);
      return {
        kind: "image_generation",
        images: [deliveredImage],
        generationRecords: [generationRecord],
        comparisonIncomplete: false
      };
    }
  };
}
