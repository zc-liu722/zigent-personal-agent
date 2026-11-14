import { z } from "zod";

/** Versioned, inert program display data. Rendering belongs to the public web resource set. */
export const sleepTimelineDataSchema = z.object({
  type: z.literal("sleep-timeline"), version: z.literal(1),
  start: z.number().int().min(0).max(8e15),
  segments: z.array(z.tuple([
    z.number().int().min(0).max(48 * 3600_000),
    z.number().int().positive().max(48 * 3600_000),
    z.enum(["awake", "rem", "core", "deep", "asleep", "inBed", "unspecified", "unknown", "conflict"])
  ])).min(1).max(500)
}).strict().refine(value => {
  let end = 0;
  for (const [start, next] of value.segments) {
    if (start !== end || next <= start) return false;
    end = next;
  }
  return true;
}, "Sleep segments must form an ordered, contiguous timeline");
export type SleepTimelineData = z.infer<typeof sleepTimelineDataSchema>;
