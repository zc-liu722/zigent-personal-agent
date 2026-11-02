import type { ReferenceImage } from "../image-generation.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";
import type { AgentToolRegistration } from "./registry.js";

export type ViewedSessionImage = ReferenceImage & { sessionImageId: string };

export type ViewSessionImagesResult = {
  kind: "view_session_images";
  imageIds: string[];
  images: ViewedSessionImage[];
  /** Safe structured context for tool-loaded reference images (never image bytes). */
  metadata?: unknown;
};

export function isViewSessionImagesResult(value: unknown): value is ViewSessionImagesResult {
  return Boolean(value && typeof value === "object" && (value as { kind?: unknown }).kind === "view_session_images");
}

function imageIds(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const values = (input as { image_ids?: unknown }).image_ids;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())
    : [];
}

const activity: ToolActivityPresenter = {
  started: (input) => ({
    message: "我正在重新查看会话中的原图。",
    ...(imageIds(input).length > 0 ? { details: [{ label: "图片编号", value: imageIds(input).join("、") }] } : {})
  }),
  completed: (input) => ({
    message: "我已经重新看到了这些原图。",
    ...(imageIds(input).length > 0 ? { details: [{ label: "图片编号", value: imageIds(input).join("、") }] } : {})
  }),
  failed: (input, error) => ({
    message: "这次没能重新读取会话原图。",
    details: [
      ...(imageIds(input).length > 0 ? [{ label: "图片编号", value: imageIds(input).join("、") }] : []),
      { label: "原因", value: error }
    ]
  })
};

export function createViewSessionImageTool(): AgentToolRegistration {
  return {
    executionMode: "sequential",
    definition: {
      type: "function",
      name: "view_session_image",
      description: "Reopen original images from this conversation by the image IDs shown in history. When the user's request needs visual details from earlier images that are not currently attached, load the relevant originals together with this tool. Older images may have no stored description. Viewing an image does not imply image generation or editing.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["image_ids"],
        properties: {
          image_ids: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
            description: "Image IDs exactly as shown in conversation history"
          }
        }
      }
    },
    activity,
    execute: async (input, context): Promise<ViewSessionImagesResult> => {
      const ids = imageIds(input);
      if (ids.length === 0 || ids.length > 8 || new Set(ids).size !== ids.length) {
        throw new Error("image_ids must contain 1 to 8 unique image IDs");
      }
      if (!context.viewSessionImages) throw new Error("Session image viewing is unavailable");
      const images = await context.viewSessionImages(ids);
      return { kind: "view_session_images", imageIds: ids, images };
    }
  };
}
