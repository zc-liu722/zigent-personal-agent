import type { TaskTrigger } from "./types.js";

type RecurringTrigger = Extract<TaskTrigger, { schedule: "daily" | "weekly" }>;
export type NextOccurrence = (trigger: TaskTrigger) => number | undefined;
const MINUTE = 60000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Occurrences = { first: number; weekdays: Map<number, number> };

/** Index first matches in UTC order, so repeated local minutes retain their first occurrence. */
class MinuteIndex {
  private readonly format: Intl.DateTimeFormat;
  private readonly times = new Map<string, Occurrences>();
  private at: number;
  private readonly end: number;
  constructor(after: number, timezone: string) {
    this.format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23",
      weekday: "short", hour: "2-digit", minute: "2-digit" });
    this.at = Math.floor(after / MINUTE) * MINUTE + MINUTE;
    this.end = this.at + 9 * 86400000;
  }
  next(trigger: RecurringTrigger): number {
    const known = this.times.get(trigger.time);
    if (known) {
      if (trigger.schedule === "daily") return known.first;
      let earliest: number | undefined;
      for (const [day, at] of known.weekdays) {
        if (trigger.weekdays!.includes(day) && (earliest === undefined || at < earliest)) earliest = at;
      }
      if (earliest !== undefined) return earliest;
    }
    while (this.at < this.end) {
      const at = this.at;
      const parts = Object.fromEntries(this.format.formatToParts(at).map(p => [p.type, p.value]));
      const time = `${parts.hour}:${parts.minute}`, day = WEEKDAYS.indexOf(parts.weekday!);
      let matches = this.times.get(time);
      if (!matches) { matches = { first: at, weekdays: new Map() }; this.times.set(time, matches); }
      if (!matches.weekdays.has(day)) matches.weekdays.set(day, at);
      this.at += MINUTE;
      if (time === trigger.time && (trigger.schedule === "daily" || trigger.weekdays!.includes(day))) return at;
    }
    throw new Error("Unable to find next schedule occurrence");
  }
}

/** One synchronous operation owns the search origin and indexes; never reuse across polls. */
export function createNextOccurrenceResolver(after: number): NextOccurrence {
  const zones = new Map<string, MinuteIndex>();
  return trigger => {
    if (trigger.type !== "time") return undefined;
    if (trigger.schedule === "once") {
      const at = Date.parse(trigger.at);
      return at > after ? at : undefined;
    }
    let index = zones.get(trigger.timezone);
    if (!index) { index = new MinuteIndex(after, trigger.timezone); zones.set(trigger.timezone, index); }
    return index.next(trigger);
  };
}

/** Minute resolution retains DST wall-clock semantics without using the host timezone. */
export function nextOccurrence(trigger: TaskTrigger, after: number): number | undefined {
  return createNextOccurrenceResolver(after)(trigger);
}
