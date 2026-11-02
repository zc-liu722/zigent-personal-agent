import type { ActiveTask, TaskRun, TaskTrigger } from "./types.js";
import { localTaskTime } from "./schedule.js";
import { deviceTimeIsUsable, timestampIsFresh } from "../time-policy.js";

export const DEFAULT_MAX_LATENESS_SECONDS = 3600;

export function scheduledWindowOpen(trigger: Extract<TaskTrigger, { type: "time" }>, scheduledAt: unknown, now: number): boolean {
  return timestampIsFresh(scheduledAt, now, (trigger.maxLatenessSeconds ?? DEFAULT_MAX_LATENESS_SECONDS) * 1000);
}

/** Receipt timestamps belong to the server. Never apply device skew to daily gates. */
export function healthReceiptWindowOpen(trigger: Extract<TaskTrigger, { type: "health_change" }>, receivedAt: number, now: number): boolean {
  if (!trigger.afterTime) return true;
  if (!timestampIsFresh(receivedAt, now, Infinity)) return false;
  const current = localTaskTime(now, trigger.timezone), received = localTaskTime(receivedAt, trigger.timezone);
  return received.day === current.day && received.time >= trigger.afterTime && current.time >= trigger.afterTime;
}

/** Deterministic execution bounds, shared by leasing, model preparation and delivery. */
export function taskTimeWindowOpen(task: ActiveTask, run: TaskRun, now = Date.now()): boolean {
  const payload = run.payload as { manual?: boolean; scheduledAt?: number; dayKey?: string; occurredAt?: unknown };
  if (payload.manual === true) return true;
  if (task.trigger.type === "time") return scheduledWindowOpen(task.trigger, payload.scheduledAt, now);
  if (task.trigger.type === "location" || task.trigger.type === "external") {
    const at = task.trigger.type === "external" && typeof payload.occurredAt === "string" ? Date.parse(payload.occurredAt) : payload.occurredAt;
    return deviceTimeIsUsable(at, now, (task.trigger.maxAgeSeconds ?? 600) * 1000);
  }
  if (task.trigger.type !== "health_change") return true;
  const trigger = task.trigger;
  if (trigger.condition === "hrv_realtime_v2" && !trigger.afterTime) return true;
  if (!trigger.afterTime && !trigger.condition && !trigger.oncePerDay) return true;
  const current = localTaskTime(now, trigger.timezone);
  return (!trigger.afterTime || current.time >= trigger.afterTime) && (!payload.dayKey || payload.dayKey === current.day);
}
