import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import { externalEventSchema } from "./external-events.js";
import type { AgentExternalEvent, TaskScope } from "./types.js";

const isoTime = z.string().datetime({ offset: true }).refine(value => Date.parse(value) >= 0, "Invalid timestamp");
export const phoneNotificationRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("get"), id: z.number().int().positive().safe() }).strict(),
  z.object({ action: z.literal("query"), from: isoTime.optional(), to: isoTime.optional(),
    app: z.string().trim().min(1).max(200).optional(), query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(1000).optional() }).strict()
]);
type Request = z.infer<typeof phoneNotificationRequest>;
type Owner = Pick<TaskScope, "agentId" | "userId" | "principalId">;
type NotificationRow = {
  id: number; event_id: string; source: string; occurred_at: number; received_at: number;
  app_id: string | null; app_name: string | null; title: string | null; subtitle: string | null; body: string | null;
};
const cursorSchema = z.object({ v: z.literal(1), high: z.number().int().nonnegative().safe(),
  at: z.number().int().nonnegative().safe(), id: z.number().int().positive().safe(), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const selection = `SELECT n.*,s.source FROM phone_notifications n JOIN agent_external_sources s ON s.id=n.source_id`;
const ownership = "s.user_id=? AND s.principal_id=?";
const iso = (value: number) => new Date(value).toISOString();

function record(row: NotificationRow) {
  return { id: row.id, eventId: row.event_id, source: row.source, occurredAt: iso(row.occurred_at), receivedAt: iso(row.received_at),
    ...(row.app_id === null ? {} : { appId: row.app_id }), ...(row.app_name === null ? {} : { appName: row.app_name }),
    ...(row.title === null ? {} : { title: row.title }), ...(row.subtitle === null ? {} : { subtitle: row.subtitle }),
    ...(row.body === null ? {} : { body: row.body }) };
}

/** Shares the external-event transaction/connection; never owns credentials or dispatches tasks. */
export class PhoneNotificationStore {
  constructor(private readonly db: DatabaseSync) {
    sqliteTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS phone_notifications(
        id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,received_at INTEGER NOT NULL,app_id TEXT,app_name TEXT,title TEXT,subtitle TEXT,body TEXT,
        UNIQUE(source_id,event_id),FOREIGN KEY(source_id,event_id) REFERENCES agent_external_events(source_id,event_id));
        CREATE INDEX IF NOT EXISTS phone_notifications_time ON phone_notifications(occurred_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS phone_notifications_source_time ON phone_notifications(source_id,occurred_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS phone_notifications_app_time ON phone_notifications(app_id,occurred_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS phone_notifications_name_time ON phone_notifications(app_name,occurred_at DESC,id DESC);
        CREATE TABLE IF NOT EXISTS phone_notification_migrations(version INTEGER PRIMARY KEY);`);
      if (!prepareSql(db, "SELECT 1 FROM phone_notification_migrations WHERE version=1").get()) {
        // Index existing saved facts once. Do not replay them into any trigger or task.
        for (const row of prepareSql(db, "SELECT source_id,payload_json,received_at FROM agent_external_events ORDER BY rowid").iterate()) {
          let event: unknown;
          try { event = JSON.parse(String(row.payload_json)); } catch { continue; }
          if (!event || typeof event !== "object") continue;
          const { eventId, occurredAt, notification, event: name } = event as AgentExternalEvent;
          const parsed = externalEventSchema.safeParse({ eventId, event: name, occurredAt, notification });
          if (parsed.success && name === "notification_received") this.save(String(row.source_id), parsed.data, Number(row.received_at));
        }
        prepareSql(db, "INSERT INTO phone_notification_migrations(version) VALUES(1)").run();
      }
    });
  }

  save(sourceId: string, event: Pick<AgentExternalEvent, "eventId" | "event" | "occurredAt" | "notification">, receivedAt: number): number | undefined {
    if (event.event !== "notification_received" || !event.notification) return undefined;
    const value = event.notification;
    prepareSql(this.db, `INSERT OR IGNORE INTO phone_notifications(source_id,event_id,occurred_at,received_at,app_id,app_name,title,subtitle,body)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(sourceId, event.eventId, Date.parse(event.occurredAt), receivedAt,
      value.appId ?? null, value.appName ?? null, value.title ?? null, value.subtitle ?? null, value.body ?? null);
    return this.eventId(sourceId, event.eventId);
  }

  eventId(sourceId: string, eventId: string): number | undefined {
    return (prepareSql(this.db, "SELECT id FROM phone_notifications WHERE source_id=? AND event_id=?").get(sourceId, eventId) as { id: number } | undefined)?.id;
  }

  read(owner: Owner, input: unknown) {
    const request: Request = phoneNotificationRequest.parse(input);
    const ownerValues = [owner.userId, owner.principalId ?? ""];
    if (request.action === "get") {
      const row = prepareSql(this.db, `${selection} WHERE ${ownership} AND n.id=?`).get(...ownerValues, request.id) as NotificationRow | undefined;
      return row ? { status: "found", notification: record(row) } : { status: "not_found" };
    }
    if (request.action === "status") {
      return sqliteTransaction(this.db, () => {
        const stats = prepareSql(this.db, `SELECT COUNT(*) AS count,MIN(n.occurred_at) AS first_at,MAX(n.occurred_at) AS last_at,
          MAX(n.received_at) AS last_received FROM phone_notifications n JOIN agent_external_sources s ON s.id=n.source_id WHERE ${ownership}`)
          .get(...ownerValues) as { count: number; first_at: number | null; last_at: number | null; last_received: number | null };
        const apps = prepareSql(this.db, `SELECT n.app_id,n.app_name,COUNT(*) AS count,MAX(n.received_at) AS last_received
          FROM phone_notifications n JOIN agent_external_sources s ON s.id=n.source_id WHERE ${ownership}
          GROUP BY n.app_id,n.app_name ORDER BY last_received DESC LIMIT 50`).all(...ownerValues) as Array<{
            app_id: string | null; app_name: string | null; count: number; last_received: number }>;
        const sources = prepareSql(this.db, `SELECT source,status,allowed_events_json FROM agent_external_sources s WHERE ${ownership}`)
          .all(...ownerValues).filter(row => (JSON.parse(String(row.allowed_events_json)) as string[]).includes("notification_received"))
          .map(row => ({ source: String(row.source), status: String(row.status) }));
        return { status: "available", count: stats.count, sources,
          firstOccurredAt: stats.first_at === null ? null : iso(stats.first_at),
          lastOccurredAt: stats.last_at === null ? null : iso(stats.last_at),
          lastReceivedAt: stats.last_received === null ? null : iso(stats.last_received),
          apps: apps.map(row => ({ appId: row.app_id, appName: row.app_name, count: row.count, lastReceivedAt: iso(row.last_received) })),
          coverage: "Successfully uploaded notifications only; empty results do not prove the phone received none. App list includes at most 50 most recently reporting app/name pairs." };
      }, "read");
    }
    const from = request.from === undefined ? null : Date.parse(request.from), to = request.to === undefined ? null : Date.parse(request.to);
    if (from !== null && to !== null && from > to) throw new Error("Notification query start must not follow its end");
    const key = createHash("sha256").update(JSON.stringify([owner.agentId, ownerValues, from, to, request.app ?? null, request.query ?? null])).digest("hex");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (request.cursor) {
      try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"))); }
      catch { throw new Error("Invalid notification cursor"); }
      if (cursor.key !== key) throw new Error("Keep the same identity and filters when continuing a notification query");
    }
    return sqliteTransaction(this.db, () => {
      const high = cursor?.high ?? Number((prepareSql(this.db, "SELECT COALESCE(MAX(id),0) AS high FROM phone_notifications").get() as { high: number }).high);
      const conditions = [ownership, "n.id<=?"], values: SQLInputValue[] = [...ownerValues, high];
      if (from !== null) { conditions.push("n.occurred_at>=?"); values.push(from); }
      if (to !== null) { conditions.push("n.occurred_at<=?"); values.push(to); }
      if (request.app) { conditions.push("(n.app_id=? OR n.app_name=?)"); values.push(request.app, request.app); }
      // Literal Unicode substring matching includes Chinese and treats %, _ and quotes as text.
      if (request.query) { conditions.push("instr(lower(COALESCE(n.title,'') || char(10) || COALESCE(n.subtitle,'') || char(10) || COALESCE(n.body,'')),lower(?))>0"); values.push(request.query); }
      if (cursor) { conditions.push("(n.occurred_at<? OR (n.occurred_at=? AND n.id<?))"); values.push(cursor.at, cursor.at, cursor.id); }
      const rows = prepareSql(this.db, `${selection} WHERE ${conditions.join(" AND ")} ORDER BY n.occurred_at DESC,n.id DESC LIMIT ?`)
        .all(...values, request.limit + 1) as NotificationRow[];
      const hasMore = rows.length > request.limit, page = rows.slice(0, request.limit), last = page.at(-1);
      const items = page.map(row => {
        const { title, subtitle, body, ...metadata } = record(row);
        return { ...metadata, ...(title === undefined ? {} : { title: Array.from(title).slice(0, 200).join("") }),
          ...(subtitle === undefined ? {} : { subtitle: Array.from(subtitle).slice(0, 200).join("") }),
          ...(body === undefined ? {} : { bodyPreview: Array.from(body).slice(0, 240).join("") }),
          truncated: Array.from(title ?? "").length > 200 || Array.from(subtitle ?? "").length > 200 || Array.from(body ?? "").length > 240 };
      });
      return { status: "queried", items, hasMore,
        ...(hasMore && last ? { nextCursor: Buffer.from(JSON.stringify({ v: 1, high, at: last.occurred_at, id: last.id, key })).toString("base64url") } : {}),
        coverage: "Successfully uploaded notifications only. Results use occurrence time; late uploads after this page snapshot appear in a new query. Use get for complete text." };
    }, "read");
  }
}
