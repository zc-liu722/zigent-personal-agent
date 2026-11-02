import type { ReferenceImage } from "../image-generation.js";
import type {
  VideoGenerationResult,
  VideoPromptExpansion,
  VideoRatio,
  VideoResolution
} from "../video-generation.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";
import type { AgentToolRegistration } from "./registry.js";

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function settings(input: unknown): string {
  const value = record(input);
  const resolution = String(value.resolution ?? "768p");
  const ratio = String(value.ratio ?? "16:9");
  const duration = Number(value.duration ?? 5);
  const references = Array.isArray(value.reference_image_indices) ? value.reference_image_indices.length : 0;
  const mode = references > 0
    ? `多图参考 ${references} 张`
    : value.last_frame_image_index
      ? "首尾帧"
      : value.first_frame_image_index || value.reference_image_index
        ? "图片首帧"
        : "文本生成";
  return [
    resolution,
    ratio,
    `${duration} 秒`,
    mode,
    ...(value.prompt_expansion === "quality" ? ["精细提示扩展"] : []),
    ...(value.watermark === true ? ["有水印"] : [])
  ].join(" · ");
}

function resultUrl(result: unknown): string | undefined {
  const value = record(result);
  const videos = Array.isArray(value.videos) ? value.videos : [];
  const first = record(videos[0]);
  return typeof first.url === "string" && /^https?:\/\//i.test(first.url) ? first.url : undefined;
}

export const videoGenerationActivity: ToolActivityPresenter = {
  started: (input) => {
    const value = record(input);
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    return {
      message: Array.isArray(value.reference_image_indices) && value.reference_image_indices.length > 0
        ? `我正参考 ${value.reference_image_indices.length} 张图片生成视频。`
        : value.last_frame_image_index
          ? "我正根据选中的首尾帧生成过渡视频。"
          : value.first_frame_image_index || value.reference_image_index
            ? "我正以选中的图片为首帧生成视频。"
            : "我正把这段描述变成视频。",
      details: [
        ...(prompt ? [{ label: "视频描述", value: prompt, format: "quote" as const }] : []),
        { label: "生成设置", value: settings(input) }
      ]
    };
  },
  completed: (_input, result) => {
    const url = resultUrl(result);
    return {
      message: "视频已经生成好了。",
      ...(url ? { resources: [{ title: "下载生成的视频", url }], resourcesLabel: "视频文件" } : {})
    };
  },
  failed: (input, error) => ({
    message: "这次视频没能生成。",
    details: [
      ...(typeof record(input).prompt === "string"
        ? [{ label: "视频描述", value: String(record(input).prompt), format: "quote" as const }]
        : []),
      { label: "原因", value: error }
    ]
  })
};

function selectedImage(indexValue: unknown, name: string, available: readonly ReferenceImage[]): ReferenceImage | undefined {
  if (indexValue === undefined) return undefined;
  if (!Number.isInteger(indexValue)) throw new Error(`${name} must be an integer`);
  const index = Number(indexValue);
  const image = available[index - 1];
  if (!image) throw new Error(`Reference image ${index} is not available`);
  return image;
}

function selectedReferences(value: unknown, available: readonly ReferenceImage[]): ReferenceImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0 || value.length > 9) {
    throw new Error("reference_image_indices must contain 1 to 9 image indices");
  }
  if (new Set(value).size !== value.length || value.some((index) => !Number.isInteger(index))) {
    throw new Error("reference_image_indices must contain unique integers");
  }
  return value.map((index) => {
    const image = available[Number(index) - 1];
    if (!image) throw new Error(`Reference image ${String(index)} is not available`);
    return image;
  });
}

