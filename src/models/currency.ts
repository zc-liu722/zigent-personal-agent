/** Shared, dated reference for model prices and USD accounting; never a live FX quote. */
export const USD_REFERENCE = {
  // ECB 2026-10-16: EUR/USD 1.1253, EUR/CNY 7.5240.
  cnyPerUsd: 7.5240 / 1.1253,
  date: "2026-10-16",
  sourceUrl: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html"
} as const;

export function toUsd(amount: number, currency: "USD" | "CNY"): number {
  return currency === "CNY" ? amount / USD_REFERENCE.cnyPerUsd : amount;
}
