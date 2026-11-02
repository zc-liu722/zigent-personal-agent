import type { HealthObservation, HealthStore } from "./store.js";
import { createLocalTaskClock, localTaskTime } from "../tasks/schedule.js";
import { hrvPeriodClassifier, readHealthMetricRows, summarizeClassifiedSleepHrv, type HrvPeriod, type SleepHrvGroup } from "./hrv-sleep.js";
import { hrvMilliseconds as milliseconds, median, prepareRealtimeHrv } from "./hrv-measurements.js";
import { deviceTimeIsUsable, deviceTimeQueryEnd } from "../time-policy.js";
export { detectRealtimeHrv } from "./hrv-measurements.js";

const DAY = 86400_000;
export const HRV_METRIC = "heart_rate_variability";
export const HRV_RULE = "hrv_anomaly_v1";
export const HRV_REALTIME_RULE = "hrv_realtime_v2";
export type HrvChange = Pick<HealthObservation, "id" | "stream" | "observedAt"> & { seq?: number };
export type HrvAnomaly = {
  stream: string; day: string; latestObservedAt: number; samples: number; currentMs: number;
  baselineMs: number; baselineDays: number; ratio: number; robustZ?: number;
  baselineStatus: "ready" | "provisional"; baselineMethod: "rolling" | "bootstrap";
  reasons: Array<"low" | "persistent_low" | "unusual_high" | "severe_low" | "extreme_high" | "sharp_drop" | "recent_low" | "recent_high">;
  signal?: "realtime"; recentMedianMs?: number; previousMedianMs?: number; windowFrom?: number;
  period?: HrvPeriod;
};
export type HrvEvidence = { rule: typeof HRV_RULE | typeof HRV_REALTIME_RULE; evaluatedAt: number; highWaterSeq: number;
  totalAnomalies?: number; anomaliesTruncated?: boolean; anomalies: HrvAnomaly[];
  suppressedRepeats?: number;
  periodPolicy?: { timezone: string; receiptCutoff: "04:00"; processedLocalTime: string; sleepDataComplete: boolean };
  sleepMeasurements?: number; awakeMeasurements?: number; unknownMeasurements?: number; sleepGroups?: SleepHrvGroup[]; sleepGroupsTruncated?: boolean;
};
export type HrvBaselineSnapshot = {
  rule: typeof HRV_RULE; stream: string; timezone: string; evaluatedAt: number; highWaterSeq: number;
  referenceDay: string; latestObservedAt?: number; baselineDays: number; baselineMs?: number; logSpread?: number;
  method?: "rolling" | "bootstrap"; seedDays?: number[];
  status: "ready" | "provisional" | "learning" | "incomplete";
};
const ordinal = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY;
function isDaily(row: HealthObservation): boolean {
  // Remove the known suffix first: uploader/source names may themselves contain slashes.
  const suffix = `/${row.kind}/${row.source ?? "unspecified"}`;
  return row.stream.endsWith(suffix) && /^days?$/i.test(row.stream.slice(0, -suffix.length).split("/").at(-1) ?? "");
}
/** Engineering thresholds for a recovery conversation, never diagnostic cutoffs. No population-wide low-HRV cutoff. */
function assessHrv(rows: readonly HealthObservation[], now: number, timezone: string, prior?: HrvBaselineSnapshot): {
  baseline: Pick<HrvBaselineSnapshot, "referenceDay" | "latestObservedAt" | "baselineDays" | "baselineMs" | "logSpread" | "method" | "seedDays">;
  anomaly?: HrvAnomaly;
} | undefined {
  const usable = rows.filter(row => milliseconds(row) !== undefined && deviceTimeIsUsable(row.observedAt, now));
  if (!usable.length) return;
  const latest = usable.reduce((a, b) => a.observedAt > b.observedAt ? a : b);
  const localTime = createLocalTaskClock(timezone);
  const day = localTime(latest.observedAt).day, currentDay = ordinal(day);
  const buckets = new Map<string, HealthObservation[]>();
  for (const row of usable) {
    if (row.stream !== latest.stream) continue;
    const key = localTime(row.observedAt).day;
    const bucket = buckets.get(key) ?? []; bucket.push(row); buckets.set(key, bucket);
  }
  const days = new Map<number, { value: number; samples: number }>();
  for (const [key, bucket] of buckets) {
    // Raw/hourly measurements need at least three distinct timestamps. Never mix export streams.
    const distinct = new Map(bucket.map(row => [row.observedAt, row]));
    const points = [...distinct.values()];
    if (points.length < (points.every(isDaily) ? 1 : 3)) continue;
    days.set(ordinal(key), { value: median(points.map(row => milliseconds(row)!)), samples: points.length });
  }
  const current = days.get(currentDay);
  // Exclude the three evaluated days from the baseline so a short low streak cannot lower its own reference.
  let selected = [...days].filter(([key]) => key >= currentDay - 30 && key <= currentDay - 3);
  let method: "rolling" | "bootstrap" = "rolling", seedDays: number[] | undefined;
  if (selected.length < 2) {
    method = "bootstrap";
    // Keep the same two seed days during warm-up; a newly low day cannot immediately lower its own reference.
    // Corrections to either seed day still update its estimate from the authoritative current records.
    const seeded = [...days].filter(([key]) => prior?.method === "bootstrap" && prior.seedDays?.includes(key) && key >= currentDay - 30 && key < currentDay);
    selected = seeded.length >= 2 ? seeded : [...days].filter(([key]) => key >= currentDay - 30 && key < currentDay).sort(([a], [b]) => b - a).slice(0, 2);
    seedDays = selected.map(([key]) => key);
  }
  const history = selected.map(([, entry]) => entry.value);
  const baseline = { referenceDay: day, latestObservedAt: latest.observedAt, baselineDays: history.length, method, ...(seedDays ? { seedDays } : {}) };
  if (history.length < 2) return { baseline };
  const logs = history.map(Math.log), center = median(logs);
  const scale = Math.max(1.4826 * median(logs.map(value => Math.abs(value - center))), 0.05);
  const baselineMs = Math.exp(center), ready = { ...baseline, baselineMs, logSpread: scale };
  if (!current) return { baseline: ready };
  const ratio = current.value / baselineMs, robustZ = Math.log(ratio) / scale;
  const baselineStatus = method === "rolling" && history.length >= 14 ? "ready" : "provisional";
  const mature = baselineStatus === "ready";
  const reasons: HrvAnomaly["reasons"] = [];
  if (ratio <= (mature ? 0.70 : 0.60) + 1e-12 && robustZ <= (mature ? -2.5 : -3)) reasons.push("low");
  if (method === "rolling" && [0, 1, 2].every(offset => (days.get(currentDay - offset)?.value ?? Infinity) <= (mature ? 0.80 : 0.75) * baselineMs + 1e-12)) reasons.push("persistent_low");
  if (ratio >= (mature ? 1.50 : 1.75) - 1e-12 && robustZ >= (mature ? 3 : 3.5)) reasons.push("unusual_high");
  const anomaly: HrvAnomaly | undefined = reasons.length ? { stream: latest.stream, day, latestObservedAt: latest.observedAt, samples: current.samples,
    currentMs: current.value, baselineMs, baselineDays: history.length, baselineStatus, baselineMethod: method, ratio, robustZ, reasons } : undefined;
  return { baseline: ready, anomaly };
}

