import { cpus, freemem, totalmem, uptime, platform } from 'node:os';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export type ResourceBucket = { slot: number; n: number; cpu_n: number; cpu_sum: number;
  memory_sum: number; memory_total: number; disk_sum: number; disk_n: number };
export const historyInterval = (hours: number) => hours <= 1 ? 300000 : hours <= 24 ? 1800000 : hours <= 168 ? 10800000 : 43200000;

/** Call only at work boundaries / during active work, or for an explicit live dashboard read. */
export class HostSampler {
  private priorCpu?: ReturnType<typeof cpus>;
  constructor(private readonly storage: string) {}
  reset(): void { this.priorCpu = undefined; }
  sample() {
    const cores = cpus(); let idle = 0, total = 0;
    for (const [index, core] of cores.entries()) {
      const previous = this.priorCpu?.[index]; if (!previous) continue;
      idle += core.times.idle - previous.times.idle;
      total += Object.values(core.times).reduce((n, value) => n + value, 0) - Object.values(previous.times).reduce((n, value) => n + value, 0);
    }
    this.priorCpu = cores;
    let disk: { free: number; total: number } | undefined;
    try { const info = statfsSync(dirname(this.storage)); disk = { free: info.bavail * info.bsize, total: info.blocks * info.bsize }; } catch { /* Unsupported volumes stay unavailable. */ }
    return { at: Date.now(), cpu: total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null,
      memoryUsed: totalmem() - freemem(), memoryTotal: totalmem(), disk, cores: cores.length, uptime: uptime(), platform: platform(), gatewayRss: process.memoryUsage().rss };
  }
}

export function mergeResourceHistory(rows: readonly ResourceBucket[]) {
  const groups = new Map<number, ResourceBucket>();
  for (const row of rows) {
    const group = groups.get(row.slot);
    if (!group) { groups.set(row.slot, { ...row }); continue; }
    group.n += row.n; group.cpu_n += row.cpu_n; group.cpu_sum += row.cpu_sum; group.memory_sum += row.memory_sum;
    group.memory_total = Math.max(group.memory_total, row.memory_total); group.disk_sum += row.disk_sum; group.disk_n += row.disk_n;
  }
  return [...groups.values()].sort((a, b) => a.slot - b.slot).map(row => ({ at: row.slot,
    cpu: row.cpu_n ? row.cpu_sum / row.cpu_n : null, memoryUsed: row.memory_sum / row.n,
    memoryTotal: row.memory_total, diskRatio: row.disk_n ? row.disk_sum / row.disk_n : null }));
}
