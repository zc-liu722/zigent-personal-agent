import { BackgroundScheduler, BackgroundWork, type ScheduledSource } from "../background-scheduler.js";
import { createHash } from "node:crypto";
import type { NotificationService } from "../notifications/service.js";
import type { ScheduleItem, ScheduleReminder, ScheduleStore } from "./store.js";

type Delivery = {
  conversation(): string;
  generate(item: ScheduleItem, conversationId: string, signal: AbortSignal): Promise<string>;
  deliver(reminder: ScheduleReminder, beforeSend: () => Promise<void>): Promise<unknown>;
};

export function scheduleReminderDue(item: ScheduleItem, now = Date.now()): boolean {
  if (item.kind !== "event" || item.reminderMinutes === null || !item.start || item.start.length === 10) return false;
  const start = Date.parse(item.start), due = start - item.reminderMinutes * 60000;
  return now >= due && now <= start + (item.reminderMinutes === 0 ? 60000 : 0) && now - due <= 3600000;
}

/** Persist generated prose before chat delivery; retries reuse both prose and event snapshot. */
export class ScheduleReminders {
  private source?: ScheduledSource;
  private readonly work = new BackgroundWork(() => this.source?.wake());
  private paused = false;
  private closed = false;
  get activeCount(): number { return this.work.size; }
  pause(value: boolean): void { this.paused = value; this.source?.wake(); }
  private delivery?: Delivery;
  constructor(private readonly store: ScheduleStore, private readonly notifications?: NotificationService,
    private readonly scheduler = new BackgroundScheduler()) {}
  connect(delivery: Delivery): void { this.delivery = delivery; }
  private prefix(item: ScheduleItem): string {
    const fingerprint = createHash("sha256").update(JSON.stringify([Date.parse(item.start!), item.reminderMinutes])).digest("hex");
    return `schedule:${item.id}:${fingerprint}:`;
  }
  private key(item: ScheduleItem): string { return `${this.prefix(item)}${item.revision}`; }
  changed(id: string): void {
    this.source?.wake();
    this.notifications?.cancelPendingPrefix(`schedule:${id}:`);
    this.notifications?.cancelPendingPrefix(`background:schedule:${id}:`);
  }
  private current(item: ScheduleItem): boolean {
    try { return !this.closed && this.store.get(item.id).revision === item.revision && scheduleReminderDue(item); }
    catch { return false; }
  }
  start(): void {
    if (this.source || !this.delivery || this.closed) return;
    this.source = this.scheduler.register(() => this.reconcile());
  }
  private reconcile(): number | undefined {
    if (this.paused || this.closed) return;
    const now = Date.now(), items = this.store.list();
    this.notifications?.reconcilePendingSchedule(new Set(items.filter(item => scheduleReminderDue(item, now)).map(item => this.key(item))));
    let next = Infinity;
    for (const item of items.sort((a, b) => Date.parse(a.start ?? "") - Date.parse(b.start ?? ""))) {
      if (item.kind !== "event" || item.reminderMinutes === null || !item.start || item.start.length === 10 || this.work.has(item.id)) continue;
      const due = Date.parse(item.start) - item.reminderMinutes * 60000;
      const prefix = this.prefix(item), saved = this.store.reminder(prefix);
      if (saved?.delivered || this.notifications?.hasDispatchedPrefix(prefix)) continue;
      if (due > now) { next = Math.min(next, due); continue; }
      if (!scheduleReminderDue(item, now)) continue;
      if (saved?.key === this.key(item) && (saved.retryAt ?? 0) > now) {
        next = Math.min(next, saved.retryAt!); continue;
      }
      this.work.start(item.id, signal => this.process(item, signal));
    }
    return Number.isFinite(next) ? next : undefined;
  }
  private async process(item: ScheduleItem, shutdown: AbortSignal): Promise<void> {
    const prefix = this.prefix(item), key = this.key(item);
    // Respect notices sent by the previous phone-only implementation during upgrades.
    if (this.notifications?.hasDispatchedPrefix(prefix)) return;
    this.notifications?.cancelPendingPrefix(prefix);
    let reminder = this.store.reminder(prefix);
    if (reminder?.delivered) return;
    if (!reminder || reminder.key !== key) {
      reminder = { key, item, conversationId: this.delivery!.conversation(), attempts: 0 };
      this.store.saveReminder(prefix, reminder);
    }
    if ((reminder.retryAt ?? 0) > Date.now()) return;
    const beforeSend = async () => { if (!this.current(item)) throw new Error("Schedule reminder is no longer current"); };
    try {
      await beforeSend();
      if (!reminder.text) {
        const signal = AbortSignal.any([shutdown, AbortSignal.timeout(120000)]);
        const text = (await this.delivery!.generate(item, reminder.conversationId, signal)).trim();
        await beforeSend();
        if (!text || [...text].length > 180) throw new Error("Schedule reminder must be brief");
        reminder.text = text;
        this.store.saveReminder(prefix, reminder);
      }
      await beforeSend();
      await this.delivery!.deliver(reminder, beforeSend);
      reminder.delivered = true;
      this.store.saveReminder(prefix, reminder);
    } catch {
      if (shutdown.aborted) return;
      reminder.attempts++;
      reminder.retryAt = Date.now() + Math.min(300000, 30000 * 2 ** Math.min(reminder.attempts - 1, 4));
      this.store.saveReminder(prefix, reminder);
      console.warn("Schedule reminder deferred; generation or chat delivery needs retry");
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.source?.close(); await this.work.close();
  }
}
