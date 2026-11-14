import { record } from "./normalize.js";

/** Owner-approved 2026-11-05 selection. Shared by the explicitly authorized Deepmind and Xiaochang accounts. */
export const SELECTED_HEALTH_METRICS = [
  "active_energy", "apple_exercise_time", "apple_move_time", "apple_sleeping_wrist_temperature",
  "flights_climbed", "heart_rate", "heart_rate_variability", "blood_oxygen_saturation",
  "breathing_disturbances", "heart_rate_recovery_one_minute", "mindful_minutes",
  "heart_rate_variability_rmssd", "respiratory_rate", "basal_energy", "resting_heart_rate",
  "sleep_analysis", "step_count", "vo2_max"
] as const;
export const HEALTH_RETENTION_VERSION = "selected-18-metrics-2026-11-05";
const selected = new Set<string>(SELECTED_HEALTH_METRICS);
// Transport/UI naming variants for the same approved metrics; never merge their streams.
const aliases: Readonly<Record<string, string>> = {
  active_energy_burned: "active_energy", resting_energy: "basal_energy", basal_energy_burned: "basal_energy",
  cardio_recovery: "heart_rate_recovery_one_minute", recovery_hrv: "heart_rate_variability_rmssd"
};
export const RETAINED_HEALTH_METRIC_NAMES = [...SELECTED_HEALTH_METRICS, ...Object.keys(aliases)];

export function hasHealthRetentionPolicy(agentId: string | undefined): boolean {
  return agentId === "deepmind" || agentId === "xiaochang";
}

export function retainHealthMetric(agentId: string | undefined, metric: string): boolean {
  return !hasHealthRetentionPolicy(agentId) || selected.has(metric) || Object.hasOwn(aliases, metric);
}

/** Filter before normalization AND raw storage. Workouts and selected sample detail survive. */
export function retainedHealthPayload(payload: unknown, agentId: string | undefined): unknown {
  if (!hasHealthRetentionPolicy(agentId)) return payload;
  const envelope = record(payload), data = record(envelope.data);
  if (data.metrics !== undefined && !Array.isArray(data.metrics)) throw new Error("INVALID_PAYLOAD");
  return { ...envelope, data: { ...data,
    ...(Array.isArray(data.metrics) ? { metrics: data.metrics.filter(metric =>
      retainHealthMetric(agentId, String(record(metric).name))) } : {})
  } };
}