function qualifies(anomaly: HrvAnomaly | undefined, changes: readonly HrvChange[], rows: readonly HealthObservation[], now: number,
  timezone: string): HrvAnomaly | undefined {
  if (!anomaly || !deviceTimeIsUsable(anomaly.latestObservedAt, now, 36 * 3600_000)) return;
  const validIds = new Set(rows.filter(row => milliseconds(row) !== undefined && deviceTimeIsUsable(row.observedAt, now)).map(row => row.id));
  // A historical correction can update the baseline without re-alerting a present anomaly.
  return changes.some(change => change.stream === anomaly.stream && deviceTimeIsUsable(change.observedAt, now, 36 * 3600_000)
    && localTaskTime(change.observedAt, timezone).day === anomaly.day
    && validIds.has(change.id)) ? anomaly : undefined;
}

export function detectHrvAnomaly(rows: readonly HealthObservation[], changes: readonly HrvChange[], now: number,
  timezone = "Asia/Shanghai"): HrvAnomaly | undefined {
  return qualifies(assessHrv(rows, now, timezone)?.anomaly, changes, rows, now, timezone);
}

/** Bounded, paginated reads of current records, not the revision history. */
function refreshBaseline(store: HealthStore, stream: string, now: number, timezone: string, highWaterSeq: number) {
  const rows: HealthObservation[] = []; let afterSeq = 0, complete = false;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = store.query({ from: Math.max(0, now - 33 * DAY), to: deviceTimeQueryEnd(now), metrics: [HRV_METRIC], stream, afterSeq, limit: 500 });
    rows.push(...page.observations);
    if (!page.hasMore) { complete = true; break; }
    afterSeq = page.nextCursor;
  }
  const prior = store.hrvBaselines().find(row => row.rule === HRV_RULE && row.stream === stream && row.timezone === timezone);
  const assessment = complete ? assessHrv(rows, now, timezone, prior) : undefined;
  const baseline: HrvBaselineSnapshot = { rule: HRV_RULE, stream, timezone, evaluatedAt: now, highWaterSeq,
    referenceDay: localTaskTime(now, timezone).day, baselineDays: 0, ...assessment?.baseline,
    status: !complete ? "incomplete" : assessment?.baseline.baselineMs === undefined ? "learning"
      : assessment.baseline.method === "rolling" && assessment.baseline.baselineDays >= 14 ? "ready" : "provisional" };
  store.saveHrvBaseline(baseline);
  return { rows, baseline, anomaly: assessment?.anomaly };
}

