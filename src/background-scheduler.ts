import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

export type ScheduledSource = { wake(): void; close(): void };
type Entry = { ready: boolean; due: number; recoveryAt: number; busy: boolean; closed: boolean; reconcile(): number | undefined | Promise<number | undefined> };

/** One deadline timer per Agent. Durable stores remain authoritative; timers are only wake-up hints. */
export class BackgroundScheduler {
  private readonly entries = new Set<Entry>();
  private timer?: ReturnType<typeof setTimeout>;
  static readonly recoveryMs = 60_000;

  status(): { mode: "deadline"; sources: number; ready: boolean; recoveryMs: number } {
    return { mode: "deadline", sources: this.entries.size, ready: [...this.entries].every(entry => entry.ready),
      recoveryMs: BackgroundScheduler.recoveryMs };
  }

  register(reconcile: Entry["reconcile"]): ScheduledSource {
    const entry: Entry = { ready: false, due: Date.now(), recoveryAt: performance.now() + BackgroundScheduler.recoveryMs, busy: false, closed: false, reconcile };
    this.entries.add(entry);
    const source = {
      wake: () => { if (!entry.closed) { entry.due = Date.now(); this.arm(); } },
      close: () => { entry.closed = true; this.entries.delete(entry); this.arm(); }
    };
    this.arm();
    return source;
  }

  private arm(): void {
    clearTimeout(this.timer);
    const now = Date.now(), elapsed = performance.now();
    const delay = Math.min(...[...this.entries].filter(entry => !entry.busy)
      .map(entry => Math.min(entry.due - now, entry.recoveryAt - elapsed)));
    if (!Number.isFinite(delay)) return;
    this.timer = setTimeout(() => this.dispatch(), Math.max(1, Math.min(BackgroundScheduler.recoveryMs, delay)));
    this.timer.unref();
  }

  private dispatch(): void {
    const now = Date.now();
    for (const entry of this.entries) {
      if (entry.busy || entry.due > now && entry.recoveryAt > performance.now()) continue;
      entry.busy = true; entry.due = Infinity;
      // Sources only collect and dispatch. Slow model/network work must not hold this reconciliation open.
      void Promise.resolve().then(() => entry.closed ? undefined : entry.reconcile()).then(next => {
        entry.ready = true;
        entry.due = Math.min(entry.due, next ?? Infinity);
      }, () => {
        entry.ready = false;
        entry.due = Date.now() + BackgroundScheduler.recoveryMs;
        console.warn("Background scheduling needs reconciliation");
      }).finally(() => {
        entry.busy = false;
        // Monotonic recovery also reconciles wall-clock corrections backwards.
        entry.recoveryAt = performance.now() + BackgroundScheduler.recoveryMs;
        this.arm();
      });
    }
    this.arm();
  }
}

/** Shared bounded execution and lifecycle; a key cannot execute/deliver twice concurrently. */
export class BackgroundWork {
  private readonly active = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private retryAt = 0;
  constructor(private readonly changed: () => void, private readonly limit = 3) {}
  get size(): number { return this.active.size; }
  get full(): boolean { return this.size >= this.limit || Date.now() < this.retryAt; }
  get keys(): string[] { return [...this.active.keys()]; }
  has(key: string): boolean { return this.active.has(key); }
  start(key: string, work: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.abort.signal.aborted || this.full || this.has(key)) return false;
    const pending = Promise.resolve().then(() => work(this.abort.signal)).catch(() => {
      this.retryAt = Date.now() + BackgroundScheduler.recoveryMs;
      console.warn("Background work needs retry; inspect private execution records");
    }).finally(() => { this.active.delete(key); this.changed(); });
    this.active.set(key, pending);
    return true;
  }
  async close(): Promise<void> {
    this.abort.abort(new Error("Background work stopped"));
    await Promise.allSettled(this.active.values());
  }
}

/** Watch the directory so WAL creation/replacement survives receiver restarts, including on Windows.
 * A filesystem event is only a hint: consume committed records using durable cursors on wake-up.
 * The scheduler's recovery sweep covers lost notifications and unavailable watchers.
 */
export function watchBackgroundInputs(paths: string[], changed: () => void): () => void {
  const directories = new Map<string, Set<string>>();
  for (const path of paths) {
    const names = directories.get(dirname(path)) ?? new Set<string>();
    names.add(basename(path)); names.add(basename(path) + "-wal");
    directories.set(dirname(path), names);
  }
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (!timer) { timer = setTimeout(() => { timer = undefined; changed(); }, 100); timer.unref(); }
  };
  for (const [directory, names] of directories) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, file) => {
        if (file === null || names.has(String(file))) wake();
      });
      watcher.on("error", () => { watcher.close(); wake(); });
      watchers.push(watcher);
    } catch { /* Recovery reconciliation remains available. */ }
  }
  return () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); };
}
