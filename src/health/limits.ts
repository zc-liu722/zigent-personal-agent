/** Unaggregated daily exports can exceed 4 MiB even after selecting metrics. */
export const MAX_HEALTH_BODY_BYTES = 32 * 1024 * 1024;

/** A day of unaggregated metrics can exceed the former 50,000-sample cap. */
export const MAX_HEALTH_OBSERVATIONS_PER_BATCH = 250_000;

export class HealthItemLimitError extends Error {
  constructor(readonly itemCount: number) { super("INVALID_ITEM_LIMIT"); }
}
