import { prepareSql, closeSqlite, sqliteTransaction } from "../sqlite.js";
import { mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonical, hash, normalizeHealthPayload, text, timestamp, type HealthImportMetadata, type HealthObservation } from "./normalize.js";
import { diaryDate, diaryRange, meal, NUTRIENTS, type Meal } from "./diary.js";
import type { ReferenceImage } from "../image-generation.js";
import type { HrvBaselineSnapshot } from "./hrv.js";
import { boundedHealthPage, queryHealthObservations, type HealthQuery } from "./query.js";
export type { HealthObservation } from "./normalize.js";
export type { HealthQuery } from "./query.js";
export class HealthStore {
  private constructor(private readonly db: DatabaseSync) {}
  static async open(path: string): Promise<HealthStore> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS health_batches (id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,last_received_at INTEGER NOT NULL,metadata_json TEXT NOT NULL,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,observation_id TEXT NOT NULL,content_hash TEXT NOT NULL,observation_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_observations (id TEXT PRIMARY KEY,seq INTEGER NOT NULL REFERENCES health_changes(seq),metric TEXT NOT NULL,stream TEXT NOT NULL,observed_at INTEGER NOT NULL,end_at INTEGER,received_at INTEGER NOT NULL,content_hash TEXT NOT NULL,observation_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS health_observations_time ON health_observations(observed_at);
      CREATE INDEX IF NOT EXISTS health_observations_stream ON health_observations(stream,metric,observed_at);
      CREATE INDEX IF NOT EXISTS health_observations_cursor ON health_observations(seq);
      CREATE INDEX IF NOT EXISTS health_observations_stream_cursor ON health_observations(stream,seq);
      CREATE INDEX IF NOT EXISTS health_observations_metric_cursor ON health_observations(stream,metric,seq);
      CREATE TABLE IF NOT EXISTS health_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_photos (id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,bytes BLOB NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS health_diary_writes (request_id TEXT PRIMARY KEY,result_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS health_diary_date ON health_observations(json_extract(observation_json,'$.values.date')) WHERE stream='project_diary';`);
    if (process.platform !== "win32") await chmod(path, 0o600);
    return new HealthStore(db);
  }
  close(): void { closeSqlite(this.db); }
  private transaction<T>(operation: () => T, mode: "read" | "write" = "write"): T {
    return sqliteTransaction(this.db, operation, mode);
  }
  private upsert(row: HealthObservation): boolean {
    const contentHash = hash(canonical({ ...row, seq: 0, receivedAt: 0 }));
    const previous = prepareSql(this.db, "SELECT content_hash FROM health_observations WHERE id=?").get(row.id) as { content_hash: string } | undefined;
    if (previous?.content_hash === contentHash) return false;
    const change = prepareSql(this.db, "INSERT INTO health_changes(observation_id,content_hash,observation_json) VALUES (?,?,?)").run(row.id, contentHash, JSON.stringify(row));
    row.seq = Number(change.lastInsertRowid);
    const json = JSON.stringify(row);
    prepareSql(this.db, "UPDATE health_changes SET observation_json=? WHERE seq=?").run(json, row.seq);
    prepareSql(this.db, `INSERT INTO health_observations(id,seq,metric,stream,observed_at,end_at,received_at,content_hash,observation_json) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,metric=excluded.metric,stream=excluded.stream,observed_at=excluded.observed_at,end_at=excluded.end_at,received_at=excluded.received_at,content_hash=excluded.content_hash,observation_json=excluded.observation_json`)
      .run(row.id, row.seq, row.metric, row.stream, row.observedAt, row.endAt ?? null, row.receivedAt, contentHash, json);
    return true;
  }
  ingest(payload: unknown, metadata: HealthImportMetadata, now = Date.now(), originalJson = JSON.stringify(payload)): { duplicate: boolean; changed: number; highWaterSeq: number } {
    if (Buffer.byteLength(originalJson) > 4 * 1024 * 1024) throw new Error("BODY_TOO_LARGE");
    const rows = normalizeHealthPayload(payload, metadata, now);
    const id = hash(canonical([metadata.automationId, metadata.aggregation, payload]));
    const metadataJson = JSON.stringify(metadata);
    return this.transaction(() => {
      const existing = Boolean(prepareSql(this.db, "SELECT 1 FROM health_batches WHERE id=?").get(id));
      prepareSql(this.db, `INSERT INTO health_batches VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_received_at=excluded.last_received_at`)
        .run(id, now, now, metadataJson, originalJson);
      // Exact request retries never roll a revised observation back to an older batch.
      let changed = 0; if (!existing) for (const row of rows) if (this.upsert(row)) changed++;
      prepareSql(this.db, "INSERT INTO health_state VALUES ('last_ingest',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(now));
      return { duplicate: existing && changed === 0, changed, highWaterSeq: this.highWaterSeq() };
    });
  }
  highWaterSeq(): number {
    return Number((prepareSql(this.db, "SELECT COALESCE(MAX(seq),0) AS n FROM health_changes").get() as { n: number }).n);
  }
  /** Last calculated personal reference, kept privately across restarts. Raw observations remain authoritative. */
  saveHrvBaseline(snapshot: HrvBaselineSnapshot): void {
    const key = `hrv_baseline:${hash(canonical([snapshot.rule, snapshot.timezone, snapshot.stream]))}`;
    prepareSql(this.db, "INSERT INTO health_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(snapshot));
  }
  hrvBaselines(): HrvBaselineSnapshot[] {
    const rows = prepareSql(this.db, "SELECT value FROM health_state WHERE key GLOB 'hrv_baseline:*' ORDER BY key").all() as { value: string }[];
    return rows.map(row => JSON.parse(row.value) as HrvBaselineSnapshot);
  }
  status(now = Date.now()) {
    const aggregate = prepareSql(this.db, "SELECT COUNT(*) AS observations,MAX(observed_at) AS latestObservedAt,MIN(observed_at) AS earliestObservedAt FROM health_observations").get() as { observations: number; latestObservedAt: number | null; earliestObservedAt: number | null };
    const lastIngest = prepareSql(this.db, "SELECT value FROM health_state WHERE key='last_ingest'").get() as { value: string } | undefined;
    const lastReceivedAt = lastIngest ? Number(lastIngest.value) : null;
    const streams = prepareSql(this.db, "SELECT stream,metric,COUNT(*) AS count,MAX(observed_at) AS latestObservedAt FROM health_observations GROUP BY stream,metric ORDER BY stream,metric LIMIT 501").all();
    return { ...aggregate, highWaterSeq: this.highWaterSeq(), lastReceivedAt, uploadFreshnessSeconds: lastReceivedAt === null ? null : Math.max(0, Math.round((now - lastReceivedAt) / 1000)), observationAgeSeconds: aggregate.latestObservedAt === null ? null : Math.max(0, Math.round((now - aggregate.latestObservedAt) / 1000)), available: aggregate.observations > 0, streams: streams.slice(0, 500), streamsTruncated: streams.length > 500 };
  }
  query(query: HealthQuery) {
    return { ...queryHealthObservations(this.db, query), highWaterSeq: this.highWaterSeq() };
  }
  scanChanges(afterSeq: number, limit = 500): { changes: HealthObservation[]; nextCursor: number; hasMore: boolean } {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_CURSOR");
    const rows = prepareSql(this.db, "SELECT observation_json FROM health_changes WHERE seq>? ORDER BY seq LIMIT ?").all(afterSeq, limit + 1) as { observation_json: string }[];
    const changes = boundedHealthPage(rows, limit);
    return { changes, nextCursor: changes.at(-1)?.seq ?? afterSeq, hasMore: rows.length > changes.length };
  }
  /** Skip irrelevant arrivals without waiting through one scheduler tick per unfiltered page. */
  scanMetricChanges(afterSeq: number, metrics: readonly string[], limit = 500): { changes: HealthObservation[]; nextCursor: number; hasMore: boolean } {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
      || !metrics.length || metrics.length > 32 || metrics.some(metric => !/^[a-z][a-z0-9_&]*$/.test(metric))) throw new Error("INVALID_CURSOR");
    const highWater = this.highWaterSeq();
    const rows = prepareSql(this.db, `SELECT observation_json FROM health_changes WHERE seq>? AND seq<=?
      AND json_extract(observation_json,'$.metric') IN (${metrics.map(() => "?").join(",")}) ORDER BY seq LIMIT ?`)
      .all(afterSeq, highWater, ...metrics, limit + 1) as { observation_json: string }[];
    const changes = boundedHealthPage(rows, limit), hasMore = rows.length > changes.length;
    return { changes, nextCursor: hasMore ? changes.at(-1)!.seq : Math.max(afterSeq, highWater), hasMore };
  }
  recordNote(input: { id: string; category: "food" | "energy" | "training" | "context"; text: string; observedAt: string }, now = Date.now()) {
    const noteId = text(input.id, 128), content = text(input.text, 4000);
    if (!["food", "energy", "training", "context"].includes(input.category)) throw new Error("INVALID_CATEGORY");
    const row: HealthObservation = { id: hash(`manual:${noteId}`), seq: 0, metric: `manual_${input.category}`, stream: "user_report", kind: "note", observedAt: timestamp(input.observedAt, now), receivedAt: now, values: { text: content }, provenance: "user_report" };
    return this.transaction(() => ({ changed: this.upsert(row), highWaterSeq: this.highWaterSeq() }));
  }

  recordDay(input: { date: unknown; category: unknown; text: unknown; requestId?: string }, now = Date.now()) {
    const date = diaryDate(input.date), comment = text(input.text, 4000);
    if (input.category !== "sleep" && input.category !== "training") throw new Error("INVALID_DIARY_CATEGORY");
    const row: HealthObservation = { id: `day:${input.category}:${date}`, seq: 0,
      metric: `manual_${input.category}`, stream: "project_diary", kind: "note",
      observedAt: Date.parse(`${date}T00:00:00+08:00`), receivedAt: now,
      values: { date, comment }, provenance: "user_report" };
    return this.transaction(() => {
      const replay = this.diaryWriteResult<{ id: string; date: string; changed: boolean; highWaterSeq: number }>(input.requestId);
      if (replay) return replay;
      const result = { id: row.id, date, changed: this.upsert(row), highWaterSeq: this.highWaterSeq() };
      this.rememberDiaryWrite(input.requestId, result);
      return result;
    });
  }

  private diaryWriteResult<T extends { changed: boolean; highWaterSeq: number }>(requestId?: string): T | undefined {
    if (!requestId) return undefined;
    const previous = prepareSql(this.db, "SELECT result_json FROM health_diary_writes WHERE request_id=?").get(requestId) as { result_json: string } | undefined;
    return previous ? { ...JSON.parse(previous.result_json), changed: false, highWaterSeq: this.highWaterSeq() } as T : undefined;
  }

  private rememberDiaryWrite(requestId: string | undefined, result: unknown): void {
    if (requestId) prepareSql(this.db, "INSERT INTO health_diary_writes VALUES (?,?)").run(requestId, JSON.stringify(result));
  }

  /** Copies staged photos and writes the meal in one SQLite transaction, independent of chat retention. */
  recordMeal(input: { id: unknown; meal: unknown; requestId?: string }, images: readonly ReferenceImage[] = [], now = Date.now()) {
    const suppliedId = text(input.id, 128);
    const id = suppliedId.startsWith("meal:") ? suppliedId : `meal:${suppliedId}`;
    if (id.length > 128) throw new Error("INVALID_MEAL_ID");
    const supplied = input.meal as Record<string, unknown>;
    const values = meal(input.meal);
    if (images.length > 8 || images.reduce((sum, image) => sum + image.data.length, 0) > 20 * 1024 * 1024) throw new Error("TOO_MANY_PHOTO_BYTES");
    const photos = images.map(image => {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)
        || !image.data.length || image.data.length > 10 * 1024 * 1024) throw new Error("INVALID_HEALTH_PHOTO");
      return { id: `health-photo-${hash(image.data.toString("base64"))}`, ...image };
    });
    return this.transaction(() => {
      const replay = this.diaryWriteResult<{ id: string; date: string; photoIds: string[]; changed: boolean; highWaterSeq: number }>(input.requestId);
      if (replay) return replay;
      const previous = prepareSql(this.db, "SELECT observation_json FROM health_observations WHERE id=? AND stream='project_diary' AND metric='manual_food'").get(id) as { observation_json: string } | undefined;
      const previousMeal = previous ? JSON.parse(previous.observation_json).values as Meal : undefined;
      if (supplied.photoIds === undefined && previousMeal) values.photoIds = previousMeal.photoIds;
      if (supplied.nutritionEstimate === undefined && previousMeal?.intake === values.intake) values.nutritionEstimate = previousMeal.nutritionEstimate;
      values.photoIds = [...new Set([...values.photoIds, ...photos.map(photo => photo.id)])];
      if (values.photoIds.length > 8) throw new Error("TOO_MANY_PHOTOS");
      for (const photo of photos) prepareSql(this.db, "INSERT OR IGNORE INTO health_photos VALUES (?,?,?,?)")
        .run(photo.id, photo.mimeType, photo.data, now);
      for (const photoId of values.photoIds) if (!prepareSql(this.db, "SELECT 1 FROM health_photos WHERE id=?").get(photoId)) throw new Error("HEALTH_PHOTO_NOT_FOUND");
      const row: HealthObservation = { id, seq: 0, metric: "manual_food", stream: "project_diary", kind: "note",
        observedAt: Date.parse(`${values.date}T00:00:00+08:00`), receivedAt: now,
        values, provenance: "user_report" };
      const result = { id, date: values.date, photoIds: values.photoIds, changed: this.upsert(row), highWaterSeq: this.highWaterSeq() };
      this.rememberDiaryWrite(input.requestId, result);
      return result;
    });
  }

  readPhoto(id: string): ReferenceImage {
    const photo = prepareSql(this.db, "SELECT mime_type,bytes FROM health_photos WHERE id=?").get(id) as { mime_type: string; bytes: Uint8Array } | undefined;
    if (!photo) throw new Error("HEALTH_PHOTO_NOT_FOUND");
    return { mimeType: photo.mime_type, data: Buffer.from(photo.bytes) };
  }

  /** Complete two-calendar-day reference, independent of tool pagination and device data. */
  recentProjectDiary(now = Date.now()) {
    const local = now + 8 * 60 * 60_000;
    const from = new Date(local - 24 * 60 * 60_000).toISOString().slice(0, 10);
    const to = new Date(local).toISOString().slice(0, 10);
    return this.transaction(() => {
      const rows = prepareSql(this.db, `SELECT observation_json FROM health_observations
        WHERE stream='project_diary' AND json_extract(observation_json,'$.values.date') BETWEEN ? AND ?
        ORDER BY json_extract(observation_json,'$.values.date'),seq`).all(from, to) as { observation_json: string }[];
      return { result: rows.length ? "available" : "no_data", timezone: "Asia/Shanghai", from, to,
        observations: rows.map(row => JSON.parse(row.observation_json) as HealthObservation),
        hasMore: false, highWaterSeq: this.highWaterSeq(), nutritionSummary: this.diaryNutritionSummary(from, to) };
    }, "read");
  }

  private diaryNutritionSummary(from: string, to: string) {
    const where = "stream='project_diary' AND json_extract(observation_json,'$.values.date') BETWEEN ? AND ?";
    const counts = prepareSql(this.db, `SELECT COUNT(*) AS meals FROM health_observations WHERE ${where} AND metric='manual_food'`).get(from, to) as { meals: number };
    const nutrients = Object.fromEntries(NUTRIENTS.map(key => {
      const path = `$.values.nutritionEstimate.${key}`;
      const totals = prepareSql(this.db, `SELECT SUM(json_extract(observation_json,?)) AS total,
        COUNT(json_extract(observation_json,?)) AS estimatedMeals FROM health_observations WHERE ${where} AND metric='manual_food'`)
        .get(path, path, from, to) as { total: number | null; estimatedMeals: number };
      return [key, { estimatedTotal: totals.total, estimatedMeals: totals.estimatedMeals, missingMeals: counts.meals - totals.estimatedMeals }];
    }));
    return { scope: "full_date_range", mealCount: counts.meals, nutrients,
      note: "Estimates for recorded meals only; missing meals/values are unknown. Sugars are part of carbohydrates, not additional intake." };
  }

  diary(input: { from: unknown; to: unknown; afterSeq?: number; limit?: number }) {
    const { from, to } = diaryRange(input.from, input.to), after = input.afterSeq ?? 0, limit = input.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("INVALID_QUERY_LIMIT");
    return this.transaction(() => {
      const where = "stream='project_diary' AND json_extract(observation_json,'$.values.date') BETWEEN ? AND ?";
      const rows = prepareSql(this.db, `SELECT observation_json FROM health_observations WHERE ${where} AND seq>? ORDER BY seq LIMIT ?`)
        .all(from, to, after, limit + 1) as { observation_json: string }[];
      const observations = boundedHealthPage(rows, limit);
      // Detail and full-range estimates share a snapshot even while the receiver imports data.
      return { result: observations.length ? "available" : "no_data", timezone: "Asia/Shanghai", from, to, observations,
        nextCursor: observations.at(-1)?.seq ?? after, hasMore: rows.length > observations.length, highWaterSeq: this.highWaterSeq(),
        nutritionSummary: this.diaryNutritionSummary(from, to) };
    }, "read");
  }
}
