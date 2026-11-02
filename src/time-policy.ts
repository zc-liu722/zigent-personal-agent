/** One device-clock policy for ingress, evidence reads and automatic tasks.
 * Preserve reported timestamps; never move wall-clock schedules or receipt-day gates.
 * A small future offset is usable evidence, not extra time before expiry.
 */
export const DEVICE_CLOCK_SKEW_MS = 60_000;

export function timestampIsFresh(at: unknown, now: number, maxAgeMs: number, futureToleranceMs = 0): at is number {
  return typeof at === "number" && Number.isFinite(at) && at >= 0 && Number.isFinite(now)
    && maxAgeMs >= 0 && futureToleranceMs >= 0
    && at <= now + futureToleranceMs && now - at <= maxAgeMs;
}

export function deviceTimeIsUsable(at: unknown, now: number, maxAgeMs = Infinity): at is number {
  return timestampIsFresh(at, now, maxAgeMs, DEVICE_CLOCK_SKEW_MS);
}

/** Exclusive query end includes exactly the same future boundary as the evaluator. */
export function deviceTimeQueryEnd(now: number): number { return now + DEVICE_CLOCK_SKEW_MS + 1; }
