import type { HealthObservation } from "./store.js";
import type { HrvAnomaly, HrvBaselineSnapshot, HrvChange } from "./hrv.js";
import { createLocalTaskClock } from "../tasks/schedule.js";
import { deviceTimeIsUsable } from "../time-policy.js";

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
export function hrvMilliseconds(row: HealthObservation): number | undefined {
  if (row.metric !== "heart_rate_variability" || row.provenance !== "health_auto_export" || row.kind !== "metric") return;
  const qty = row.values.qty, unit = row.units?.trim().toLowerCase();
  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) return;
  if (["ms", "millisecond", "milliseconds"].includes(unit ?? "")) return qty;
  if (["s", "sec", "second", "seconds"].includes(unit ?? "")) return qty * 1000;
}

function isLongAggregate(row: HealthObservation): boolean {
  const suffix = `/${row.kind}/${row.source ?? "unspecified"}`;
  return row.stream.endsWith(suffix) && /^(?:hours?|days?|weeks?|months?|years?)$/i.test(row.stream.slice(0, -suffix.length).split("/").at(-1) ?? "");
}

/** Prepare once per evaluation/stream; never retain observations across arrivals or corrections. */
export function prepareRealtimeHrv(rows: readonly HealthObservation[], now: number, baseline: HrvBaselineSnapshot):
  (changes: readonly HrvChange[]) => HrvAnomaly | undefined {
  if (!baseline.baselineMs || !["ready", "provisional"].includes(baseline.status)) return () => undefined;
  const byTime = new Map<number, { row: HealthObservation; index: number }>();
  for (const row of rows) {
    if (row.stream !== baseline.stream || hrvMilliseconds(row) === undefined || !deviceTimeIsUsable(row.observedAt, now) || isLongAggregate(row)) continue;
    const prior = byTime.get(row.observedAt);
    if (!prior || row.seq > prior.row.seq) byTime.set(row.observedAt, { row, index: 0 });
  }
  const ordered = [...byTime.values()].sort((a, b) => a.row.observedAt - b.row.observedAt);
  ordered.forEach((entry, index) => { entry.index = index; });
  const localTime = createLocalTaskClock(baseline.timezone);
  return changes => {
    // The public single-result API chooses the latest matching current revision.
    let selected: typeof ordered[number] | undefined;
    for (const change of changes) {
      const entry = byTime.get(change.observedAt);
      if (entry && change.id === entry.row.id && change.stream === entry.row.stream
        && (change.seq === undefined || change.seq === entry.row.seq)
        && (!selected || entry.index > selected.index)) selected = entry;
    }
    if (!selected) return;
    const { row: current, index } = selected;
    const currentMs = hrvMilliseconds(current)!, reference = baseline.baselineMs!;
    // Unique, ascending timestamps make the three adjacent samples the only possible window members.
    const recent = ordered.slice(Math.max(0, index - 2), index + 1).map(entry => entry.row)
      .filter(row => row.observedAt >= current.observedAt - 30 * 60_000);
    const previous = ordered.slice(Math.max(0, index - 3), index).map(entry => entry.row)
      .filter(row => row.observedAt >= current.observedAt - 60 * 60_000);
    const recentMedianMs = median(recent.map(row => hrvMilliseconds(row)!));
    const previousMedianMs = previous.length === 3 ? median(previous.map(row => hrvMilliseconds(row)!)) : undefined;
    const reasons: HrvAnomaly["reasons"] = [];
    if (currentMs <= 0.50 * reference + 1e-12) reasons.push("severe_low");
    if (currentMs >= 2.00 * reference - 1e-12) reasons.push("extreme_high");
    if (recent.length >= 2 && recentMedianMs <= 0.70 * reference + 1e-12 && currentMs <= 0.70 * reference + 1e-12) reasons.push("recent_low");
    if (recent.length >= 2 && recentMedianMs >= 1.50 * reference - 1e-12 && currentMs >= 1.50 * reference - 1e-12) reasons.push("recent_high");
    if (previousMedianMs !== undefined && currentMs <= 0.65 * previousMedianMs + 1e-12 && currentMs <= 0.80 * reference + 1e-12) reasons.push("sharp_drop");
    if (!reasons.length) return;
    return { stream: current.stream, day: localTime(current.observedAt).day,
      latestObservedAt: current.observedAt, samples: recent.length, currentMs, baselineMs: reference,
      baselineDays: baseline.baselineDays, ratio: currentMs / reference,
      baselineStatus: baseline.status === "ready" ? "ready" : "provisional", baselineMethod: baseline.method ?? "rolling",
      signal: "realtime", recentMedianMs, previousMedianMs, windowFrom: recent[0]!.observedAt, reasons };
  };
}

/** Evaluate one latest matching change; batch callers reuse prepareRealtimeHrv instead. */
export function detectRealtimeHrv(rows: readonly HealthObservation[], changes: readonly HrvChange[], now: number,
  baseline: HrvBaselineSnapshot): HrvAnomaly | undefined {
  return prepareRealtimeHrv(rows, now, baseline)(changes);
}
