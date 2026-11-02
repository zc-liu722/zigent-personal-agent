import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeSqlite, sqliteTransaction } from "../sqlite.js";
import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
const instant = z.string().datetime({ offset: true });
const temporal = z.union([date, instant]);
const recurrence = z.object({ frequency: z.enum(["daily", "weekly", "monthly", "yearly"]), interval: z.number().int().min(1).max(365).default(1), until: date.optional(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional() }).strict();
export const scheduleFields = z.object({
  kind: z.enum(["todo", "event"]), title: z.string().trim().min(1).max(500), description: z.string().max(8000).default(""),
  start: temporal.nullable().default(null), end: temporal.nullable().default(null), due: temporal.nullable().default(null),
  timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }).default("Asia/Shanghai"),
  reminderMinutes: z.number().int().min(0).max(10080).nullable().default(null),
  location: z.string().max(1000).default(""), priority: z.number().int().min(1).max(4).default(1),
  labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]), project: z.string().max(500).default(""),
  parentId: z.string().uuid().nullable().default(null), recurrence: recurrence.nullable().default(null), completed: z.boolean().default(false)
}).strict().superRefine((item, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (item.kind === "event" && (!item.start || !item.end)) fail("日程必须包含开始和结束时间。");
  if (item.kind === "event" && item.start && item.end && (item.start.length === 10) !== (item.end.length === 10)) fail("日程开始和结束必须都是全天日期或带时区偏移的时间。");
  if (item.kind === "event" && item.start && item.end && (item.start.length === 10 ? item.start >= item.end : Date.parse(item.start) >= Date.parse(item.end))) fail("结束时间必须晚于开始时间。");
  if (item.kind === "todo" && (item.start || item.end)) fail("待办使用截止日期；预留时间请创建日程。");
  if (item.kind === "event" && item.due) fail("日程不能设置待办截止日期。");
  if (item.reminderMinutes !== null && (item.kind !== "event" || !item.start || item.start.length === 10)) fail("提醒需要带具体时间的日程。");
  if (item.recurrence) fail("暂不支持重复事项。请创建单次事项。");
  if (item.recurrence?.weekdays && item.recurrence.frequency !== "weekly") fail("星期只适用于每周重复。");
});
export type ScheduleFields = z.infer<typeof scheduleFields>;
export type ScheduleItem = ScheduleFields & { id: string; revision: number; createdAt: string; updatedAt: string };
export type ScheduleReminder = { key: string; item: ScheduleItem; conversationId: string; text?: string; delivered?: boolean; retryAt?: number; attempts: number };

/** The database is agent- and owner-bound; callers must supply neither identity nor path from model input. */
export class ScheduleStore {
  private readonly db: DatabaseSync;
  constructor(path: string, readonly agentId: string, readonly ownerId: string, private readonly reminderAvailable = false, private readonly onChange?: (id: string) => void) {
    if (!agentId || !ownerId) throw new Error("日程账户未配置。");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedule_owner (id INTEGER PRIMARY KEY CHECK(id=1), agent TEXT NOT NULL, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_items (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_reminders (fingerprint TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO schedule_owner VALUES (1,?,?)").run(agentId, ownerId);
    const owner = this.db.prepare("SELECT agent,owner FROM schedule_owner WHERE id=1").get() as { agent: string; owner: string };
    if (owner.agent !== agentId || owner.owner !== ownerId) { closeSqlite(this.db); throw new Error("日程数据库属于其他账户。"); }
  }
  canRemind(): boolean { return this.reminderAvailable; }
  reminder(fingerprint: string): ScheduleReminder | undefined {
    const row = this.db.prepare("SELECT value FROM schedule_reminders WHERE fingerprint=?").get(fingerprint) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as ScheduleReminder : undefined;
  }
  saveReminder(fingerprint: string, reminder: ScheduleReminder): void {
    this.db.prepare("INSERT INTO schedule_reminders VALUES (?,?) ON CONFLICT(fingerprint) DO UPDATE SET value=excluded.value")
      .run(fingerprint, JSON.stringify(reminder));
  }
  private fromRow(row: Record<string, unknown>): ScheduleItem {
    return { ...scheduleFields.parse(JSON.parse(String(row.value))), id: String(row.id), revision: Number(row.revision), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  list(): ScheduleItem[] { return this.db.prepare("SELECT * FROM schedule_items ORDER BY created_at DESC").all().map(row => this.fromRow(row)); }
  get(id: string): ScheduleItem {
    const row = this.db.prepare("SELECT * FROM schedule_items WHERE id=?").get(id);
    if (!row) throw new Error("日程或待办不存在。");
    return this.fromRow(row);
  }
  create(value: unknown): ScheduleItem {
    const item = scheduleFields.parse(value), id = randomUUID(), now = new Date().toISOString();
    if (item.reminderMinutes !== null && !this.reminderAvailable) throw new Error("提醒服务尚未配置。");
    if (item.parentId) { const parent = this.get(item.parentId); if (parent.kind !== "todo" || item.kind !== "todo") throw new Error("父事项必须是待办。"); }
    this.db.prepare("INSERT INTO schedule_items VALUES (?,1,?,?,?)").run(id, JSON.stringify(item), now, now);
    this.onChange?.(id);
    return this.get(id);
  }
  update(id: string, expectedRevision: number, patch: unknown): ScheduleItem {
    const result = sqliteTransaction(this.db, () => {
      const current = this.get(id);
      if (current.revision !== expectedRevision) throw new Error("事项已更改，请重新查看后操作。");
      const { id: _id, revision: _revision, createdAt: _created, updatedAt: _updated, ...fields } = current;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("修改内容无效。");
      const next = scheduleFields.parse({ ...fields, ...patch });
      if (next.reminderMinutes !== null && !this.reminderAvailable) throw new Error("提醒服务尚未配置。");
      if (next.kind !== current.kind) throw new Error("不能更改事项类型。");
      if (next.parentId) {
        const seen = new Set([id]); let parent: string | null = next.parentId;
        while (parent) { if (seen.has(parent)) throw new Error("待办层级不能循环。"); seen.add(parent); const item = this.get(parent); if (item.kind !== "todo") throw new Error("父事项必须是待办。"); parent = item.parentId; }
      }
      this.db.prepare("UPDATE schedule_items SET value=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(JSON.stringify(next), new Date().toISOString(), id, expectedRevision);
      return this.get(id);
    });
    this.onChange?.(id);
    return result;
  }
  delete(id: string, expectedRevision: number): void {
    sqliteTransaction(this.db, () => {
      const current = this.get(id);
      if (current.revision !== expectedRevision) throw new Error("事项已更改，请重新查看后操作。");
      if (this.list().some(item => item.parentId === id)) throw new Error("请先处理子待办。");
      this.db.prepare("DELETE FROM schedule_items WHERE id=?").run(id);
    });
    this.onChange?.(id);
  }
  close(): void { closeSqlite(this.db); }
}
