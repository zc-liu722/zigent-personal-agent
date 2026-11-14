import { z } from "zod";
import { conversationOutputSchema } from "./output.js";
import { sleepTimelineDataSchema } from "./program-data.js";

/** Program-owned display data. Never add to model messages, tool results or transcripts. */
export const messageAttachmentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  program: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  output: conversationOutputSchema,
  data: sleepTimelineDataSchema.optional()
}).strict().refine(value => !value.data || value.program === "sleep-timeline" && value.id === "sleep-timeline",
  "Program display data must match its owning attachment");
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export function validateAttachments(items: readonly MessageAttachment[]): MessageAttachment[] {
  return z.array(messageAttachmentSchema).max(6).refine(values => new Set(values.map(item => item.id)).size === values.length,
    "Duplicate attachment identity").parse(items);
}
