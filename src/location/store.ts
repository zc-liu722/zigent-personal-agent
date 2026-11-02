import { prepareSql, closeSqlite } from "../sqlite.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { distanceMeters, wgs84ToGcj02 } from "./coordinates.js";

export type StoredLocation = {
  payloadType: "location" | "transition";
  wgs84Latitude: number;
  wgs84Longitude: number;
  gcj02Latitude: number;
  gcj02Longitude: number;
  accuracyMeters?: number;
  altitudeMeters?: number;
  verticalAccuracyMeters?: number;
  batteryPercent?: number;
  velocityKph?: number;
  courseDegrees?: number;
  triggerCode?: string;
  eventType?: "enter" | "leave";
  regionId?: string;
  regionDescription?: string;
  waypointCreatedAt?: number;
  inRegions?: readonly string[];
  inRegionIds?: readonly string[];
  observedAt: number;
  receivedAt: number;
  geocodeId?: number;
};

export const MAX_LOCATION_HISTORY_WINDOW_MS = 31 * 24 * 60 * 60_000;
export type LocationHistoryQuery = { from: number; to: number; limit: number; cursor?: string };
export type LocationHistoryPage = {
  points: Array<StoredLocation & { id: number }>;
  hasMore: boolean;
  nextCursor?: string;
};

export type StoredWaypoint = {
  regionId?: string;
  description: string;
  wgs84Latitude?: number;
  wgs84Longitude?: number;
  radiusMeters?: number;
  createdAt?: number;
  receivedAt: number;
};

export type StoredRegion = {
  regionId?: string;
  description?: string;
  active: boolean;
  lastEvent?: "enter" | "leave";
  stateObservedAt?: number;
  stateReceivedAt?: number;
};

export type StoredRegionEvent = {
  velocityKph?: number;
  regionId?: string;
  regionDescription?: string;
  waypointCreatedAt?: number;
  eventType: "enter" | "leave";
  triggerCode?: string;
  observedAt: number;
  receivedAt: number;
};

export type StoredGeocode = {
  id: number;
  provider: "amap";
  queryLatitude: number;
  queryLongitude: number;
  queryRadiusMeters: number;
  formattedAddress?: string;
  country?: string;
  province?: string;
  city?: string;
  district?: string;
  township?: string;
  adcode?: string;
  citycode?: string;
  street?: string;
  streetNumber?: string;
  pois: readonly Record<string, unknown>[];
  aois: readonly Record<string, unknown>[];
  fetchedAt: number;
  reuseUntil: number;
  responseVersion: number;
};

type LocationRow = {
  id: number;
  payload_type: "location" | "transition";
  wgs84_latitude: number;
  wgs84_longitude: number;
  gcj02_latitude: number;
  gcj02_longitude: number;
  horizontal_accuracy_meters: number | null;
  altitude_meters: number | null;
  vertical_accuracy_meters: number | null;
  battery_percent: number | null;
  velocity_kph: number | null;
  course_degrees: number | null;
  trigger_code: string | null;
  event_type: "enter" | "leave" | null;
  region_id: string | null;
  region_description: string | null;
  waypoint_created_at_ms: number | null;
  in_regions_json: string | null;
  in_region_ids_json: string | null;
  observed_at_ms: number;
  received_at_ms: number;
  source_payload_json: string | null;
  geocode_id: number | null;
};

type RegionRow = {
  region_key: string;
  region_id: string | null;
  description: string | null;
  active: number;
  last_event: "enter" | "leave" | null;
  state_observed_at_ms: number | null;
  state_received_at_ms: number | null;
};

type GeocodeRow = {
  id: number;
  provider: "amap";
  query_gcj02_latitude: number;
  query_gcj02_longitude: number;
  query_radius_meters: number;
  formatted_address: string | null;
  country: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  township: string | null;
  adcode: string | null;
  citycode: string | null;
  street: string | null;
  street_number: string | null;
  pois_json: string;
  aois_json: string;
  fetched_at_ms: number;
  reuse_until_ms: number;
  response_version: number;
};

type LegacyLocationRow = {
  record_key?: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
  altitude_meters: number | null;
  battery_percent: number | null;
  velocity_kph: number | null;
  course_degrees: number | null;
  trigger: string | null;
  event: string | null;
  observed_at: number;
  received_at: number;
  payload_json?: string | null;
};

