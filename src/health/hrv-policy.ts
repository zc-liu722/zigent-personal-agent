import type { ActiveTask, TaskRun } from "../tasks/types.js";
import type { TaskStore } from "../tasks/store.js";
import { localTaskTime } from "../tasks/schedule.js";
import type { HrvAnomaly, HrvEvidence } from "./hrv.js";

export const HRV_REPEAT_WINDOW_MS = 90 * 60_000;

export function hrvSleepReviews(store: TaskStore, task: ActiveTask) {
  return store.all().filter(review => review.status !== "cancelled" && review.skill === "health"
    && review.userId === task.userId && review.principalId === task.principalId
    && review.trigger.type === "health_change" && review.trigger.oncePerDay && review.trigger.metrics?.includes("sleep_analysis"));
}

/** A configured sleep review owns the morning backlog. Only its confirmed delivery releases new samples. */
export function hrvSleepGate(store: TaskStore, task: ActiveTask, now: number) {
  const current = localTaskTime(now, task.trigger.type === "health_change" ? task.trigger.timezone : undefined);
  const reviews = hrvSleepReviews(store, task);
  if (!reviews.length) return { open: true };
  // Do not replay a previous day's held arrivals when the late-night policy opens again.
  if (current.time < "04:00") return { open: true, receiptDay: current.day };
  const completed = reviews.map(review => store.deliveredHealthReviewAt(review.id, current.day,
    task.trigger.type === "health_change" ? task.trigger.timezone : undefined));
  if (completed.some(at => at === undefined)) return { open: false };
  return { open: true, notBefore: Math.max(...completed.filter((at): at is number => at !== undefined)) };
}

export function hrvRunEvidence(run: TaskRun): HrvEvidence | undefined {
  const snapshot = run.result?.dataSnapshot as { hrv?: HrvEvidence } | undefined;
  const payload = run.payload as { snapshot?: { hrv?: HrvEvidence }; data?: { hrv?: HrvEvidence } };
  return snapshot?.hrv ?? payload.snapshot?.hrv ?? payload.data?.hrv;
}

/** Recheck receipt-day/sleep-review and repeat gates at the moment of use. */
export function currentHrvEvidence(store: TaskStore, task: ActiveTask, evidence: HrvEvidence, now = Date.now(), excludeRunId = ""): HrvEvidence {
  const gate = hrvSleepGate(store, task, now);
  const anomalies = evidence.anomalies.filter(signal => gate.open
    && (gate.notBefore === undefined || signal.latestObservedAt >= gate.notBefore)
    && (!gate.receiptDay || signal.period && localTaskTime(signal.period.receivedAt,
      task.trigger.type === "health_change" ? task.trigger.timezone : undefined).day === gate.receiptDay));
  return filterHrvRepeats({ ...evidence, anomalies }, store.recentNotifications(task.id, now - HRV_REPEAT_WINDOW_MS, excludeRunId));
}

const direction = (signal: HrvAnomaly) => signal.ratio < 1 ? "low" : "high";
const severe = (signal: HrvAnomaly) => signal.reasons.some(reason => reason === "severe_low" || reason === "extreme_high");
function repeats(signal: HrvAnomaly, prior: HrvAnomaly): boolean {
  if (signal.stream !== prior.stream || direction(signal) !== direction(prior)) return false;
  // A newly severe reading or another 25% deterioration may interrupt the repeat window.
  if (severe(signal) && !severe(prior)) return false;
  const worse = direction(signal) === "low" ? signal.ratio <= prior.ratio * 0.75 : signal.ratio >= prior.ratio * 1.25;
  return !worse;
}

/** Pending/uncertain deliveries reserve the same episode too. No daily cap or higher detection threshold. */
export function filterHrvRepeats(evidence: HrvEvidence, priorRuns: readonly TaskRun[]): HrvEvidence {
  const prior = [...priorRuns].sort((a, b) => (b.deliveredAt ?? b.endedAt ?? b.triggeredAt) - (a.deliveredAt ?? a.endedAt ?? a.triggeredAt))
    .flatMap(run => [...hrvRunEvidence(run)?.anomalies ?? []].sort((a, b) => b.latestObservedAt - a.latestObservedAt));
  const anomalies = evidence.anomalies.filter(signal => {
    const previous = prior.find(previous => signal.stream === previous.stream);
    return !previous || !repeats(signal, previous);
  });
  return { ...evidence, anomalies, totalAnomalies: (evidence.totalAnomalies ?? evidence.anomalies.length) - evidence.anomalies.length + anomalies.length,
    suppressedRepeats: evidence.anomalies.length - anomalies.length };
}
