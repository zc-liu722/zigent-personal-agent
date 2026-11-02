import { createHmac, randomBytes } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";

type Route = { site: string; route: string; category: string; securityAttempt?: number; verificationCode?: number };
type Intent = { commandId?: string; actor: "agent" | "user"; action: string; at: number };
export type BrowserDiagnostic = { tab: string; at: number; kind: string; route?: Route; previous?: Route;
  reason?: string; navigationType?: string; request?: string; loader?: string; method?: string; status?: number;
  initiator?: string; script?: string; line?: number; userGesture?: boolean; commandId?: string; actor?: string;
  action?: string; actionAgeMs?: number; count?: number; windowMs?: number;
  endpoints?: { route: Route; method: string; resourceType: string; initiator: string; script?: string;
    attempts: number; responses: number; failures: number; statuses: Record<string, number> }[] };
type Endpoint = NonNullable<BrowserDiagnostic["endpoints"]>[number];
type EventName = "Page.frameRequestedNavigation" | "Page.frameStartedNavigating" | "Page.frameNavigated" | "Page.navigatedWithinDocument"
  | "Network.requestWillBeSent" | "Network.responseReceived" | "Network.loadingFailed" | "Network.loadingFinished";
type Target = { client: CDPSession; page: Page; tab: string; frame: string; intent?: Intent;
  requests: Map<string, Endpoint>; endpoints: Map<string, Endpoint>; documents: { at: number; route: string }[];
  listeners: [EventName, (event: any) => void][]; stopped: boolean; previous?: Route; dispose(): void };
const label = (value: unknown): string | undefined => typeof value === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value : undefined;

/** Passive CDP metadata only: never persists URLs, queries, headers, bodies or cookie values.
 * Per-launch salted route IDs correlate redirects and endpoints without exposing personal paths.
 * Page events distinguish document loads from history/fragment changes; Network IDs correlate redirects.
 */
