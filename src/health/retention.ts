import type { DatabaseSync } from "node:sqlite";
import { SELECTED_HEALTH_METRICS, RETAINED_HEALTH_METRIC_NAMES, HEALTH_RETENTION_VERSION, retainedHealthPayload, retainHealthMetric, hasHealthRetentionPolicy } from "./retention-policy.js";

const placeholders = RETAINED_HEALTH_METRIC_NAMES.map(() => "?").join(",");
const device = "json_extract(observation_json,'$.provenance')='health_auto_export'";
const excluded = `${device} AND json_extract(observation_json,'$.metric')<>'workout' AND json_extract(observation_json,'$.metric') NOT IN (${placeholders})`;
function assertOwner(db: DatabaseSync, agentId: string) {
  if (!hasHealthRetentionPolicy(agentId) || db.prepare("SELECT agent_id FROM health_owner WHERE singleton=1").get()?.agent_id !== agentId)
    throw new Error("HEALTH_RETENTION_OWNER_MISMATCH");
}
function count(db: DatabaseSync, sql: string, ...args: string[]) {
  return Number(db.prepare(sql).get(...args)?.n ?? 0);
}
function inventory(db: DatabaseSync) {
  return {
    observations: count(db, "SELECT COUNT(*) AS n FROM health_observations"),
    changes: count(db, "SELECT COUNT(*) AS n FROM health_changes"),
    photos: count(db, "SELECT COUNT(*) AS n FROM health_photos"),
    userReports: count(db, "SELECT COUNT(*) AS n FROM health_observations WHERE json_extract(observation_json,'$.provenance')='user_report'"),
    removableObservations: count(db, `SELECT COUNT(*) AS n FROM health_observations WHERE ${excluded}`, ...RETAINED_HEALTH_METRIC_NAMES),
    removableChanges: count(db, `SELECT COUNT(*) AS n FROM health_changes WHERE ${excluded}`, ...RETAINED_HEALTH_METRIC_NAMES),
    rawPayloadBytes: count(db, "SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS n FROM health_batches"),
    removableRawMetrics: count(db, `SELECT COUNT(*) AS n FROM health_batches b,
      json_each(b.payload_json,'$.data.metrics') m WHERE json_extract(m.value,'$.name') NOT IN (${placeholders})`, ...RETAINED_HEALTH_METRIC_NAMES),
    highWaterSeq: count(db, "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='health_changes'),0) AS n"),
    fileBytes: count(db, "SELECT page_count*page_size AS n FROM pragma_page_count(),pragma_page_size()"),
    metrics: db.prepare(`SELECT metric,COUNT(*) AS count FROM health_observations WHERE ${device} GROUP BY metric ORDER BY metric`).all()
  };
}

/** Explicit maintenance only. Transaction preserves kept observations, diaries and all sequence IDs. */
export function maintainHealthRetention(db: DatabaseSync, apply: boolean, agentId: string) {
  assertOwner(db, agentId);
  db.exec("PRAGMA busy_timeout=30000");
  if (apply) db.exec("PRAGMA secure_delete=ON");
  db.exec(apply ? "BEGIN IMMEDIATE" : "BEGIN");
  let before: ReturnType<typeof inventory>, after: ReturnType<typeof inventory>;
  let rewrittenBatches = 0, removedRawPoints = 0;
  try {
    before = inventory(db);
    const update = apply ? db.prepare("UPDATE health_batches SET payload_json=? WHERE id=?") : undefined;
    let cursor = "";
    for (;;) {
      const batches = db.prepare("SELECT id,payload_json FROM health_batches WHERE id>? ORDER BY id LIMIT 8").all(cursor) as { id: string; payload_json: string }[];
      if (!batches.length) break;
      for (const batch of batches) {
        const original = JSON.parse(batch.payload_json);
        const retained = retainedHealthPayload(original, agentId) as typeof original;
        const removed = (original.data.metrics ?? []).filter((metric: { name: string }) =>
          !retainHealthMetric(agentId, metric.name));
        if (removed.length) {
          rewrittenBatches++;
          removedRawPoints += removed.reduce((sum: number, metric: { data?: unknown[] }) => sum + (metric.data?.length ?? 0), 0);
          // Preserve the original request hash as a deduplication tombstone, even for empty batches.
          update?.run(JSON.stringify(retained), batch.id);
        }
      }
      cursor = batches.at(-1)!.id;
    }
    if (apply) {
      db.prepare(`DELETE FROM health_observations WHERE ${excluded}`).run(...RETAINED_HEALTH_METRIC_NAMES);
      db.prepare(`DELETE FROM health_changes WHERE ${excluded}`).run(...RETAINED_HEALTH_METRIC_NAMES);
    }
    after = inventory(db);
    if (apply && (after.removableObservations || after.removableChanges || after.removableRawMetrics || before.photos !== after.photos
      || before.userReports !== after.userReports || before.highWaterSeq !== after.highWaterSeq
      || before.observations - before.removableObservations !== after.observations
      || before.changes - before.removableChanges !== after.changes
      || db.prepare("PRAGMA foreign_key_check").get())) throw new Error("HEALTH_RETENTION_VERIFICATION_FAILED");
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  // Run with the receiver/Agent paused by the maintained workflow; reclaim pages and WAL.
  if (apply) {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
    after = inventory(db);
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("HEALTH_RETENTION_INTEGRITY_FAILED");
  }
  return { agent: agentId, policy: HEALTH_RETENTION_VERSION, applied: apply, checkedAt: new Date().toISOString(),
    keepMetrics: SELECTED_HEALTH_METRICS, keepWorkouts: true, before, after, rewrittenBatches, removedRawPoints };
}
