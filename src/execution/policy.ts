import policy from './policy.json' with { type: 'json' };

/** Versioned defaults, also delivered unchanged to each native worker. */
export const executionPolicy = Object.freeze(policy);
export type ExecutionPolicy = typeof policy;

export function initialYieldTime(requested: number | undefined, windows: boolean) {
  return Math.min(executionPolicy.maxYieldTimeMs, Math.max(windows ? executionPolicy.windowsInitialYieldFloorMs
    : executionPolicy.minYieldTimeMs, requested ?? executionPolicy.initialYieldTimeMs));
}

export function inputYieldTime(requested: number | undefined, empty: boolean) {
  return Math.min(executionPolicy.maxBackgroundTerminalTimeoutMs, Math.max(empty ? executionPolicy.minEmptyYieldTimeMs
    : executionPolicy.minYieldTimeMs, requested ?? (empty ? executionPolicy.minEmptyYieldTimeMs : executionPolicy.minYieldTimeMs)));
}
