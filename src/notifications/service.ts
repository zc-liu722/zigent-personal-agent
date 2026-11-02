import { BackgroundScheduler, type ScheduledSource } from "../background-scheduler.js";
import { prepareSql, closeSqlite } from "../sqlite.js";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NotificationTransportError, type NotificationContent, type NotificationTransport } from "./bark.js";

export type NotificationScope = { agentId: string; userId: string; conversationKind?: "p2p" | "group" };
export type NotificationStatus = "pending" | "sending" | "accepted" | "failed" | "uncertain" | "expired";
type Row = NotificationContent & { id: string; status: NotificationStatus; attempts: number; created_at: number };

/** Agent-owned durable outbox. Acceptance is not proof of device delivery or reading. */
export class NotificationService {
  private readonly db: DatabaseSync;
  private source?: ScheduledSource;
  private active?: Promise<void>;
  private started = false;
  private closed = false;
  private retryAt = 0;
  constructor(private readonly options: {
    databasePath: string; agentId: string; ownerUserId: string; transport: NotificationTransport;
  }, private readonly scheduler = new BackgroundScheduler()) {
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS agent_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),agent_id TEXT NOT NULL);`);
      prepareSql(this.db, "INSERT OR IGNORE INTO agent_metadata(singleton,agent_id) VALUES(1,?)").run(options.agentId);
      const owner = prepareSql(this.db, "SELECT agent_id FROM agent_metadata WHERE singleton=1").get() as { agent_id: string };
      if (owner.agent_id !== options.agentId) throw new Error("Notification database belongs to another agent");
      this.db.exec(`CREATE TABLE IF NOT EXISTS notification_outbox(
        id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, available_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS notification_due ON notification_outbox(status,available_at);`);
      // We cannot reconcile an in-flight Bark request after a process crash.
      prepareSql(this.db, "UPDATE notification_outbox SET status='uncertain' WHERE status='sending'").run();
      prepareSql(this.db, "UPDATE notification_outbox SET status='failed' WHERE status='pending' AND user_id<>?").run(options.ownerUserId);
    } catch (error) { closeSqlite(this.db); throw error; }
  }

  canNotify(scope: NotificationScope): boolean {
    return scope.agentId === this.options.agentId && scope.userId === this.options.ownerUserId && scope.conversationKind === "p2p";
  }

  enqueue(scope: NotificationScope, input: NotificationContent & { idempotencyKey: string }, now = Date.now()): { id: string; status: NotificationStatus } {
    if (!this.canNotify(scope)) throw new Error("Notifications require the configured owner in a private conversation");
    if (this.closed) throw new Error("Notification service is closed");
    if (!input.idempotencyKey || input.idempotencyKey.length > 512 || input.title.length > 200
      || !input.body.trim() || input.body.length > 12000) throw new Error("Invalid notification content");
    const existing = prepareSql(this.db, "SELECT id,status FROM notification_outbox WHERE dedup_key=?").get(input.idempotencyKey) as
      { id: string; status: NotificationStatus } | undefined;
    if (existing) return existing;
    const id = randomUUID();
    prepareSql(this.db, `INSERT INTO notification_outbox(id,dedup_key,user_id,title,body,status,created_at,available_at)
      VALUES(?,?,?,?,?,'pending',?,?)`).run(id, input.idempotencyKey, scope.userId, input.title.trim(), input.body.trim(), now, now);
    this.source?.wake();
    return { id, status: "pending" };
  }

  /** Invalidate queued reminders before an event is changed or deleted. */
  cancelPendingPrefix(prefix: string): void {
    prepareSql(this.db, "UPDATE notification_outbox SET status='expired' WHERE status='pending' AND substr(dedup_key,1,?)=?").run(prefix.length, prefix);
  }
  hasDispatchedPrefix(prefix: string): boolean {
    return Boolean(prepareSql(this.db, "SELECT 1 FROM notification_outbox WHERE substr(dedup_key,1,?)=? AND status IN ('sending','accepted','uncertain') LIMIT 1").get(prefix.length, prefix));
  }
  /** Invalidate only obsolete revisions after a restart. */
  reconcilePendingSchedule(validKeys: ReadonlySet<string>): void {
    const rows = prepareSql(this.db, "SELECT id,dedup_key FROM notification_outbox WHERE status='pending' AND substr(dedup_key,1,9)='schedule:'").all() as Array<{ id: string; dedup_key: string }>;
    for (const row of rows) if (!validKeys.has(row.dedup_key)) prepareSql(this.db, "UPDATE notification_outbox SET status='expired' WHERE id=? AND status='pending'").run(row.id);
  }

  /** Safe metadata only; keys, recipients and message contents never enter diagnostics. */
  status(id: string): { id: string; status: NotificationStatus; attempts: number } | undefined {
    return prepareSql(this.db, "SELECT id,status,attempts FROM notification_outbox WHERE id=?").get(id) as
      { id: string; status: NotificationStatus; attempts: number } | undefined;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.source = this.scheduler.register(() => {
      if (this.active) return undefined;
      if (this.retryAt > Date.now()) return this.retryAt;
      const next = this.nextWakeAt();
      if (next !== undefined && next <= Date.now()) {
        void this.tick().catch(() => console.warn("Notification queue needs attention; inspect notification metadata"));
        return undefined;
      }
      return next;
    });
  }
  private nextWakeAt(): number | undefined {
    const row = prepareSql(this.db, `SELECT MIN(MIN(available_at,created_at+86400000)) AS at
      FROM notification_outbox WHERE status='pending'`).get() as { at: number | null };
    return row.at ?? undefined;
  }
  tick(now = Date.now()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.deliverOne(now).catch(error => {
      this.retryAt = Date.now() + BackgroundScheduler.recoveryMs;
      throw error;
    }).finally(() => { this.active = undefined; this.source?.wake(); });
    return this.active;
  }
  private async deliverOne(now: number): Promise<void> {
    prepareSql(this.db, "UPDATE notification_outbox SET status='expired' WHERE status='pending' AND created_at<=?").run(now - 24 * 60 * 60_000);
    const row = prepareSql(this.db, `UPDATE notification_outbox SET status='sending',attempts=attempts+1
      WHERE id=(SELECT id FROM notification_outbox WHERE status='pending' AND available_at<=? ORDER BY created_at LIMIT 1)
      RETURNING id,title,body,status,attempts,created_at`).get(now) as Row | undefined;
    if (!row) return;
    let status: NotificationStatus = "accepted", next = now;
    try { await this.options.transport.send(row); }
    catch (error) {
      const kind = error instanceof NotificationTransportError ? error.kind : "uncertain";
      status = kind === "retryable" ? row.attempts < 3 ? "pending" : "failed" : kind;
      next = now + (row.attempts === 1 ? 30_000 : 120_000);
    }
    prepareSql(this.db, "UPDATE notification_outbox SET status=?,available_at=? WHERE id=?").run(status, next, row.id);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.started = false;
    this.source?.close();
    await this.active;
    this.closed = true;
    closeSqlite(this.db);
  }
}
