import { z } from "zod";
import type { BeijingSubway } from "../transit/beijing-subway.js";
import type { AgentToolRegistration } from "./registry.js";

const schema = z.object({ action: z.enum(["status", "search", "view"]), line: z.string().trim().min(1).max(40).optional(), station: z.string().trim().min(1).max(40).optional(), direction: z.string().trim().min(1).max(40).optional(), day_type: z.enum(["weekday", "weekend"]).optional(), table_ids: z.array(z.string().regex(/^[a-f0-9]{20}$/)).min(1).max(4).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).default(10) }).strict();
export function createBeijingSubwayTool(service?: BeijingSubway): AgentToolRegistration {
  return {
    definition: { type: "function", name: "beijing_subway", description: "Query locally downloaded official Beijing Subway planned timetables, all operators. search by line/station returns first/last services, source/download time, day types and image table IDs; view table_ids (1–4) loads the actual images for vision. Always view the matching table before answering individual train times. Confirm direction, weekday/weekend, short turns and legend from the image. No live arrivals or inferred intermediate train times. Holidays/shifted workdays need operator verification; do not infer their schedule solely from weekday. status reports download coverage. Paginate search with offset/limit. Cache is checked weekly; report stale/unavailable data honestly.", input_schema: { type: "object", additionalProperties: false, required: ["action"], properties: { action: { type: "string", enum: ["status", "search", "view"] }, line: { type: "string" }, station: { type: "string" }, direction: { type: "string" }, day_type: { type: "string", enum: ["weekday", "weekend"] }, table_ids: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
    activity: {
      started: input => ({ message: (input as { action?: string } | null)?.action === "view" ? "我正在查看地铁时刻表原图。" : "我正在查询北京地铁时刻表。" }),
      completed: (_input, result) => {
        const r = result as { status?: string; kind?: string } | null;
        return { message: r?.status === "unavailable" ? "本地地铁时刻表尚未就绪。" : r?.status === "not_found" ? "我没有找到匹配的地铁时刻表。" : r?.kind === "view_session_images" ? "我已读取地铁时刻表原图。" : "我已查到北京地铁时刻表。" };
      },
      failed: () => ({ message: "这次未能读取北京地铁时刻表。" })
    },
    execute: async (input, context) => {
      context.signal?.throwIfAborted();
      const args = schema.parse(input);
      if (args.action === "view" && (!args.table_ids || new Set(args.table_ids).size !== args.table_ids.length)) throw new Error("view requires 1–4 unique table_ids from search");
      if (!service) return { status: "unavailable", message: "北京地铁时刻表尚未配置。" };
      return service.query(args);
    }
  };
}
