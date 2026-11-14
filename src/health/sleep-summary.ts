import type { HealthObservation } from "./normalize.js";
import type { HealthQuery } from "./query.js";
import type { HealthStore } from "./store.js";

type Stage = "core" | "deep" | "rem" | "asleep" | "awake" | "inBed" | "unspecified";
// Auto Export localizes stage labels. Preserve the original values/identities in
// storage and normalize on every read, including records imported before this fix.
export function stageOf(value: unknown): Stage {
  const name = String(value ?? "").toLowerCase().replace(/[ _-]/g, "");
  return ({ core: "core", asleepcore: "core", deep: "deep", asleepdeep: "deep", rem: "rem", asleeprem: "rem",
    asleep: "asleep", asleepunspecified: "asleep", awake: "awake", inbed: "inBed",
    核心: "core", 核心睡眠: "core", 深度: "deep", 深睡: "deep", 深度睡眠: "deep",
    快速动眼期: "rem", 快速動眼期: "rem", 快速眼动期: "rem", 快速眼動期: "rem",
    清醒: "awake", 在床上: "inBed", 卧床: "inBed", 臥床: "inBed", 已入睡: "asleep", 睡眠: "asleep"
  } as Record<string, Stage>)[name] ?? "unspecified";
}

/** Full-window summary of one source; never add upstream summaries to segments. */
export function summarizeSleep(query: (input: HealthQuery) => ReturnType<HealthStore["query"]>,
  input: Pick<HealthQuery, "from" | "to" | "stream">) {
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.to <= input.from
    || input.to - input.from > 48 * 3600_000) throw new Error("INVALID_SLEEP_RANGE_MAX_48_HOURS");
  const rows: HealthObservation[] = [];
  let cursor = 0, highWaterSeq = 0, stream = input.stream;
  for (;;) {
    const page = query({ ...input, metrics: ["sleep_analysis"], afterSeq: cursor, limit: 500 });
    if (page.result === "stream_required") return { ...page, action: "sleep" };
    highWaterSeq = page.highWaterSeq; stream = page.stream;
    rows.push(...page.observations);
    if (!page.hasMore) break;
    if (page.nextCursor <= cursor || rows.length >= 50_000) throw new Error("SLEEP_WINDOW_TOO_DENSE");
    cursor = page.nextCursor;
  }
  const base = { result: rows.length ? "available" : "no_data", stream, from: input.from, to: input.to,
    highWaterSeq, records: rows.length, recordsComplete: true, units: "hr",
    note: "Full query-window coverage of stored records, not proof of a complete night. Missing stages are unknown; do not add other sources or legacy summaries." };
  const segments = rows.filter(row => row.kind === "sleep_segment");
  if (!segments.length) return { ...base, format: "upstream_summaries", summaries: rows.filter(row => row.kind === "sleep_summary") };

  const events: { time: number; stage: Stage; delta: number }[] = [];
  let clippedSegments = 0, invalidSegments = 0;
  for (const row of segments) {
    if (row.endAt === undefined || row.endAt <= row.observedAt) { invalidSegments++; continue; }
    const start = Math.max(input.from, row.observedAt), end = Math.min(input.to, row.endAt);
    if (end <= start) continue;
    if (start !== row.observedAt || end !== row.endAt) clippedSegments++;
    const stage = stageOf(row.values.value);
    events.push({ time: start, stage, delta: 1 }, { time: end, stage, delta: -1 });
  }
  events.sort((a, b) => a.time - b.time);
  const active = new Map<Stage, number>();
  const stagesPresent = [...new Set(events.map(event => event.stage))];
  const stageDetailAvailable = stagesPresent.some(stage => ["core", "deep", "rem"].includes(stage));
  const sleepStateAvailable = stagesPresent.some(stage => ["core", "deep", "rem", "asleep", "awake"].includes(stage));
  const durations = { core: 0, deep: 0, rem: 0, asleep: 0, awake: 0, inBed: 0, unspecified: 0,
    totalSleep: 0, conflicting: 0, unobserved: 0 };
  let previous = events[0]?.time, sleepStart: number | null = null, sleepEnd: number | null = null;
  for (let i = 0; i < events.length;) {
    const time = events[i]!.time, duration = time - previous!;
    if (duration > 0) {
      const stages = [...active].filter(([, count]) => count > 0).map(([stage]) => stage);
      const sleeping = stages.filter(stage => ["asleep", "core", "deep", "rem"].includes(stage));
      if (stages.includes("inBed")) durations.inBed += duration;
      if (!stages.length) durations.unobserved += duration;
      if (stages.includes("unspecified")) durations.unspecified += duration;
      // Overlaps are measured once; contradictory evidence is disclosed, not silently summed.
      if (sleeping.length > 1 || sleeping.length && stages.includes("awake")) durations.conflicting += duration;
      if (sleeping.length && !stages.includes("awake")) {
        durations.totalSleep += duration;
        sleepStart ??= previous!; sleepEnd = time;
        if (sleeping.length === 1) durations[sleeping[0]!] += duration;
      } else if (!sleeping.length && stages.includes("awake")) durations.awake += duration;
    }
    while (i < events.length && events[i]!.time === time) {
      const event = events[i++]!;
      active.set(event.stage, (active.get(event.stage) ?? 0) + event.delta);
    }
    previous = time;
  }
  return { ...base, format: "segments", sleepStart, sleepEnd,
    observedStart: events[0]?.time ?? null, observedEnd: events.at(-1)?.time ?? null,
    stagesPresent, stageDetailAvailable, sleepStateAvailable,
    durations: Object.fromEntries(Object.entries(durations).map(([key, value]) => [key,
      !stageDetailAvailable && ["core", "deep", "rem"].includes(key) || !sleepStateAvailable && key === "totalSleep" ? null : value / 3600_000])),
    clippedSegments, invalidSegments, ignoredSummaries: rows.length - segments.length };
}
