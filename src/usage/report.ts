import type { DatabaseSync } from "node:sqlite";
import { prepareSql } from "../sqlite.js";
import type { UsageModelIdentity } from "./media-identity.js";
import { emptyTotals, modelUsageKey, type Currency, type UsageReport, type UsageTotals } from "./types.js";

export const accountedUsage = "supplier<>'unknown' AND length(trim(supplier))>0 AND (missing_usage=0 AND estimated_tokens=0 OR price_status='subscription') AND price_status<>'excluded' AND outcome<>'rejected'";
const DAY = 86_400_000, OFFSET = 8 * 3_600_000;
export const usageDateKey = (at: number) => new Date(at + OFFSET).toISOString().slice(0, 10);
const dayStart = (at: number) => Math.floor((at + OFFSET) / DAY) * DAY - OFFSET;
export type UsagePeriod = "today" | "7d" | "30d" | "all";
export type UsageSelection = { key: string } | { model: string };

/** Read ledger projections only; pricing and reconciliation belong to the writer.
 * Resolve the selection before aggregation so a filtered report never builds an unused full report.
 */
export function readUsageReport(db: DatabaseSync, period: UsagePeriod, selection: UsageSelection | undefined,
  now: number, chartInterval: "day" | "hour"): UsageReport {
  const start = period === "today" ? dayStart(now) : period === "7d" ? dayStart(now) - 6 * DAY : period === "30d" ? dayStart(now) - 29 * DAY : 0;
  // Preserve first-seen kind/supplier order from the original rowid scan, even
  // though the catalogue now reads a narrow index in model order.
  const identities = prepareSql(db, `SELECT model,supplier,kind FROM model_usage WHERE ${accountedUsage} GROUP BY model,supplier,kind ORDER BY MIN(rowid)`).all() as Array<UsageModelIdentity>;
  const available = new Map<string,UsageReport["availableModels"][number]>();
  for (const row of identities) {
    const key=modelUsageKey(row.model,row.supplier), existing=available.get(key);
    if (existing) { if (!existing.kinds.includes(row.kind)) existing.kinds.push(row.kind); }
    else available.set(key,{key,model:row.model,supplier:row.supplier,kinds:[row.kind]});
  }
  // Name-based dashboard selection follows the same sorted catalogue as before.
  const availableModels = [...available.values()].sort((a,b) => a.model.localeCompare(b.model));
  const identity = selection && ("key" in selection ? available.get(selection.key)
    : availableModels.find(row => row.model === selection.model));
  if (selection && "key" in selection && !identity) throw new Error("Unknown usage model");
  const hourly = chartInterval === "hour" && period === "today";
  const chartDay = hourly ? "strftime('%Y-%m-%dT%H:00:00',created_at/1000+8*3600,'unixepoch')" : "day";
  const rows = prepareSql(db, `SELECT model,supplier,day,${chartDay} AS chart_day,kind,currency,price_status,time_known,
    COUNT(*) requests,SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,SUM(cached_tokens) cachedInputTokens,
    SUM(write_tokens) cacheWriteTokens,SUM(output_seconds) outputSeconds,SUM(output_images) outputImages,SUM(output_videos) outputVideos,SUM(amount_nano) amount,
    SUM(historical) historicalRows,
    SUM(missing_usage) missingUsage,SUM(outcome IN ('failed','rejected')) failed,
    SUM(supplier='zenmux' AND generation_id IS NOT NULL AND price_status IN ('estimated','unpriced','historical-estimated','historical')) awaitingBill,
    SUM(missing_usage=1 AND amount_nano IS NULL AND price_status<>'excluded'
      AND (generation_id IS NULL OR supplier<>'zenmux')) unpricedUsage FROM model_usage ${identity ? "" : "INDEXED BY model_usage_time"}
    WHERE ${accountedUsage} AND created_at>=? AND created_at<=? ${period !== "all" ? "AND time_known=1" : ""} ${identity ? "AND model=? AND supplier=?" : ""}
    GROUP BY model,supplier,day,chart_day,kind,currency,price_status,time_known`).all(start, now, ...(identity ? [identity.model, identity.supplier] : []));
  const totals = emptyTotals(), models = new Map<string, UsageReport["models"][number]>(), days = new Map<string, UsageReport["days"][number]>();
  for (const row of available.values()) if (!identity || identity.key === row.key) models.set(row.key, { ...row, ...emptyTotals() });
  const first = period === "all" ? rows.reduce((earliest, row) => row.time_known
    ? Math.min(earliest, Date.parse(`${row.day}T00:00:00+08:00`)) : earliest, dayStart(now)) : start;
  // All-time charts use monthly buckets once the range exceeds 90 days.
  const monthly = now - first > 90 * DAY;
  for (let at = first; at <= now; at += hourly ? 3600000 : DAY) {
    const date = hourly ? new Date(at + OFFSET).toISOString().slice(0,13) + ":00:00" : usageDateKey(at).slice(0, monthly ? 7 : 10);
    if (!days.has(date)) days.set(date, { date, ...emptyTotals() });
  }
  const add = (target: UsageTotals, row: Record<string, unknown>) => {
    for (const field of ["inputTokens","outputTokens","cachedInputTokens","cacheWriteTokens","outputSeconds","outputImages","outputVideos","missingUsage","failed"] as const) target[field] += Number(row[field]);
    const n = Number(row.requests), status = String(row.price_status);
    if (!row.time_known) target.undated += n;
    if (row.kind === "historical") target.historical += n;
    else { target.requests += n; target.historical += Number(row.historicalRows); }
    if (row.kind === "image") target.imageRequests += n;
    if (row.kind === "video") target.videoRequests += n;
    const awaiting = Number(row.awaitingBill);
    target.awaitingBill += awaiting;
    if (row.supplier === "unknown") target.sourceMissing += n;
    else {
      const unpricedUsage = Number(row.unpricedUsage);
      target.unpricedUsage += unpricedUsage;
      if (status === "unpriced" || status === "historical") target.unpriced += Math.max(0,n-awaiting-unpricedUsage);
    }
    if (row.currency && row.amount !== null) {
      const currency = row.currency as Currency;
      target.costs[currency] += Number(row.amount); // Integer nanounits until aggregation is complete.
      if (status === "estimated" || status === "historical-estimated") target.estimatedCosts[currency] += Number(row.amount);
    }
  };
  for (const row of rows) {
    const key = modelUsageKey(String(row.model), String(row.supplier));
    const model = models.get(key)!;
    const billing = row.price_status === "subscription" ? "subscription" : row.price_status === "free" ? "free" : "api";
    model.billingTypes ??= [];
    if (!model.billingTypes.includes(billing)) model.billingTypes.push(billing);
    const date = hourly ? String(row.chart_day) : String(row.day).slice(0, monthly ? 7 : 10);
    add(totals, row); add(model, row); if (row.time_known) add(days.get(date)!, row);
  }
  const values = [...models.values()], dates = [...days.values()];
  for (const target of [totals, ...values, ...dates]) {
    target.costs.USD /= 1e9; target.estimatedCosts.USD /= 1e9;
  }
  const report: UsageReport = { period, from: first, through: now, timezone: "Asia/Shanghai", totals, models: values.sort((a,b) =>
    (b.inputTokens+b.outputTokens)-(a.inputTokens+a.outputTokens) || a.model.localeCompare(b.model)),
    days: dates, availableModels };
  // Unknown dashboard names retain the all-model date range and catalogue.
  return selection && !identity ? { ...report, totals: emptyTotals(), models: [], days: [] } : report;
}
