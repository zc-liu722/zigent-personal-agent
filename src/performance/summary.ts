import { latencyMetrics, replyAboveTargetBucket, type LatencyMetric } from './metrics.js';

export type HistogramRow = { metric: LatencyMetric; bucket: number; version?: 1 | 2; outcome: string; n: number; total: number; maximum: number; at?: number };
type HistogramBin = [bucket: number, count: number, version: 1 | 2];
type Distribution = { metric: LatencyMetric; at?: number; count: number; errors: number; cancelled: number; total: number; max: number; within: number; ambiguous: number; legacySuccess: number; histogram: Map<string, HistogramBin> };

const upperBound = (metric: LatencyMetric, bucket: number, version: 1 | 2) =>
  version === 1 && metric === 'web.reply_first' && bucket === replyAboveTargetBucket ? 10000 : bucket;

/** Merge bucket counts, never percentile values or percentages. Durations include successes only. */
export function summarizeLatency(rows: readonly HistogramRow[], timed = false, includeEmpty = false) {
  const distributions = new Map<string, Distribution>();
  const obtain = (metric: LatencyMetric, at?: number) => {
    const key = timed ? `${metric}:${at}` : metric;
    let group = distributions.get(key);
    if (!group) { group = { metric, ...(timed ? { at } : {}), count: 0, errors: 0, cancelled: 0, total: 0, max: 0, within: 0, ambiguous: 0, legacySuccess: 0, histogram: new Map() }; distributions.set(key, group); }
    return group;
  };
  for (const row of rows) {
    const meta = latencyMetrics[row.metric]; if (!meta) continue;
    const group = obtain(row.metric, row.at);
    group.count += row.n;
    if (row.outcome === 'error') group.errors += row.n;
    else if (row.outcome === 'cancelled') group.cancelled += row.n;
    else {
      group.total += row.total; group.max = Math.max(group.max, row.maximum);
      const version = row.version ?? 1, key = `${version}:${row.bucket}`;
      if (row.n) {
        const bin = group.histogram.get(key);
        if (bin) bin[1] += row.n;
        else group.histogram.set(key, [row.bucket, row.n, version]);
      }
      if (version === 1) group.legacySuccess += row.n;
      if (row.bucket <= meta.target) group.within += row.n;
      else if (version === 1 && row.metric === 'web.reply_first' && row.bucket === 10000) group.ambiguous += row.n;
    }
  }
  if (includeEmpty) for (const metric of Object.keys(latencyMetrics) as LatencyMetric[]) obtain(metric);
  return [...distributions.values()].map(group => {
    const meta = latencyMetrics[group.metric], success = group.count - group.errors - group.cancelled;
    const histogram = [...group.histogram.values()].sort((a,b) => upperBound(group.metric, a[0], a[2])-upperBound(group.metric, b[0], b[2]) || a[2]-b[2]);
    const percentile = (percent: number) => {
      if (!success) return null;
      let count = 0; for (const [bucket,n,version] of histogram) {
        count += n;
        if (count >= Math.ceil(success*percent/100)) return Math.min(group.max, upperBound(group.metric, bucket, version));
      }
      return null;
    };
    return { metric: group.metric, ...meta, ...(timed ? { at: group.at! } : {}), count: group.count, success, errors: group.errors, cancelled: group.cancelled,
      total: group.total, histogram, legacySuccess: group.legacySuccess, avg: success ? group.total/success : null, max: success ? group.max : null,
      p50: percentile(50), p75: percentile(75), p95: percentile(95), p99: percentile(99),
      errorRate: group.count > group.cancelled ? group.errors/(group.count-group.cancelled) : null,
      compliance: success ? group.within/success : null,
      complianceMax: success ? (group.within + group.ambiguous)/success : null,
      status: success < 20 ? 'collecting' : group.within >= Math.ceil(success * meta.percentile / 100) ? 'good'
        : group.within + group.ambiguous >= Math.ceil(success * meta.percentile / 100) ? 'uncertain' : 'slow' };
  });
}
export type LatencySummary = ReturnType<typeof summarizeLatency>[number];
export function mergeLatency(summaries: readonly LatencySummary[], timed = false) {
  const rows: HistogramRow[] = [];
  for (const summary of summaries) {
    let first = true;
    for (const [bucket,n,version] of summary.histogram) {
      rows.push({ metric: summary.metric, at: summary.at, bucket, version, outcome: 'ok', n, total: first ? summary.total : 0, maximum: first ? summary.max ?? 0 : 0 }); first = false;
    }
    for (const [outcome,n] of [['error',summary.errors],['cancelled',summary.cancelled]] as const) {
      if (n) rows.push({ metric: summary.metric, at: summary.at, bucket: 0, outcome, n, total: 0, maximum: 0 });
    }
  }
  return summarizeLatency(rows, timed, !timed);
}
