import type { HealthObservation, HealthStore } from "./store.js";
import { timestamp } from "./normalize.js";
import { createLocalTaskClock } from "../tasks/schedule.js";
import { hrvMilliseconds } from "./hrv-measurements.js";
import { deviceTimeIsUsable, deviceTimeQueryEnd } from "../time-policy.js";

const DAY = 86400_000;
type SleepInterval = { start: number; end: number; state: "asleep" | "awake"; source?: string; precision: "segment" | "summary" };
export type HrvPeriod = {
  state: "awake" | "asleep" | "unknown";
  reason: "received_before_0400" | "sleep_record" | "awake_record" | "outside_sleep_record" | "sleep_data_missing" | "conflicting_sleep_records";
  receivedAt: number; receivedLocalTime: string; interval?: { start: number; end: number };
};
export type SleepHrvGroup = { stream: string; start: number; end: number; samples: number; medianMs: number; minMs: number; maxMs: number };
const asleepStages = new Set(["asleep", "core", "deep", "rem", "asleepcore", "asleepdeep", "asleeprem", "asleepunspecified"]);

function sleepIntervals(rows: readonly HealthObservation[], now: number): SleepInterval[] {
  const intervals: SleepInterval[] = [];
  for (const row of rows) {
    if (row.metric !== "sleep_analysis" || row.provenance !== "health_auto_export" || row.receivedAt > now) continue;
    let start: number | undefined, end: number | undefined, state: "asleep" | "awake" = "asleep";
    if (row.kind === "sleep_segment") {
      const stage = String(row.values.value ?? "").toLowerCase().replace(/[ _-]/g, "");
      if (stage === "awake") state = "awake";
      else if (!asleepStages.has(stage)) continue; // In Bed alone does not establish sleep or wakefulness.
      start = row.observedAt; end = row.endAt;
    } else if (row.kind === "sleep_summary") {
      try { start = timestamp(row.values.sleepStart, now); end = timestamp(row.values.sleepEnd, now); }
      catch { continue; } // A duration/date without actual bounds cannot define a sleep interval.
    }
    if (start === undefined || end === undefined || !Number.isFinite(start) || start < 0 || end <= start || !deviceTimeIsUsable(end, now)) continue;
    intervals.push({ start, end, state, source: row.source, precision: row.kind === "sleep_segment" ? "segment" : "summary" });
  }
  return intervals;
}

/** The cutoff is receipt time in the declared zone, never measurement time or the time a retry runs. */
export function hrvPeriodClassifier(sleepRows: readonly HealthObservation[], now = Date.now(), timezone = "Asia/Shanghai") {
  const all = sleepIntervals(sleepRows, now), receiptTimes = new Map<number, string>();
  const localTime = createLocalTaskClock(timezone);
  return (row: HealthObservation): HrvPeriod => {
    const receivedLocalTime = receiptTimes.get(row.receivedAt) ?? localTime(row.receivedAt).time;
    receiptTimes.set(row.receivedAt, receivedLocalTime);
    const base = { receivedAt: row.receivedAt, receivedLocalTime };
    if (receivedLocalTime < "04:00") return { ...base, state: "awake", reason: "received_before_0400" };
    const covering = all.filter(interval => interval.start <= row.observedAt && row.observedAt < interval.end);
    const sameSource = row.source ? covering.filter(interval => interval.source === row.source) : [];
    const selected = sameSource.length ? sameSource : covering;
    const segments = selected.filter(interval => interval.precision === "segment");
    const evidence = segments.length ? segments : selected;
    if (evidence.some(interval => interval.state === "awake") && evidence.some(interval => interval.state === "asleep"))
      return { ...base, state: "unknown", reason: "conflicting_sleep_records" };
    if (evidence.some(interval => interval.state === "awake")) return { ...base, state: "awake", reason: "awake_record" };
    if (evidence.some(interval => interval.state === "asleep")) {
      const bounds = selected.filter(interval => interval.state === "asleep").sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]!;
      return { ...base, state: "asleep", reason: "sleep_record", interval: { start: bounds.start, end: bounds.end } };
    }
    const nearby = all.some(interval => interval.start <= row.observedAt + DAY && interval.end >= row.observedAt - DAY);
    return { ...base, state: nearby ? "awake" : "unknown", reason: nearby ? "outside_sleep_record" : "sleep_data_missing" };
  };
}
export function classifyHrvPeriod(row: HealthObservation, sleepRows: readonly HealthObservation[], now = Date.now(), timezone = "Asia/Shanghai"): HrvPeriod {
  return hrvPeriodClassifier(sleepRows, now, timezone)(row);
}

