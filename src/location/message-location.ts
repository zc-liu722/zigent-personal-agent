import type { DatabaseSync } from "node:sqlite";
import { distanceMeters } from "./coordinates.js";
import type { StoredLocation } from "./store.js";
import { sqliteTransaction } from "../sqlite.js";

export type MessageLocation = { wgs84Latitude: number; wgs84Longitude: number; velocityKph: number | null };

/** Additive migration; NULL means that observation coverage is not available yet. */
export function initializeMessageLocation(db: DatabaseSync): void {
  sqliteTransaction(db, () => {
    const columns = new Set((db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map(row => row.name));
    for (const column of ["wgs84_latitude", "wgs84_longitude", "velocity_kph"]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} REAL`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS messages_location_time ON messages(created_at,id);
      CREATE INDEX IF NOT EXISTS messages_location_pending ON messages(created_at,id) WHERE wgs84_latitude IS NULL`);
  });
}

function speed(point: StoredLocation): number | undefined {
  return typeof point.velocityKph === "number" && Number.isFinite(point.velocityKph) && point.velocityKph >= 0
    ? point.velocityKph : undefined;
}

function sameRegion(first: StoredLocation, second: StoredLocation): boolean {
  // Use observation-local memberships, never the location store's current active regions.
  const ids = (point: StoredLocation) => new Set([
    ...point.inRegionIds ?? [],
    ...(point.eventType === "enter" && point.regionId ? [point.regionId] : [])
  ]);
  const a = ids(first), b = ids(second);
  if (a.size && b.size) return [...a].some(id => b.has(id));
  // Legacy observations may have names only. Do not match names over conflicting IDs.
  const names = (point: StoredLocation) => new Set([
    ...point.inRegions ?? [],
    ...(point.eventType === "enter" && point.regionDescription ? [point.regionDescription] : [])
  ]);
  const secondNames = names(second);
  return [...names(first)].some(name => name.trim() !== "" && secondNames.has(name));
}

/** Shared by message enrichment and historical point-in-time queries. */
export function locationIntervalIsStationary(older: StoredLocation, newer: StoredLocation): boolean {
  return distanceMeters(
    { latitude: older.wgs84Latitude, longitude: older.wgs84Longitude },
    { latitude: newer.wgs84Latitude, longitude: newer.wgs84Longitude }
  ) < 500 || sameRegion(older, newer);
}

/** Right-closed intervals (older, newer]; exact observations prefer the interval ending there. */
export function interpolateMessageLocation(older: StoredLocation | undefined, newer: StoredLocation, at: number): MessageLocation {
  if (!older) {
    if (at !== newer.observedAt) throw new Error("Message location requires bracketing observations");
    return { wgs84Latitude: newer.wgs84Latitude, wgs84Longitude: newer.wgs84Longitude, velocityKph: speed(newer) ?? null };
  }
  const duration = newer.observedAt - older.observedAt;
  if (duration <= 0 || at <= older.observedAt || at > newer.observedAt) throw new Error("Invalid message location interval");
  const distance = distanceMeters(
    { latitude: older.wgs84Latitude, longitude: older.wgs84Longitude },
    { latitude: newer.wgs84Latitude, longitude: newer.wgs84Longitude }
  );
  if (locationIntervalIsStationary(older, newer)) {
    return { wgs84Latitude: newer.wgs84Latitude, wgs84Longitude: newer.wgs84Longitude, velocityKph: 0 };
  }
  const ratio = (at - older.observedAt) / duration;
  const averageKph = distance / duration * 3600;
  const startSpeed = speed(older) ?? averageKph, endSpeed = speed(newer) ?? averageKph;
  // Follow the shortest longitude interval, including crossings of the date line.
  const deltaLongitude = ((newer.wgs84Longitude - older.wgs84Longitude + 540) % 360) - 180;
  return {
    wgs84Latitude: older.wgs84Latitude + (newer.wgs84Latitude - older.wgs84Latitude) * ratio,
    wgs84Longitude: ((older.wgs84Longitude + deltaLongitude * ratio + 540) % 360) - 180,
    velocityKph: startSpeed + (endSpeed - startSpeed) * ratio
  };
}
