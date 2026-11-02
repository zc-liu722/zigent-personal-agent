import type { CodexService } from "./service.js";
import type { CodexTask } from "./types.js";

/** Results are reviewed only under an explicit, persisted user authorization. */
export class CodexSupervisor {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private stopped = false;
  private readonly reviews = new Map<string, Promise<void>>();
  private readonly rendered = new Map<string, number>();
  private readonly retryAfter = new Map<string, number>();
  constructor(private readonly service: CodexService,
    private readonly delivery: { status(task: CodexTask): Promise<void>; result(task: CodexTask, key: string): Promise<void>; review?(task: CodexTask): Promise<void> }) {}
  start() { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 2000); this.timer.unref(); void this.tick().catch(() => {}); }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve(); if (this.work) return this.work;
    this.work = this.run().finally(() => { this.work = undefined; }); return this.work;
  }
  private async run() {
    this.service.store.sweep();
    for (const task of this.service.store.all()) {
      if (this.stopped) return;
      if ((this.retryAfter.get(task.id) ?? 0) > Date.now()) continue;
      try {
        if (this.rendered.get(task.id) !== task.revision) {
          await this.delivery.status(task); this.rendered.set(task.id, task.revision);
        }
        if (task.state === "succeeded" && task.review && ["pending", "running"].includes(task.review.state)) {
          if (this.delivery.review && !this.reviews.has(task.id)) {
            const work = this.delivery.review(task).catch(() => {}).finally(() => this.reviews.delete(task.id));
            this.reviews.set(task.id, work);
          }
          continue;
        }
        if (task.review?.state === "continued" || !task.notification.startsWith("pending:")) continue;
        const pending = task.notification;
        await this.delivery.result(task, `codex:${task.id}:${pending.slice(8)}`);
        this.service.store.update(task.id, current => { if (current.notification === pending) current.notification = "delivered:" + pending.slice(8); });
        this.retryAfter.delete(task.id);
      } catch { this.retryAfter.set(task.id, Date.now() + 30000); }
    }
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.work?.catch(() => {}); await Promise.allSettled(this.reviews.values()); }
}
