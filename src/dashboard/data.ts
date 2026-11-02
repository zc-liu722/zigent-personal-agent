import { DatabaseSync } from "node:sqlite";
import { closeSqlite, prepareSql } from "../sqlite.js";
import { mergeLatency } from "../performance/summary.js";
import { existsSync } from 'node:fs';
import { HostSampler, historyInterval, mergeResourceHistory, type ResourceBucket } from '../performance/resources.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Manifest } from '../config/schemas.js';
import { PerformanceStore } from '../performance/store.js';
import { UsageStore } from '../usage/store.js';
import { emptyTotals, type UsageReport, type UsageTotals } from '../usage/types.js';

const sumTotals = (into: UsageTotals, from: UsageTotals) => {
  for (const key of Object.keys(emptyTotals()) as Array<keyof UsageTotals>) {
    if (key === 'costs' || key === 'estimatedCosts') into[key].USD += from[key].USD;
    else into[key] += from[key];
  }
};
function mergeUsage(reports: UsageReport[], period: string) {
  const totals = emptyTotals(), models = new Map<string, UsageReport['models'][number]>(), days = new Map<string, UsageReport['days'][number]>();
  const available = new Map<string, UsageReport['availableModels'][number]>();
  for (const report of reports) {
    sumTotals(totals, report.totals);
    for (const model of report.availableModels) available.set(model.key, model);
    for (const model of report.models) {
      let row = models.get(model.key);
      if (!row) { row = { ...model, ...emptyTotals() }; models.set(model.key, row); }
      row.kinds = [...new Set([...row.kinds, ...model.kinds])]; row.billingTypes = [...new Set([...(row.billingTypes ?? []), ...(model.billingTypes ?? [])])]; sumTotals(row, model);
    }
    for (const day of report.days) {
      let row = days.get(day.date);
      if (!row) { row = { date: day.date, ...emptyTotals() }; days.set(day.date, row); }
      sumTotals(row, day);
    }
  }
  // Normalize mixed daily/monthly reports when a long all-time range includes a new Agent.
  const monthly = [...days.keys()].some(date => date.length === 7), normalized = new Map<string, UsageReport['days'][number]>();
  for (const day of days.values()) {
    const date = monthly ? day.date.slice(0, 7) : day.date;
    let row = normalized.get(date);
    if (!row) { row = { date, ...emptyTotals() }; normalized.set(date, row); } sumTotals(row, day);
  }
  return { period, totals, models: [...models.values()].sort((a,b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens),
    days: [...normalized.values()].sort((a,b) => a.date.localeCompare(b.date)), availableModels: [...available.values()], timezone: 'Asia/Shanghai' };
}
export class DashboardData {
  private readonly hostSampler: HostSampler;
  private host?: ReturnType<HostSampler['sample']>;
  private historyDb?: DatabaseSync;
  private historyState = 'ready';
  private release?: string;
  private cache = new Map<string, { at: number; value: Promise<Awaited<ReturnType<DashboardData['build']>>> }>();
  constructor(readonly manifest: Manifest, storage: string) {
    this.hostSampler = new HostSampler(storage);
    // Preserve the existing continuous history without creating or updating it.
    if (existsSync(storage + '.metrics.sqlite')) try {
      this.historyDb = new DatabaseSync(storage + '.metrics.sqlite', { readOnly: true });
      this.historyDb.exec('PRAGMA busy_timeout=250');
    } catch { this.historyState = 'unavailable'; this.historyDb?.close(); this.historyDb = undefined; }
    void readFile(new URL('../../release.json', import.meta.url), 'utf8').then(text => { this.release = JSON.parse(text).commit; }).catch(() => {});
  }
  private resourceHistory(hours: number, now: number, rows: ResourceBucket[]) {
    const intervalMs = historyInterval(hours), since = Math.floor((now - hours * 3600000) / 300000) * 300000;
    if (this.historyDb) try {
      rows = [...rows, ...prepareSql(this.historyDb, `SELECT CAST(slot/${intervalMs} AS INTEGER)*${intervalMs} AS slot,
        SUM(n) AS n,SUM(cpu_n) AS cpu_n,SUM(cpu_sum) AS cpu_sum,SUM(memory_sum) AS memory_sum,
        MAX(memory_total) AS memory_total,SUM(disk_sum) AS disk_sum,SUM(disk_n) AS disk_n
        FROM host_history WHERE slot>=? GROUP BY 1 ORDER BY 1`).all(since) as ResourceBucket[]];
      this.historyState = 'ready';
    } catch { this.historyState = 'unavailable'; }
    return { intervalMs, points: mergeResourceHistory(rows) };
  }
  private async liveStatus(agent: Manifest['agents'][number]) {
    if (!agent.enabled) return { state: 'disabled' as const };
    if (!agent.web) return { state: 'unavailable' as const };
    try {
      // Independent health checks are triggered only by an authenticated dashboard read.
      // /healthz bypasses instrumentation and never refreshes the stored activity snapshot.
      const response = await fetch(`http://127.0.0.1:${agent.web.listenPort}/healthz`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) throw new Error('health');
      const body = await response.json() as { status?: string; channel?: string; monitoring?: ReturnType<PerformanceStore['activityState']> };
      if (body.status !== 'ok' || body.channel !== 'web') throw new Error('health');
      const monitoring = body.monitoring;
      if (monitoring?.mode !== 'on-demand' || !Number.isSafeInteger(monitoring.active) || monitoring.active < 0) return { state: 'online' as const };
      return { state: monitoring.active > 0 ? 'busy' as const : 'idle' as const, monitoring };
    } catch { return { state: 'unavailable' as const }; }
  }
  report(hours: number, period: 'today' | '7d' | '30d' | 'all', agent: string, model: string) {
    const key = JSON.stringify([hours, period, agent, model]), cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 5000) return cached.value;
    const value = this.build(hours, period, agent, model).catch(error => { this.cache.delete(key); throw error; });
    this.cache.set(key, { at: Date.now(), value });
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
  private async build(hours: number, period: 'today' | '7d' | '30d' | 'all', selected: string, model: string) {
    const allReports = await Promise.all(this.manifest.agents.map(async agent => {
      const health = await this.liveStatus(agent);
      let resourceRows: ResourceBucket[] = [];
      let performance: ReturnType<PerformanceStore['report']> | undefined, runtime: ReturnType<PerformanceStore['snapshot']>;
      let usage: UsageReport | undefined;
      let metricsState = 'unavailable', usageState = 'unavailable';
      let reader: PerformanceStore | undefined, usageReader: UsageStore | undefined;
      try {
        reader = new PerformanceStore(resolve(agent.storage.sqlite), agent.id, true);
        performance = reader.report(hours); runtime = reader.snapshot(); resourceRows = reader.resourceHistory(hours); metricsState = 'ready';
      } catch { /* One missing or locked database must not hide other Agents. */ }
      finally { reader?.close(); }
      try {
        usageReader = new UsageStore(resolve(agent.storage.sqlite), agent.id, undefined, true);
        const usageNow=Date.now(), chartInterval=period==='today'?'hour':'day';
        usage = usageReader.reportForModel(period, model, usageNow, chartInterval);
        usageState = 'ready';
      } catch { /* No fabricated zeros: status distinguishes unavailable data. */ }
      finally { usageReader?.close(); }
      // A current process may be idle for days; old disk snapshots never establish liveness.
      if (health.monitoring) runtime = { ...health.monitoring.runtime, uptime: health.monitoring.uptime };
      else if (runtime) runtime = { ...runtime, uptime: null };
      return { id: agent.id, name: agent.name, enabled: agent.enabled, state: health.state, metricsState, usageState, runtime,
        lastActivityAt: health.monitoring?.lastActivityAt, performance, resourceRows, usage };
    }));
    const reports = allReports.filter(agent => !selected || agent.id === selected);
    const catalog = [...(this.manifest.catalog?.models ?? []), ...this.manifest.agents.flatMap(agent => agent.models ?? [])];
    const configured = new Map(catalog.map(model => [model.name, model]));
    const usage = mergeUsage(reports.flatMap(report => report.usage ? [report.usage] : []), period);
    const modelList = new Set([...configured.keys(), ...usage.availableModels.map(model => model.model)]);
    const generatedAt=Date.now(), resources=this.resourceHistory(hours, generatedAt, allReports.flatMap(agent => agent.resourceRows));
    if (!this.host || generatedAt - this.host.at >= 5000) {
      if (!this.host || generatedAt - this.host.at > 35000) this.hostSampler.reset();
      this.host = this.hostSampler.sample();
    }
    return { generatedAt, timezone: 'Asia/Shanghai', hours, period, selectedAgent: selected, selectedModel: model,
      release: this.release, host: this.host, hostHistory: resources.points, hostHistoryIntervalMs: resources.intervalMs, hostHistoryState: this.historyState,
      availableAgents: this.manifest.agents.map(({ id, name, enabled }) => ({ id, name, enabled })), models: [...modelList].sort(),
      performance: { quantiles: 'versioned-histogram-upper-bound', histogramVersion: 2,
        metrics: mergeLatency(reports.flatMap(agent => agent.performance?.metrics ?? [])),
        series: mergeLatency(reports.flatMap(agent => agent.performance?.series ?? []), true),
        intervalMs: reports.find(agent => agent.performance)?.performance?.intervalMs,
        availableAgents: reports.filter(agent => agent.metricsState === 'ready').length,
        unavailableAgents: reports.filter(agent => agent.enabled && agent.metricsState !== 'ready').map(agent => agent.id),
        dropped: reports.reduce((n, agent) => n + Number(agent.runtime?.dropped ?? 0), 0) },
      agents: reports.map(({ performance, resourceRows, ...agent }) => agent), usage: { ...usage, models: usage.models.map(model => ({ ...model, costType: model.billingTypes?.length ? model.billingTypes.length === 1 ? model.billingTypes[0] : 'mixed' : configured.get(model.model)?.cost?.type ?? this.manifest.catalog?.suppliers?.[model.supplier]?.cost.type ?? 'unknown' })) } };
  }
  close() { this.cache.clear(); if(this.historyDb) closeSqlite(this.historyDb); }
}
