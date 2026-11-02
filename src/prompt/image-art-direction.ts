import type { ModelFunctionTool } from "../models/types.js";

export const PREPARE_IMAGE_GENERATION_TOOL = "prepare_image_generation";

export const prepareImageGenerationDefinition: ModelFunctionTool = Object.freeze({
  type: "function",
  name: PREPARE_IMAGE_GENERATION_TOOL,
  description: [
    "Call when the user clearly wants an image generated or edited.",
    "When images are attached, inspect their actual visual content together with the relevant conversation and decide whether the required material is semantically complete; never infer completeness from the number of image files alone.",
    "For example, a request using 'a photo of the two of us' is complete with one photo containing both people or with two applicable single-person photos, but is incomplete with only one applicable single-person photo.",
    "If required material is missing, reply normally with one concise description of what is still needed; no dedicated waiting tool is required.",
    "Do not call for image discussion, simple acknowledgement, genuinely unclear requests, or while required instructions or reference images are still coming."
  ].join(" "),
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["generate", "edit"],
        description: "Whether to generate from scratch or edit supplied reference images"
      }
    }
  }
});

export function prepareImageGenerationDefinitionForTurn(referenceImageCount: number): ModelFunctionTool {
  if (referenceImageCount <= 0) return prepareImageGenerationDefinition;
  return {
    ...prepareImageGenerationDefinition,
    description: [
      prepareImageGenerationDefinition.description,
      `${referenceImageCount} staged reference image(s) are attached to the current request, numbered 1 through ${referenceImageCount}.`,
      "They may have arrived over several messages. Inspect what each image contains and relate it to the user's words. If material is semantically incomplete, do not call prepare_image_generation; state briefly what specific material is missing.",
      "Only call prepare_image_generation after the user clearly requests generation or editing and the request is sufficiently specified."
    ].join(" ")
  };
}

export function imageGenerationArtDirection(
  referenceImageCount: number,
  action?: "generate" | "edit"
): string {
  const referenceGuidance = referenceImageCount > 0
    ? `${referenceImageCount} staged reference image(s) are available, numbered 1 through ${referenceImageCount}. Identify each selected image by index and role in the prompt.`
    : "No staged reference images are available.";
  const actionGuidance = action === "generate"
    ? "This turn was prepared as a new generation. Do not provide reference_image_indices or input_fidelity, even when staged images are visible in the conversation."
    : action === "edit"
      ? "This turn was prepared as an edit. Explicitly provide reference_image_indices for every image that should affect the result; staged images are never selected implicitly."
      : undefined;

  return [
    "Image generation has been prepared for this turn. The full image_generation tool is now available and should be called to fulfill the user's visual request.",
    "The full relevant conversation is already visible in this model context. Use it together with the current request to determine the user's complete intent; no separate history lookup is needed, and the final message may rely on what is already visible.",
    "Resolve contextual phrases such as '按之前要求来', '继续刚才的', '其中', '还是这张', and pronouns by carrying forward only the latest applicable requirements the user actually stated.",
    "Write one concise, self-contained prompt for the image model, which sees only that prompt and any explicitly selected reference images. Preserve the user's own wording wherever practical, including their emphasis, requested imperfections, exclusions, and exact text.",
    "Do not perform aesthetic enhancement. Do not invent subjects, stories, characters, styles, composition, camera choices, lighting, colors, materials, quality adjectives, decorative details, or negative constraints that the user did not request.",
    "Add only the minimum connective context needed to make an otherwise context-dependent request understandable to the image model. Do not turn a short request into an elaborate visual brief.",
    "Multi-turn example; at every step the agent already sees all earlier turns and any currently staged images:",
    "1. User: '想要个樱花场景的图像，有点故事感'. Correct: prepare generate, then prompt '想要个樱花场景的图像，有点故事感', with no reference_image_indices or input_fidelity. Incorrect: designing a path, riverbank, distant figure, implied event, lighting, mood, or other concrete imagery.",
    "2. User, after seeing the generated image: '能不能有点人物在其中'. Correct: prepare edit, explicitly select the latest generated image, use prompt '在这张图中加入人物', and use high input fidelity. Incorrect: inventing the person's gender, clothes, pose, position, identity, or story.",
    "3. User: '能不能换个场景，也换个国家，在中国的樱花场景，而不是日本'. Correct: prepare edit, explicitly select the latest generated image, use prompt '把这张图换成中国的樱花场景，而不是日本', and use low input fidelity. Incorrect: adding Jiangnan scenery, stone bridges, pavilions, mountains, props, lighting, or preservation requirements the user did not state.",
    "4. User: '不要参考这张图片了，就说生成一张中国的樱花场景氛围图片，有人物有故事，试试'. Correct: prepare generate, then prompt '生成一张中国的樱花场景氛围图片，有人物、有故事感', with no reference_image_indices or input_fidelity. The instruction not to reference the old image controls tool inputs and need not become visual prompt text. Incorrect: carrying forward the prior image's person, clothing, composition, props, or setting, or inventing a letter, a waiting person, or a reunion story.",
    "For edits, describe the requested change plainly. Include preservation constraints only when the user stated them or they are necessary to identify what should remain unchanged; avoid exhaustive preserve-everything boilerplate and do not repeat constraints for emphasis.",
    "Inspect the actual visual content of every staged image and select references by their semantic role, not by file count. One group photo may satisfy a request involving two people; one single-person photo does not, while two applicable single-person photos may. If required material is still missing, ask concisely for that specific material instead of calling image_generation.",
    "For an edit, set input_fidelity to high when identity, layout, geometry, or fine details should remain stable. Set it to low when the user requests a strong whole-image style or rendering transformation. This affects only the current edit and does not replace selecting the correct reference images.",
    "If the user's intent remains genuinely ambiguous within the conversation already visible to you, ask one concise clarification instead of guessing or calling image_generation.",
    referenceGuidance,
    actionGuidance,
    "Use image quality high by default. The image API supports only low, medium, high, and auto; never pass text-model reasoning levels such as xhigh or max as image quality. After preparation, do not call prepare_image_generation again."
  ].filter(Boolean).join("\n");
}
