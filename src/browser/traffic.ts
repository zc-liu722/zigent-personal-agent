import type { CDPSession, Page } from "playwright-core";

export const BROWSER_TRAFFIC_TYPES = ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "prefetch", "eventsource", "websocket", "manifest", "signedexchange", "ping", "cspviolationreport", "preflight", "other"] as const;
export type BrowserTrafficType = typeof BROWSER_TRAFFIC_TYPES[number];
export type BrowserTrafficCounts = {
  attempts: number; responses: number; networkResponses: number; completed: number; failures: number; redirects: number;
  memoryCacheResponses: number; diskCacheResponses: number; serviceWorkerResponses: number; prefetchCacheResponses: number;
  revalidatedResponses: number; networkCompletedEncodedBytes: number; incompleteRequests: number; missingExtraInfo: number;
  httpStatuses: Record<string, number>;
};
export type BrowserTrafficBatch = {
  version: 1; startedAt: number; endedAt: number; trackingOverflows: number;
  resources: Partial<Record<BrowserTrafficType, BrowserTrafficCounts>>;
};
export type BrowserTrafficOptions = { maxTrackedRequests?: number; flushIntervalMs?: number; batchEvents?: number };
type Response = { status?: number; fromDiskCache?: boolean; fromServiceWorker?: boolean; fromPrefetchCache?: boolean; encodedDataLength?: number };
type Hop = { type: BrowserTrafficType; response?: Response; extraStatus?: number; expectsExtra?: boolean; servedFromCache: boolean;
  terminal?: "completed" | "failed" | "redirect" | "incomplete"; bytes: number };
type Request = { hops: Hop[]; earlyExtra: number[] };
type NetworkEvent = "Network.requestWillBeSent" | "Network.requestServedFromCache" | "Network.responseReceived" | "Network.responseReceivedExtraInfo" | "Network.loadingFinished" | "Network.loadingFailed";
type Target = { session: CDPSession; prefix: string; listeners: [NetworkEvent, (event: any) => void][]; page: Page; remove: () => void };
const resourceType = (value?: string): BrowserTrafficType => {
  const type = value?.toLowerCase();
  return BROWSER_TRAFFIC_TYPES.includes(type as BrowserTrafficType) ? type as BrowserTrafficType : "other";
};
const finiteBytes = (value?: number): number => Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
const statusCode = (value?: number): number | undefined => Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : undefined;
const optionNumber = (value: number | undefined, fallback: number, minimum: number, maximum: number): number =>
  Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value!))) : fallback;
const counts = (): BrowserTrafficCounts => ({ attempts: 0, responses: 0, networkResponses: 0, completed: 0, failures: 0, redirects: 0,
  memoryCacheResponses: 0, diskCacheResponses: 0, serviceWorkerResponses: 0, prefetchCacheResponses: 0,
  revalidatedResponses: 0, networkCompletedEncodedBytes: 0, incompleteRequests: 0, missingExtraInfo: 0, httpStatuses: {} });

/** Passive, aggregate-only Chromium telemetry. Never enables Fetch/request interception,
 * disables cache, fetches bodies, or retains URL/header/body/credential values.
 * Attempts include cache hits and redirects; network responses are NOT origin request
 * counts (proxies, CDN, SW internals and missing CDP events prevent that inference).
 * Encoded bytes are Chromium's completed-transfer attribution, not physical wire bytes;
 * failed/streaming transfers, WebSocket frames and independently targeted OOPIF/worker
 * traffic are not fully covered. Attach to every page before navigating it.
 */
