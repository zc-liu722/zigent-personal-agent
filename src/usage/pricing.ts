import { HolidayUtil } from "lunar-typescript";
import type { ModelCostPolicy } from "../config.js";
import type { TokenUsage } from "../memory/types.js";
import { tokenPrices } from "../models/token-pricing.js";
import { toUsd } from "../models/currency.js";
import type { Currency } from "./types.js";

export type UsagePrice = { currency: Currency; amount: number; source: string };
/** Official list-price estimates. Historical aggregate rows remain estimates, not invoices. */
export function priceTokens(model: string, policy: ModelCostPolicy | undefined, usage: TokenUsage | undefined,
  at: number, options: { historical?: boolean; contextInputTokens?: number } = {}): UsagePrice | undefined {
  if (policy?.type === "free" || policy?.type === "subscription") {
    return { currency: "USD", amount: 0, source: policy.type };
  }
  if (!usage) return undefined;
  const price = tokenPrices[model];
  if (!price || usage.cacheHitTokensReported === false && !options.historical) return undefined;
  let tiers = price.tiers;
  if (price.promotion && at >= Date.parse(`${price.promotion.through}T23:59:59.999+08:00`) + 1) tiers = [price.promotion.regular];
  const contextTokens = options.contextInputTokens ?? usage.inputTokens;
  let tier = [...tiers].reverse().find(tier => contextTokens > (tier.aboveTokens ?? -1));
  if (model === "deepseek-v4.1flash-official") {
    const date = new Date(at + 8 * 3_600_000), year = date.getUTCFullYear();
    if (!HolidayUtil.getHolidays(year).length) return undefined;
    const holiday = HolidayUtil.getHoliday(date.toISOString().slice(0,10));
    const weekday = date.getUTCDay(), hour = date.getUTCHours();
    const peak = weekday >= 1 && weekday <= 5 && !(holiday && !holiday.isWork()) && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18);
    tier = tiers[peak ? 1 : 0];
  } else if (tiers.some((tier,index) => index > 0 && !tier.aboveTokens)) return undefined;
  if (!tier) return undefined;
  const cached = usage.cachedInputTokens, writes5m = usage.cacheWriteTokens5m ?? 0, writes1h = usage.cacheWriteTokens1h ?? 0;
  const uncached = usage.inputTokens - cached - writes5m - writes1h;
  if (uncached < 0 || cached > 0 && tier.cachedInput === undefined || writes5m > 0 && tier.cacheWrite5m === undefined
    || writes1h > 0 && tier.cacheWrite1h === undefined) return undefined;
  return { currency: "USD",
    amount: toUsd((uncached * tier.input + cached * (tier.cachedInput ?? 0) + writes5m * (tier.cacheWrite5m ?? 0)
      + writes1h * (tier.cacheWrite1h ?? 0) + usage.outputTokens * tier.output) / 1e6
      * (policy?.type === "official" ? policy.multiplier ?? 1 : 1), price.currency), source: price.sourceUrl };
}

export type PriceCatalog = Map<string, { currency: Currency; sourceUrl: string; items: Record<string, Array<{ value: number; above: number }>> }>;
/** Fail closed for currencies, units or conditions we do not understand. */
export function parseZenmuxPrices(payload: unknown): PriceCatalog {
  const catalog: PriceCatalog = new Map();
  const data = (payload as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return catalog;
  for (const row of data as Array<{ id?: unknown; pricings?: Record<string, unknown> }>) {
    if (typeof row.id !== "string" || !row.pricings) continue;
    const items: Record<string, Array<{ value: number; above: number }>> = {};
    for (const [key, value] of Object.entries(row.pricings)) {
      if (!Array.isArray(value)) continue;
      const rates: Array<{ value: number; above: number }> = [];
      for (const rate of value) {
        if (rate.currency !== "USD" || rate.unit !== "perMTokens" || typeof rate.value !== "number" || !Number.isFinite(rate.value) || rate.value < 0) continue;
        const conditions = rate.conditions ?? {};
        if (Object.keys(conditions).some(key => key !== "prompt_tokens")) continue;
        const condition = conditions.prompt_tokens;
        if (condition && (condition.unit !== "kTokens" || Object.keys(condition).some(key => !["unit", "gte"].includes(key)))) continue;
        const above = condition ? Number(condition.gte) * 1000 : 0;
        if (!Number.isFinite(above) || above < 0) continue;
        rates.push({ value: rate.value, above });
      }
      // Partial interpretation of a conditional schedule would give a false estimate.
      if (rates.length === value.length) items[key] = rates.sort((a,b) => a.above-b.above);
    }
    if (items.prompt?.length && items.completion?.length) catalog.set(row.id, { currency: "USD", sourceUrl: "https://zenmux.ai/api/v1/models", items });
  }
  return catalog;
}
export function priceFromCatalog(catalog: PriceCatalog, apiModel: string, usage: TokenUsage, multiplier = 1): UsagePrice | undefined {
  const quote = catalog.get(apiModel);
  if (!quote || usage.cacheHitTokensReported === false) return undefined;
  const counts = { prompt: usage.inputTokens - usage.cachedInputTokens - (usage.cacheWriteTokens5m ?? 0) - (usage.cacheWriteTokens1h ?? 0),
    completion: usage.outputTokens, input_cache_read: usage.cachedInputTokens,
    input_cache_write_5_min: usage.cacheWriteTokens5m ?? 0, input_cache_write_1_h: usage.cacheWriteTokens1h ?? 0 };
  let amount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (!count) continue;
    const rates = quote.items[key] ?? (key === "input_cache_write_5_min" ? quote.items.input_cache_write : undefined);
    const rate = rates && [...rates].reverse().find(rate => usage.inputTokens >= rate.above);
    if (!rate || count < 0) return undefined;
    amount += count * rate.value / 1e6;
  }
  return { currency: quote.currency, amount: amount * multiplier, source: quote.sourceUrl };
}