/** Owner-requested initial setup. Saves calculated baselines only; never queues old data or sends a message. */
export function initializeHrvBaselines(store: HealthStore, now = Date.now(), timezone = "Asia/Shanghai"): HrvBaselineSnapshot[] {
  const highWater = store.highWaterSeq();
  const streams = store.status(now).streams as { metric: string; stream: string }[];
  return streams.filter(row => row.metric === HRV_METRIC).map(row => refreshBaseline(store, row.stream, now, timezone, highWater).baseline);
}

/** Every HRV change re-estimates its own rolling baseline, including historical corrections. */
export function evaluateHrvChanges(store: HealthStore, changes: readonly HrvChange[], now = Date.now(),
  timezone = "Asia/Shanghai", rule: HrvEvidence["rule"] = HRV_RULE, notBefore?: number): HrvEvidence {
  const evidence: HrvEvidence = { rule, evaluatedAt: now, highWaterSeq: store.highWaterSeq(), anomalies: [] };
  const sleep = rule === HRV_REALTIME_RULE
    ? readHealthMetricRows(store, "sleep_analysis", now - 35 * DAY, now + DAY) : undefined;
  const classify = sleep ? hrvPeriodClassifier(sleep.rows, now, timezone) : undefined;
  if (sleep) {
    evidence.periodPolicy = { timezone, receiptCutoff: "04:00", processedLocalTime: localTaskTime(now, timezone).time, sleepDataComplete: sleep.complete };
    evidence.sleepMeasurements = 0; evidence.awakeMeasurements = 0; evidence.unknownMeasurements = 0; evidence.sleepGroups = [];
  }
  for (const stream of new Set(changes.map(row => row.stream))) {
    const assessment = refreshBaseline(store, stream, now, timezone, evidence.highWaterSeq);
    if (rule === HRV_REALTIME_RULE) {
      const periods = new Map(assessment.rows.map(row => [row.id, classify!(row)]));
      const awakeRows = assessment.rows.filter(row => periods.get(row.id)!.state !== "asleep"
        && (notBefore === undefined || row.observedAt >= notBefore));
      const changedIds = new Set(changes.filter(row => row.stream === stream).map(row => row.id));
      const changedRows = assessment.rows.filter(row => changedIds.has(row.id) && milliseconds(row) !== undefined);
      for (const row of changedRows) {
        const state = periods.get(row.id)!.state;
        if (state === "asleep") evidence.sleepMeasurements!++;
        else if (state === "awake") evidence.awakeMeasurements!++;
        else evidence.unknownMeasurements!++;
      }
      evidence.sleepGroups!.push(...summarizeClassifiedSleepHrv(changedRows, now, row => periods.get(row.id)!));
      const detect = prepareRealtimeHrv(awakeRows, now, assessment.baseline);
      for (const change of new Map(changes.filter(row => row.stream === stream).map(row => [row.id, row])).values()) {
        const anomaly = detect([change]);
        if (anomaly) evidence.anomalies.push({ ...anomaly, period: periods.get(change.id) });
      }
    } else {
      const anomaly = qualifies(assessment.anomaly, changes, assessment.rows, now, timezone);
      if (anomaly) evidence.anomalies.push(anomaly);
    }
  }
  if (rule === HRV_REALTIME_RULE) {
    evidence.sleepGroups!.sort((a, b) => a.start - b.start);
    if (evidence.sleepGroups!.length > 20) { evidence.sleepGroups = evidence.sleepGroups!.slice(-20); evidence.sleepGroupsTruncated = true; }
    evidence.anomalies.sort((a, b) => a.latestObservedAt - b.latestObservedAt);
    evidence.totalAnomalies = evidence.anomalies.length;
    if (evidence.anomalies.length > 100) {
      evidence.anomalies = [...evidence.anomalies.slice(0, 50), ...evidence.anomalies.slice(-50)]; evidence.anomaliesTruncated = true;
    }
  }
  return evidence;
}