function stringArray(value: string | null): readonly string[] | undefined {
  try {
    const parsed = value === null ? undefined : JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function rowLocation(row: LocationRow): StoredLocation & { id: number } {
  const inRegions = stringArray(row.in_regions_json);
  const inRegionIds = stringArray(row.in_region_ids_json);
  return {
    id: row.id,
    payloadType: row.payload_type,
    wgs84Latitude: row.wgs84_latitude,
    wgs84Longitude: row.wgs84_longitude,
    gcj02Latitude: row.gcj02_latitude,
    gcj02Longitude: row.gcj02_longitude,
    ...(row.horizontal_accuracy_meters === null ? {} : { accuracyMeters: row.horizontal_accuracy_meters }),
    ...(row.altitude_meters === null ? {} : { altitudeMeters: row.altitude_meters }),
    ...(row.vertical_accuracy_meters === null ? {} : { verticalAccuracyMeters: row.vertical_accuracy_meters }),
    ...(row.battery_percent === null ? {} : { batteryPercent: row.battery_percent }),
    ...(row.velocity_kph === null ? {} : { velocityKph: row.velocity_kph }),
    ...(row.course_degrees === null ? {} : { courseDegrees: row.course_degrees }),
    ...(row.trigger_code === null ? {} : { triggerCode: row.trigger_code }),
    ...(row.event_type === null ? {} : { eventType: row.event_type }),
    ...(row.region_id === null ? {} : { regionId: row.region_id }),
    ...(row.region_description === null ? {} : { regionDescription: row.region_description }),
    ...(row.waypoint_created_at_ms == null ? {} : { waypointCreatedAt: row.waypoint_created_at_ms }),
    ...(inRegions === undefined ? {} : { inRegions }),
    ...(inRegionIds === undefined ? {} : { inRegionIds }),
    observedAt: row.observed_at_ms,
    receivedAt: row.received_at_ms,
    ...(row.geocode_id === null ? {} : { geocodeId: row.geocode_id })
  };
}

function rowGeocode(row: GeocodeRow): StoredGeocode {
  const objects = (value: string): readonly Record<string, unknown>[] => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    provider: row.provider,
    queryLatitude: row.query_gcj02_latitude,
    queryLongitude: row.query_gcj02_longitude,
    queryRadiusMeters: row.query_radius_meters,
    ...(row.formatted_address === null ? {} : { formattedAddress: row.formatted_address }),
    ...(row.country === null ? {} : { country: row.country }),
    ...(row.province === null ? {} : { province: row.province }),
    ...(row.city === null ? {} : { city: row.city }),
    ...(row.district === null ? {} : { district: row.district }),
    ...(row.township === null ? {} : { township: row.township }),
    ...(row.adcode === null ? {} : { adcode: row.adcode }),
    ...(row.citycode === null ? {} : { citycode: row.citycode }),
    ...(row.street === null ? {} : { street: row.street }),
    ...(row.street_number === null ? {} : { streetNumber: row.street_number }),
    pois: objects(row.pois_json),
    aois: objects(row.aois_json),
    fetchedAt: row.fetched_at_ms,
    reuseUntil: row.reuse_until_ms,
    responseVersion: row.response_version
  };
}

export class UserLocationStore {
  private constructor(private readonly database: DatabaseSync) {}

  static async open(path: string): Promise<UserLocationStore> {
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const store = new UserLocationStore(database);
    store.initialize();
    return store;
  }

  static openReadOnly(path: string): UserLocationStore {
    const database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    return new UserLocationStore(database);
  }

  private initialize(): void {
    const schemaVersion = Number((prepareSql(this.database, "PRAGMA user_version").get() as { user_version: number }).user_version);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS location_owner (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          user_id TEXT NOT NULL,
          claimed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS location_geocodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          provider TEXT NOT NULL CHECK (provider = 'amap'),
          query_gcj02_latitude REAL NOT NULL,
          query_gcj02_longitude REAL NOT NULL,
          query_radius_meters INTEGER NOT NULL,
          formatted_address TEXT,
          country TEXT,
          province TEXT,
          city TEXT,
          district TEXT,
          township TEXT,
          adcode TEXT,
          citycode TEXT,
          street TEXT,
          street_number TEXT,
          pois_json TEXT NOT NULL DEFAULT '[]',
          aois_json TEXT NOT NULL DEFAULT '[]',
          fetched_at_ms INTEGER NOT NULL,
          reuse_until_ms INTEGER NOT NULL,
          response_version INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_location_geocodes_lookup
          ON location_geocodes (query_gcj02_latitude, query_gcj02_longitude, reuse_until_ms);
        CREATE TABLE IF NOT EXISTS location_regions (
          region_key TEXT PRIMARY KEY,
          region_id TEXT,
          description TEXT,
          wgs84_latitude REAL,
          wgs84_longitude REAL,
          radius_meters REAL,
          waypoint_created_at_ms INTEGER,
          waypoint_received_at_ms INTEGER,
          waypoint_payload_json TEXT,
          active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
          last_event TEXT CHECK (last_event IS NULL OR last_event IN ('enter', 'leave')),
          state_observed_at_ms INTEGER,
          state_received_at_ms INTEGER
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_location_regions_id
          ON location_regions (region_id) WHERE region_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS location_region_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_key TEXT NOT NULL UNIQUE,
          region_id TEXT,
          region_description TEXT,
          waypoint_created_at_ms INTEGER,
          event_type TEXT NOT NULL CHECK (event_type IN ('enter', 'leave')),
          trigger_code TEXT,
          velocity_kph REAL,
          observed_at_ms INTEGER NOT NULL,
          received_at_ms INTEGER NOT NULL,
          source_payload_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_location_region_events_received
          ON location_region_events (received_at_ms DESC);
        CREATE TABLE IF NOT EXISTS location_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_key TEXT NOT NULL UNIQUE,
          payload_type TEXT NOT NULL CHECK (payload_type IN ('location', 'transition')),
          wgs84_latitude REAL NOT NULL,
          wgs84_longitude REAL NOT NULL,
          gcj02_latitude REAL NOT NULL,
          gcj02_longitude REAL NOT NULL,
          horizontal_accuracy_meters REAL,
          altitude_meters REAL,
          vertical_accuracy_meters REAL,
          battery_percent REAL,
          velocity_kph REAL,
          course_degrees REAL,
          trigger_code TEXT,
          event_type TEXT CHECK (event_type IS NULL OR event_type IN ('enter', 'leave')),
          region_id TEXT,
          region_description TEXT,
          waypoint_created_at_ms INTEGER,
          in_regions_json TEXT,
          in_region_ids_json TEXT,
          observed_at_ms INTEGER NOT NULL,
          received_at_ms INTEGER NOT NULL,
          source_payload_json TEXT,
          geocode_id INTEGER REFERENCES location_geocodes(id)
        );
        CREATE INDEX IF NOT EXISTS idx_location_points_latest
          ON location_points (observed_at_ms DESC, received_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_location_points_received
          ON location_points (received_at_ms DESC);
        CREATE INDEX IF NOT EXISTS idx_location_points_history
          ON location_points (observed_at_ms, id);
      `);
      const locationColumns = new Set((prepareSql(this.database, "PRAGMA table_info(location_points)").all() as Array<{ name: string }>).map((column) => column.name));
      if (!locationColumns.has("in_region_ids_json")) {
        this.database.exec("ALTER TABLE location_points ADD COLUMN in_region_ids_json TEXT");
      }
      for (const table of ["location_points", "location_region_events"]) {
        const columns = prepareSql(this.database, `PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!columns.some(column => column.name === "waypoint_created_at_ms"))
          this.database.exec(`ALTER TABLE ${table} ADD COLUMN waypoint_created_at_ms INTEGER`);
      }
      const eventColumns = prepareSql(this.database, "PRAGMA table_info(location_region_events)").all() as Array<{ name: string }>;
      if (!eventColumns.some(column => column.name === "velocity_kph"))
        this.database.exec("ALTER TABLE location_region_events ADD COLUMN velocity_kph REAL");
      this.migrateLegacy("location_history");
      this.migrateLegacy("latest_location");
      this.database.exec("DROP TABLE IF EXISTS latest_location; DROP TABLE IF EXISTS location_history;");
      if (schemaVersion < 3) this.rebuildRegionState();
      this.database.exec("PRAGMA user_version = 3; COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private rebuildRegionState(): void {
    const rows = prepareSql(this.database, `
      SELECT * FROM location_points
      ORDER BY observed_at_ms, received_at_ms, id
    `).all() as unknown as LocationRow[];
    for (const row of rows) {
      if (row.in_region_ids_json === null && row.source_payload_json) {
        try {
          const payload = JSON.parse(row.source_payload_json) as Record<string, unknown>;
          if (Array.isArray(payload.inrids)) {
            const ids = payload.inrids.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
              .map((item) => item.trim().slice(0, 128));
            prepareSql(this.database, "UPDATE location_points SET in_region_ids_json = ? WHERE id = ?")
              .run(JSON.stringify(ids), row.id);
            row.in_region_ids_json = JSON.stringify(ids);
          }
        } catch {
          // Retain the point even when an old raw payload cannot be reparsed.
        }
      }
      this.applyRegionState(rowLocation(row));
    }
  }

  private migrateLegacy(table: "location_history" | "latest_location"): void {
    const exists = prepareSql(this.database, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return;
    const rows = prepareSql(this.database, `SELECT * FROM ${table}`).all() as unknown as LegacyLocationRow[];
    for (const row of rows) {
      if (table === "latest_location") {
        const alreadyMigrated = prepareSql(this.database, `
          SELECT 1 FROM location_points
          WHERE wgs84_latitude = ? AND wgs84_longitude = ? AND observed_at_ms = ?
          LIMIT 1
        `).get(row.latitude, row.longitude, row.observed_at);
        if (alreadyMigrated) continue;
      }
      const gcj02 = wgs84ToGcj02(row.latitude, row.longitude);
      const eventType = row.event === "enter" || row.event === "leave" ? row.event : undefined;
      const key = row.record_key ?? createHash("sha256").update(JSON.stringify([
        row.latitude, row.longitude, row.observed_at, row.payload_json ?? null
      ])).digest("hex");
      this.insertPoint({
        payloadType: eventType ? "transition" : "location",
        wgs84Latitude: row.latitude,
        wgs84Longitude: row.longitude,
        gcj02Latitude: gcj02.latitude,
        gcj02Longitude: gcj02.longitude,
        ...(row.accuracy_meters === null ? {} : { accuracyMeters: row.accuracy_meters }),
        ...(row.altitude_meters === null ? {} : { altitudeMeters: row.altitude_meters }),
        ...(row.battery_percent === null ? {} : { batteryPercent: row.battery_percent }),
        ...(row.velocity_kph === null ? {} : { velocityKph: row.velocity_kph }),
        ...(row.course_degrees === null ? {} : { courseDegrees: row.course_degrees }),
        ...(row.trigger === null ? {} : { triggerCode: ({
          p: "background_ping", c: "circular_region", C: "follow_region",
          b: "beacon_region", r: "remote_request", u: "manual", t: "timer",
          v: "frequent_locations", l: "location_update"
        } as Record<string, string>)[row.trigger] ?? `unknown:${row.trigger}` }),
        ...(eventType ? { eventType } : {}),
        observedAt: row.observed_at,
        receivedAt: row.received_at
      }, row.payload_json ?? undefined, key);
    }
  }

  private existingRegionKey(regionId?: string, description?: string): string | undefined {
    if (regionId) {
      const row = prepareSql(this.database, "SELECT region_key FROM location_regions WHERE region_id = ? LIMIT 1").get(regionId) as { region_key: string } | undefined;
      if (row) return row.region_key;
    }
    if (description) {
      const row = prepareSql(this.database, `SELECT region_key FROM location_regions WHERE description = ? ${regionId ? "AND region_id IS NULL" : ""} LIMIT 1`).get(description) as { region_key: string } | undefined;
      if (row) return row.region_key;
    }
    return undefined;
  }

  private regionKey(regionId?: string, description?: string): string {
    const existing = this.existingRegionKey(regionId, description);
    if (existing) return existing;
    if (regionId) return `rid:${regionId}`;
    if (description) return `desc:${createHash("sha256").update(description).digest("hex").slice(0, 24)}`;
    throw new Error("Region identity is missing");
  }

  saveWaypoint(waypoint: StoredWaypoint, payloadJson?: string): void {
    const key = this.regionKey(waypoint.regionId, waypoint.description);
    prepareSql(this.database, `
      INSERT INTO location_regions (
        region_key, region_id, description, wgs84_latitude, wgs84_longitude,
        radius_meters, waypoint_created_at_ms, waypoint_received_at_ms, waypoint_payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_key) DO UPDATE SET
        region_id = COALESCE(excluded.region_id, location_regions.region_id),
        description = excluded.description,
        wgs84_latitude = COALESCE(excluded.wgs84_latitude, location_regions.wgs84_latitude),
        wgs84_longitude = COALESCE(excluded.wgs84_longitude, location_regions.wgs84_longitude),
        radius_meters = COALESCE(excluded.radius_meters, location_regions.radius_meters),
        waypoint_created_at_ms = COALESCE(excluded.waypoint_created_at_ms, location_regions.waypoint_created_at_ms),
        waypoint_received_at_ms = excluded.waypoint_received_at_ms,
        waypoint_payload_json = COALESCE(excluded.waypoint_payload_json, location_regions.waypoint_payload_json)
    `).run(
      key,
      waypoint.regionId ?? null,
      waypoint.description,
      waypoint.wgs84Latitude ?? null,
      waypoint.wgs84Longitude ?? null,
      waypoint.radiusMeters ?? null,
      waypoint.createdAt ?? null,
      waypoint.receivedAt,
      payloadJson ?? null
    );
  }

  saveWaypoints(waypoints: StoredWaypoint[], payloads: string[]): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      waypoints.forEach((waypoint, index) => this.saveWaypoint(waypoint, payloads[index]));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Resolve the official wtst -> waypoint.tst link only when it is unambiguous. */
  resolveRegion<T extends { regionId?: string; regionDescription?: string; waypointCreatedAt?: number }>(event: T): T {
    const rows = event.regionId
      ? prepareSql(this.database, "SELECT region_id, description FROM location_regions WHERE region_id=?").all(event.regionId)
      : event.waypointCreatedAt !== undefined
        ? prepareSql(this.database, "SELECT region_id, description FROM location_regions WHERE waypoint_created_at_ms=? LIMIT 2").all(event.waypointCreatedAt)
        : [];
    if (rows.length !== 1) return event;
    const row = rows[0] as { region_id: string | null; description: string | null };
    return { ...event, ...(!event.regionId && row.region_id ? { regionId: row.region_id } : {}),
      ...(!event.regionDescription && row.description ? { regionDescription: row.description } : {}) };
  }

  /** Includes inactive/unknown regions so an Agent can configure the next arrival. */
  knownRegions(limit = 100): { regions: Array<StoredRegion & { center?: { system: "GCJ-02"; latitude: number; longitude: number }; radiusMeters?: number }>; hasMore: boolean } {
    const rows = prepareSql(this.database, "SELECT * FROM location_regions ORDER BY description, region_id, region_key LIMIT ?")
      .all(limit + 1) as Array<RegionRow & { wgs84_latitude: number | null; wgs84_longitude: number | null; radius_meters: number | null }>;
    return { hasMore: rows.length > limit, regions: rows.slice(0, limit).map(row => ({
      ...(row.region_id ? { regionId: row.region_id } : {}), ...(row.description ? { description: row.description } : {}),
      active: Boolean(row.active),
      ...(row.state_observed_at_ms === null ? {} : { stateObservedAt: row.state_observed_at_ms }),
      ...(row.wgs84_latitude === null || row.wgs84_longitude === null ? {} : {
        center: { system: "GCJ-02" as const, ...wgs84ToGcj02(row.wgs84_latitude, row.wgs84_longitude) }
      }), ...(row.radius_meters === null ? {} : { radiusMeters: row.radius_meters })
    })) };
  }

  private upsertRegionState(
    regionId: string | undefined,
    description: string | undefined,
    active: boolean,
    event: "enter" | "leave" | undefined,
    observedAt: number,
    receivedAt: number
  ): void {
    if (!regionId && !description) return;
    const key = this.regionKey(regionId, description);
    prepareSql(this.database, `
      INSERT INTO location_regions (
        region_key, region_id, description, active, last_event, state_observed_at_ms, state_received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(region_key) DO UPDATE SET
        region_id = COALESCE(excluded.region_id, location_regions.region_id),
        description = COALESCE(excluded.description, location_regions.description),
        active = CASE
          WHEN location_regions.state_observed_at_ms IS NULL OR excluded.state_observed_at_ms >= location_regions.state_observed_at_ms
            THEN excluded.active ELSE location_regions.active END,
        last_event = CASE
          WHEN location_regions.state_observed_at_ms IS NULL OR excluded.state_observed_at_ms >= location_regions.state_observed_at_ms
            THEN excluded.last_event ELSE location_regions.last_event END,
        state_observed_at_ms = MAX(COALESCE(location_regions.state_observed_at_ms, excluded.state_observed_at_ms), excluded.state_observed_at_ms),
        state_received_at_ms = CASE
          WHEN location_regions.state_observed_at_ms IS NULL OR excluded.state_observed_at_ms >= location_regions.state_observed_at_ms
            THEN excluded.state_received_at_ms ELSE location_regions.state_received_at_ms END
    `).run(key, regionId ?? null, description ?? null, active ? 1 : 0, event ?? null, observedAt, receivedAt);
  }

  private applyRegionState(location: StoredLocation): void {
    if (location.payloadType === "transition" && location.eventType) {
      this.upsertRegionState(
        location.regionId,
        location.regionDescription,
        location.eventType === "enter",
        location.eventType,
        location.observedAt,
        location.receivedAt
      );
      return;
    }
    const hasSnapshot = location.inRegions !== undefined || location.inRegionIds !== undefined;
    if (!hasSnapshot) return;
    prepareSql(this.database, `
      UPDATE location_regions SET active = 0, last_event = NULL,
        state_observed_at_ms = ?, state_received_at_ms = ?
      WHERE active = 1 AND (state_observed_at_ms IS NULL OR state_observed_at_ms <= ?)
    `).run(location.observedAt, location.receivedAt, location.observedAt);
    const descriptions = location.inRegions ?? [];
    const ids = location.inRegionIds ?? [];
    const paired = descriptions.length === ids.length;
    const length = Math.max(descriptions.length, ids.length);
    for (let index = 0; index < length; index += 1) {
      this.upsertRegionState(
        paired ? ids[index] : undefined,
        paired ? descriptions[index] : descriptions[index],
        true,
        undefined,
        location.observedAt,
        location.receivedAt
      );
    }
    if (!paired) {
      for (const regionId of ids) {
        this.upsertRegionState(regionId, undefined, true, undefined, location.observedAt, location.receivedAt);
      }
    }
  }

  /** Bounded transition feed for authorized background tasks; never returns coordinates. */
  regionTaskEvents(source: "points" | "events", afterId: number, limit = 200): {
    events: Array<{ id: string; event: "enter" | "leave"; regionId?: string; regionName?: string; occurredAt: number; velocityKph?: number }>;
    nextCursor: number; highWater: number;
  } {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Invalid location task cursor");
    }
    const table = source === "points" ? "location_points" : "location_region_events";
    const highWater = Number((prepareSql(this.database, `SELECT COALESCE(MAX(id),0) AS n FROM ${table}`).get() as { n: number }).n);
    const rows = prepareSql(this.database, `SELECT id,record_key,event_type,region_id,region_description,waypoint_created_at_ms,observed_at_ms,velocity_kph FROM ${table}
      WHERE id > ? AND event_type IN ('enter','leave') ORDER BY id LIMIT ?`).all(afterId, limit + 1) as unknown as Array<{
        id: number; record_key: string; event_type: "enter" | "leave"; region_id: string | null; region_description: string | null; waypoint_created_at_ms: number | null; observed_at_ms: number; velocity_kph: number | null;
      }>;
    const selected = rows.slice(0, limit);
    return {
      events: selected.map((row) => {
        const region = this.resolveRegion({ regionId: row.region_id ?? undefined, regionDescription: row.region_description ?? undefined,
          waypointCreatedAt: row.waypoint_created_at_ms ?? undefined });
        return { id: `${source}:${row.record_key}`, event: row.event_type,
          ...(row.velocity_kph === null ? {} : { velocityKph: row.velocity_kph }),
          ...(region.regionId ? { regionId: region.regionId } : {}), ...(region.regionDescription ? { regionName: region.regionDescription } : {}), occurredAt: row.observed_at_ms };
      }),
      nextCursor: rows.length > limit ? selected.at(-1)!.id : highWater, highWater
    };
  }

  activeRegions(): readonly StoredRegion[] {
    const rows = prepareSql(this.database, `
      SELECT region_key, region_id, description, active, last_event, state_observed_at_ms, state_received_at_ms
      FROM location_regions WHERE active = 1 ORDER BY description, region_id
    `).all() as unknown as RegionRow[];
    return rows.map((row) => ({
      ...(row.region_id === null ? {} : { regionId: row.region_id }),
      ...(row.description === null ? {} : { description: row.description }),
      active: true,
      ...(row.last_event === null ? {} : { lastEvent: row.last_event }),
      ...(row.state_observed_at_ms === null ? {} : { stateObservedAt: row.state_observed_at_ms }),
      ...(row.state_received_at_ms === null ? {} : { stateReceivedAt: row.state_received_at_ms })
    }));
  }

  saveRegionEvent(event: StoredRegionEvent, payloadJson?: string): "stored" | "duplicate" {
    const recordKey = createHash("sha256").update(JSON.stringify([
      event.regionId ?? null,
      event.regionDescription ?? null,
      event.eventType,
      event.observedAt,
      ...(event.waypointCreatedAt === undefined ? [] : [event.waypointCreatedAt]),
      payloadJson ?? null
    ])).digest("hex");
    event = this.resolveRegion(event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = prepareSql(this.database, `
        INSERT OR IGNORE INTO location_region_events (
          record_key, region_id, region_description, event_type, trigger_code,
          observed_at_ms, received_at_ms, source_payload_json, waypoint_created_at_ms, velocity_kph
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recordKey,
        event.regionId ?? null,
        event.regionDescription ?? null,
        event.eventType,
        event.triggerCode ?? null,
        event.observedAt,
        event.receivedAt,
        payloadJson ?? null,
        event.waypointCreatedAt ?? null,
        event.velocityKph ?? null
      );
      this.upsertRegionState(
        event.regionId,
        event.regionDescription,
        event.eventType === "enter",
        event.eventType,
        event.observedAt,
        event.receivedAt
      );
      this.database.exec("COMMIT");
      return result.changes === 1 ? "stored" : "duplicate";
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  withRegionContext(location: StoredLocation & { id: number }, includeActiveRegions = true): StoredLocation & { id: number } {
    if (location.regionDescription || location.inRegions?.length) return location;
    if (location.regionId) {
      const row = prepareSql(this.database, "SELECT description FROM location_regions WHERE region_id = ? LIMIT 1").get(location.regionId) as { description: string | null } | undefined;
      if (row?.description) return { ...location, regionDescription: row.description };
      return location;
    }
    if (location.inRegions !== undefined || location.inRegionIds !== undefined) {
      const descriptions = location.inRegions ?? [];
      const resolved = (location.inRegionIds ?? []).flatMap((regionId) => {
        const row = prepareSql(this.database, "SELECT description FROM location_regions WHERE region_id = ? LIMIT 1").get(regionId) as { description: string | null } | undefined;
        return row?.description ? [row.description] : [];
      });
      const names = [...new Set([...descriptions, ...resolved])];
      return names.length > 0 ? { ...location, inRegions: names } : location;
    }
    if (!includeActiveRegions) return location;
    const active = this.activeRegions();
    const names = active.flatMap((region) => region.description ? [region.description] : []);
    const ids = active.flatMap((region) => region.regionId ? [region.regionId] : []);
    if (names.length === 0 && ids.length === 0) return location;
    return {
      ...location,
      ...(names.length > 0 ? { inRegions: names } : {}),
      ...(ids.length > 0 ? { inRegionIds: ids } : {})
    };
  }

  claimOwner(userId: string, aliases: readonly string[] = []): "claimed" | "already_claimed" | "owned_by_another_user" {
    const row = prepareSql(this.database, "SELECT user_id FROM location_owner WHERE singleton = 1").get() as { user_id: string } | undefined;
    if (row && (row.user_id === userId || aliases.includes(row.user_id))) {
      if (row.user_id !== userId) prepareSql(this.database, "UPDATE location_owner SET user_id = ?, claimed_at = ? WHERE singleton = 1").run(userId, Date.now());
      return "already_claimed";
    }
    if (row) return "owned_by_another_user";
    const result = prepareSql(this.database, "INSERT OR IGNORE INTO location_owner (singleton, user_id, claimed_at) VALUES (1, ?, ?)").run(userId, Date.now());
    if (result.changes === 1) return "claimed";
    return this.isOwner(userId, aliases) ? "already_claimed" : "owned_by_another_user";
  }

  isOwner(userId: string, aliases: readonly string[] = []): boolean {
    const row = prepareSql(this.database, "SELECT user_id FROM location_owner WHERE singleton = 1").get() as { user_id: string } | undefined;
    return row?.user_id === userId || Boolean(row && aliases.includes(row.user_id));
  }

  revoke(userId: string, aliases: readonly string[] = []): boolean {
    if (!this.isOwner(userId, aliases)) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      prepareSql(this.database, "DELETE FROM location_points").run();
      prepareSql(this.database, "DELETE FROM location_region_events").run();
      prepareSql(this.database, "DELETE FROM location_geocodes").run();
      prepareSql(this.database, "DELETE FROM location_regions").run();
      prepareSql(this.database, "DELETE FROM location_owner WHERE singleton = 1").run();
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertPoint(location: StoredLocation, payloadJson?: string, explicitKey?: string): boolean {
    const recordKey = explicitKey ?? createHash("sha256").update(JSON.stringify([
      location.payloadType,
      location.wgs84Latitude,
      location.wgs84Longitude,
      location.observedAt,
      payloadJson ?? null
    ])).digest("hex");
    const result = prepareSql(this.database, `
      INSERT OR IGNORE INTO location_points (
        record_key, payload_type, wgs84_latitude, wgs84_longitude,
        gcj02_latitude, gcj02_longitude, horizontal_accuracy_meters,
        altitude_meters, vertical_accuracy_meters, battery_percent,
        velocity_kph, course_degrees, trigger_code, event_type,
        region_id, region_description, in_regions_json, in_region_ids_json,
        observed_at_ms, received_at_ms, source_payload_json, geocode_id, waypoint_created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordKey,
      location.payloadType,
      location.wgs84Latitude,
      location.wgs84Longitude,
      location.gcj02Latitude,
      location.gcj02Longitude,
      location.accuracyMeters ?? null,
      location.altitudeMeters ?? null,
      location.verticalAccuracyMeters ?? null,
      location.batteryPercent ?? null,
      location.velocityKph ?? null,
      location.courseDegrees ?? null,
      location.triggerCode ?? null,
      location.eventType ?? null,
      location.regionId ?? null,
      location.regionDescription ?? null,
      location.inRegions === undefined ? null : JSON.stringify(location.inRegions),
      location.inRegionIds === undefined ? null : JSON.stringify(location.inRegionIds),
      location.observedAt,
      location.receivedAt,
      payloadJson ?? null,
      location.geocodeId ?? null,
      location.waypointCreatedAt ?? null
    );
    return result.changes === 1;
  }

  save(location: StoredLocation, payloadJson?: string): "stored" | "duplicate" {
    location = this.resolveRegion(location);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.insertPoint(location, payloadJson);
      this.applyRegionState(location);
      this.database.exec("COMMIT");
      return inserted ? "stored" : "duplicate";
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  historyCount(): number {
    const row = prepareSql(this.database, "SELECT count(*) AS count FROM location_points").get() as { count: number };
    return row.count;
  }

  latest(at = Number.MAX_SAFE_INTEGER): (StoredLocation & { id: number }) | undefined {
    const row = prepareSql(this.database, `
      SELECT * FROM location_points
      WHERE observed_at_ms <= ?
      ORDER BY observed_at_ms DESC, received_at_ms DESC, id DESC
      LIMIT 1
    `).get(at) as LocationRow | undefined;
    return row ? rowLocation(row) : undefined;
  }

  /** Arrival-order feed for geofence evaluation, bounded without loading location history. */
  taskPoints(afterId: number, limit = 200): { points: Array<StoredLocation & { id: number }>; nextCursor: number; highWater: number } {
    const highWater = Number((prepareSql(this.database, "SELECT COALESCE(MAX(id),0) AS n FROM location_points").get() as { n: number }).n);
    const rows = prepareSql(this.database, "SELECT * FROM location_points WHERE id > ? ORDER BY id LIMIT ?")
      .all(afterId, Math.max(1, Math.min(500, limit))) as unknown as LocationRow[];
    return { points: rows.map(rowLocation), nextCursor: rows.at(-1)?.id ?? highWater, highWater };
  }

  historyNewestFirst(): readonly (StoredLocation & { id: number })[] {
    const rows = prepareSql(this.database, `
      SELECT * FROM location_points
      ORDER BY observed_at_ms DESC, received_at_ms DESC, id DESC
    `).all() as unknown as LocationRow[];
    return rows.map(rowLocation);
  }

  /** Snapshot pagination by observation time; no full-history load or live region state. */
  history(query: LocationHistoryQuery): LocationHistoryPage {
    const { from, to, limit, cursor } = query;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from
      || to - from > MAX_LOCATION_HISTORY_WINDOW_MS || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Location history requires from < to, a window of at most 31 days, and limit 1..100");
    }
    let afterTime = from;
    let afterId = 0;
    let highWater: number;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const saved = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!saved || saved.version !== 1 || saved.from !== from || saved.to !== to
          || !Number.isSafeInteger(saved.time) || saved.time < from || saved.time >= to
          || !Number.isSafeInteger(saved.id) || saved.id < 1
          || !Number.isSafeInteger(saved.highWater) || saved.highWater < saved.id) throw new Error();
        afterTime = saved.time;
        afterId = saved.id;
        highWater = saved.highWater;
      } catch {
        throw new Error("Invalid location history cursor; reuse next_cursor with the same from/to window");
      }
    } else {
      highWater = (prepareSql(this.database, "SELECT COALESCE(MAX(id), 0) AS id FROM location_points").get() as { id: number }).id;
    }
    const rows = prepareSql(this.database, `
      SELECT * FROM location_points
      WHERE observed_at_ms >= ? AND observed_at_ms < ? AND id <= ?
        AND (observed_at_ms, id) > (?, ?)
      ORDER BY observed_at_ms, id LIMIT ?
    `).all(from, to, highWater, afterTime, afterId, limit + 1) as unknown as LocationRow[];
    const hasMore = rows.length > limit;
    const points = rows.slice(0, limit).map((row) => this.withRegionContext(rowLocation(row), false));
    const last = points.at(-1);
    return {
      points,
      hasMore,
      ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({
        version: 1, from, to, time: last.observedAt, id: last.id, highWater
      })).toString("base64url") } : {})
    };
  }

  geocodeById(id: number): StoredGeocode | undefined {
    const row = prepareSql(this.database, "SELECT * FROM location_geocodes WHERE id = ?").get(id) as GeocodeRow | undefined;
    return row ? rowGeocode(row) : undefined;
  }

  findReusableGeocode(latitude: number, longitude: number, now: number, maximumDistanceMeters = 30): StoredGeocode | undefined {
    const latitudeDelta = maximumDistanceMeters / 111_320;
    const longitudeScale = Math.max(0.1, Math.cos(latitude * Math.PI / 180));
    const longitudeDelta = maximumDistanceMeters / (111_320 * longitudeScale);
    const rows = prepareSql(this.database, `
      SELECT * FROM location_geocodes
      WHERE reuse_until_ms >= ?
        AND query_gcj02_latitude BETWEEN ? AND ?
        AND query_gcj02_longitude BETWEEN ? AND ?
      ORDER BY fetched_at_ms DESC
    `).all(
      now,
      latitude - latitudeDelta,
      latitude + latitudeDelta,
      longitude - longitudeDelta,
      longitude + longitudeDelta
    ) as unknown as GeocodeRow[];
    return rows
      .map(rowGeocode)
      .map((geocode) => ({ geocode, distance: distanceMeters(
        { latitude, longitude },
        { latitude: geocode.queryLatitude, longitude: geocode.queryLongitude }
      ) }))
      .filter(({ distance }) => distance <= maximumDistanceMeters)
      .sort((first, second) => first.distance - second.distance)[0]?.geocode;
  }

  saveGeocode(geocode: Omit<StoredGeocode, "id">): StoredGeocode {
    const result = prepareSql(this.database, `
      INSERT INTO location_geocodes (
        provider, query_gcj02_latitude, query_gcj02_longitude,
        query_radius_meters, formatted_address, country, province, city,
        district, township, adcode, citycode, street, street_number,
        pois_json, aois_json, fetched_at_ms, reuse_until_ms, response_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      geocode.provider,
      geocode.queryLatitude,
      geocode.queryLongitude,
      geocode.queryRadiusMeters,
      geocode.formattedAddress ?? null,
      geocode.country ?? null,
      geocode.province ?? null,
      geocode.city ?? null,
      geocode.district ?? null,
      geocode.township ?? null,
      geocode.adcode ?? null,
      geocode.citycode ?? null,
      geocode.street ?? null,
      geocode.streetNumber ?? null,
      JSON.stringify(geocode.pois),
      JSON.stringify(geocode.aois),
      geocode.fetchedAt,
      geocode.reuseUntil,
      geocode.responseVersion
    );
    return { ...geocode, id: Number(result.lastInsertRowid) };
  }

  linkGeocode(locationId: number, geocodeId: number): void {
    prepareSql(this.database, "UPDATE location_points SET geocode_id = ? WHERE id = ?").run(geocodeId, locationId);
  }

  close(): void {
    closeSqlite(this.database);
  }
}
