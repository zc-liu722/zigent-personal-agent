export { createNextOccurrenceResolver, nextOccurrence, type NextOccurrence } from "./schedule-search.js";
import type { TaskTrigger } from "./types.js";
import { validLocationSpeedRange } from "./location-speed.js";
export function validateTrigger(trigger: TaskTrigger): TaskTrigger {
  if (!trigger || typeof trigger !== "object")
    throw new Error("Task trigger is required");
  if (trigger.type === "reference") {
    if (typeof trigger.triggerId !== "string" || !trigger.triggerId || trigger.triggerId.length > 200 || Object.keys(trigger).some(key => !["type", "triggerId"].includes(key))) throw new Error("Invalid shared trigger reference");
    return trigger;
  }
  if (trigger.type === "external") {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(trigger.event)) throw new Error("External event must be a compact event name");
    if (trigger.source !== undefined && !/^[a-z][a-z0-9_]{0,63}$/.test(trigger.source)) throw new Error("External source must be a compact source name");
    if (trigger.preparation !== undefined && trigger.preparation !== "outing_weather") throw new Error("Unsupported external preparation");
    for (const key of ["cooldownSeconds", "maxAgeSeconds"] as const) {
      const value = trigger[key];
      if (value !== undefined && (!Number.isInteger(value) || value < (key === "maxAgeSeconds" ? 60 : 0) || value > 86400))
        throw new Error("External cooldown/max age must be bounded seconds");
    }
    return trigger;
  }
  if (trigger.type === "time") {
    if (trigger.maxLatenessSeconds !== undefined && (!Number.isInteger(trigger.maxLatenessSeconds)
      || trigger.maxLatenessSeconds < 1 || trigger.maxLatenessSeconds > 86400)) throw new Error("Time lateness must be 1..86400 seconds");
    const zone = trigger.timezone ?? "Asia/Shanghai";
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
    if (trigger.schedule === "once") {
      if (
        !/([Zz]|[+-]\d{2}:\d{2})$/.test(trigger.at) ||
        !Number.isFinite(Date.parse(trigger.at))
      )
        throw new Error(
          "Once schedule requires an ISO timestamp with timezone",
        );
    } else if (trigger.schedule === "daily" || trigger.schedule === "weekly") {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time))
        throw new Error("Time must be HH:mm");
      if (
        trigger.schedule === "weekly" &&
        (!trigger.weekdays?.length ||
          trigger.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
      )
        throw new Error("Weekly weekdays must contain 0 (Sunday) through 6");
    } else throw new Error("Unsupported schedule");
    return { ...trigger, timezone: zone };
  }
  if (trigger.type === "health_change") {
    if (trigger.condition !== undefined && !["hrv_anomaly_v1", "hrv_realtime_v2"].includes(trigger.condition)) throw new Error("Unsupported health condition");
    if (trigger.condition && (trigger.metrics?.length !== 1
      || trigger.metrics[0] !== "heart_rate_variability"))
      throw new Error("HRV condition requires metrics=[heart_rate_variability]");
    if (trigger.afterTime !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.afterTime))
      throw new Error("Health afterTime must be HH:mm");
    if (trigger.timezone !== undefined) new Intl.DateTimeFormat("en", { timeZone: trigger.timezone }).format();
    if (trigger.oncePerDay !== undefined && typeof trigger.oncePerDay !== "boolean") throw new Error("oncePerDay must be boolean");
    if (
      trigger.debounceSeconds !== undefined &&
      (!Number.isFinite(trigger.debounceSeconds) ||
        trigger.debounceSeconds < 0 ||
        trigger.debounceSeconds > 3600)
    )
      throw new Error("Health debounce must be 0..3600 seconds");
    if (
      trigger.metrics &&
      (!Array.isArray(trigger.metrics) ||
        trigger.metrics.some((m) => typeof m !== "string" || !m))
    )
      throw new Error("Health metrics must be names");
    return trigger;
  }
  if (trigger.type === "location" && (trigger.event === "enter" || trigger.event === "leave")) {
    if (!validLocationSpeedRange(trigger)) throw new Error("Location speed requires 0 <= minSpeedKph <= maxSpeedKph <= 2000; either bound may be omitted");
    if (trigger.repeat !== undefined && typeof trigger.repeat !== "boolean") throw new Error("Location repeat must be boolean");
    for (const key of ["regionId", "regionName"] as const) {
      if (trigger[key] !== undefined && (typeof trigger[key] !== "string" || !trigger[key]!.trim() || trigger[key]!.length > 200))
        throw new Error("Region must be a nonempty name or ID");
    }
    if (trigger.center) {
      const c = trigger.center;
      if (c.system !== "GCJ-02" || !Number.isFinite(c.latitude) || Math.abs(c.latitude) > 90
        || !Number.isFinite(c.longitude) || Math.abs(c.longitude) > 180
        || !Number.isFinite(trigger.radiusMeters) || trigger.radiusMeters! < 100 || trigger.radiusMeters! > 50000
        || trigger.regionId || trigger.regionName) throw new Error("Geofence requires GCJ-02 coordinates and radiusMeters 100..50000, without a region selector");
    } else if (trigger.radiusMeters !== undefined) throw new Error("radiusMeters requires center");
    for (const key of ["cooldownSeconds", "maxAgeSeconds"] as const) {
      const v = trigger[key];
      if (v !== undefined && (!Number.isFinite(v) || v < (key === "maxAgeSeconds" ? 1 : 0) || v > 86400))
        throw new Error("Location cooldown/max age must be bounded seconds");
    }
    return trigger;
  }
  throw new Error("Unsupported trigger");
}
/** A batch owns its formatter; no global cache or timestamp results survive the operation. */
export function createLocalTaskClock(timezone = "Asia/Shanghai"): (at: number) => { day: string; time: string } {
  let format: Intl.DateTimeFormat | undefined;
  return at => {
    // Lazy construction preserves empty-batch behavior, including invalid unused zones.
    format ??= new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const parts = Object.fromEntries(format.formatToParts(at).map(p => [p.type, p.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  };
}

/** Calendar and window evaluation always use the declared zone, never the runner host's zone. */
export function localTaskTime(at: number, timezone = "Asia/Shanghai"): { day: string; time: string } {
  return createLocalTaskClock(timezone)(at);
}