export class BrowserTraffic {
  private readonly requests = new Map<string, Request>();
  private readonly pages = new Map<Page, Promise<Target | undefined>>();
  private readonly targets = new Set<Target>();
  private batch: BrowserTrafficBatch = this.emptyBatch();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private sequence = 0;
  private eventCount = 0;
  private readonly maxTracked: number;
  private readonly batchEvents: number;
  private readonly interval: number;
  constructor(private readonly onBatch: (batch: BrowserTrafficBatch) => void | Promise<void>, options: BrowserTrafficOptions = {}) {
    this.maxTracked = optionNumber(options.maxTrackedRequests, 2048, 1, 65_536);
    this.batchEvents = optionNumber(options.batchEvents, 512, 1, 65_536);
    this.interval = optionNumber(options.flushIntervalMs, 5000, 0, 60_000);
  }
  private emptyBatch(): BrowserTrafficBatch { return { version: 1, startedAt: Date.now(), endedAt: Date.now(), trackingOverflows: 0, resources: {} }; }
  private row(type: BrowserTrafficType): BrowserTrafficCounts { return this.batch.resources[type] ??= counts(); }
  private schedule(): void {
    this.eventCount++;
    if (!this.closed && this.interval && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => {}); }, this.interval);
      this.timer.unref();
    }
    if (!this.closed && this.eventCount >= this.batchEvents) void this.flush().catch(() => {});
  }
  attach(page: Page): Promise<void> {
    if (this.closed) return Promise.resolve();
    let attaching = this.pages.get(page);
    if (!attaching) {
      attaching = this.attachPage(page);
      this.pages.set(page, attaching);
      void attaching.catch(() => { if (this.pages.get(page) === attaching) this.pages.delete(page); });
    }
    return attaching.then(() => {});
  }
  private async attachPage(page: Page): Promise<Target | undefined> {
    const session = await page.context().newCDPSession(page);
    if (this.closed) { await session.detach().catch(() => {}); return; }
    const target: Target = { session, page, prefix: `${++this.sequence}:`, listeners: [], remove: () => {} };
    const listen = (name: NetworkEvent, listener: (event: any) => void) => {
      const guarded = (event: any) => { if (!this.closed) { listener(event); this.schedule(); } };
      target.listeners.push([name, guarded]); session.on(name, guarded);
    };
    listen("Network.requestWillBeSent", event => this.started(target.prefix + event.requestId, event.type, event.redirectResponse, event.redirectHasExtraInfo));
    listen("Network.requestServedFromCache", event => {
      const hop = this.requests.get(target.prefix + event.requestId)?.hops.at(-1); if (hop) hop.servedFromCache = true;
    });
    listen("Network.responseReceived", event => {
      const key = target.prefix + event.requestId, request = this.requests.get(key), hop = request?.hops.at(-1);
      if (!request || !hop) return;
      // Copy only scalar fields; CDP's response also contains private URLs and headers.
      hop.response = this.response(event.response); hop.expectsExtra = event.hasExtraInfo === true;
      this.matchExtra(request); this.drain(key, request);
    });
    listen("Network.responseReceivedExtraInfo", event => {
      const key = target.prefix + event.requestId, request = this.requests.get(key), status = statusCode(event.statusCode);
      if (!request || status === undefined) return;
      if (request.earlyExtra.length < 16) request.earlyExtra.push(status); else this.batch.trackingOverflows++;
      this.matchExtra(request); this.drain(key, request);
    });
    listen("Network.loadingFinished", event => this.ended(target.prefix + event.requestId, "completed", event.encodedDataLength));
    listen("Network.loadingFailed", event => this.ended(target.prefix + event.requestId, "failed", 0));
    target.remove = () => { for (const [name, listener] of target.listeners) session.off(name, listener); page.off("close", pageClosed); this.targets.delete(target); this.pages.delete(page); this.finishTarget(target.prefix); };
    const pageClosed = () => { target.remove(); void session.detach().catch(() => {}); void this.flush().catch(() => {}); };
    page.once("close", pageClosed); this.targets.add(target);
    try {
      // No Fetch.enable, route(), setCacheDisabled, or SW bypass. No body buffers needed.
      await session.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
      return target;
    } catch (error) { target.remove(); await session.detach().catch(() => {}); throw error; }
  }
  private response(response: Response): Response {
    return { status: statusCode(response.status), fromDiskCache: response.fromDiskCache === true,
      fromServiceWorker: response.fromServiceWorker === true, fromPrefetchCache: response.fromPrefetchCache === true };
  }
  private started(key: string, type?: string, redirect?: Response, extra?: boolean): void {
    let request = this.requests.get(key);
    if (request && redirect) {
      const previous = request.hops.at(-1)!;
      previous.response = this.response(redirect); previous.expectsExtra = extra === true;
      previous.terminal = "redirect"; previous.bytes = finiteBytes(redirect.encodedDataLength);
      this.matchExtra(request); this.drain(key, request);
      if (request.hops.length >= 16) { this.commit(request.hops.shift()!, true); this.batch.trackingOverflows++; }
    } else if (request) {
      for (const hop of request.hops) this.commit(hop, true);
      this.requests.delete(key); request = undefined;
    }
    if (!request) {
      while (this.requests.size >= this.maxTracked) {
        const oldest = this.requests.entries().next().value!;
        for (const hop of oldest[1].hops) this.commit(hop, true);
        this.requests.delete(oldest[0]); this.batch.trackingOverflows++;
      }
      request = { hops: [], earlyExtra: [] };
    }
    request.hops.push({ type: resourceType(type), servedFromCache: false, bytes: 0 });
    this.requests.set(key, request); this.row(resourceType(type)).attempts++;
  }
  private matchExtra(request: Request): void {
    // ExtraInfo may precede responseReceived and redirect hops reuse requestId.
    // Consume it in hop order only once CDP confirms that hop expects ExtraInfo.
    for (const hop of request.hops) {
      if (!request.earlyExtra.length) break;
      if (hop.expectsExtra === undefined) break;
      if (hop.expectsExtra && hop.extraStatus === undefined) hop.extraStatus = request.earlyExtra.shift();
    }
  }
  private ended(key: string, terminal: "completed" | "failed", bytes: number): void {
    const request = this.requests.get(key), hop = request?.hops.at(-1); if (!request || !hop) return;
    hop.terminal = terminal; hop.bytes = finiteBytes(bytes);
    // Failed requests may have no responseReceived even when ExtraInfo is present.
    if (!hop.response && request.earlyExtra.length) hop.extraStatus = request.earlyExtra.shift();
    this.drain(key, request);
  }
  private drain(key: string, request: Request): void {
    while (request.hops[0]?.terminal && (!request.hops[0].expectsExtra || request.hops[0].extraStatus !== undefined)) this.commit(request.hops.shift()!);
    if (!request.hops.length) this.requests.delete(key);
  }
  private commit(hop: Hop, forced = false): void {
    const row = this.row(hop.type), response = hop.response;
    const missingExtra = forced && hop.expectsExtra && hop.extraStatus === undefined;
    // responseReceived may normalize a revalidated response to 200. Missing
    // promised ExtraInfo therefore cannot establish its actual HTTP status.
    const status = hop.extraStatus ?? (missingExtra ? undefined : response?.status);
    if (missingExtra) row.missingExtraInfo++;
    if (!hop.terminal || hop.terminal === "incomplete") row.incompleteRequests++;
    else if (hop.terminal === "failed") row.failures++;
    else { row.completed++; if (hop.terminal === "redirect") row.redirects++; }
    if (status !== undefined) row.httpStatuses[String(status)] = (row.httpStatuses[String(status)] ?? 0) + 1;
    if (!response) return;
    row.responses++;
    // The generic servedFromCache event does not itself distinguish memory/disk.
    // Memory is inferred only after excluding explicit disk/SW/prefetch markers.
    const sw = response.fromServiceWorker, disk = !sw && response.fromDiskCache, prefetch = !sw && !disk && response.fromPrefetchCache;
    const memory = !sw && !disk && !prefetch && hop.servedFromCache && status !== 304;
    if (sw) row.serviceWorkerResponses++; else if (disk && status !== 304) row.diskCacheResponses++;
    else if (prefetch) row.prefetchCacheResponses++; else if (memory) row.memoryCacheResponses++;
    if (status === 304) row.revalidatedResponses++;
    if ((!sw && !disk && !prefetch && !memory) || status === 304) {
      row.networkResponses++;
      if (hop.terminal === "completed" || hop.terminal === "redirect") row.networkCompletedEncodedBytes += hop.bytes;
    }
  }
  private finishTarget(prefix: string): void {
    for (const [key, request] of this.requests) if (key.startsWith(prefix)) {
      for (const hop of request.hops) this.commit(hop, true);
      this.requests.delete(key);
    }
  }
  private finishCached(): void {
    for (const [key, request] of this.requests) {
      const hop = request.hops[0];
      // With a separate CDP Fetch-auth session, Chromium can advertise
      // hasExtraInfo=true on a cache hit yet never emit ExtraInfo.
      // An explicit cache event plus completed zero-byte transfer can be
      // reported now. Do not invent the missing wire status (including 304).
      // Leave multi-hop redirects and real transfers pending for their extras.
      const cached = hop.servedFromCache || hop.response?.fromDiskCache || hop.response?.fromPrefetchCache || hop.response?.fromServiceWorker;
      if (request.hops.length === 1 && hop.terminal === "completed" && cached && hop.bytes === 0 && hop.expectsExtra && hop.extraStatus === undefined) {
        this.commit(hop, true); this.requests.delete(key);
      }
    }
  }
  /** Concurrent callers coalesce into one bounded writer; no per-event I/O. */
  flush(): Promise<void> {
    this.finishCached();
    if (this.flushing) return this.flushing;
    clearTimeout(this.timer); this.timer = undefined;
    this.flushing = (async () => {
      while (Object.keys(this.batch.resources).length || this.batch.trackingOverflows) {
        const batch = this.batch; batch.endedAt = Date.now(); this.batch = this.emptyBatch(); this.eventCount = 0;
        try { await this.onBatch(batch); }
        catch (error) {
          // Retain a bounded aggregate for an explicit retry after writer failure.
          this.batch.startedAt = Math.min(batch.startedAt, this.batch.startedAt);
          this.batch.trackingOverflows += batch.trackingOverflows;
          for (const type of BROWSER_TRAFFIC_TYPES) {
            const previous = batch.resources[type]; if (!previous) continue;
            const row = this.row(type);
            for (const field of Object.keys(previous) as (keyof BrowserTrafficCounts)[]) {
              if (field === "httpStatuses") {
                for (const [status, count] of Object.entries(previous.httpStatuses)) row.httpStatuses[status] = (row.httpStatuses[status] ?? 0) + count;
              } else row[field] += previous[field];
            }
          }
          throw error;
        }
      }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; clearTimeout(this.timer); this.timer = undefined;
      await Promise.allSettled(this.pages.values());
      const targets = [...this.targets];
      for (const target of targets) target.remove();
      await Promise.allSettled(targets.map(target => target.session.detach()));
      await this.flush();
    })();
  }
}
