import { z } from "zod";
import { executionSchema, type Execution } from "../project-spaces/workspace.js";

export const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const PROJECT_LIMIT = 200;
export const projectSchema = z.object({ id: identifier, name: z.string().trim().min(1).max(80), directory: z.string().min(1).max(1024).optional(),
  codexProjectId: identifier.optional(), roots: z.array(z.string().min(1).max(1024)).max(16).optional(), available: z.boolean().optional(),
  executor: z.enum(["windows-codex", "linux-claude"]).optional(), host: z.enum(["windows", "linux"]).optional(),
  scopeVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(), unavailableReason: z.string().max(100).optional() }).strict();
/** Owner-facing display snapshots. Never returned by the model's get/events tools. */
export const displaySchema = z.object({ itemId: z.string().min(1).max(160), kind: z.enum(["message", "command", "file", "tool", "plan"]),
  status: z.enum(["started", "completed", "failed"]), title: z.string().max(200), text: z.string().max(8000).optional(),
  output: z.string().max(12000).optional(), cwd: z.string().max(1024).optional(), exitCode: z.number().int().optional() }).strict();
export type CodexDisplay = z.infer<typeof displaySchema>;
export const taskStates = ["queued", "running", "waiting_user", "reconciling", "succeeded", "blocked", "cancelled"] as const;
export type CodexState = typeof taskStates[number];
export type CodexScope = { agentId: string; userId: string; conversationId?: string; sessionId?: string; conversationKind?: "p2p" | "group" };
export type CodexDevice = { id: string; name: string; projects: z.infer<typeof projectSchema>[]; lastSeenAt: number | null; revoked: boolean };
export type CodexTask = {
  id: string; userId: string; conversationId: string; sessionId: string; deviceId: string; projectId: string;
  project?: z.infer<typeof projectSchema>;
  protocol: "text-v1"; sourceRunId?: string; title: string; prompt: string;
  state: CodexState; phase: string; threadId?: string; turnId?: string; attempt: number; revision: number;
  leaseToken?: string; leaseUntil?: number; lastSeenAt?: number; lastProgressAt?: number;
  createdAt: number; updatedAt: number; deadlineAt: number; summary?: string;
  waitingSince?: number;
  execution?: Execution;
  continueTaskId?: string;
  notification: string;
  /** Channel-captured user text is immutable across automatic continuations. */
  originalRequest?: string;
  /** Accepted synthesized goal, retained when a follow-up only addresses one gap. */
  intent?: string;
  review?: { state: "pending" | "running" | "continued" | "delivered" | "blocked"; deadlineAt: number;
    model?: string; reasoningEfforts?: Readonly<Record<string, import("../config.js").ReasoningEffort>>;
    leaseToken?: string; leaseUntil?: number; nextAttemptAt?: number; failures?: number;
    decision?: "continue" | "deliver" | "blocked"; message?: string; nextTaskId?: string };

};
export const workerEventSchema = z.object({
  eventId: z.string().uuid(), taskId: z.string().uuid(), attempt: z.number().int().positive(), leaseToken: z.string().uuid(),
  type: z.enum(["started", "progress", "waiting_user", "completed", "blocked", "interrupted", "display"]),
  display: displaySchema.optional(),
  historical: z.boolean().optional(),
  threadId: z.string().min(1).max(128).optional(), turnId: z.string().min(1).max(128).optional(),
  phase: z.string().trim().min(1).max(100).optional(),
  activity: z.object({ kind: z.enum(["tool", "command", "file", "message", "reasoning_summary"]),
    status: z.enum(["started", "completed", "failed"]), name: z.string().max(80).optional(),
    durationMs: z.number().int().nonnegative().optional(), exitCode: z.number().int().optional() }).strict().optional(),
  summary: z.string().max(100000).optional(), execution: executionSchema.optional()
}).strict();
export type WorkerEvent = z.infer<typeof workerEventSchema>;
export const promptSchema = z.string().min(1).max(16000).refine(value => value.trim().length > 0, "请填写提示词");
export const dispatchSchema = z.object({ deviceId: z.string().uuid(), projectId: identifier,
  title: z.string().trim().min(1).refine(value => Array.from(value).length <= 4, "任务标题最多四个字符"),
  prompt: promptSchema, continueTaskId: z.string().uuid().optional(),
  sourceTurns: z.array(z.object({ sessionId: z.string().min(1).max(200), turnId: z.number().int().positive() }).strict()).max(20).optional(),
  reviewAfterCompletion: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(5).max(1440).default(120)
}).strict();
export type CodexDispatch = z.infer<typeof dispatchSchema>;

export function macDirectory(directory: string): string { return directory.replace(/^\/Users\/[^/]+(?=\/|$)/, "~"); }
