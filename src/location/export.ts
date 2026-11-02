import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LocationExportOptions = {
  database: string;
  output: string;
  from?: string | number | Date;
  to?: string | number | Date;
  minutes?: number;
  includeRaw?: boolean;
  now?: number;
};

type Row = Record<string, unknown>;

function timestamp(value: string | number | Date | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an ISO timestamp or epoch milliseconds`);
  return parsed;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function exportLocations(options: LocationExportOptions): Promise<void> {
  const now = options.now ?? Date.now();
  const minutes = options.minutes ?? 60;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43_200) {
    throw new Error("Location export lookback must be an integer from 1 to 43200 minutes");
  }
  const to = timestamp(options.to, now, "to");
  const from = timestamp(options.from, to - minutes * 60_000, "from");
  if (from > to) throw new Error("Location export from timestamp must not be later than to timestamp");

  const database = new DatabaseSync(resolve(options.database), { readOnly: true });
  database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
  try {
    const points = database.prepare(`
      SELECT id, payload_type, wgs84_latitude, wgs84_longitude,
        gcj02_latitude, gcj02_longitude, horizontal_accuracy_meters,
        altitude_meters, vertical_accuracy_meters, battery_percent,
        velocity_kph, course_degrees, trigger_code, event_type,
        region_id, region_description, in_regions_json, in_region_ids_json,
        observed_at_ms, received_at_ms, source_payload_json, geocode_id
      FROM location_points
      WHERE received_at_ms BETWEEN ? AND ?
      ORDER BY received_at_ms, id
    `).all(from, to) as Row[];
    const regions = database.prepare(`
      SELECT region_id, description, wgs84_latitude, wgs84_longitude,
        radius_meters, waypoint_created_at_ms, waypoint_received_at_ms,
        waypoint_payload_json, active, last_event, state_observed_at_ms, state_received_at_ms
      FROM location_regions
      ORDER BY description, region_id
    `).all() as Row[];
    const regionEvents = database.prepare(`
      SELECT id, region_id, region_description, event_type, trigger_code,
        observed_at_ms, received_at_ms, source_payload_json
      FROM location_region_events
      WHERE received_at_ms BETWEEN ? AND ?
      ORDER BY received_at_ms, id
    `).all(from, to) as Row[];

    const report = {
      schemaVersion: 1,
      exportedAt: new Date(now).toISOString(),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      warning: "This file contains private location history. Keep it encrypted and delete it after diagnosis.",
      points: points.map((row) => ({
        id: row.id,
        payloadType: row.payload_type,
        coordinates: {
          wgs84: { latitude: row.wgs84_latitude, longitude: row.wgs84_longitude },
          gcj02: { latitude: row.gcj02_latitude, longitude: row.gcj02_longitude }
        },
        accuracyMeters: row.horizontal_accuracy_meters,
        altitudeMeters: row.altitude_meters,
        verticalAccuracyMeters: row.vertical_accuracy_meters,
        batteryPercent: row.battery_percent,
        velocityKph: row.velocity_kph,
        courseDegrees: row.course_degrees,
        trigger: row.trigger_code,
        event: row.event_type,
        regionId: row.region_id,
        regionDescription: row.region_description,
        inRegions: parseJson(row.in_regions_json),
        inRegionIds: parseJson(row.in_region_ids_json),
        observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
        receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
        receiveDelayMs: Number(row.received_at_ms) - Number(row.observed_at_ms),
        geocodeId: row.geocode_id,
        ...(options.includeRaw ? { rawPayload: parseJson(row.source_payload_json) } : {})
      })),
      regionEvents: regionEvents.map((row) => ({
        id: row.id,
        regionId: row.region_id,
        regionDescription: row.region_description,
        event: row.event_type,
        trigger: row.trigger_code,
        observedAt: new Date(Number(row.observed_at_ms)).toISOString(),
        receivedAt: new Date(Number(row.received_at_ms)).toISOString(),
        receiveDelayMs: Number(row.received_at_ms) - Number(row.observed_at_ms),
        coordinatesPresent: false,
        ...(options.includeRaw ? { rawPayload: parseJson(row.source_payload_json) } : {})
      })),
      regions: regions.map((row) => ({
        regionId: row.region_id,
        description: row.description,
        coordinates: row.wgs84_latitude === null || row.wgs84_latitude === undefined
          ? undefined
          : { wgs84: { latitude: row.wgs84_latitude, longitude: row.wgs84_longitude } },
        radiusMeters: row.radius_meters,
        waypointCreatedAt: row.waypoint_created_at_ms === null || row.waypoint_created_at_ms === undefined
          ? undefined : new Date(Number(row.waypoint_created_at_ms)).toISOString(),
        waypointReceivedAt: row.waypoint_received_at_ms === null || row.waypoint_received_at_ms === undefined
          ? undefined : new Date(Number(row.waypoint_received_at_ms)).toISOString(),
        ...(options.includeRaw ? { rawWaypointPayload: parseJson(row.waypoint_payload_json) } : {}),
        active: row.active === 1,
        lastEvent: row.last_event,
        stateObservedAt: row.state_observed_at_ms === null || row.state_observed_at_ms === undefined
          ? undefined : new Date(Number(row.state_observed_at_ms)).toISOString(),
        stateReceivedAt: row.state_received_at_ms === null || row.state_received_at_ms === undefined
          ? undefined : new Date(Number(row.state_received_at_ms)).toISOString()
      }))
    };

    const output = resolve(options.output);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2), { encoding: "utf8", mode: 0o600 });
  } finally {
    database.close();
  }
}
