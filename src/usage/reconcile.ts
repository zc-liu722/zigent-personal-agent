import { parseZenmuxPrices } from "./pricing.js";
import { ProxyAgent, type Dispatcher } from "undici";
import type { AgentConfig } from "../config.js";
import { UsageStore, type BillingRow } from "./store.js";
import type { PerformanceStore } from "../performance/store.js";

/** ZenMux bills asynchronously. Pending IDs survive restarts; retries never add a second charge.
 * https://zenmux.ai/docs/api/platform/get-generation.html
 */
export class UsageReconciler {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private pricesCheckedAt = 0;
  private dispatcher?: ProxyAgent;
  private readonly abort = new AbortController();
  constructor(private readonly store: UsageStore, private readonly config: AgentConfig, private readonly performance?: PerformanceStore) {}
  start(): void {
    this.timer = setInterval(() => { void this.run(); }, 60_000);
    this.timer.unref(); void this.run();
  }
  run(): Promise<void> {
    return this.running ??= this.reconcile().catch(() => { console.warn("Usage reconciliation deferred"); }).finally(() => { this.running = undefined; });
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.abort.abort(); await this.running; await this.dispatcher?.close();
  }
  private async reconcile(): Promise<void> {
    const refreshPrices = Date.now() - this.pricesCheckedAt > 6 * 3_600_000 && Boolean(this.config.models?.some(route => route.supplier === "zenmux"));
    const rows = this.store.pending();
    if (!refreshPrices && !rows.length) return;
    const work = () => this.reconcilePending(refreshPrices, rows);
    await (this.performance ? this.performance.measure("task.execute", "usage.reconcile", work) : work());
  }
  private async reconcilePending(refreshPrices: boolean, rows: BillingRow[]): Promise<void> {
    if (refreshPrices) {
      try {
        const route = this.config.models?.find(route => route.supplier === "zenmux");
        const dispatcher = route?.network === "proxy" && this.config.zenmuxProxyUrl ? this.dispatcher ??= new ProxyAgent(this.config.zenmuxProxyUrl) : undefined;
        const response = await fetch("https://zenmux.ai/api/v1/models", { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
          ...(dispatcher ? { dispatcher } : {}) } as RequestInit & { dispatcher?: Dispatcher });
        if (response.ok) { this.store.setPrices(parseZenmuxPrices(await response.json())); this.pricesCheckedAt = Date.now(); }
        else await response.body?.cancel();
      } catch { /* Keep the previous verified catalogue until the next refresh. */ }
    }
    for (const row of rows) {
      if (this.abort.signal.aborted) return;
      const deployment = this.config.models?.find(route => route.name === row.model && route.supplier === row.supplier)
        ?? (row.kind === "image" && this.config.imageGeneration?.supplier === row.supplier ? this.config.imageGeneration : undefined)
        ?? (row.kind === "video" && this.config.videoGeneration?.supplier === row.supplier ? this.config.videoGeneration : undefined);
      const supplier = this.config.suppliers?.[row.supplier];
      const route = deployment ?? (supplier ? { apiKey: supplier.apiKey, network: supplier.network,
        baseUrl: Object.values(supplier.endpoints).find(value => value && new URL(value).hostname === "zenmux.ai") } : undefined);
      // Never send a credential to an inferred endpoint or match on model family alone.
      const hostname = route?.baseUrl ? new URL(route.baseUrl).hostname : "";
      if (row.supplier !== "zenmux" || hostname !== "zenmux.ai" || !route?.apiKey) {
        this.store.defer(row.id, row.attempts); continue;
      }
      try {
        let dispatcher: Dispatcher | undefined;
        if (route.network === "proxy" && this.config.zenmuxProxyUrl) dispatcher = this.dispatcher ??= new ProxyAgent(this.config.zenmuxProxyUrl);
        const url = new URL("https://zenmux.ai/api/v1/management/generation");
        url.searchParams.set("id", row.generation_id);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${route.apiKey}` },
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
          ...(dispatcher ? { dispatcher } : {}) } as RequestInit & { dispatcher?: Dispatcher });
        if (response.ok) {
          const payload = await response.json() as { data?: Record<string, unknown> } & Record<string, unknown>;
          const data = payload.data ?? payload;
          // `usage` is the final payable USD amount, including hosted tools and discounts.
          if (data.generationId === row.generation_id && typeof data.usage === "number" && Number.isFinite(data.usage) && data.usage >= 0) {
            this.store.settle(row.id, data.usage); continue;
          }
        } else await response.body?.cancel();
      } catch { /* Preserve the unpriced/estimated state; no private response data in logs. */ }
      this.store.defer(row.id, row.attempts);
    }
  }
}
