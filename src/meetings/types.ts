import { z } from "zod";
export const meetingPlanSchema = z.object({
  title: z.string().trim().min(1).max(60), goal: z.string().trim().min(1).max(2000),
  invitationText: z.string().trim().min(1).max(80).optional(),
  startsAt: z.union([z.literal("now"), z.string().datetime({ offset: true })]).default("now"),
  context: z.string().max(16000), instructions: z.string().max(8000),
  questions: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), question: z.string().min(1).max(1000),
    required: z.boolean(), sufficient: z.string().max(1000) }).strict()).min(1).max(20),
  targetSeconds: z.number().int().min(30).max(1800), maxSeconds: z.number().int().min(30).max(3600)
}).strict().refine(p => p.maxSeconds >= p.targetSeconds && new Set(p.questions.map(q => q.id)).size === p.questions.length);
export type MeetingPlan = z.infer<typeof meetingPlanSchema>;
export type MeetingLine = { id: string; role: "user" | "assistant"; text: string; at: number; interrupted?: boolean };
export type MeetingView = { phase: "invited" | "idle" | "connecting" | "active" | "paused" | "ending" | "ended"; startedAt?: number; endedAt?: number;
  acceptedAt?: number; calendarStatus?: "syncing" | "synced" | "failed"; calendarError?: string;
  scheduledAt?: number; scheduled?: boolean; expiresAt?: number; invitationText?: string;
  targetSeconds: number; maxSeconds: number; speaker?: string; transcript: MeetingLine[]; questions: Array<{ id: string; question: string; status: string }>;
  playback?:Array<{connection:number;generation:number;lineId?:string;trackSid?:string;createdAt?:number;generatedAt?:number;sentAt?:number;startedAt?:number;endedAt?:number;interruptedAt?:number;samples?:number;evidence?:'render_observed'|'estimated';metrics?:Record<string,number>}>;
  summary?: string; reason?: string; supervisorError?: string };
export const directionSchema = z.object({ action: z.enum(["continue", "guide", "interrupt", "finish"]),
  guidance: z.string().max(3000), speech: z.string().max(2000), summary: z.string().max(4000),
  questions: z.array(z.object({ id: z.string(), status: z.enum(["unanswered", "answered", "clarify", "deferred", "confirmed"]) }).strict()).max(20)
}).strict();
export type Direction = z.infer<typeof directionSchema>;
