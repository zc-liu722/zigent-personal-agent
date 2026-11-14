/** Idle targets are decided by the Agent. Each component owns its processes and leases. */
export type NativeProcessTarget<T> = {
  key: string;
  expiresAt?: number;
  create(signal: AbortSignal): Promise<T>;
};

export type NativeProcessLease<T> = {
  process: T;
  hit: 'ready' | 'starting' | 'cold';
  release(reusable: boolean): Promise<void>;
};

type Entry<T> = {
  key: string;
  controller: AbortController;
  ready: Promise<T>;
  process?: T;
  cleanup?: Promise<void>;
};

export const NATIVE_PROCESS_IDLE_MS = 5 * 60_000;
const REPLENISH_MS = 1000;
const MAX_RETRY_MS = 60_000;

export class NativeProcessPool<T> {
  private targets = new Map<string, NativeProcessTarget<T>>();
  private readonly idle = new Map<string, Entry<T>>();
  private readonly active = new Set<Entry<T>>();
  private readonly draining = new Set<Entry<T>>();
  private readonly retries = new Map<string, { at: number; ms: number }>();
  private wake?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private readonly available: (process: T) => boolean, private readonly dispose: (process: T) => Promise<void>) {}

  setTargets(targets: readonly NativeProcessTarget<T>[]): void {
    if (this.closed) return;
    this.targets = new Map();
    // The default route is first. Several model names may share its process.
    for (const target of targets) if (!this.targets.has(target.key)) this.targets.set(target.key, target);
    this.reconcile();
  }

  private create(target: NativeProcessTarget<T>): Entry<T> {
    const controller = new AbortController();
    const entry: Entry<T> = { key: target.key, controller, ready: Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      return entry.process = await target.create(controller.signal);
    }) };
    return entry;
  }

  private backoff(key: string): void {
    if (!this.targets.has(key)) return;
    const ms = Math.min(MAX_RETRY_MS, (this.retries.get(key)?.ms ?? 500) * 2);
    this.retries.set(key, { at: Date.now() + ms, ms });
  }

  private reconcile(): void {
    clearTimeout(this.wake);
    if (this.closed) return;
    const now = Date.now();
    let wakeAt = Infinity;
    for (const [key, target] of this.targets) {
      if (target.expiresAt !== undefined && target.expiresAt <= now) this.targets.delete(key);
      else wakeAt = Math.min(wakeAt, target.expiresAt ?? Infinity);
    }
    for (const key of this.retries.keys()) if (!this.targets.has(key)) this.retries.delete(key);
    for (const [key, entry] of this.idle) {
      const unavailable = entry.process && !this.available(entry.process);
      if (!this.targets.has(key) || unavailable) {
        this.idle.delete(key);
        if (unavailable && this.targets.has(key)) this.backoff(key);
        void this.destroy(entry);
      }
    }
    // Reconcile the latest requested targets after cleanup finishes. Never
    // capture an obsolete model choice in a cleanup continuation.
    if (!this.draining.size) for (const [key, target] of this.targets) {
      if (this.idle.has(key)) continue;
      const retry = this.retries.get(key);
      if (retry && retry.at > now) { wakeAt = Math.min(wakeAt, retry.at); continue; }
      const entry = this.create(target);
      this.idle.set(key, entry);
      void entry.ready.then(() => {
        if (this.idle.get(key) !== entry) return;
        if (this.available(entry.process!)) this.retries.delete(key);
        else this.reconcile();
      }, () => {
        if (this.idle.get(key) !== entry) return;
        this.idle.delete(key);
        this.backoff(key);
        void this.destroy(entry);
      });
    }
    // Detect idle child exits even when no further browser request arrives.
    if (this.idle.size) wakeAt = Math.min(wakeAt, now + 1000);
    if (Number.isFinite(wakeAt)) {
      this.wake = setTimeout(() => this.reconcile(), Math.max(1, wakeAt - now));
      this.wake.unref();
    }
  }

  async acquire(target: NativeProcessTarget<T>, signal?: AbortSignal): Promise<NativeProcessLease<T>> {
    signal?.throwIfAborted();
    const candidate = this.idle.get(target.key);
    const expired = (this.targets.get(target.key)?.expiresAt ?? Infinity) <= Date.now();
    const entry = !expired && candidate && (!candidate.process || this.available(candidate.process)) ? candidate : undefined;
    if (entry) {
      this.idle.delete(target.key);
      if (this.targets.has(target.key)) this.retries.set(target.key, { at: Date.now() + REPLENISH_MS, ms: 0 });
      this.reconcile();
      const hit = entry.process ? 'ready' : 'starting';
      try { return await this.lease(entry, hit, signal); }
      catch (error) { if (signal?.aborted || this.closed) throw error; }
    }
    if (this.closed) throw new Error("Native process pool is closed");
    return this.lease(this.create(target), 'cold', signal);
  }

  private async lease(entry: Entry<T>, hit: NativeProcessLease<T>['hit'], signal?: AbortSignal): Promise<NativeProcessLease<T>> {
    this.active.add(entry);
    const abort = () => entry.controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const process = await entry.ready;
      entry.controller.signal.throwIfAborted();
      if (!this.available(process)) throw new Error("Native process closed during initialization");
      let released = false;
      return { process, hit, release: async reusable => {
        if (released) return;
        released = true;
        this.active.delete(entry);
        const target = this.targets.get(entry.key);
        if (!this.closed && reusable && target && (target.expiresAt ?? Infinity) > Date.now() && this.available(process)) {
          const standby = this.idle.get(entry.key);
          this.idle.set(entry.key, entry);
          // Keep the process that just served the turn, including live sessions.
          if (standby) void this.destroy(standby);
          this.retries.delete(entry.key);
          this.reconcile();
        } else {
          await this.destroy(entry);
        }
      } };
    } catch (error) {
      this.active.delete(entry);
      if (!signal?.aborted) this.backoff(entry.key);
      await this.destroy(entry);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private destroy(entry: Entry<T>): Promise<void> {
    if (entry.cleanup) return entry.cleanup;
    entry.controller.abort();
    this.draining.add(entry);
    return entry.cleanup = entry.ready.then(process => this.dispose(process), () => undefined)
      .catch(() => undefined).finally(() => {
        this.draining.delete(entry);
        this.reconcile();
      });
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.wake);
    const processes = new Set([...this.idle.values(), ...this.active, ...this.draining]);
    this.idle.clear();
    this.targets.clear();
    await Promise.all([...processes].map(entry => this.destroy(entry)));
  }
}
