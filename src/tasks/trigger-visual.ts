import type { TaskTrigger } from "./types.js";
import type { LocationSpeedRange } from "./location-speed.js";

/** Explicit display fields only. No coordinates, source IDs or health samples. */
export type TriggerVisual =
  | { type: "time"; schedule: "once" | "daily" | "weekly"; time: string; timezone: string; date?: string; weekdays?: number[]; maxLatenessSeconds: number }
  | (LocationSpeedRange & { type: "location"; event: "enter" | "leave"; place: string; radiusMeters?: number; cooldownSeconds: number; repeat: boolean })
  | { type: "external"; source: string; event: string; cooldownSeconds: number }
  | { type: "health_change"; metrics: string[]; afterTime?: string; timezone: string; debounceSeconds: number; oncePerDay: boolean; condition?: string };

export function triggerVisual(trigger: TaskTrigger): TriggerVisual | undefined {
  if (trigger.type === "reference") return undefined;
  if (trigger.type === "location") return { type: "location", event: trigger.event, place: trigger.regionName || "所选地点",
    ...(trigger.minSpeedKph === undefined ? {} : { minSpeedKph: trigger.minSpeedKph }),
    ...(trigger.maxSpeedKph === undefined ? {} : { maxSpeedKph: trigger.maxSpeedKph }),
    ...(trigger.radiusMeters ? { radiusMeters: trigger.radiusMeters } : {}), cooldownSeconds: trigger.cooldownSeconds ?? 300, repeat: trigger.repeat !== false };
  if (trigger.type === "external") return { type: "external", source: trigger.source || "设备", event: trigger.event, cooldownSeconds: trigger.cooldownSeconds ?? 0 };
  if (trigger.type === "health_change") return { type: "health_change", metrics: trigger.metrics ? [...trigger.metrics] : [],
    ...(trigger.afterTime ? { afterTime: trigger.afterTime } : {}), timezone: trigger.timezone ?? "Asia/Shanghai",
    debounceSeconds: trigger.debounceSeconds ?? 30, oncePerDay: Boolean(trigger.oncePerDay), ...(trigger.condition ? { condition: trigger.condition } : {}) };
  const timezone = trigger.timezone ?? "Asia/Shanghai";
  const maxLatenessSeconds = trigger.maxLatenessSeconds ?? 3600;
  if (trigger.schedule !== "once") return { type: "time", schedule: trigger.schedule, time: trigger.time, timezone, maxLatenessSeconds,
    ...(trigger.schedule === "weekly" ? { weekdays: [...(trigger.weekdays ?? [])] } : {}) };
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(trigger.at));
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return { type: "time", schedule: "once", time: `${value("hour")}:${value("minute")}`, date: `${value("year")}-${value("month")}-${value("day")}`, timezone, maxLatenessSeconds };
}
