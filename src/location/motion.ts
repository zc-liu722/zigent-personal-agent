import { distanceMeters } from "./coordinates.js";
import type { StoredLocation } from "./store.js";

export const MOVEMENT_MAX_INTERVAL_MS = 30 * 60 * 1000;
export const MOVEMENT_MIN_DISTANCE_METERS = 500;
export const STATIONARY_CONFIRMATION_MS = 5 * 60 * 1000;
export const TRAJECTORY_DEDUPE_DISTANCE_METERS = 30;
export const TURN_MIN_ANGLE_DEGREES = 45;

export type LocationPoint = StoredLocation & { id: number };

export type MovingLocationAnalysis = {
  state: "moving";
  trajectory: readonly LocationPoint[];
  start: LocationPoint;
  end: LocationPoint;
  turningPoints: readonly LocationPoint[];
  startedAt: number;
  durationMs: number;
  distanceMeters: number;
};

export type StationaryLocationAnalysis = {
  state: "stationary";
  location: LocationPoint;
  arrivedAt: number;
  durationMs: number;
};

export type LocationMotionAnalysis = MovingLocationAnalysis | StationaryLocationAnalysis;

function pointDistance(first: LocationPoint, second: LocationPoint): number {
  return distanceMeters(
    { latitude: first.wgs84Latitude, longitude: first.wgs84Longitude },
    { latitude: second.wgs84Latitude, longitude: second.wgs84Longitude }
  );
}

function isMovingEdge(newer: LocationPoint, older: LocationPoint): boolean {
  const interval = newer.observedAt - older.observedAt;
  return interval >= 0
    && interval <= MOVEMENT_MAX_INTERVAL_MS
    && pointDistance(newer, older) > MOVEMENT_MIN_DISTANCE_METERS;
}

function dedupeTrajectory(points: readonly LocationPoint[]): LocationPoint[] {
  if (points.length < 2) return [...points];
  const deduped = [points[0]!];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    const isEnd = index === points.length - 1;
    if (pointDistance(deduped[deduped.length - 1]!, point) <= TRAJECTORY_DEDUPE_DISTANCE_METERS) {
      if (isEnd && deduped.length > 1) deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  return deduped;
}

function trajectoryLineAngleDegrees(previous: LocationPoint, turn: LocationPoint, next: LocationPoint): number {
  const latitudeRadians = turn.wgs84Latitude * Math.PI / 180;
  const incoming = {
    x: (turn.wgs84Longitude - previous.wgs84Longitude) * Math.cos(latitudeRadians),
    y: turn.wgs84Latitude - previous.wgs84Latitude
  };
  const outgoing = {
    x: (next.wgs84Longitude - turn.wgs84Longitude) * Math.cos(latitudeRadians),
    y: next.wgs84Latitude - turn.wgs84Latitude
  };
  const incomingLength = Math.hypot(incoming.x, incoming.y);
  const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
  if (incomingLength === 0 || outgoingLength === 0) return 0;
  const cosine = (incoming.x * outgoing.x + incoming.y * outgoing.y) / (incomingLength * outgoingLength);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

function turningPoints(trajectory: readonly LocationPoint[]): LocationPoint[] {
  const turns: LocationPoint[] = [];
  for (let index = 1; index < trajectory.length - 1; index += 1) {
    if (trajectoryLineAngleDegrees(
      trajectory[index - 1]!,
      trajectory[index]!,
      trajectory[index + 1]!
    ) > TURN_MIN_ANGLE_DEGREES) {
      turns.push(trajectory[index]!);
    }
  }
  return turns;
}

function stationaryArrival(newestFirst: readonly LocationPoint[]): LocationPoint {
  const latest = newestFirst[0]!;
  let arrival = latest;
  for (const older of newestFirst.slice(1)) {
    const interval = arrival.observedAt - older.observedAt;
    if (interval < 0 || interval > MOVEMENT_MAX_INTERVAL_MS) break;
    if (pointDistance(latest, older) > MOVEMENT_MIN_DISTANCE_METERS) break;
    arrival = older;
  }
  return arrival;
}

function activeMovementEndIndex(newestFirst: readonly LocationPoint[]): number | undefined {
  if (newestFirst.length < 2) return undefined;

  let cursor = 0;
  while (cursor + 1 < newestFirst.length && !isMovingEdge(newestFirst[cursor]!, newestFirst[cursor + 1]!)) {
    const interval = newestFirst[cursor]!.observedAt - newestFirst[cursor + 1]!.observedAt;
    if (interval < 0 || interval > MOVEMENT_MAX_INTERVAL_MS) return undefined;
    cursor += 1;
  }
  if (cursor + 1 >= newestFirst.length) return undefined;
  const currentPauseMs = newestFirst[0]!.observedAt - newestFirst[cursor]!.observedAt;
  if (currentPauseMs >= STATIONARY_CONFIRMATION_MS) return undefined;

  let includedEnd = cursor + 1;
  cursor = includedEnd;
  while (cursor + 1 < newestFirst.length) {
    const next = newestFirst[cursor + 1]!;
    const interval = newestFirst[cursor]!.observedAt - next.observedAt;
    if (interval < 0 || interval > MOVEMENT_MAX_INTERVAL_MS) break;
    if (isMovingEdge(newestFirst[cursor]!, next)) {
      cursor += 1;
      includedEnd = cursor;
      continue;
    }

    const pauseStart = cursor;
    let pauseEnd = cursor;
    while (pauseEnd + 1 < newestFirst.length) {
      const older = newestFirst[pauseEnd + 1]!;
      const pauseInterval = newestFirst[pauseEnd]!.observedAt - older.observedAt;
      if (pauseInterval < 0 || pauseInterval > MOVEMENT_MAX_INTERVAL_MS) break;
      if (isMovingEdge(newestFirst[pauseEnd]!, older)) break;
      pauseEnd += 1;
    }
    const pauseMs = newestFirst[pauseStart]!.observedAt - newestFirst[pauseEnd]!.observedAt;
    const olderMovementPoint = newestFirst[pauseEnd + 1];
    if (pauseMs >= STATIONARY_CONFIRMATION_MS
      || !olderMovementPoint
      || !isMovingEdge(newestFirst[pauseEnd]!, olderMovementPoint)) break;
    cursor = pauseEnd + 1;
    includedEnd = cursor;
  }
  return includedEnd;
}

/** Analyze newest-first database rows using the location product's movement thresholds. */
export function analyzeLocationMotion(
  newestFirst: readonly LocationPoint[],
  now = Date.now()
): LocationMotionAnalysis | undefined {
  const latest = newestFirst[0];
  if (!latest) return undefined;
  const movementEndIndex = activeMovementEndIndex(newestFirst);

  if (movementEndIndex !== undefined) {
    const trajectory = dedupeTrajectory(newestFirst.slice(0, movementEndIndex + 1).reverse());
    const start = trajectory[0]!;
    const end = trajectory[trajectory.length - 1]!;
    let travelled = 0;
    for (let index = 1; index < trajectory.length; index += 1) {
      travelled += pointDistance(trajectory[index - 1]!, trajectory[index]!);
    }
    return {
      state: "moving",
      trajectory,
      start,
      end,
      turningPoints: turningPoints(trajectory),
      startedAt: start.observedAt,
      durationMs: Math.max(0, end.observedAt - start.observedAt),
      distanceMeters: travelled
    };
  }

  const arrival = stationaryArrival(newestFirst);
  return {
    state: "stationary",
    location: latest,
    arrivedAt: arrival.observedAt,
    durationMs: Math.max(0, now - arrival.observedAt)
  };
}
