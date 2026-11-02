import { createHash } from "node:crypto";

export type HealthObservation = {
  id: string; seq: number; metric: string; stream: string;
  kind: "metric" | "sleep_summary" | "sleep_segment" | "workout" | "note";
  observedAt: number; endAt?: number; receivedAt: number; units?: string; source?: string;
  values: Record<string, unknown>; provenance: "health_auto_export" | "user_report";
};
export type HealthImportMetadata = { automationId: string; aggregation: string; period?: string; automationName?: string };
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_FIELD");
  return value.trim();
}
/** Auto Export emits an empty source for some aggregated metrics. */
function metricSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 256) throw new Error("INVALID_FIELD");
  return value.trim() || undefined;
}
/** Explicit offsets required; date-only summaries use a stable UTC calendar bucket, preserving the original label. */
export function timestamp(value: unknown, now = Date.now(), dateOnly = false): number {
  const raw = text(value, 64);
  const formatted = /^\d{4}-\d{2}-\d{2}$/.test(raw) && dateOnly ? `${raw}T00:00:00Z`
    : raw.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, "$1T$2$3:$4");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(formatted)) throw new Error("INVALID_TIMESTAMP");
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(formatted)!;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) throw new Error("INVALID_TIMESTAMP");
  const result = Date.parse(formatted);
  if (!Number.isFinite(result) || result < Date.UTC(1970, 0, 1) || result > now + 24 * 3600_000) throw new Error("INVALID_TIMESTAMP");
  return result;
}
function validateValues(value: unknown, depth = 0): void {
  if (depth > 12) throw new Error("INVALID_DEPTH");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("INVALID_NUMBER");
  if (typeof value === "string" && value.length > 16_384) throw new Error("INVALID_FIELD");
  if (Array.isArray(value)) value.forEach((item) => validateValues(item, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => validateValues(item, depth + 1));
}
const pointNumericFields = ["qty", "Min", "Avg", "Max", "systolic", "diastolic", "totalSleep", "asleep", "core", "deep", "rem", "inBed", "awake", "Unspecified", "Protection Used", "Protection Not Used"];
const pointDateFields = ["date", "startDate", "endDate", "sleepStart", "sleepEnd", "inBedStart", "inBedEnd"];
/** Only documented measurements enter model-visible rows; originals remain in private batches. */
function measurementValues(point: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of pointNumericFields) if (point[field] !== undefined) {
    if (typeof point[field] !== "number" || !Number.isFinite(point[field])) throw new Error("INVALID_METRIC_VALUE");
    result[field] = point[field];
  }
  for (const field of pointDateFields) if (point[field] !== undefined) result[field] = text(point[field], 64);
  const source = metricSource(point.source);
  if (source !== undefined) result.source = source;
  for (const field of ["value", "mealTime", "reason"]) if (point[field] !== undefined) result[field] = text(point[field], 256);
  return result;
}
function quantity(value: unknown): Record<string, unknown> {
  const field = record(value);
  if (typeof field.qty !== "number" || !Number.isFinite(field.qty)) throw new Error("INVALID_WORKOUT_QUANTITY");
  return { qty: field.qty, units: text(field.units, 64) };
}
function workoutValues(workout: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["id", "name", "start", "end", "location", "source", "strokeStyle", "salinity"]) {
    if (workout[field] !== undefined) result[field] = text(workout[field], 256);
  }
  for (const field of ["duration", "swolfScore"]) if (workout[field] !== undefined) {
    if (typeof workout[field] !== "number" || !Number.isFinite(workout[field])) throw new Error("INVALID_WORKOUT_QUANTITY");
    result[field] = workout[field];
  }
  if (workout.isIndoor !== undefined) {
    if (typeof workout.isIndoor !== "boolean") throw new Error("INVALID_WORKOUT");
    result.isIndoor = workout.isIndoor;
  }
  for (const field of ["activeEnergyBurned", "totalEnergy", "intensity", "distance", "speed", "avgSpeed", "maxSpeed", "elevationUp", "elevationDown", "temperature", "humidity", "lapLength", "totalSwimmingStrokeCount", "swimCadence", "stepCadence", "flightsClimbed", "maxHeartRate", "avgHeartRate"]) {
    if (workout[field] !== undefined) result[field] = quantity(workout[field]);
  }
  if (workout.heartRate !== undefined) {
    const heart = record(workout.heartRate), summary: Record<string, unknown> = {};
    for (const field of ["min", "avg", "max"]) if (heart[field] !== undefined) summary[field] = quantity(heart[field]);
    result.heartRate = summary;
  }
  return result;
}
export function normalizeHealthPayload(payload: unknown, metadata: HealthImportMetadata, now = Date.now()): HealthObservation[] {
  const envelope = record(payload); const data = record(envelope.data);
  if (!Array.isArray(data.metrics) && !Array.isArray(data.workouts)) throw new Error("INVALID_PAYLOAD");
  if (data.metrics !== undefined && !Array.isArray(data.metrics) || data.workouts !== undefined && !Array.isArray(data.workouts)) throw new Error("INVALID_PAYLOAD");
  text(metadata.automationId, 128); text(metadata.aggregation, 64); validateValues(payload);
  const rows: HealthObservation[] = [];
  for (const value of (data.metrics ?? []) as unknown[]) {
    const metric = record(value); const name = text(metric.name, 128); const units = text(metric.units, 64);
    if (!/^[a-z][a-z0-9_&]*$/.test(name) || !Array.isArray(metric.data)) throw new Error("INVALID_METRIC");
    for (const item of metric.data) {
      const point = record(item); const segment = name === "sleep_analysis" && point.startDate !== undefined;
      const kind = name === "sleep_analysis" ? segment ? "sleep_segment" : "sleep_summary" : "metric";
      const observedAt = timestamp(segment ? point.startDate : point.date, now, kind === "sleep_summary");
      const endAt = segment ? timestamp(point.endDate, now) : undefined;
      if (endAt !== undefined && endAt < observedAt) throw new Error("INVALID_INTERVAL");
      const numericFields = kind === "sleep_summary" ? ["totalSleep", "asleep", "core", "deep", "rem", "inBed", "awake"]
        : name === "heart_rate" ? ["qty", "Min", "Avg", "Max"]
        : name === "blood_pressure" ? ["systolic", "diastolic"]
        : name === "sexual_activity" ? ["Unspecified", "Protection Used", "Protection Not Used"] : ["qty"];
      const measured = numericFields.filter((field) => point[field] !== undefined);
      if (!measured.length || measured.some((field) => typeof point[field] !== "number" || !Number.isFinite(point[field]))) throw new Error("INVALID_METRIC_VALUE");
      const source = metricSource(point.source);
      const stream = `${metadata.automationId}/${metadata.aggregation}/${kind}/${source ?? "unspecified"}`;
      // Values never enter the bucket identity: a revised aggregate replaces its prior value.
      const id = hash(canonical([stream, name, point.id ?? observedAt]));
      rows.push({ id, seq: 0, metric: name, stream, kind, units, source, observedAt, endAt, receivedAt: now, values: measurementValues(point), provenance: "health_auto_export" });
    }
  }
  for (const value of (data.workouts ?? []) as unknown[]) {
    const workout = record(value); const workoutId = text(workout.id, 256); text(workout.name);
    const observedAt = timestamp(workout.start, now), endAt = timestamp(workout.end, now);
    if (endAt < observedAt || typeof workout.duration !== "number" || !Number.isFinite(workout.duration) || workout.duration < 0) throw new Error("INVALID_WORKOUT");
    const stream = `${metadata.automationId}/${metadata.aggregation}/workout`;
    // Routes and nested series remain in the private original batch; tool output excludes them by default.
    const summary = workoutValues(workout);
    rows.push({ id: hash(canonical([stream, "workout", workoutId])), seq: 0, metric: "workout", stream, kind: "workout", observedAt, endAt, receivedAt: now, values: summary, provenance: "health_auto_export" });
  }
  if (rows.some((row) => Buffer.byteLength(JSON.stringify(row.values)) > 8192)) throw new Error("INVALID_OBSERVATION_SIZE");
  if (rows.length > 50_000) throw new Error("INVALID_ITEM_LIMIT");
  return rows;
}
