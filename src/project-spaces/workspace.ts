import { z } from "zod";

export const executionSchema = z.object({ executor: z.literal("windows-codex"), host: z.literal("windows"), inputVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  directory: z.string().min(1).max(1024), baselineTaskId: z.string().uuid().optional(), mode: z.enum(["project", "direct"]).optional(),
  publication: z.enum(["pending", "published", "conflict"]).default("pending"), files: z.number().int().nonnegative().max(10000).default(0),
  changedPaths: z.array(z.string().min(1).max(600)).max(10000).optional(),
  cost: z.object({ type: z.literal("subscription") }).default({ type: "subscription" }), monetaryCost: z.literal(0).default(0),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional() }).optional(), usageReportedAt: z.number().int().nonnegative().optional() }).strict();
export type Execution = z.infer<typeof executionSchema>;
