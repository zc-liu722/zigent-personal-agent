import { summarizeLatency, type HistogramRow } from "./summary.js";
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
import { closeSqlite, prepareSql } from '../sqlite.js';
import { preciseHistogramBucket, type BrowserTiming, type LatencyMetric, type Outcome } from './metrics.js';
import { HostSampler, historyInterval, type ResourceBucket } from './resources.js';

type Scope = { store: PerformanceStore; trace: string; span?: string; model?: string; detail?: string };
type Sample = { metric: LatencyMetric; detail: string; ms: number; outcome: Outcome; at: number; trace: string; span: string; parent?: string; timing?: BrowserTiming };
const context = new AsyncLocalStorage<Scope>();
const DAY = 86400000, STEP = 300000;
let networkInstalled = false;
/** No URLs, headers, payloads, user identifiers or error text enter this store. */
export class PerformanceStore {
  private readonly db: DatabaseSync;
  private pending: Sample[] = [];
  private closed = false;
  private dropped = 0;
  private lastPrune = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private resourceTimer?: ReturnType<typeof setInterval>;
  private lagTimer?: ReturnType<typeof setInterval>;
  private active = 0;
  private lagTick = 0;
  private observations = 0;
  private lastActivityAt?: number;
  private readonly host: HostSampler;
  private resources = new Map<number, ResourceBucket>();
  private latestRuntime?: { at: number; pid: number; uptime: number; rss: number; heap: number; cpu: number | null; dropped: number };
  private cpu = process.cpuUsage();
  private cpuAt = performance.now();
  constructor(path: string, readonly agentId: string, private readonly readOnly = false) {
    this.host = new HostSampler(path);
    this.db = new DatabaseSync(path + '.performance.sqlite', { readOnly });
    if (readOnly) { this.db.exec('PRAGMA busy_timeout=250'); return; }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
      CREATE TABLE IF NOT EXISTS aggregate (slot INTEGER, metric TEXT, detail TEXT, bucket INTEGER, outcome TEXT, n INTEGER, total REAL, maximum REAL,
        PRIMARY KEY(slot,metric,detail,bucket,outcome));
      CREATE TABLE IF NOT EXISTS aggregate_v2 (slot INTEGER, metric TEXT, detail TEXT, bucket REAL, outcome TEXT, n INTEGER, total REAL, maximum REAL,
        PRIMARY KEY(slot,metric,detail,bucket,outcome));
      CREATE TABLE IF NOT EXISTS spans (id INTEGER PRIMARY KEY, at INTEGER, metric TEXT, detail TEXT, ms REAL, outcome TEXT, trace TEXT, span TEXT, parent TEXT);
      CREATE TABLE IF NOT EXISTS runtime (singleton INTEGER PRIMARY KEY, at INTEGER, pid INTEGER, uptime REAL, rss INTEGER, heap INTEGER, cpu REAL, dropped INTEGER);
      CREATE TABLE IF NOT EXISTS resource_history (slot INTEGER PRIMARY KEY, n INTEGER, cpu_n INTEGER, cpu_sum REAL,
        memory_sum REAL, memory_total REAL, disk_sum REAL, disk_n INTEGER);
      CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace); CREATE INDEX IF NOT EXISTS spans_time ON spans(at);`);
    if (!(this.db.prepare('PRAGMA table_info(spans)').all() as Array<{ name: string }>).some(column => column.name === 'timing')) this.db.exec('ALTER TABLE spans ADD COLUMN timing TEXT');
    installNetworkMetrics();
  }
  /** Explicit work lifetime. Nested / concurrent operations share collectors until the last one ends. */
  beginActivity(): () => void {
    if (this.closed || this.readOnly) return () => {};
    if (this.active++ === 0) {
      this.cpu = process.cpuUsage(); this.cpuAt = performance.now(); this.host.reset();
      this.sampleResources(false);
      this.lagTick = performance.now();
      this.lagTimer = setInterval(() => {
        const now = performance.now(); this.record('server.event_loop', Math.max(0, now - this.lagTick - 1000)); this.lagTick = now;
      }, 1000); this.lagTimer.unref();
      this.resourceTimer = setInterval(() => this.sampleResources(), 5000); this.resourceTimer.unref();
    }
    let ended = false;
    return () => {
      if (ended || this.closed) return; ended = true;
      this.lastActivityAt = Date.now();
      if (--this.active === 0) {
        // A synchronous operation can finish before an overdue timer gets a turn.
        const overdue = performance.now() - this.lagTick - 1000;
        if (overdue >= 0) this.record('server.event_loop', overdue);
        clearInterval(this.resourceTimer); this.resourceTimer = undefined;
        clearInterval(this.lagTimer); this.lagTimer = undefined;
        this.sampleResources();
      }
    };
  }
  activity<T>(operation: () => T): T {
    const end = this.beginActivity();
    try {
      const result = operation();
      if (result instanceof Promise) return result.finally(end) as T;
      end(); return result;
    } catch (error) { end(); throw error; }
  }
  /** A live health read does not sample resources, enqueue observations or touch SQLite. */
  activityState() {
    return { mode: 'on-demand' as const, histogramVersion: 2, active: this.active, sampling: Boolean(this.resourceTimer || this.lagTimer),
      flushPending: Boolean(this.flushTimer), pendingSamples: this.pending.length, pendingResources: this.resources.size,
      lastActivityAt: this.lastActivityAt, observations: this.observations, uptime: process.uptime(), runtime: this.latestRuntime };
  }
  private scheduleFlush(): void {
    if (this.flushTimer || this.closed || this.readOnly) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, 5000); this.flushTimer.unref();
  }
  private sampleResources(withCpu = true): void {
    const host = this.host.sample(), now = performance.now(), cpu = process.cpuUsage(this.cpu), memory = process.memoryUsage();
    this.latestRuntime = { at: host.at, pid: process.pid, uptime: process.uptime(), rss: memory.rss, heap: memory.heapUsed,
      cpu: withCpu ? (cpu.user + cpu.system) / Math.max(1, now - this.cpuAt) / 10 : null, dropped: this.dropped };
    this.cpu = process.cpuUsage(); this.cpuAt = now;
    const disk = host.disk?.total ? 1 - host.disk.free / host.disk.total : undefined;
    const slot = Math.floor(host.at / STEP) * STEP, group = this.resources.get(slot);
    if (group) {
      group.n++; group.cpu_n += host.cpu == null ? 0 : 1; group.cpu_sum += host.cpu ?? 0; group.memory_sum += host.memoryUsed;
      group.memory_total = host.memoryTotal; group.disk_sum += disk ?? 0; group.disk_n += disk == null ? 0 : 1;
    } else this.resources.set(slot, { slot, n: 1, cpu_n: host.cpu == null ? 0 : 1, cpu_sum: host.cpu ?? 0,
      memory_sum: host.memoryUsed, memory_total: host.memoryTotal, disk_sum: disk ?? 0, disk_n: disk == null ? 0 : 1 });
    this.scheduleFlush();
  }
  scope<T>(operation: () => T, trace?: string): T {
    const current = context.getStore();
    return current?.store === this && !trace ? operation() : context.run({ store: this, trace: trace ?? randomUUID() }, operation);
  }
  record(metric: LatencyMetric, ms: number, detail = '', outcome: Outcome = 'ok', trace?: string, timing?: BrowserTiming): Sample | undefined {
    if (this.closed || this.readOnly || !Number.isFinite(ms) || ms < 0 || ms > DAY) return;
    if (this.pending.length >= 4000) { this.dropped++; return; }
    const scope = context.getStore();
    const sample: Sample = { metric, detail: detail.slice(0, 160), ms, outcome, at: Date.now(), trace: trace ?? (scope?.store === this ? scope.trace : randomUUID()),
      span: randomUUID(), parent: scope?.store === this ? scope.span : undefined, timing };
    this.pending.push(sample); this.observations++; this.scheduleFlush(); return sample;
  }
  async measure<T>(metric: LatencyMetric, detail: string, operation: () => Promise<T>, model?: string, classify?: (result: T) => Outcome): Promise<T> {
    return this.activity(() => this.scope(async () => {
      const scope = context.getStore()!, span = randomUUID(), started = performance.now();
      let outcome: Outcome = 'ok';
      try {
        const result = await context.run({ ...scope, span, detail, model: model ?? scope.model }, operation);
        outcome = classify?.(result) ?? "ok"; return result;
      }
      catch (error) { outcome = error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error'; throw error; }
      finally {
        const sample = this.record(metric, performance.now() - started, detail, outcome);
        if (sample?.trace === scope.trace && sample.metric === metric) { sample.span = span; sample.parent = scope.span; }
      }
    }));
  }
  flush(): void {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    if (this.closed || this.readOnly || !this.pending.length && !this.resources.size) return;
    const batch = this.pending.splice(0);
    const resources = [...this.resources.values()]; this.resources.clear();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const insert = prepareSql(this.db, 'INSERT INTO spans(at,metric,detail,ms,outcome,trace,span,parent,timing) VALUES(?,?,?,?,?,?,?,?,?)');
      const aggregate = prepareSql(this.db, `INSERT INTO aggregate_v2 VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(slot,metric,detail,bucket,outcome)
        DO UPDATE SET n=n+excluded.n,total=total+excluded.total,maximum=MAX(maximum,excluded.maximum)`);
      const groups = new Map<string, { slot: number; sample: Sample; bucket: number; n: number; total: number; maximum: number }>();
      for (const s of batch) {
        const bucket = preciseHistogramBucket(s.ms), slot = Math.floor(s.at / STEP) * STEP;
        const key = JSON.stringify([slot, s.metric, s.detail, bucket, s.outcome]), group = groups.get(key);
        if (group) { group.n++; group.total += s.ms; group.maximum = Math.max(group.maximum, s.ms); }
        else groups.set(key, { slot, sample: s, bucket, n: 1, total: s.ms, maximum: s.ms });
        // Event-loop samples need no individual trace storage.
        if (s.metric !== 'server.event_loop') insert.run(s.at, s.metric, s.detail, s.ms, s.outcome, s.trace, s.span, s.parent ?? null, s.timing ? JSON.stringify(s.timing) : null);
      }
      for (const { slot, sample: s, bucket, n, total, maximum } of groups.values()) aggregate.run(slot, s.metric, s.detail, bucket, s.outcome, n, total, maximum);
      const resource = prepareSql(this.db, `INSERT INTO resource_history VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET
        n=n+excluded.n,cpu_n=cpu_n+excluded.cpu_n,cpu_sum=cpu_sum+excluded.cpu_sum,memory_sum=memory_sum+excluded.memory_sum,
        memory_total=excluded.memory_total,disk_sum=disk_sum+excluded.disk_sum,disk_n=disk_n+excluded.disk_n`);
      for (const row of resources) resource.run(row.slot, row.n, row.cpu_n, row.cpu_sum, row.memory_sum, row.memory_total, row.disk_sum, row.disk_n);
      this.db.exec('DELETE FROM spans WHERE id <= (SELECT COALESCE(MAX(id),0)-20000 FROM spans)');
      const snapshot = this.latestRuntime;
      if (snapshot) prepareSql(this.db, 'INSERT OR REPLACE INTO runtime VALUES(1,?,?,?,?,?,?,?)').run(snapshot.at, snapshot.pid, snapshot.uptime,
        snapshot.rss, snapshot.heap, snapshot.cpu, this.dropped);
      const now = Date.now(), pruneDue = now - this.lastPrune > 3600000;
      if (pruneDue) this.prune(now);
      this.db.exec('COMMIT');
      if (pruneDue) this.lastPrune = now;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* Collection must never fail a user operation. */ }
      this.dropped += batch.length;
    }
  }
  private prune(now: number): void {
    this.db.exec(`DELETE FROM spans WHERE at < ${now - 7 * DAY};
      DELETE FROM aggregate WHERE slot < ${now - 30 * DAY};
      DELETE FROM aggregate_v2 WHERE slot < ${now - 30 * DAY};
      DELETE FROM resource_history WHERE slot < ${now - 30 * DAY};`);
  }
  report(hours: number, model = '') {
    this.flush();
    const since = Math.floor((Date.now() - hours * 3600000) / STEP) * STEP;
    const intervalMs = hours <= 1 ? STEP : hours <= 24 ? 6*STEP : hours <= 168 ? 36*STEP : 144*STEP;
    const parameters = model ? [since, model] : [since];
    const hasPrecise = prepareSql(this.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='aggregate_v2'").get();
    const source = `(SELECT *,1 AS version FROM aggregate${hasPrecise ? ' UNION ALL SELECT *,2 AS version FROM aggregate_v2' : ''})`;
    const selection = `FROM ${source} WHERE slot>=? ${model ? 'AND detail=?' : ''}`;
    const rows = prepareSql(this.db, `SELECT metric,bucket,version,outcome,SUM(n) AS n,SUM(total) AS total,MAX(maximum) AS maximum
      ${selection} GROUP BY metric,bucket,version,outcome`).all(...parameters) as HistogramRow[];
    const series = prepareSql(this.db, `SELECT CAST(slot/${intervalMs} AS INTEGER)*${intervalMs} AS at,
      metric,bucket,version,outcome,SUM(n) AS n,SUM(total) AS total,MAX(maximum) AS maximum
      ${selection} GROUP BY at,metric,bucket,version,outcome ORDER BY at`).all(...parameters) as HistogramRow[];
    return { quantiles: 'versioned-histogram-upper-bound', histogramVersion: 2, targets: 'initial-budget-v1', agent: this.agentId, generatedAt: Date.now(), since, hours,
      dropped: this.dropped, retentionDays: 30, intervalMs,
      metrics: summarizeLatency(rows, false, true), series: summarizeLatency(series, true) };
  }

  snapshot() {
    try { return prepareSql(this.db, 'SELECT at,pid,uptime,rss,heap,cpu,dropped FROM runtime WHERE singleton=1').get(); } catch { return undefined; }
  }
  resourceHistory(hours: number): ResourceBucket[] {
    const interval = historyInterval(hours), since = Math.floor((Date.now() - hours * 3600000) / STEP) * STEP;
    // An older release has no resource table; its latency history remains readable.
    if (!prepareSql(this.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='resource_history'").get()) return [];
    return prepareSql(this.db, `SELECT CAST(slot/${interval} AS INTEGER)*${interval} AS slot,SUM(n) AS n,SUM(cpu_n) AS cpu_n,
      SUM(cpu_sum) AS cpu_sum,SUM(memory_sum) AS memory_sum,MAX(memory_total) AS memory_total,SUM(disk_sum) AS disk_sum,SUM(disk_n) AS disk_n
      FROM resource_history WHERE slot>=? GROUP BY 1 ORDER BY 1`).all(since) as ResourceBucket[];
  }
  trace(id: string) {
    this.flush();
    return prepareSql(this.db, 'SELECT at,metric,detail,ms,outcome,trace,span,parent FROM spans WHERE trace=? ORDER BY at,id LIMIT 200').all(id);
  }
  close(): void { clearInterval(this.resourceTimer); clearInterval(this.lagTimer); this.flush(); this.closed = true; closeSqlite(this.db); }
}
export function currentPerformance() { return context.getStore(); }

/** Node fetch / undici lifecycle events; connections can be reused, so headers includes connection setup and provider wait. */
function installNetworkMetrics(): void {
  if (networkInstalled) return; networkInstalled = true;
  const requests = new WeakMap<object, { scope: Scope; started: number; detail: string; status?: number }>();
  channel('undici:request:create').subscribe(value => {
    const scope = context.getStore(); if (!scope) return;
    const { request } = value as { request: { origin: string } };
    // Attribute to canonical model or tool span; arbitrary URL hostnames never become labels.
    const detail = scope.model ?? scope.detail ?? 'external';
    requests.set(request, { scope, started: performance.now(), detail });
  });
  channel('undici:request:headers').subscribe(value => {
    const { request, response } = value as { request: object; response: { statusCode: number } };
    const item = requests.get(request); if (!item) return; item.status = response.statusCode;
    context.run(item.scope, () => item.scope.store.record('network.headers', performance.now() - item.started, item.detail, response.statusCode >= 400 ? 'error' : 'ok'));
  });
  const finish = (value: unknown, failed: boolean) => {
    const { request, error } = value as { request: object; error?: { name?: string } };
    const item = requests.get(request); if (!item) return; requests.delete(request);
    context.run(item.scope, () => item.scope.store.record('network.total', performance.now() - item.started, item.detail,
      error?.name === 'AbortError' ? 'cancelled' : failed || (item.status ?? 200) >= 400 ? 'error' : 'ok'));
  };
  channel('undici:request:trailers').subscribe(value => finish(value, false));
  channel('undici:request:error').subscribe(value => finish(value, true));
}
