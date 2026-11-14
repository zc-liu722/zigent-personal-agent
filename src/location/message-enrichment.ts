import { DatabaseSync } from "node:sqlite";
import { closeSqlite, prepareSql, sqliteTransaction } from "../sqlite.js";
import { interpolateMessageLocation, type MessageLocation } from "./message-location.js";
import type { UserLocationStore, StoredLocation } from "./store.js";

type Point = StoredLocation & { id: number };
type MessageTime = { id: string; at: number };

/** The location receiver runs in another process. Consume its durable arrival feed,
 * rather than relying on an in-process event or on messages being saved in order. */
export class MessageLocationEnrichment {
  private readonly history: DatabaseSync;
  private readonly scope: string;
  private previous?: Point;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private failed = false;
  private bindingActive?: boolean;

  constructor(private readonly locations: UserLocationStore, historyPath: string,
    agentId: string, private readonly owners: readonly string[]) {
    this.history = new DatabaseSync(historyPath);
    try {
      this.history.exec("PRAGMA busy_timeout=5000");
      if (this.history.prepare("SELECT agent_id FROM agent_metadata WHERE singleton=1").get()?.agent_id !== agentId)
        throw new Error("MESSAGE_LOCATION_AGENT_MISMATCH");
      if (!owners.length) throw new Error("MESSAGE_LOCATION_OWNER_REQUIRED");
      this.history.exec(`CREATE TABLE IF NOT EXISTS message_location_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
        arrival_cursor INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      // First installation fills missing history independently; old arrivals need not
      // be replayed. Persist before processing so a restart never skips new arrivals.
      prepareSql(this.history, `INSERT OR IGNORE INTO message_location_state VALUES(1,1,?,?)`)
        .run(locations.pointHighWater(), Date.now());
      const ownerList = owners.map(() => "?").join(",");
      this.scope = `session_id IN (SELECT session_id FROM sessions WHERE chat_type='p2p' AND user_id IN (${ownerList}))`;
      this.previous = locations.latest();
    } catch (error) { closeSqlite(this.history); throw error; }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let more = false;
      try {
        more = this.tick();
        this.failed = false;
      } catch {
        // Do not leak coordinates, conversation IDs, or SQL into production logs.
        if (!this.failed) console.error("Message location enrichment failed; retrying from its durable checkpoint");
        this.failed = true;
      }
      if (!this.stopped) this.schedule(more ? 10 : 2000);
    }, delay);
    this.timer.unref();
  }

  private write(rows: MessageTime[], locate: (at: number) => MessageLocation): void {
    if (!rows.length) return;
    sqliteTransaction(this.history, () => {
      const update = prepareSql(this.history, `UPDATE messages
        SET wgs84_latitude=?,wgs84_longitude=?,velocity_kph=? WHERE id=?`);
      for (const row of rows) {
        const location = locate(row.at);
        update.run(location.wgs84Latitude, location.wgs84Longitude, location.velocityKph, row.id);
      }
    });
  }

  /** No location calculation or write when the interval contains no messages. */
  private repairInterval(older: Point | undefined, newer: Point): void {
    const from = older?.observedAt ?? newer.observedAt;
    let after: MessageTime | undefined;
    for (;;) {
      const rows = prepareSql(this.history, `SELECT id,created_at AS at FROM messages
        WHERE ${this.scope} AND created_at${older ? ">" : ">="}? AND created_at<=?
        ${after ? "AND (created_at>? OR (created_at=? AND id>?))" : ""}
        ORDER BY created_at,id LIMIT 200`).all(...this.owners, from, newer.observedAt,
        ...(after ? [after.at, after.at, after.id] : [])) as MessageTime[];
      this.write(rows, at => interpolateMessageLocation(older, newer, at));
      if (rows.length < 200) break;
      after = rows.at(-1)!;
    }
  }

  private tick(): boolean {
    // Location ownership must be established through the existing binding flow.
    if (!this.locations.isOwner(this.owners[0]!, this.owners.slice(1))) {
      // Revocation erases derived coordinates as well as the source observations.
      if (this.bindingActive !== false) {
        prepareSql(this.history, `UPDATE messages SET wgs84_latitude=NULL,wgs84_longitude=NULL,velocity_kph=NULL
          WHERE wgs84_latitude IS NOT NULL AND ${this.scope}`).run(...this.owners);
        this.previous = undefined;
        this.bindingActive = false;
      }
      return false;
    }
    this.bindingActive = true;
    const cursor = Number(prepareSql(this.history, "SELECT arrival_cursor FROM message_location_state WHERE singleton=1").get()!.arrival_cursor);
    const arrivals = this.locations.taskPoints(cursor, 10);
    for (const arrival of arrivals.points) {
      const point = this.locations.atOrAfter(arrival.observedAt)!;
      // Validate the cached point: another process can insert an intermediate point
      // (or revoke the source history) between polls, even during an ordered arrival.
      const predecessor = this.locations.latest(point.observedAt - 1);
      const older = this.previous?.id === predecessor?.id ? this.previous : predecessor;
      this.repairInterval(older, point);
      // Late observations split an already completed interval. Repair both sides,
      // including populated rows, and choose canonical equal-time observations.
      const newer = this.locations.atOrAfter(point.observedAt + 1);
      if (newer) this.repairInterval(point, newer);
      this.previous = this.locations.latest();
      // Writes are idempotent. A crash before the checkpoint replays the arrival.
      prepareSql(this.history, "UPDATE message_location_state SET arrival_cursor=?,updated_at=? WHERE singleton=1")
        .run(arrival.id, Date.now());
    }
    const first = this.locations.atOrAfter(0), last = this.locations.latest();
    if (!first || !last) return false;
    // Also catch delayed model replies, copied turns, downtime, and initial history.
    // The partial index excludes already-enriched rows; uncovered tails stay NULL.
    const rows = prepareSql(this.history, `SELECT id,created_at AS at FROM messages
      WHERE wgs84_latitude IS NULL AND ${this.scope} AND created_at>=? AND created_at<=?
      ORDER BY created_at,id LIMIT 200`).all(...this.owners, first.observedAt, last.observedAt) as MessageTime[];
    this.write(rows, at => {
      const right = this.locations.atOrAfter(at)!;
      return interpolateMessageLocation(this.locations.latest(at - 1), right, at);
    });
    return arrivals.nextCursor < arrivals.highWater || rows.length === 200;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    closeSqlite(this.history);
  }
}