/** Read all matching streams explicitly. Date-only sleep labels may be UTC buckets later than the local receipt hour. */
export function readHealthMetricRows(store: HealthStore, metric: string, from: number, to: number) {
  const status = store.status();
  const streams = status.streams as { metric: string; stream: string }[];
  const rows: HealthObservation[] = []; let complete = !status.streamsTruncated;
  for (const entry of streams.filter(entry => entry.metric === metric)) {
    let afterSeq = 0, finished = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = store.query({ from: Math.max(0, from), to, metrics: [metric], stream: entry.stream, afterSeq, limit: 500 });
      rows.push(...page.observations);
      if (!page.hasMore) { finished = true; break; }
      afterSeq = page.nextCursor;
    }
    if (!finished) complete = false;
  }
  return { rows, complete };
}

/** Sleep-classified HRV stays available to sleep reviews instead of causing awake-state point alerts. */
export function summarizeSleepHrv(rows: readonly HealthObservation[], sleepRows: readonly HealthObservation[], now: number, timezone = "Asia/Shanghai"): SleepHrvGroup[] {
  return summarizeClassifiedSleepHrv(rows, now, hrvPeriodClassifier(sleepRows, now, timezone));
}

/** Reuse the batch's period evidence so awake alerts and sleep groups share one classification. */
export function summarizeClassifiedSleepHrv(rows: readonly HealthObservation[], now: number,
  classify: (row: HealthObservation) => HrvPeriod): SleepHrvGroup[] {
  const groups = new Map<string, { stream: string; start: number; end: number; values: Map<number, number> }>();
  for (const row of rows) {
    if (row.metric !== "heart_rate_variability" || row.kind !== "metric" || row.provenance !== "health_auto_export" || !deviceTimeIsUsable(row.observedAt, now)) continue;
    const period = classify(row);
    if (period.state !== "asleep" || !period.interval) continue;
    const value = hrvMilliseconds(row);
    if (value === undefined) continue;
    const { start, end } = period.interval, key = JSON.stringify([row.stream, start, end]);
    const group = groups.get(key) ?? { stream: row.stream, start, end, values: new Map<number, number>() };
    group.values.set(row.observedAt, value); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const values = [...group.values.values()].sort((a, b) => a - b), mid = Math.floor(values.length / 2);
    return { stream: group.stream, start: group.start, end: group.end, samples: values.length,
      medianMs: values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2, minMs: values[0]!, maxMs: values.at(-1)! };
  }).sort((a, b) => a.start - b.start);
}

export function recentSleepHrv(store: HealthStore, now = Date.now(), timezone = "Asia/Shanghai") {
  const highWaterSeq = store.highWaterSeq();
  const sleep = readHealthMetricRows(store, "sleep_analysis", now - 3 * DAY, now + DAY);
  const hrv = readHealthMetricRows(store, "heart_rate_variability", now - 3 * DAY, deviceTimeQueryEnd(now));
  const groups = summarizeSleepHrv(hrv.rows, sleep.rows, now, timezone);
  return { highWaterSeq, complete: sleep.complete && hrv.complete, groupCount: groups.length,
    groupsTruncated: groups.length > 20, groups: groups.slice(-20) };
}
