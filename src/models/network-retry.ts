import type { ModelFailureKind } from "./errors.js";

/** Failures recoverable by reconnecting without changing credentials or input. */
export function isNetworkFailure(kind: ModelFailureKind): boolean {
  return ["connection-error", "transport-timeout", "first-progress-timeout", "stream-idle-timeout",
    "http-timeout", "service-unavailable", "invalid-response"].includes(kind);
}

export function networkRetryDelay(baseMs: number, retry: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, retry - 1), 16_000);
}
