import type { UserHealthAccess } from "../health/service.js";
import { record, text, timestamp } from "../health/normalize.js";
import { MEAL_TYPES, NUTRIENTS, photoIds } from "../health/diary.js";
import type { ViewSessionImagesResult } from "./view-session-image.js";
import { mutationIdentity } from "./health-tasks.js";
import type { AgentToolRegistration } from "./registry.js";
export function createHealthDataTool(service: UserHealthAccess): AgentToolRegistration {
  return {
    requiredSkill: "health",
    definition: {
      type: "function", name: "health_data",
      description: "Private health data and project diary for the authorized Deepmind owner. status/query read existing Auto Export observations; preserve upstream granularity and choose one stream when required. Never double-count overlapping streams, sleep summaries/segments or workout/daily totals. diary reads sleep/training comments and meals by inclusive Asia/Shanghai dates, with paginated details and full-range nutrition estimates/coverage (not proof of complete intake). record_day replaces ONE comment per date/category; merge relevant existing details before correcting. Sleep uses the wake-up date. record_meal saves meal_type, intake, photo_image_ids from chat history, staged photo_indices or saved health photo_ids, and nutrition_estimate inferred from user reports/photos. Save actual health reports/meals during the conversation without requiring a separate 'remember' request. Clearly mark uncertain portions in intake; estimates are not device measurements. Reuse the returned meal id to correct that meal; different meals need different stable ids, even on the same day. Existing photos are preserved if photo_ids is omitted. Omitted nutrition is cleared when intake changes, so provide a revised estimate with a correction. view_photos reopens saved originals across conversations. Earlier CHAT photos that are not yet in health storage must use photo_image_ids with the exact image IDs from session history; this reloads originals on demand, without staged images or re-upload. photo_indices applies only to currently staged images; an INVALID_PHOTO_INDICES error does not mean the original expired. Never retry obsolete indices or drop the photos merely to make the write succeed. Do not invent consumed meals, user feelings or missing values. Legacy record remains for old text notes. Paginate with nextCursor while hasMore.",
      input_schema: {
        type: "object", properties: {
          action: { type: "string", enum: ["status", "query", "record", "record_day", "record_meal", "diary", "view_photos"] },
          from: { type: "string", description: "ISO timestamp with explicit timezone offset" },
          to: { type: "string", description: "ISO timestamp with explicit timezone offset" },
          metrics: { type: "array", items: { type: "string" }, maxItems: 32 },
          stream: { type: "string" }, after_seq: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 },
          id: { type: "string", description: "Stable user-report identifier; reuse to correct the same report" },
          category: { type: "string", enum: ["sleep", "food", "energy", "training", "context"] },
          text: { type: "string", maxLength: 4000 }, observed_at: { type: "string" },
          date: { type: "string", description: "record_day/record_meal: actual diary date YYYY-MM-DD, Asia/Shanghai; sleep belongs to wake-up day" },
          from_date: { type: "string", description: "diary: inclusive YYYY-MM-DD" },
          to_date: { type: "string", description: "diary: inclusive YYYY-MM-DD, defaults to from_date; maximum 366 calendar days" },
          meal_type: { type: "string", enum: [...MEAL_TYPES] },
          intake: { type: "string", maxLength: 4000, description: "Foods and actual amounts from the user or inferred from photos/conversation; indicate uncertainty" },
          photo_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string" }, description: "Saved health photo IDs. Omit to retain existing photos; [] explicitly removes references" },
          photo_indices: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "integer", minimum: 1 }, description: "record_meal ONLY: 1-based indices of currently staged images. Earlier chat photos use photo_image_ids; originals already in health use photo_ids. Never reuse an earlier turn's indices" },
          photo_image_ids: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 128 }, description: "record_meal: exact conversation image IDs shown as 会话图片 img_… in history. Reloads those originals from this session and copies them into health storage, even when no images are staged this turn. Use for earlier chat photos not yet saved in health; do not reuse their old photo_indices. Cannot combine with photo_indices" },
          nutrition_estimate: { type: "object", additionalProperties: false,
            description: "Agent estimates for actual consumption. Omit unknown nutrients or use null; sugars are included in carbohydrates. Not a measured value.",
            properties: Object.fromEntries(NUTRIENTS.map(key => [key, { type: ["number", "null"], minimum: 0 }])) }
        }, required: ["action"], additionalProperties: false
      }
    },
    executionMode: "sequential",
    activity: {
      started: (input) => ({ message: ["record", "record_day", "record_meal"].includes(String((input as { action?: string })?.action)) ? "我正在保存你提供的健康记录。" : (input as { action?: string })?.action === "view_photos" ? "我正在查看已保存的餐食照片。" : "我正在核对你的健康数据和更新时间。" }),
      completed: (input, result) => ({ message: (result as { result?: string })?.result === "not_authorized"
        ? "我无法为当前聊天访问健康数据。"
        : ["record", "record_day", "record_meal"].includes(String((input as { action?: string })?.action)) ? "我已保存你提供的健康记录。" : (input as { action?: string })?.action === "view_photos" ? "我已读取保存的餐食照片。" : "我已核对健康数据的可用情况。" }),
      failed: () => ({ message: "这次健康数据操作没有完成。" })
    },
    execute: async (input, context) => {
      context.signal?.throwIfAborted();
      if (!service.isAuthorized(context)) return { result: "not_authorized" };
      const args = record(input);
      if (context.taskRunId && ["record", "record_day", "record_meal"].includes(String(args.action))) throw new Error("Health diary writes require a user turn");
      if (args.action === "status") return { result: "status", ...service.store.status() };
      if (args.action === "record_day") return { result: "recorded", ...service.store.recordDay({ date: args.date, category: args.category, text: args.text, requestId: mutationIdentity(context, args) }) };
      if (args.action === "record_meal") {
        const indices = args.photo_indices ?? [];
        if (!Array.isArray(indices) || indices.length > 8 || new Set(indices).size !== indices.length
          || indices.some(index => !Number.isSafeInteger(index) || index < 1 || index > (context.referenceImages?.length ?? 0))) throw new Error("INVALID_PHOTO_INDICES: staged indices are turn-local; use photo_image_ids with the exact conversation image IDs from history to import earlier chat photos without re-uploading");
        const historicalIds = args.photo_image_ids ?? [];
        if (!Array.isArray(historicalIds) || historicalIds.length > 8
          || args.photo_image_ids !== undefined && !historicalIds.length
          || historicalIds.some(id => typeof id !== "string" || !id.trim() || id.length > 128)
          || new Set(historicalIds).size !== historicalIds.length) throw new Error("INVALID_PHOTO_IMAGE_IDS");
        if (args.photo_image_ids !== undefined && args.photo_indices !== undefined) throw new Error("Choose photo_image_ids or photo_indices, not both");
        const images = indices.map(index => context.referenceImages![index - 1]!);
        if (historicalIds.length) {
          if (!context.viewSessionImages) throw new Error("Historical photo loading is unavailable");
          const loaded = await context.viewSessionImages(historicalIds);
          for (const id of historicalIds) {
            const image = loaded.find(image => image.sessionImageId === id);
            if (!image) throw new Error("HEALTH_SOURCE_IMAGE_NOT_FOUND");
            images.push(image);
          }
        }
        context.signal?.throwIfAborted();
        return { result: "recorded", ...service.store.recordMeal({ id: args.id, requestId: mutationIdentity(context, args), meal: {
          date: args.date, mealType: args.meal_type, intake: args.intake,
          ...(args.photo_ids === undefined ? {} : { photoIds: args.photo_ids }),
          ...(args.nutrition_estimate === undefined ? {} : { nutritionEstimate: args.nutrition_estimate })
        } }, images) };
      }
      if (args.action === "diary") return service.store.diary({ from: args.from_date, to: args.to_date ?? args.from_date,
        afterSeq: args.after_seq as number | undefined, limit: args.limit as number | undefined });
      if (args.action === "view_photos") {
        const ids = photoIds(args.photo_ids);
        if (!ids.length) throw new Error("INVALID_PHOTO_IDS");
        // Reuse the executor's image-result protocol: original bytes reach vision, never JSON traces.
        const result: ViewSessionImagesResult = { kind: "view_session_images", imageIds: ids,
          images: ids.map(id => ({ ...service.store.readPhoto(id), sessionImageId: id })) };
        return result;
      }
      if (args.action === "query") {
        if (args.metrics !== undefined && (!Array.isArray(args.metrics) || args.metrics.some((v) => typeof v !== "string"))) throw new Error("INVALID_METRICS");
        return { ...service.store.query({
          from: timestamp(args.from), to: timestamp(args.to),
          ...(args.metrics === undefined ? {} : { metrics: args.metrics as string[] }),
          ...(args.stream === undefined ? {} : { stream: text(args.stream, 1024) }),
          ...(args.after_seq === undefined ? {} : { afterSeq: args.after_seq as number }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number })
        }), freshness: service.store.status() };
      }
      if (args.action === "record") return { result: "recorded", provenance: "user_report", ...service.store.recordNote({ id: text(args.id, 128), category: text(args.category) as "food", text: text(args.text, 4000), observedAt: text(args.observed_at, 64) }) };
      throw new Error("INVALID_ACTION");
    }
  };
}
