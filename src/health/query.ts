import type { DatabaseSync } from "node:sqlite";
import { prepareSql } from "../sqlite.js";
import { text, type HealthObservation } from "./normalize.js";

export type HealthQuery = { from: number; to: number; metrics?: readonly string[]; stream?: string; afterSeq?: number; limit?: number };
type ObservationRow = { observation_json: string };

/** The first record always fits, even when it alone exceeds the page's byte budget. */
export function boundedHealthPage(rows: ObservationRow[], limit: number): HealthObservation[] {
  const selected: HealthObservation[] = []; let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const length = Buffer.byteLength(row.observation_json);
    if (selected.length && bytes + length > 256 * 1024) break;
    selected.push(JSON.parse(row.observation_json) as HealthObservation); bytes += length;
  }
  return selected;
}

/** Current-record pagination; revision history and freshness stay with the store. */
export function queryHealthObservations(db: DatabaseSync, query: HealthQuery) {
  const { from, to } = query;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to - from > 366 * 86400_000) throw new Error("INVALID_QUERY_RANGE");
  const limit = query.limit ?? 200, after = query.afterSeq ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(after) || after < 0) throw new Error("INVALID_QUERY_LIMIT");
  if (query.metrics && (query.metrics.length > 32 || query.metrics.some(metric => !/^[a-z][a-z0-9_&]*$/.test(metric)))) throw new Error("INVALID_METRICS");
  const metrics = [...new Set(query.metrics)];
  const clauses = ["observed_at <= ?", "COALESCE(end_at, observed_at) >= ?", "seq > ?"];
  const args: (string | number)[] = [to, from, after];
  if (query.stream) { text(query.stream, 1024); clauses.push("stream=?"); args.push(query.stream); }
  if (metrics.length) { clauses.push(`metric IN (${metrics.map(() => "?").join(",")})`); args.push(...metrics); }
  const where = clauses.join(" AND ");
  // An explicit stream needs no discovery. Unscoped reads must still discover
  // streams after this cursor on every call, including after concurrent imports.
  const streams = query.stream ? [] : prepareSql(db,
    `SELECT DISTINCT stream FROM health_observations WHERE ${where} ORDER BY stream LIMIT 101`)
    .all(...args) as { stream: string }[];
  if (!query.stream && streams.length > 1) return { result: "stream_required" as const,
    streams: streams.map(row => row.stream), observations: [] as HealthObservation[], nextCursor: after, hasMore: false };

  let rows: ObservationRow[];
  // A cursor scan of a small historical window could walk every newer record
  // just to establish EOF. Preserve time-range access when the upper bound
  // precedes stored observations. This indexed probe reads no bodies or counts.
  const timeBounded = prepareSql(db, `SELECT 1 FROM health_observations INDEXED BY health_observations_time
    WHERE observed_at>? LIMIT 1`).get(to);
  if (timeBounded) {
    const index = query.stream ? "health_observations_stream" : "health_observations_time";
    rows = prepareSql(db, `WITH page AS MATERIALIZED (SELECT rowid,seq FROM health_observations INDEXED BY ${index}
      WHERE ${where} ORDER BY seq LIMIT ?)
      SELECT o.observation_json FROM page JOIN health_observations o ON o.rowid=page.rowid ORDER BY page.seq`)
      .all(...args, limit + 1) as ObservationRow[];
  } else if (query.stream && metrics.length > 1) {
    // Each metric contributes at most limit+1 ordered identities. Merge those
    // bounded candidates before loading bodies; IN + ORDER BY otherwise sorts
    // the entire remaining metric history on every page.
    const branch = `SELECT rowid,seq FROM health_observations INDEXED BY health_observations_metric_cursor
      WHERE stream=? AND metric=? AND seq>? AND observed_at<=? AND COALESCE(end_at,observed_at)>=? ORDER BY seq LIMIT ?`;
    const candidates = metrics.map(() => `SELECT * FROM (${branch})`).join(" UNION ALL ");
    rows = prepareSql(db, `WITH page AS MATERIALIZED (SELECT rowid,seq FROM (${candidates}) ORDER BY seq LIMIT ?)
      SELECT o.observation_json FROM page JOIN health_observations o ON o.rowid=page.rowid ORDER BY page.seq`)
      .all(...metrics.flatMap(metric => [query.stream!, metric, after, to, from, limit + 1]), limit + 1) as ObservationRow[];
  } else {
    const index = query.stream ? metrics.length ? "health_observations_metric_cursor" : "health_observations_stream_cursor"
      : "health_observations_cursor";
    rows = prepareSql(db, `SELECT observation_json FROM health_observations INDEXED BY ${index}
      WHERE ${where} ORDER BY seq LIMIT ?`).all(...args, limit + 1) as ObservationRow[];
  }
  const observations = boundedHealthPage(rows, limit);
  return { result: observations.length ? "available" as const : "no_data" as const,
    stream: query.stream ?? streams[0]?.stream, observations, nextCursor: observations.at(-1)?.seq ?? after,
    hasMore: rows.length > observations.length };
}