export class BrowserDiagnostics {
  private salt = randomBytes(32);
  private targets = new Map<Page, Target>();
  private closed = false;
  private timer: NodeJS.Timeout;
  private since = Date.now();
  constructor(private emit: (event: BrowserDiagnostic) => void, private loop: (page: Page) => void) {
    this.timer = setInterval(() => this.flush(), 5000); this.timer.unref();
  }
  private hash(value: string): string { return createHmac("sha256", this.salt).update(value).digest("hex").slice(0, 16); }
  private route(value: string): Route {
    try {
      const url = new URL(value), path = url.pathname.toLowerCase();
      const category = /security[-_]?check/.test(path) ? "security_check"
        : /(?:captcha|security|verify|verification|challenge|safe)/.test(path) ? "verification"
        : /(?:login|signin|passport|\/web\/user(?:\/|$))/.test(path) ? "login"
        : /(?:oauth|authorize|callback)/.test(path) ? "authorization"
        : /^\/web\/geek\/jobs\/?$/.test(path) ? "jobs"
        : /(?:\/api\/|\/wapi\/)/.test(path) ? "api" : path === "/" ? "home" : "other";
      const route: Route = { site: this.hash(url.origin), route: this.hash(url.origin + url.pathname), category };
      // Fixed numeric BOSS diagnostic fields only. Never retain arbitrary query values.
      if (/(^|\.)zhipin\.com$/.test(url.hostname)) {
        const attempt = /^(\d{1,2})_\d{10,16}$/.exec(url.searchParams.get("_security_check") ?? "");
        if (attempt) route.securityAttempt = Number(attempt[1]);
        const code = url.searchParams.get("code");
        if (path === "/web/passport/zp/verify.html" && code && /^\d{1,4}$/.test(code)) route.verificationCode = Number(code);
      }
      return route;
    } catch { return { site: "unknown", route: "unknown", category: "other" }; }
  }
  intent(page: Page, actor: Intent["actor"], action: string, commandId?: string): void {
    const target = this.targets.get(page); if (!target) return;
    target.intent = { actor, action, commandId, at: Date.now() };
    // A new real action starts a new navigation chain. Observations and viewer polling do not.
    target.documents = [];
    this.record(target, { kind: "intent" });
  }
  private record(target: Target, event: Omit<BrowserDiagnostic, "tab" | "at">): void {
    if (this.closed) return;
    const intent = target.intent, age = intent ? Date.now() - intent.at : undefined;
    this.emit({ tab: target.tab, at: Date.now(), ...(intent && age! <= 30000 ? {
      commandId: intent.commandId, actor: intent.actor, action: intent.action, actionAgeMs: age } : {}), ...event });
  }
  async attach(page: Page, tab: string): Promise<void> {
    const client = await page.context().newCDPSession(page);
    if (this.closed) { await client.detach().catch(() => {}); return; }
    const target: Target = { client, page, tab, frame: "", requests: new Map(), endpoints: new Map(), documents: [], listeners: [], stopped: false, dispose: () => {} };
    const listen = (name: EventName, callback: (event: any) => void) => {
      const guarded = (event: any) => { if (!this.closed && !target.stopped) callback(event); };
      target.listeners.push([name, guarded]); client.on(name, guarded);
    };
    listen("Page.frameRequestedNavigation", e => {
      if (e.frameId === target.frame) this.record(target, { kind: "navigation_requested", route: this.route(e.url), reason: label(e.reason) });
    });
    listen("Page.frameStartedNavigating", e => {
      if (e.frameId === target.frame) this.record(target, { kind: "navigation_started", route: this.route(e.url), navigationType: label(e.navigationType), loader: this.hash(e.loaderId) });
    });
    listen("Page.frameNavigated", e => {
      if (e.frame.parentId) return;
      target.frame = e.frame.id;
      const route = this.route(e.frame.url);
      this.record(target, { kind: "document_committed", route, previous: target.previous, loader: this.hash(e.frame.loaderId) });
      target.previous = route;
    });
    listen("Page.navigatedWithinDocument", e => {
      if (e.frameId !== target.frame) return;
      const route = this.route(e.url);
      this.record(target, { kind: "same_document", route, previous: target.previous, navigationType: label(e.navigationType) }); target.previous = route;
    });
    listen("Network.requestWillBeSent", e => {
      const route = this.route(e.request.url), method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(e.request.method) ? e.request.method : "other";
      const initiator = label(e.initiator?.type) ?? "other", call = e.initiator?.stack?.callFrames?.[0];
      const script = call?.url ? this.route(call.url).route : undefined;
      if (e.type === "Document" && e.frameId === target.frame) {
        this.record(target, { kind: e.redirectResponse ? "document_redirect" : "document_request", route,
          previous: e.redirectResponse ? this.route(e.redirectResponse.url) : target.previous,
          status: e.redirectResponse?.status, method, request: this.hash(e.requestId), loader: this.hash(e.loaderId),
          initiator, script, line: Number.isInteger(call?.lineNumber) ? call.lineNumber : undefined, userGesture: e.hasUserGesture === true });
        const now = Date.now(); target.documents = target.documents.filter(item => now - item.at <= 15000);
        target.documents.push({ at: now, route: route.route });
        // Count actual document requests (including HTTP redirects), never SPA navigation or XHR.
        // Require repeated destinations as well as volume, so a long one-way OAuth chain is not a loop.
        if (target.documents.length >= 8 && target.documents.filter(item => item.route === route.route).length >= 3) {
          this.record(target, { kind: "navigation_loop", route, count: target.documents.length, windowMs: now - target.documents[0]!.at });
          target.stopped = true; this.flush(); this.loop(page);
        }
      }
      if (!["XHR", "Fetch"].includes(e.type)) return;
      if (e.redirectResponse) this.response(target, e.requestId, e.redirectResponse.status);
      let key = [route.route, method, e.type, initiator, script].join(":");
      if (!target.endpoints.has(key) && target.endpoints.size >= 128) this.flush();
      if (!target.endpoints.has(key) && target.endpoints.size >= 128) key = "overflow";
      let endpoint = target.endpoints.get(key);
      if (!endpoint) { endpoint = { route: key === "overflow" ? { site: "overflow", route: "overflow", category: "other" } : route,
        method: key === "overflow" ? "other" : method, resourceType: key === "overflow" ? "other" : e.type.toLowerCase(),
        initiator: key === "overflow" ? "other" : initiator, script: key === "overflow" ? undefined : script, attempts: 0, responses: 0, failures: 0, statuses: {} }; target.endpoints.set(key, endpoint); }
      endpoint.attempts++;
      if (target.requests.size >= 2048) target.requests.delete(target.requests.keys().next().value!);
      target.requests.set(e.requestId, endpoint);
    });
    listen("Network.responseReceived", e => {
      if (e.type === "Document" && e.frameId === target.frame) this.record(target, { kind: "document_response", route: this.route(e.response.url),
        request: this.hash(e.requestId), loader: this.hash(e.loaderId), status: e.response.status });
      this.response(target, e.requestId, e.response.status);
    });
    listen("Network.loadingFailed", e => { const endpoint = target.requests.get(e.requestId); if (endpoint) endpoint.failures++; target.requests.delete(e.requestId); });
    listen("Network.loadingFinished", e => target.requests.delete(e.requestId));
    target.dispose = () => { this.flush(); for (const [name, listener] of target.listeners) client.off(name, listener); page.off("close", close); this.targets.delete(page); };
    const close = () => { target.dispose(); void client.detach().catch(() => {}); };
    this.targets.set(page, target); page.once("close", close);
    try {
      await client.send("Page.enable");
      const tree = await client.send("Page.getFrameTree"); target.frame = tree.frameTree.frame.id;
      await client.send("Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
    } catch (error) { target.dispose(); await client.detach().catch(() => {}); throw error; }
  }
  private response(target: Target, id: string, status: number): void {
    const endpoint = target.requests.get(id); if (!endpoint) return;
    endpoint.responses++; if (Number.isInteger(status) && status >= 100 && status <= 599) endpoint.statuses[status] = (endpoint.statuses[status] ?? 0) + 1;
  }
  flush(): void {
    const now = Date.now();
    for (const target of this.targets.values()) {
      const endpoints = [...target.endpoints.values()].filter(e => e.attempts || e.responses || e.failures).map(e => ({ ...e, statuses: { ...e.statuses } }));
      if (endpoints.length) this.record(target, { kind: "endpoints", windowMs: now - this.since, endpoints });
      // In-flight references remain valid across flushes. Keep only their bounded buckets.
      const pending = new Set(target.requests.values());
      for (const [key, e] of target.endpoints) {
        if (pending.has(e)) { e.attempts = e.responses = e.failures = 0; e.statuses = {}; }
        else target.endpoints.delete(key);
      }
    }
    this.since = now;
  }
  async close(): Promise<void> {
    clearInterval(this.timer); this.flush(); this.closed = true;
    const targets = [...this.targets.values()]; for (const target of targets) target.dispose();
    await Promise.allSettled(targets.map(target => target.client.detach()));
  }
}