export function createVideoGenerationTool(): AgentToolRegistration {
  return {
    executionMode: "sequential",
    activity: videoGenerationActivity,
    definition: {
      type: "function",
      name: "video_generation",
      description: "Generate one video with the official MiniMax China API. Supports text-to-video; one selected first frame; selected first and last frames; or up to 9 selected subject/style reference images. Preserve the user's intent and wording, and refer to multi-image subjects as Image 1, Image 2, etc. H3 Max handles 480p/768p; H3 handles 2K and 4-second output. Do not combine reference_image_indices with first/last-frame fields.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 7000, description: "A faithful description of the requested scene, subject motion, camera motion, and audio or dialogue" },
          duration: { type: "integer", minimum: 4, maximum: 15, default: 5, description: "Video duration in seconds; 4 seconds uses MiniMax H3" },
          resolution: { type: "string", enum: ["480p", "768p", "2k"], default: "768p" },
          ratio: { type: "string", enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], default: "16:9" },
          watermark: { type: "boolean", default: false },
          prompt_expansion: { type: "string", enum: ["balanced", "quality"], description: "Optional MiniMax H3 Max prompt expansion mode; unavailable for 2K or 4-second MiniMax H3 output" },
          first_frame_image_index: { type: "integer", minimum: 1, maximum: 16, description: "Optional 1-based staged image index for the exact first frame" },
          last_frame_image_index: { type: "integer", minimum: 1, maximum: 16, description: "Optional 1-based staged image index for the exact last frame; requires first_frame_image_index" },
          reference_image_indices: {
            type: "array",
            minItems: 1,
            maxItems: 9,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 16 },
            description: "Subject/style reference images in prompt order; use Image 1, Image 2, etc. in the prompt"
          },
          reference_image_index: { type: "integer", minimum: 1, maximum: 16, description: "Deprecated compatibility alias for first_frame_image_index" }
        }
      }
    },
    execute: async (input, context): Promise<VideoGenerationResult> => {
      if (!context.videoGenerator) throw new Error("Video generation is not configured for this agent");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("video_generation input must be an object");
      const value = input as Record<string, unknown>;
      if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("prompt must be a non-empty string");
      if (value.prompt.trim().length > 7_000) throw new Error("prompt must not exceed 7000 characters");
      const duration = value.duration === undefined ? 5 : Number(value.duration);
      if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw new Error("duration must be an integer from 4 to 15");
      const resolution = String(value.resolution ?? "768p");
      if (resolution !== "480p" && resolution !== "768p" && resolution !== "2k") {
        throw new Error("resolution must be 480p, 768p, or 2k");
      }
      const ratio = String(value.ratio ?? "16:9");
      if (!["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) {
        throw new Error("ratio is not supported");
      }
      if (value.watermark !== undefined && typeof value.watermark !== "boolean") throw new Error("watermark must be a boolean");
      if (value.prompt_expansion !== undefined && value.prompt_expansion !== "balanced" && value.prompt_expansion !== "quality") {
        throw new Error("prompt_expansion must be balanced or quality");
      }
      if (value.reference_image_index !== undefined && value.first_frame_image_index !== undefined) {
        throw new Error("Use first_frame_image_index instead of combining it with reference_image_index");
      }
      const available = context.referenceImages ?? [];
      const firstFrame = selectedImage(
        value.first_frame_image_index ?? value.reference_image_index,
        "first_frame_image_index",
        available
      );
      const lastFrame = selectedImage(value.last_frame_image_index, "last_frame_image_index", available);
      const referenceImages = selectedReferences(value.reference_image_indices, available);
      if (lastFrame && !firstFrame) throw new Error("last_frame_image_index requires first_frame_image_index");
      if (referenceImages.length > 0 && (firstFrame || lastFrame)) {
        throw new Error("reference_image_indices cannot be combined with first/last-frame fields");
      }
      if (ratio === "adaptive" && referenceImages.length === 0 && !firstFrame && !lastFrame) {
        throw new Error("ratio cannot be adaptive for text-to-video");
      }
      if (duration === 4 && resolution === "480p") {
        throw new Error("4-second video requires 768p or 2k");
      }
      if ((resolution === "2k" || duration === 4) && value.prompt_expansion !== undefined) {
        throw new Error("prompt expansion is unavailable when using MiniMax H3");
      }
      return context.videoGenerator.generate({
        prompt: value.prompt.trim(),
        duration,
        resolution: resolution as VideoResolution,
        ratio: ratio as VideoRatio,
        watermark: value.watermark === true,
        firstFrame,
        lastFrame,
        referenceImages,
        promptExpansion: value.prompt_expansion as VideoPromptExpansion | undefined,
        signal: context.signal
      });
    }
  };
}
