import { BrowserOperation, BrowserTimeoutError, boundedBrowserWork, BROWSER_OPERATION_TIMEOUT } from "./operation.js";
import { browserActionPolicy } from "./action-policy.js";
import { browserExecutable } from "./engine.js";
import { browserConnection } from "./connection.js";
import { startBrowserGateway, type BrowserGateway } from "./gateway.js";
import { BrowserTraffic, type BrowserTrafficBatch } from "./traffic.js";
import { BrowserDiagnostics, type BrowserDiagnostic } from "./diagnostics.js";
import { browserRestriction, browserTransientVerification, inspectBrowserRestriction, type BrowserRestriction } from "./restrictions.js";
import { BrowserEditing, type BrowserEditor } from "./editing.js";
import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium, type BrowserContext, type Page, type ElementHandle, type FileChooser, type Dialog, type Cookie } from "playwright-core";
import { browserUrl } from "./network.js";
import { browserInputSchema, browserStateMessage, type BrowserNetwork, type BrowserPauseReason, type BrowserInput, type BrowserScope, type BrowserSession, type BrowserView, type BrowserControl, type BrowserElement, type BrowserTab } from "./types.js";

const SUBMISSION_APPROVED = Symbol("trusted-browser-submission");
const WIDTH = 1280, HEIGHT = 800;
const IDLE_TIMEOUT = 10 * 60_000;
type Viewport = { width: number; height: number };
const interactive = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"],[contenteditable="true"],[onclick]';
type BrowserEventDetails = { commandId?: string; durationMs?: number; frameIndex?: number; mainFrame?: boolean;
  visible?: boolean; elementCount?: number; resourceType?: string; httpStatus?: number; failureKind?: string; actionCompleted?: boolean; traffic?: BrowserTrafficBatch;
  diagnostic?: BrowserDiagnostic; source?: string };
type Workspace = { tabs: BrowserTab[]; activeTab?: string };
type Live = { context: BrowserContext; gateway: BrowserGateway; traffic: BrowserTraffic; diagnostics: BrowserDiagnostics; safetyTimer?: NodeJS.Timeout; safetyCheck?: Promise<boolean>; safetyFailureAt?: number;
  ready: WeakMap<Page, Promise<void>>; documents: WeakMap<Page, { status: number; retryAt?: number }>; pages: Map<string, Page>; tabs: Map<string, BrowserTab>; active: string; epoch: number; navigation: number; tail: Promise<unknown>; restoring: boolean; disposing: boolean; lastActivityAt: number;
  editing?: BrowserEditing; desiredViewport: Viewport; viewportTasks: WeakMap<Page, Promise<void>>; downloads: number;
  pointer?: { id: string; page: Page; timer?: NodeJS.Timeout };
  observation?: { id: string; page: Page; url: string; at: number; refs: Map<string, ElementHandle> };
  pending?: { id: string; label: string; input: BrowserInput; epoch: number; hash: string; at: number };
  chooser?: FileChooser; dialog?: Dialog; controller?: string; cookiePath: string; cookieTail: Promise<unknown>; cookieTimer?: NodeJS.Timeout; screenshot?: Promise<Buffer> };
type Options = { agentId: string; ownerUserId: string; directory: string; proxyUrl?: string; executablePath?: string; testLocal?: boolean; idleTimeoutMs?: number; readTimeoutMs?: number; operationTimeoutMs?: number; cleanupTimeoutMs?: number;
  verifyBackground?: (scope: BrowserScope & { taskRunId?: string; taskLeaseToken?: string; backgroundTaskKind?: string }) => boolean };

export class BrowserService extends EventEmitter {
  private db: DatabaseSync;
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();
  private networkChanges = new Set<string>();
  private closing = false;
  private shutdown?: Promise<void>;
  private databaseClosed = false;
  private readonly operations = new Set<BrowserOperation>();
  private readonly contextsToClose = new Map<string, BrowserContext>();
  private readonly closingContexts = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, number>();
  private readonly idleTimer: NodeJS.Timeout;
  private idleSweep?: Promise<void>;
  constructor(readonly options: Options) {
    super(); mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(options.directory, "browser.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,conversation_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(session_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,name TEXT NOT NULL,direction TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,revision INTEGER NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,session_id TEXT NOT NULL,action TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    if (!this.db.prepare("PRAGMA table_info(events)").all().some(column => column.name === "details_json"))
      this.db.exec("ALTER TABLE events ADD COLUMN details_json TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS browser_events_time ON events(created_at)");
    // A restart never resumes an action or replays a submission. Profile data survives.
    for (const row of this.db.prepare("SELECT payload FROM sessions").all() as { payload: string }[]) {
      const session = JSON.parse(row.payload) as BrowserSession;
      if (session.mode === "stopped") continue;
      this.save({ ...session, mode: "paused", pauseReason: session.mode === "paused" ? session.pauseReason ?? "unknown" : "restart", revision: session.revision + 1, updatedAt: Date.now() }, false);
    }
    this.db.exec("UPDATE commands SET state='uncertain' WHERE state='running'");
    this.idleTimer = setInterval(() => { void this.reapIdle().catch(() => {}); }, Math.min(30_000, this.idleTimeout));
    this.idleTimer.unref();
  }
  private operation(timeout: number, parent?: AbortSignal, interrupted?: (reason: unknown) => void): BrowserOperation {
    const operation = new BrowserOperation(timeout, parent, interrupted);
    this.operations.add(operation); return operation;
  }
  private finishOperation(operation: BrowserOperation): void { this.operations.delete(operation); operation.close(); }
  private get readTimeout(): number { return this.options.readTimeoutMs ?? 8000; }
  private get cleanupTimeout(): number { return this.options.cleanupTimeoutMs ?? 2000; }
  private closeContext(id: string, context: Promise<BrowserContext | undefined>, live?: Live): Promise<void> {
    let owned: BrowserContext | undefined;
    const task = context.then(context => {
      owned = context;
      if (!context) return;
      this.contextsToClose.set(id, context);
      // Cut off egress immediately even if Chromium refuses to terminate.
      if (live) { clearInterval(live.safetyTimer); void live.gateway.close().catch(() => {}); }
      return context.browser()?.close() ?? context.close();
    }).finally(async () => {
      if (live) await Promise.allSettled([live.traffic.close(), live.diagnostics.close(), live.gateway.close()]);
    }).then(() => {
      if (owned && this.contextsToClose.get(id) === owned) this.contextsToClose.delete(id);
      if (live && this.live.get(id) === live) this.live.delete(id);
    }).finally(() => { if (this.closingContexts.get(id) === task) this.closingContexts.delete(id); });
    this.closingContexts.set(id, task);
    void task.catch(() => console.warn("Unable to close interrupted browser"));
    return task;
  }
  /** Quarantine before rejecting a tool: an old native request must never share the next turn's browser. */
  private interrupt(id: string, live: Live, timeout: boolean): void {
    if (live.disposing) return;
    this.saveWorkspace(id, live);
    live.disposing = true; live.epoch++; live.observation = undefined; live.pending = undefined; live.controller = undefined;
    live.editing?.reset(); clearInterval(live.cookieTimer);
    const current = this.row(id);
    if (current) this.update(current, { ...(current.mode === "agent" ? { mode: "paused" as const, pauseReason: "disconnected" as const } : {}),
      error: timeout ? "网页无响应，请继续浏览。" : "浏览器操作已取消，请继续浏览。" });
    this.record(id, "interrupt", timeout ? "timeout" : "cancelled", false);
    // Each persistent context owns a separate Chromium process. Closing its browser also
    // terminates paused scripts; Page.stopLoading alone cannot cancel those reads.
    void this.closeContext(id, Promise.resolve(live.context), live);
  }
  private get idleTimeout(): number { return this.options.idleTimeoutMs ?? IDLE_TIMEOUT; }
  private touch(id: string): void { const live = this.live.get(id); if (live) live.lastActivityAt = Date.now(); }
  /** Trusted executor lifetime: protect model thinking and tool continuations, including proactive runs. */
  retainForRun(scope: BrowserScope): (() => void) | undefined {
    if (this.closing || scope.agentId !== this.options.agentId || scope.userId !== this.options.ownerUserId
      || scope.conversationKind !== "p2p" || !scope.conversationId) return;
    const conversation = scope.conversationId;
    this.activeRuns.set(conversation, (this.activeRuns.get(conversation) ?? 0) + 1);
    this.publishRunState(conversation);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = (this.activeRuns.get(conversation) ?? 1) - 1;
      if (count > 0) this.activeRuns.set(conversation, count);
      else {
        this.activeRuns.delete(conversation);
        if (!this.closing) for (const [id] of this.live) if (this.row(id)?.conversationId === conversation) this.touch(id);
      }
      this.publishRunState(conversation);
    };
  }
  private publishRunState(conversation: string): void {
    if (this.closing) return;
    const row = this.db.prepare("SELECT id FROM sessions WHERE conversation_id=?").get(conversation) as { id: string } | undefined;
    if (row) this.emit("view", row.id);
  }
  private reapIdle(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.idleSweep) return this.idleSweep;
    const eligible = (id: string, live: Live) => {
      if (this.closing) return false;
      const session = this.row(id);
      return this.live.get(id) === live && !live.disposing && !live.downloads && session
        && Date.now() - live.lastActivityAt >= this.idleTimeout
        && !(session.mode === "agent" && this.activeRuns.has(session.conversationId));
    };
    const task = Promise.allSettled([...this.live].filter(([id, live]) => eligible(id, live)).map(([id, live]) => this.serial(live, async () => {
      // Queued activity, a new turn or a control transition wins over reclamation.
      if (!eligible(id, live)) return;
      await this.releasePointer(live); await this.checkpoint(live);
      if (!eligible(id, live)) return;
      live.epoch++; live.observation = undefined; live.pending = undefined; live.controller = undefined; live.editing?.reset();
      live.disposing = true;
      this.update(this.row(id)!, { mode: "paused", pauseReason: "idle", resumeOnUse: this.row(id)?.mode === "agent", error: undefined });
      try { await this.closeContext(id, Promise.resolve(live.context), live); }
      catch { return; }
      if (!this.closing) {
        this.record(id, "idle_close", "completed");
      }
    }))).then(() => {});
    this.idleSweep = task.finally(() => { this.idleSweep = undefined; });
    return this.idleSweep;
  }
  private assert(scope: BrowserScope): void {
    if (this.closing || scope.agentId !== this.options.agentId || scope.userId !== this.options.ownerUserId
      || scope.conversationKind !== "p2p" || !scope.conversationId) throw new Error("浏览器仅对所属用户的私聊开放");
    scope.signal?.throwIfAborted();
  }
  sessions(scope: BrowserScope): BrowserSession[] {
    this.assert(scope);
    return (this.db.prepare("SELECT payload FROM sessions ORDER BY rowid DESC").all() as { payload: string }[]).map(row => JSON.parse(row.payload) as BrowserSession);
  }
  summary(scope: BrowserScope, id: string): BrowserSession & { running: boolean; agentRunning: boolean } {
    const session = this.session(scope, id), live = this.live.get(id);
    return { ...session, running: Boolean(live && !live.disposing), agentRunning: session.mode === "agent" && this.activeRuns.has(session.conversationId) };
  }
  private session(scope: BrowserScope, id?: string): BrowserSession {
    this.assert(scope);
    const row = (id ? this.db.prepare("SELECT payload FROM sessions WHERE id=?").get(id)
      : this.db.prepare("SELECT payload FROM sessions WHERE conversation_id=?").get(scope.conversationId!)) as { payload: string } | undefined;
    const session = row && JSON.parse(row.payload) as BrowserSession | undefined;
    if (!session || session.conversationId !== scope.conversationId) throw new Error("此浏览器不属于当前对话");
    return session;
  }
  private save(session: BrowserSession, emit = true): BrowserSession {
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload")
      .run(session.id, session.conversationId, JSON.stringify(session));
    if (emit && !this.closing) this.emit("change", session);
    return session;
  }
  private update(session: BrowserSession, patch: Partial<BrowserSession>): BrowserSession {
    const current = JSON.parse((this.db.prepare("SELECT payload FROM sessions WHERE id=?").get(session.id) as { payload: string }).payload) as BrowserSession;
    return this.save({ ...current, ...patch, revision: current.revision + 1, updatedAt: Date.now() });
  }
  create(scope: BrowserScope, title = "浏览器", mode: "agent" | "user" = "agent"): BrowserSession {
    this.assert(scope);
    const found = this.sessions(scope).find(item => item.conversationId === scope.conversationId);
    if (found) return found;
    if (this.sessions(scope).length >= 12) throw new Error("浏览器数量已达上限");
    return this.save({ id: randomUUID(), conversationId: scope.conversationId!, sourceSessionId: scope.sessionId, title, mode, network: "direct", revision: 1, updatedAt: Date.now() });
  }
  /** A trusted new user message hands this conversation back to the agent, without launching a browser. */
  async resumeForMessage(scope: BrowserScope): Promise<void> {
    this.assert(scope);
    const session = this.sessions(scope).find(item => item.conversationId === scope.conversationId);
    if (!session) return;
    if (session.pauseReason === "navigation_loop") return; // Requires explicit manual inspection, not an automatic reopen.
    const live = this.live.get(session.id);
    let handoffEpoch = live?.epoch;
    const ownsHandoff = () => !live || live.epoch === handoffEpoch;
    const operation = this.operation(this.options.operationTimeoutMs ?? 30000, scope.signal, reason => {
      if (live && ownsHandoff()) {
        this.interrupt(session.id, live, reason instanceof BrowserTimeoutError);
        handoffEpoch = live.epoch;
      }
    });
    try {
      this.touch(session.id);
      if (live && !live.disposing) {
        live.epoch++; live.controller = undefined; live.observation = undefined; live.pending = undefined; live.editing?.reset();
        handoffEpoch = live.epoch;
        for (const item of session.restrictions ?? []) if (item.kind !== "verification") live.gateway.restrict(item.origin, item.retryAt ?? item.detectedAt + 10 * 60000);
        // Transfer ownership without aborting the site's login/verification loads.
        // Old queued commands are fenced; an already dispatched command may settle.
        await operation.wait(() => live.tail);
        if (!ownsHandoff()) return;
        await operation.wait(() => this.releasePointer(live));
        if (!ownsHandoff()) return;
        if (session.restrictions?.some(item => item.kind !== "verification" && (item.retryAt ?? item.detectedAt + 10 * 60000) > Date.now())) {
          this.saveWorkspace(session.id, live);
          void live.gateway.close().catch(() => {});
          await operation.wait(() => this.checkpoint(live));
          if (!ownsHandoff()) return;
          live.disposing = true; clearInterval(live.cookieTimer);
          await operation.wait(() => this.closeContext(session.id, Promise.resolve(live.context), live));
        }
      }
      this.assert(scope);
      if (!ownsHandoff()) return;
      operation.close(); // Cleanup deadline must not interrupt the separate read-only safety inspection.
      if (live && !live.disposing && await this.checkSafety(session.id, live, "message", true)) return;
      this.assert(scope);
      if (!ownsHandoff()) return;
      this.update(session, { mode: "agent", pauseReason: undefined, resumeOnUse: undefined, error: undefined });
    } catch (error) {
      if (!(error instanceof BrowserTimeoutError)) throw error;
      if (!ownsHandoff()) return;
      // The old context is quarantined. A new turn can still answer without using it.
      this.update(session, { mode: "agent", pauseReason: undefined, resumeOnUse: undefined });
    } finally { this.finishOperation(operation); }
  }
  private async launch(session: BrowserSession, viewport: Viewport = { width: WIDTH, height: HEIGHT }, operation?: BrowserOperation, controller?: string, destination?: string): Promise<Live> {
    if (this.networkChanges.has(session.id)) throw new Error("浏览器网络正在切换，请稍后重试");
    if (!operation) {
      const owned = this.operation(this.options.operationTimeoutMs ?? 30000);
      try { return await owned.wait(() => this.launch(session, viewport, owned, controller, destination)); }
      finally { this.finishOperation(owned); }
    }
    const wait = <T>(work: () => Promise<T>) => operation ? operation.wait(work) : boundedBrowserWork(work, this.options.operationTimeoutMs ?? 30000);
    const existing = this.live.get(session.id);
    const abandoned = this.contextsToClose.get(session.id);
    const priorClose = this.closingContexts.get(session.id) ?? (abandoned ? this.closeContext(session.id, Promise.resolve(abandoned), existing?.context === abandoned ? existing : undefined) : undefined);
    if (!existing && priorClose) await wait(() => boundedBrowserWork(() => priorClose, this.cleanupTimeout));
    if (existing?.disposing) {
      const closing = this.closingContexts.get(session.id) ?? this.closeContext(session.id, Promise.resolve(existing.context), existing);
      await wait(() => boundedBrowserWork(() => closing, this.cleanupTimeout));
      return this.launch(session, viewport, operation, controller, destination);
    }
    if (existing) return existing;
    const pending = this.starting.get(session.id); if (pending) return wait(() => pending);
    if (this.live.size + this.starting.size >= 3) throw new Error("同时最多运行三个浏览器，请先停止其他浏览器");
    let launched: BrowserContext | undefined;
    let launchingContext: Promise<BrowserContext> | undefined;
    let cookieTimer: NodeJS.Timeout | undefined;
    let gateway: BrowserGateway | undefined;
    let traffic: BrowserTraffic | undefined;
    let diagnostics: BrowserDiagnostics | undefined;
    const launchStarted = Date.now();
    this.record(session.id, "launch", "started", false);
    const task = (async () => {
      const directory = join(this.options.directory, session.id);
      await wait(() => mkdir(directory, { recursive: true, mode: 0o700 }));
      // Validate the administrator-selected upstream before creating any listener.
      browserConnection(session.network ?? "direct", this.options.proxyUrl);
      gateway = await startBrowserGateway({ network: session.network ?? "direct", upstreamProxyUrl: this.options.proxyUrl, testLocal: this.options.testLocal });
      if (operation.signal.aborted || this.closing) { await gateway.close(); operation.signal.throwIfAborted(); throw new Error("浏览器服务正在关闭"); }
      if (session.mode !== "user") for (const item of session.restrictions ?? []) if (item.kind !== "verification")
        gateway.restrict(item.origin, item.retryAt ?? item.detectedAt + 10 * 60000);
      operation.signal.throwIfAborted();
      const launching = launchingContext = chromium.launchPersistentContext(join(directory, "profile"), {
        headless: true, chromiumSandbox: true, viewport,
        acceptDownloads: true, serviceWorkers: "block", locale: "zh-CN", timezoneId: "Asia/Shanghai",
        executablePath: this.options.executablePath ?? browserExecutable(), downloadsPath: join(directory, "temporary-downloads"),
        proxy: gateway.proxy,
        // Translate is already disabled by Playwright. A second disable-features
        // switch replaces its full Chromium compatibility list, including the
        // Fetch interception / cross-origin redirect workarounds we rely on.
        args: ["--disable-background-networking", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", ...gateway.args]
      });
      const context = await wait(() => launching);
      launched = context;
      this.record(session.id, "launch", "context_ready", false, { durationMs: Date.now() - launchStarted });
      context.setDefaultTimeout(8000); context.setDefaultNavigationTimeout(20000);
      // Keep website JavaScript globals native. Replacing console methods breaks
      // sites that validate native APIs before running their page logic.
      const workspace = this.workspace(session.id);
      traffic = new BrowserTraffic(batch => this.record(session.id, "traffic", "batch", false, { traffic: batch }));
      diagnostics = new BrowserDiagnostics(event => this.record(session.id, "diagnostic", event.kind, false, { diagnostic: event }),
        page => this.stopNavigationLoop(session.id, live, page));
      const live: Live = { context, gateway, traffic, diagnostics, ready: new WeakMap(), documents: new WeakMap(), controller, pages: new Map(), tabs: new Map(), active: "", epoch: 0, navigation: 0, tail: Promise.resolve(), restoring: true, disposing: false, downloads: 0, lastActivityAt: Date.now(), desiredViewport: viewport, viewportTasks: new WeakMap(), cookiePath: join(directory, "session-cookies.json"), cookieTail: Promise.resolve() };
      try {
        const saved = JSON.parse(await wait(() => readFile(live.cookiePath, "utf8"))) as Cookie[];
        if (Array.isArray(saved) && saved.length <= 5000) {
          // Chromium owns persistent cookies, including rotations and deletions.
          // Legacy checkpoints contained all cookies; never replay those values.
          const key = (cookie: Cookie) => JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey ?? ""]);
          const current = new Set((await wait(() => context.cookies())).map(key));
          const missing = saved.filter(cookie => cookie.expires === -1 && !current.has(key(cookie)));
          if (missing.length) await wait(() => context.addCookies(missing));
        }
      } catch { operation.signal.throwIfAborted(); /* Missing/expired cookies leave the normal profile intact. */ }
      operation.signal.throwIfAborted();
      live.cookieTimer = cookieTimer = setInterval(() => { void this.checkpoint(live).catch(() => {}); }, 10000); live.cookieTimer.unref();
      // The authenticated gateway checks and pins every destination connection.
      // Playwright routing (including proxy credentials) would disable HTTP caching.
      context.on("request", request => {
        try { if (request.isNavigationRequest()) {
          const page = [...live.pages.values()].find(page => page.mainFrame() === request.frame());
          if (page) live.documents.delete(page);
        } } catch { /* Detached frames have no document state to clear. */ }
        if (request.isNavigationRequest() && request.method() !== "GET") {
          try { const tab = [...live.pages].find(([, page]) => page.mainFrame() === request.frame())?.[0];
            if (tab && live.tabs.has(tab)) live.tabs.get(tab)!.restore = false;
          } catch { /* A detached frame cannot become a recoverable submission. */ }
        }
      });
      let restored = 0;
      const add = (page: Page) => {
        if (this.closing || live.disposing) { void page.close().catch(() => {}); return; }
        const saved = live.restoring ? workspace.tabs[restored++] : undefined;
        const id = saved?.id ?? randomUUID(); live.pages.set(id, page); live.active = id;
        // Popup callbacks cannot await the session queue: their opener may be
        // holding it while waiting for this very page to appear.
        void this.sizePage(live, page).catch(() => {});
        live.tabs.set(id, saved ? { ...saved } : { id, title: "", url: page.url() });
        const ready = Promise.all([live.gateway.authenticate(page), live.traffic.attach(page), live.diagnostics.attach(page, id), this.sizePage(live, page)]).then(() => {});
        live.ready.set(page, ready); void ready.catch(() => {});
        page.on("framenavigated", frame => {
          if (this.closing || live.disposing) return;
          if (frame === page.mainFrame() && live.pages.get(live.active) === page) live.editing?.reset();
          live.observation = undefined;
          if (frame === page.mainFrame()) {
            live.navigation++;
            this.record(session.id, "navigation", page.url() === "about:blank" ? "blank_page" : "completed", false, { mainFrame: true });
          }
          if (frame !== page.mainFrame() || live.restoring || live.disposing) return;
          const tab = live.tabs.get(id)!;
          const previous = tab.url, url = page.url();
          tab.url = url;
          if (url === "about:blank" && /^https?:/.test(previous)) {
            tab.recoveryUrl = previous;
            this.update(this.row(session.id)!, { error: "网页已变空，请恢复网页" });
          } else if (/^https?:/.test(url)) tab.recoveryUrl = undefined;
          this.saveWorkspace(session.id, live); this.notifyView(session.id);
          void this.checkSafety(session.id, live, "navigation");
        });
        page.on("domcontentloaded", () => { void this.checkSafety(session.id, live, "dom_ready"); });
        page.on("crash", () => this.record(session.id, "page", "crashed", false));
        page.on("pageerror", () => this.record(session.id, "page", "script_error", false));
        page.on("requestfailed", request => this.record(session.id, "request", "failed", false, {
          resourceType: request.resourceType(), failureKind: browserFailureKind(new Error(request.failure()?.errorText ?? "")) }));
        page.on("response", response => {
          try { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
            const value = response.headers()["retry-after"];
            const retryAt = value ? /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value) : undefined;
            live.documents.set(page, { status: response.status(), ...(retryAt !== undefined && Number.isFinite(retryAt) ? { retryAt } : {}) });
          } } catch { /* A detached frame cannot provide reliable document metadata. */ }
          if (response.status() >= 400) this.record(session.id, "request", "http_error", false,
            { resourceType: response.request().resourceType(), httpStatus: response.status() });
        });
        page.on("close", () => { if (live.active === id) live.editing?.reset(); live.pages.delete(id); if (live.active === id) live.active = live.pages.keys().next().value ?? ""; live.observation = undefined; this.notifyView(session.id); });
        page.on("filechooser", chooser => { live.chooser = chooser; this.notifyView(session.id); });
        page.on("dialog", dialog => { live.dialog = dialog; this.notifyView(session.id); });
        page.on("download", download => { live.downloads++; void (async () => {
          const id = randomUUID(), name = safeName(download.suggestedFilename());
          await mkdir(join(directory, "files"), { recursive: true });
          const path = join(directory, "files", id); await download.saveAs(path);
          const { stat } = await import("node:fs/promises"); const info = await stat(path);
          if (info.size > 25 * 1024 * 1024) { await rm(path); return; }
          this.db.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run(id, session.id, name, "download", info.size);
          this.notifyView(session.id);
        })().catch(() => {}).finally(() => { live.downloads--; live.lastActivityAt = Date.now(); }); });
      };
      context.on("page", page => { add(page); this.notifyView(session.id); });
      context.on("close", () => { void live.traffic.close().catch(() => {}); void live.gateway.close().catch(() => {}); const intentional = live.disposing; this.record(session.id, "context", intentional ? "intentional_close" : "disconnected", false); live.editing?.reset(); live.disposing = true; clearInterval(live.cookieTimer); if (this.live.get(session.id) === live) this.live.delete(session.id); if (!this.closing && !intentional) {
        const current = this.row(session.id); if (current && current.mode !== "stopped") this.update(current, { mode: "paused", pauseReason: "disconnected", error: "浏览器连接已断开，请继续浏览" });
      } });
      context.pages().forEach(add); if (!live.pages.size) await wait(() => context.newPage());
      while (live.pages.size < workspace.tabs.length) await wait(() => context.newPage());
      let failed = false;
      for (const [id, page] of live.pages) {
        await wait(() => live.ready.get(page) ?? Promise.resolve());
        await wait(() => live.viewportTasks.get(page) ?? Promise.resolve());
        const tab = live.tabs.get(id)!;
        const url = tab.recoveryUrl ?? tab.url;
        if (!/^https?:/.test(url)) continue;
        if (this.row(session.id)?.restrictions?.some(item => item.kind !== "verification" && urlOrigin(url) === item.origin
          && (item.retryAt ?? item.detectedAt + 10 * 60000) > Date.now())) {
          tab.url = page.url(); tab.recoveryUrl = url; tab.restore = false; continue;
        }
        // A new explicit destination replaces the active GET page. Do not first
        // load a stale page (or its polling/API calls) merely to navigate away.
        if (destination && id === (workspace.activeTab ?? live.pages.keys().next().value)) {
          tab.url = page.url(); tab.recoveryUrl = url; continue;
        }
        // Challenge URLs carry temporary seeds/UUIDs and may start polling on load.
        // Preserve a manual recovery link, never replay them on process restart.
        if (browserRestriction(url, "", "") || browserTransientVerification(url)) { tab.url = page.url(); tab.recoveryUrl = url; tab.restore = false; continue; }
        if (tab.restore === false) { tab.url = page.url(); tab.recoveryUrl = url; continue; }
        const restoreStarted = Date.now();
        try { const response = await wait(async () => page.goto(await browserUrl(url, this.options.testLocal), { waitUntil: "domcontentloaded" }));
          if (response && response.status() >= 500) throw new Error("网页暂时无法访问");
          tab.url = page.url(); tab.recoveryUrl = undefined; }
        catch (error) {
          operation.signal.throwIfAborted();
          this.record(session.id, "restore", "failed", false, { failureKind: browserFailureKind(error), durationMs: Date.now() - restoreStarted });
          tab.url = page.url(); tab.recoveryUrl = url; failed = true;
        }
      }
      if (workspace.activeTab && live.pages.has(workspace.activeTab)) live.active = workspace.activeTab;
      operation?.signal.throwIfAborted();
      live.restoring = false; this.saveWorkspace(session.id, live);
      if (live.disposing) throw new Error("浏览器已停止加载");
      if (failed) this.update(this.row(session.id)!, { error: "部分网页未恢复，请重试" });
      if (this.closing) { await context.close(); throw new Error("浏览器服务正在关闭"); }
      live.lastActivityAt = Date.now(); this.live.set(session.id, live);
      live.safetyTimer = setInterval(() => { void this.checkSafety(session.id, live, "watch"); }, 1500); live.safetyTimer.unref();
      this.record(session.id, "launch", "completed", false, { durationMs: Date.now() - launchStarted }); return live;
    })();
    this.starting.set(session.id, task);
    try { return await wait(() => task); }
    catch (error) {
      clearInterval(cookieTimer);
      void traffic?.close().catch(() => {});
      void diagnostics?.close().catch(() => {});
      void gateway?.close().catch(() => {});
      this.record(session.id, "launch", "failed", false, { durationMs: Date.now() - launchStarted, failureKind: browserFailureKind(error) });
      // A rejected launch created no context; it must not poison later retries.
      const context = launched ? Promise.resolve(launched) : launchingContext?.catch(() => undefined);
      if (context) void this.closeContext(session.id, context);
      if (!this.closing && this.row(session.id)?.revision === session.revision)
        this.update(session, { mode: "paused", pauseReason: "launch_failed", error: "浏览器启动未完成，请重新连接" });
      if (operation?.signal.aborted) throw operation.signal.reason;
      throw new Error("浏览器启动未完成，请重新连接");
    } finally { if (this.starting.get(session.id) === task) this.starting.delete(session.id); }
  }
  private row(id: string): BrowserSession | undefined {
    const row = this.db.prepare("SELECT payload FROM sessions WHERE id=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as BrowserSession : undefined;
  }
  /** Independent of model turns and the viewer: DOM-only challenges are detected too. */
  private async checkSafety(id: string, live: Live, source: string, returning = false): Promise<boolean> {
    if (this.closing || live.disposing || live.restoring) return returning;
    if (live.dialog) return returning ? this.pauseUnknownSafety(id, live, source) : false;
    if (live.safetyCheck) {
      if (!returning) return live.safetyCheck;
      await live.safetyCheck;
      if (live.disposing) return true;
    }
    const epoch = live.epoch, navigation = live.navigation;
    const inspection = this.operation(2200);
    const task = (async () => {
      const found: BrowserRestriction[] = [], clearOrigins = new Set<string>(), unknownOrigins = new Set<string>();
      let complete = true;
      for (const page of live.pages.values()) {
        const url = page.url(), document = live.documents.get(page);
        const inspected = await inspection.wait(() => inspectBrowserRestriction(page));
        if (page.url() !== url) { complete = false; continue; }
        const origin = urlOrigin(url);
        const restriction = document?.status === 429 && origin
          ? { origin, kind: "rate_limit" as const, detectedAt: Date.now(), retryAt: document.retryAt } : inspected.restriction;
        if (restriction) found.push(restriction);
        else if (inspected.complete && origin) clearOrigins.add(origin);
        if (!inspected.complete && origin) unknownOrigins.add(origin);
        complete &&= inspected.complete;
      }
      if (this.closing || live.disposing) return true;
      if (live.epoch !== epoch) return returning; // A newer takeover/pause/stop owns the state.
      if (live.navigation !== navigation) return returning ? this.pauseUnknownSafety(id, live, source) : false;
      const current = this.row(id); if (!current || current.mode === "stopped") return true;
      const restrictions = (current.restrictions ?? []).filter(item => item.kind !== "verification" || !clearOrigins.has(item.origin)
        || unknownOrigins.has(item.origin) || found.some(next => next.origin === item.origin));
      for (const item of found) {
        const index = restrictions.findIndex(previous => previous.origin === item.origin);
        if (index >= 0 && restrictions[index]!.kind === item.kind) continue;
        if (index >= 0) restrictions.splice(index, 1);
        restrictions.push(item);
        this.record(id, "restriction", item.kind, false, { source });
      }
      const detected = found.find(item => item.kind !== "verification") ?? found[0];
      if (detected) {
        const reason = detected.kind === "verification" ? "verification" : "restricted";
        // Manual verification must remain usable. It still updates the badge and audit record.
        const mode = current.mode === "user" && !returning ? "user" : "paused";
        const changed = current.mode !== mode || current.pauseReason !== reason
          || JSON.stringify(current.restrictions ?? []) !== JSON.stringify(restrictions);
        if (changed) {
          if (mode !== "user") { live.epoch++; live.controller = undefined; live.observation = undefined; live.pending = undefined; live.editing?.reset(); }
          this.update(current, { mode, pauseReason: reason, restrictions: restrictions.slice(-16), resumeOnUse: undefined, error: undefined });
        }
        if (reason === "restricted" && mode !== "user") {
          this.saveWorkspace(id, live); live.disposing = true; clearInterval(live.cookieTimer); clearInterval(live.safetyTimer);
          void live.gateway.close().catch(() => {}); void this.closeContext(id, Promise.resolve(live.context), live);
        }
        return true;
      }
      if (returning && !complete) return this.pauseUnknownSafety(id, live, source);
      if (JSON.stringify(current.restrictions ?? []) !== JSON.stringify(restrictions)) {
        this.update(current, { restrictions, ...(current.mode === "user" ? { pauseReason: undefined } : {}) });
        this.record(id, "restriction", "verification_cleared", false, { source });
      }
      return false;
    })().catch(error => {
      if (!this.closing && !live.disposing && Date.now() - (live.safetyFailureAt ?? 0) > 30000) {
        live.safetyFailureAt = Date.now(); this.record(id, "restriction", "inspection_failed", false, { source, failureKind: browserFailureKind(error) });
      }
      if (returning && !this.closing && !live.disposing && live.epoch === epoch) return this.pauseUnknownSafety(id, live, source);
      if (returning) return true;
      return false;
    });
    live.safetyCheck = task;
    try { return await task; } finally { this.finishOperation(inspection); if (live.safetyCheck === task) live.safetyCheck = undefined; }
  }
  private pauseUnknownSafety(id: string, live: Live, source: string): boolean {
    const current = this.row(id); if (!current || current.mode === "stopped" || live.disposing) return true;
    live.epoch++; live.controller = undefined; live.observation = undefined; live.pending = undefined; live.editing?.reset();
    this.update(current, { mode: "paused", pauseReason: "unknown", error: "网页状态未确认，请重试" });
    this.record(id, "restriction", "inspection_incomplete", false, { source }); return true;
  }
  private stopNavigationLoop(id: string, live: Live, page: Page): void {
    if (this.closing || live.disposing) return;
    for (const [tab, candidate] of live.pages) if (candidate === page) {
      const saved = live.tabs.get(tab)!;
      saved.url = page.url(); saved.recoveryUrl = /^https?:/.test(saved.url) ? saved.url : saved.recoveryUrl; saved.restore = false;
    }
    // Persist before fencing; close every connection so cross-origin API loops also stop.
    live.restoring = false;
    this.saveWorkspace(id, live);
    live.disposing = true; live.epoch++; live.controller = undefined; live.observation = undefined; live.pending = undefined; live.editing?.reset();
    clearInterval(live.safetyTimer); clearInterval(live.cookieTimer);
    const current = this.row(id);
    if (current) this.update(current, { mode: "paused", pauseReason: "navigation_loop", resumeOnUse: false, error: "网页反复跳转，已停止加载" });
    void live.gateway.close().catch(() => {});
    void boundedBrowserWork(() => this.checkpoint(live, true), this.cleanupTimeout).catch(() => {})
      .finally(() => this.closeContext(id, Promise.resolve(live.context), live)).catch(() => {});
  }
  private workspace(id: string): Workspace {
    const row = this.db.prepare("SELECT payload FROM workspaces WHERE session_id=?").get(id) as { payload: string } | undefined;
    if (row) return JSON.parse(row.payload) as Workspace;
    // Older releases saved only the Chromium profile. Recover its last visited
    // address for an explicit reload, never automatically replay legacy history.
    let history: DatabaseSync | undefined;
    try {
      history = new DatabaseSync(join(this.options.directory, id, "profile", "Default", "History"), { readOnly: true });
      const last = history.prepare("SELECT url,title FROM urls WHERE url LIKE 'https://%' OR url LIKE 'http://%' ORDER BY last_visit_time DESC LIMIT 1").get() as { url: string; title: string } | undefined;
      if (last && last.url.length <= 4096) {
        const tab: BrowserTab = { id: randomUUID(), title: last.title.slice(0, 120), url: "about:blank", recoveryUrl: last.url, restore: false };
        const workspace: Workspace = { tabs: [tab], activeTab: tab.id };
        this.db.prepare("INSERT INTO workspaces VALUES(?,?)").run(id, JSON.stringify(workspace));
        return workspace;
      }
    } catch { /* Missing or locked legacy history does not prevent browser use. */ }
    finally { history?.close(); }
    return { tabs: [] };
  }
  private saveWorkspace(id: string, live: Live): void {
    if (live.restoring || live.disposing || !live.pages.size) return;
    const workspace: Workspace = { tabs: [...live.pages.keys()].map(id => live.tabs.get(id)!), activeTab: live.active };
    this.db.prepare("INSERT INTO workspaces VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload").run(id, JSON.stringify(workspace));
  }
  async view(scope: BrowserScope, id: string): Promise<BrowserView> {
    const session = this.session(scope, id), live = this.live.get(id);
    const workspace = this.workspace(id);
    const operation = this.operation(this.readTimeout, scope.signal, reason => {
      if (live && !live.disposing) this.interrupt(id, live, reason instanceof BrowserTimeoutError);
    });
    try {
      const tabs = live && !live.disposing ? await operation.wait(() => Promise.all([...live.pages].map(async ([id, page]) => {
        await operation.wait(() => live.viewportTasks.get(page)?.catch(() => {}) ?? Promise.resolve());
        const tab = live.tabs.get(id)!;
        const title = (live.dialog ? "网页" : await operation.wait(() => page.title().catch(() => ""))).slice(0, 120);
        if (title) tab.title = title;
        return { ...tab, url: page.url() };
      }))) : workspace.tabs;
      if (live) this.saveWorkspace(id, live);
      const current = this.row(session.id)!;
      return { ...current, network: current.network ?? "direct", proxyAvailable: Boolean(this.options.proxyUrl), running: Boolean(live && !live.disposing),
        agentRunning: current.mode === "agent" && this.activeRuns.has(current.conversationId), tabs,
        pendingSubmission: live?.pending ? { id: live.pending.id, label: live.pending.label } : undefined,
        activeTab: live?.active ?? workspace.activeTab, viewport: live?.pages.get(live.active)?.viewportSize() ?? { width: WIDTH, height: HEIGHT }, fileChooser: Boolean(live?.chooser),
        ...(live?.dialog ? { dialog: { type: live.dialog.type(), message: live.dialog.message().slice(0, 1000) } } : {}),
        files: (this.db.prepare("SELECT id,name,direction FROM files WHERE session_id=? ORDER BY rowid DESC LIMIT 30").all(id) as BrowserView["files"]) };
    } finally { this.finishOperation(operation); }
  }
  private checkpoint(live: Live, closing = false): Promise<unknown> {
    // Session cookies are not persisted by Chromium itself on a clean shutdown.
    // Keep this credential file private and atomic; no model or media API exposes it.
    const id = [...this.live].find(([, value]) => value === live)?.[0];
    if (id) this.saveWorkspace(id, live);
    const previous = live.cookieTail;
    const task = boundedBrowserWork(() => previous.catch(() => {}), this.cleanupTimeout).then(async () => {
      const cookies = await boundedBrowserWork(() => live.context.cookies(), this.cleanupTimeout), temporary = live.cookiePath + "." + randomUUID() + ".tmp";
      if (live.disposing && !closing) return;
      await writeFile(temporary, JSON.stringify(cookies.filter(cookie => cookie.expires === -1)), { mode: 0o600 });
      if (!live.disposing || closing) await rename(temporary, live.cookiePath);
      else await rm(temporary, { force: true });
    });
    void task.catch(() => {});
    live.cookieTail = task; return task;
  }
  private async stopLoading(live: Live): Promise<void> {
    const task = (async () => { const client = await live.context.newCDPSession(this.page(live));
      try { await client.send("Page.stopLoading"); } finally { await client.detach().catch(() => {}); } })().catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([task, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); if (timer) clearTimeout(timer);
  }
  private page(live: Live): Page { const page = live.pages.get(live.active); if (!page) throw new Error("请先打开一个标签页"); return page; }
  private sizePage(live: Live, page: Page): Promise<void> {
    const task = (live.viewportTasks.get(page) ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!page.isClosed()) await page.setViewportSize(live.desiredViewport);
    });
    live.viewportTasks.set(page, task); return task;
  }
  private async newPage(live: Live): Promise<Page> {
    const page = await live.context.newPage();
    await live.ready.get(page);
    await live.viewportTasks.get(page); return page;
  }
  private async resize(live: Live, viewport: Viewport): Promise<void> {
    live.desiredViewport = viewport;
    await Promise.all([...live.pages.values()].map(page => this.sizePage(live, page)));
  }
  private serial<T>(live: Live, run: () => Promise<T>, activity = false): Promise<T> {
    if (activity) live.lastActivityAt = Date.now();
    const task = live.tail.catch(() => {}).then(async () => {
      if (activity) live.lastActivityAt = Date.now();
      try { return await run(); } finally { if (activity) live.lastActivityAt = Date.now(); }
    });
    live.tail = task.catch(() => {}); return task;
  }
  private async releasePointer(live: Live): Promise<void> {
    const pointer = live.pointer; if (!pointer) return;
    live.pointer = undefined; clearTimeout(pointer.timer);
    // Release outside the page so cancellation cannot click the pressed control.
    await pointer.page.mouse.move(-1, -1).catch(() => {});
    await pointer.page.mouse.up().catch(() => {});
  }
  private pointerTimeout(live: Live): void {
    const pointer = live.pointer; if (!pointer) return;
    clearTimeout(pointer.timer);
    const timer = setTimeout(() => { void this.serial(live, async () => {
      if (live.pointer === pointer && pointer.timer === timer) await this.releasePointer(live);
    }); }, 15000);
    pointer.timer = timer;
    pointer.timer.unref();
  }
  private async observe(live: Live, stage?: (state: string, details?: BrowserEventDetails) => void, operation?: BrowserOperation) {
    const wait = <T>(work: () => Promise<T>) => operation ? operation.wait(work) : boundedBrowserWork(work, this.readTimeout);
    if (live.dialog) return { observation: randomUUID(), tab: live.active, url: this.page(live).url(), text: "", elements: [],
      viewport: this.page(live).viewportSize() ?? live.desiredViewport, dialog: { type: live.dialog.type(), message: live.dialog.message().slice(0, 1000) } };
    const page = this.page(live), refs = new Map<string, ElementHandle>(), elements: BrowserElement[] = [];
    if (page.url() === "about:blank" && live.tabs.get(live.active)?.recoveryUrl) throw new Error("网页已变空，请在浏览器中恢复网页后重试");
    const navigation = live.navigation, epoch = live.epoch;
    const observation = { id: randomUUID(), page, url: page.url(), at: Date.now(), refs };
    for (const [frameIndex, frame] of page.frames().slice(0, 12).entries()) {
      if (elements.length >= 160) break;
      const details = { frameIndex, mainFrame: frame === page.mainFrame(), elementCount: elements.length };
      if (frame !== page.mainFrame()) {
        stage?.("frame_visibility", details);
        const host = await wait(() => frame.frameElement());
        try { if (!await wait(() => host.isVisible())) { stage?.("frame_skipped", { ...details, visible: false }); continue; } }
        finally { void host.dispose().catch(() => {}); }
      }
      stage?.("elements_query", details);
      // Keep refs and metadata in the same captured node list. Two bounded CDP
      // reads per frame replace one remote evaluate for every visible element.
      const captured = await wait(() => frame.evaluateHandle(({ selector, limit }) => {
        const result: Array<{ node: HTMLElement; distance: number }> = [];
        for (const node of document.querySelectorAll<HTMLElement>(selector)) {
          const box = node.getBoundingClientRect();
          if (!box.width || !box.height || getComputedStyle(node).visibility === "hidden") continue;
          // A long station list must expose the controls currently on screen,
          // even when hundreds of earlier links remain rendered above it.
          const distance = Math.max(0, -box.bottom, box.top - innerHeight)
            + Math.max(0, -box.right, box.left - innerWidth);
          result.push({ node, distance });
        }
        return result.sort((a, b) => a.distance - b.distance).slice(0, limit).map(item => item.node);
      }, { selector: interactive, limit: 160 - elements.length }));
      try {
        const items = await wait(() => captured.evaluate(nodes => nodes.map(element => {
          const input = element as HTMLInputElement, rect = element.getBoundingClientRect();
          const label = element.getAttribute("aria-label") || input.labels?.[0]?.innerText || element.getAttribute("placeholder") || element.innerText || element.getAttribute("title") || "";
          return { role: element.getAttribute("role") || element.tagName.toLowerCase(), name: label.trim().slice(0, 180), type: input.type || undefined,
            value: input.type !== "password" && input.type !== "hidden" && typeof input.value === "string" ? input.value.slice(0, 400) : undefined,
            disabled: Boolean(input.disabled) || element.getAttribute("aria-disabled") === "true" || undefined,
            bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            options: element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).options).slice(0, 30).map(option => option.value + ": " + option.text) : undefined };
        })));
        const properties = await wait(() => captured.getProperties());
        stage?.("elements_read", { ...details, elementCount: items.length });
        for (const [key, property] of properties) {
          const item = items[Number(key)], handle = property.asElement();
          if (!item || !handle) { void property.dispose().catch(() => {}); continue; }
          const ref = "e" + (elements.length + 1); refs.set(ref, handle);
          // Frame-local rectangles are not screenshot coordinates. Only expose
          // main-frame bounds rather than inviting a misplaced coordinate click.
          elements.push({ ref, ...item, bounds: frame === page.mainFrame() ? item.bounds : undefined });
        }
      } finally { void captured.dispose().catch(() => {}); }
    }
    stage?.("title_read");
    const title = await wait(() => page.title());
    stage?.("body_read");
    const text = (await wait(() => page.locator("body").innerText({ timeout: 3000 }).catch(() => ""))).slice(0, 14000);
    operation?.signal.throwIfAborted();
    if (live.disposing) throw new Error("浏览器已断开，请重新观察页面");
    if (live.epoch !== epoch || navigation !== live.navigation || this.page(live) !== page || page.url() !== observation.url) {
      for (const ref of refs.values()) void ref.dispose().catch(() => {});
      throw new Error("页面已变化，请重新 observe 后操作");
    }
    if (live.observation) for (const ref of live.observation.refs.values()) void ref.dispose().catch(() => {});
    live.observation = observation;
    if (title) live.tabs.get(live.active)!.title = title.slice(0, 120);
    return { observation: observation.id, tab: live.active, url: observation.url, title, text, elements, httpStatus: live.documents.get(page)?.status,
      viewport: page.viewportSize() ?? live.desiredViewport, fileChooser: Boolean(live.chooser) };
  }
  private target(live: Live, input: BrowserInput): ElementHandle | undefined {
    const observation = live.observation;
    if (!observation || input.observation !== observation.id || observation.page !== this.page(live) || observation.url !== this.page(live).url() || Date.now() - observation.at > 120000)
      throw new Error("页面已变化，请重新 observe 后操作");
    if (!input.ref) return undefined;
    const handle = observation.refs.get(input.ref); if (!handle) throw new Error("元素引用已失效，请重新 observe"); return handle;
  }
  private async formHash(live: Live, operation: BrowserOperation): Promise<string> {
    const page = this.page(live), values: unknown[] = [];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) {
        const host = await operation.wait(() => frame.frameElement());
        try { if (!await operation.wait(() => host.isVisible())) continue; }
        finally { void host.dispose().catch(() => {}); }
      }
      values.push(await operation.wait(() => frame.evaluate(() => [location.href,
        Array.from(document.querySelectorAll('input,textarea,select,[contenteditable="true"]')).map(node => {
          const input = node as HTMLInputElement; return [input.name, input.type, input.value, input.checked, node.textContent];
        })])));
    }
    return createHash("sha256").update(JSON.stringify([page.url(), values])).digest("hex");
  }
  private async actionPolicy(live: Live, input: BrowserInput) {
    const target = input.observation ? this.target(live, input) : undefined;
    return browserActionPolicy(this.page(live), target, { enter: input.action === "press" && /(?:^|\+)Enter$/.test(input.key ?? ""), x: input.x, y: input.y });
  }
  private async submissionLabel(live: Live, input: BrowserInput): Promise<string | undefined> {
    if (input.action !== "click" && !(input.action === "press" && /(?:^|\+)Enter$/.test(input.key ?? ""))) return;
    const policy = await this.actionPolicy(live, input);
    return policy.submits || policy.confirm ? policy.label : undefined;
  }
  async execute(scope: BrowserScope, raw: unknown, approval?: symbol): Promise<unknown> {
    this.assert(scope);
    const input = browserInputSchema.parse(raw);
    let active: { session: BrowserSession; live: Live } | undefined;
    const operation = this.operation(this.options.operationTimeoutMs ?? 30000, scope.signal, reason => {
      if (active) this.interrupt(active.session.id, active.live, reason instanceof BrowserTimeoutError);
    });
    try { return await operation.wait(() => this.executeWithin({ ...scope, signal: operation.signal }, input, approval, operation, value => { active = value; })); }
    finally { this.finishOperation(operation); }
  }
  private async executeWithin(scope: BrowserScope, input: BrowserInput, approval: symbol | undefined, operation: BrowserOperation,
    selected: (value: { session: BrowserSession; live: Live }) => void): Promise<unknown> {
    this.assert(scope);
    let session = input.action === "open" ? this.create(scope, input.title) : this.session(scope);
    if (input.action === "status") return this.view(scope, session.id);
    this.touch(session.id);
    // Idle reclamation is transparent to a later authorized task, while a
    // manual pause/takeover or security handoff still requires the user's return.
    if (session.mode === "paused" && session.pauseReason === "idle" && session.resumeOnUse)
      session = this.update(session, { mode: "agent", pauseReason: undefined, resumeOnUse: undefined });
    if (input.action === "handoff" && session.mode === "agent") { session = await this.mode(scope, session.id, "pause", undefined, undefined, "handoff"); }
    if (session.pauseReason === "navigation_loop") return { status: "paused", browser: session.id, pauseReason: "navigation_loop",
      message: "Repeated document navigation was stopped. Do not automatically reopen, refresh, change network or replay the last action. Ask the user to inspect the browser and explicitly recover the page." };
    if (session.mode !== "agent") return { status: session.mode, browser: session.id, pauseReason: session.pauseReason,
      message: browserStateMessage(session.mode, session.pauseReason) + ". " + (session.mode === "user"
        ? "The browser is currently in explicit user-control mode."
        : session.pauseReason === "handoff" ? "Ask the user to take control for login, then send a new message to continue."
        : "This state does NOT mean the user took control; do not claim they opened or operated the browser.")
        + " A new user message in this conversation automatically returns control to the agent, including from paused or stopped. The user can also click Continue browsing or Return control. If this state changed during the current turn, do not retry old actions; wait for a new message or an explicit return of control. Closing the viewer alone does not return control." };
    const activeTab = this.workspace(session.id), activeUrl = activeTab.tabs.find(tab => tab.id === activeTab.activeTab) ?? activeTab.tabs[0];
    const requestedUrl = input.url ?? (activeUrl?.recoveryUrl || activeUrl?.url);
    const blocked = session.restrictions?.find(item => item.kind !== "verification" && (item.retryAt ?? item.detectedAt + 10 * 60000) > Date.now()
      && requestedUrl && urlOrigin(requestedUrl) === item.origin);
    const readLive = ["observe", "screenshot", "wait"].includes(input.action) && Boolean(this.live.get(session.id) && !this.live.get(session.id)!.disposing);
    if (blocked && !readLive && !["status", "handoff", "close_tab"].includes(input.action)) return { status: "paused", browser: session.id, pauseReason: "restricted", retryAt: blocked.retryAt,
      message: "The website restricted access. Do not retry, refresh, change network or reopen this site. Wait for the stated recovery time or let the user inspect it manually. This evidence does not establish whether the restriction applies to an account or IP." };
    if (input.network) session = await this.setNetwork(scope, session.id, input.network, session.revision);
    if (input.action === "set_network" || session.mode !== "agent") return this.view(scope, session.id);
    const destination = ["open", "navigate"].includes(input.action) ? input.url : undefined;
    if (destination) await operation.wait(() => browserUrl(destination, this.options.testLocal));
    const live = await operation.wait(() => this.launch(session, undefined, operation, undefined, destination)), epoch = live.epoch;
    selected({ session, live });
    if (await this.checkSafety(session.id, live, "before_action")) return { status: this.row(session.id)?.mode, pauseReason: this.row(session.id)?.pauseReason, browser: session.id,
      message: "The page requires manual verification or access is restricted. Do not retry, refresh or change network; let the user inspect the browser." };
    const wait = <T>(work: () => Promise<T>, timeout?: number) => operation.wait(() => {
      this.assert(scope);
      if (live.disposing || live.epoch !== epoch || this.row(session.id)?.mode !== "agent") throw new Error("浏览器控制权已变化，动作未执行");
      return work();
    }, timeout);
    return operation.wait(() => this.serial(live, async () => {
      this.assert(scope); if (live.epoch !== epoch || this.row(session.id)?.mode !== "agent") throw new Error("浏览器控制权已变化，动作未执行");
      if (live.pending) return { status: "pending_confirmation", message: "A submission is awaiting the user's browser confirmation. Do not repeat or bypass it." };
      if (["click", "press", "fill", "select", "upload"].includes(input.action)) {
        const policy = await wait(() => this.actionPolicy(live, input), this.readTimeout);
        if (policy.verification) {
          live.epoch++; live.observation = undefined; live.editing?.reset();
          this.update(session, { mode: "paused", pauseReason: "verification" });
          return { status: "paused", browser: session.id, pauseReason: "verification", message: "A website security challenge requires the user's manual verification in Browser. Do not solve, retry or refresh it. After verification, the user can return control or send a new message; observe the current page and continue without repeating earlier actions." };
        }
        const activation = input.action === "click" || input.action === "press" && /(?:^|\+)(?:Enter|Space|Spacebar| )$/.test(input.key ?? "");
        if (approval !== SUBMISSION_APPROVED && activation && policy.confirm) {
          const hash = await wait(() => this.formHash(live, operation), this.readTimeout);
          this.assert(scope);
          if (live.epoch !== epoch || this.row(session.id)?.mode !== "agent") throw new Error("浏览器控制权已变化，动作未执行");
          live.pending = { id: randomUUID(), label: policy.label, input, epoch: live.epoch, hash, at: Date.now() };
          this.update(session, {});
          return { status: "pending_confirmation", message: "This payment or external communication is waiting for the authenticated user's Confirm submission button. It has NOT run. Do not repeat or bypass it." };
        }
        if (activation && (policy.submits || policy.confirm)) live.tabs.get(live.active)!.restore = false;
      }
      let actionCompleted = false;
      const commandStarted = Date.now();
      const id = randomUUID(); this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(id, session.id, session.revision, input.action, "running", Date.now());
      if (["open", "navigate", "new_tab", "click", "press", "select"].includes(input.action)) live.diagnostics.intent(this.page(live), "agent", input.action, id);
      const abort = () => { this.record(session.id, input.action, "cancel_requested", false, { commandId: id, durationMs: Date.now() - commandStarted }); };
      scope.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (input.action === "open" || input.action === "navigate" || input.action === "new_tab") {
          if (input.action !== "open" && !input.url) throw new Error("请提供完整网址");
          const url = input.url ? await wait(() => browserUrl(input.url!, this.options.testLocal)) : undefined;
          if (input.action === "new_tab") await wait(() => this.newPage(live));
          if (url && (input.action !== "open" || this.page(live).url() !== url)) {
            const tab = live.tabs.get(live.active)!; tab.restore = true; tab.recoveryUrl = url; this.saveWorkspace(session.id, live);
            await wait(() => this.page(live).goto(url, { waitUntil: "domcontentloaded" }));
          }
        } else if (input.action === "switch_tab" || input.action === "close_tab") {
          if (!input.tab || !live.pages.has(input.tab)) throw new Error("标签页已关闭");
          if (input.action === "switch_tab") live.active = input.tab; else { await wait(() => live.pages.get(input.tab!)!.close()); if (!live.pages.size) await wait(() => this.newPage(live)); }
        } else if (["click", "fill", "select", "press", "scroll", "upload"].includes(input.action)) {
          const target = this.target(live, input), page = this.page(live);
          if (input.action === "click") {
            if (target) await wait(() => target.click()); else if (input.x !== undefined && input.y !== undefined) await wait(() => page.mouse.click(input.x!, input.y!)); else throw new Error("请指定元素引用或截图坐标");
          } else if (input.action === "fill") { if (!target || input.text === undefined) throw new Error("请指定字段和内容"); await wait(() => target.fill(input.text!)); }
          else if (input.action === "select") { if (!target || input.value === undefined) throw new Error("请指定选项"); await wait(() => target.selectOption(input.value!)); }
          else if (input.action === "press") { if (!input.key) throw new Error("请指定按键"); await wait(() => (target ?? page.keyboard).press(input.key!)); }
          else if (input.action === "scroll") await wait(() => page.mouse.wheel(0, input.delta ?? 600));
          else { if (!target || !input.file) throw new Error("请指定上传字段和文件编号"); const file = await wait(() => this.file(scope, session.id, input.file!, "upload")); await wait(() => target.setInputFiles({ name: file.name, mimeType: "application/octet-stream", buffer: file.data })); }
        } else if (input.action === "dialog") {
          if (!live.dialog) throw new Error("没有待处理的对话框");
          if (input.accept) await wait(() => live.dialog!.accept(input.text)); else await wait(() => live.dialog!.dismiss()); live.dialog = undefined;
        } else if (input.action === "wait") await wait(() => new Promise(resolve => setTimeout(resolve, (input.seconds ?? 1) * 1000)));
        scope.signal?.throwIfAborted();
        if (live.epoch !== epoch || this.row(session.id)?.mode !== "agent") throw new Error("控制权已变化，请重新核对页面，不能重放刚才的动作");
        actionCompleted = true;
        this.db.prepare("UPDATE commands SET state='completed' WHERE id=?").run(id);
        this.record(session.id, input.action, "completed", true, { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted: true });
        const observe = () => operation.wait(() => this.observe(live, (state, details) => this.record(session.id, input.action, state, false, { ...details, commandId: id, durationMs: Date.now() - commandStarted }), operation), this.readTimeout);
        let observation: Awaited<ReturnType<BrowserService["observe"]>>;
        try { observation = await observe(); }
        catch (error) {
          operation.signal.throwIfAborted();
          if (["observe", "screenshot", "wait"].includes(input.action)) throw error;
          // A navigation can replace the document after a successful click. Reading
          // again is safe; repeating the click or marking it failed is not.
          try { observation = await observe(); }
          catch {
            operation.signal.throwIfAborted();
            this.record(session.id, input.action, "observation_pending", false, { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted });
            live.observation = undefined;
            return { browser: session.id, status: "observation_pending", actionCompleted: true,
              message: "The browser action completed, but its resulting page could not yet be observed. Use observe or wait to verify the result; do not repeat the action or claim the website accepted it." };
          }
        }
        this.record(session.id, input.action, "observed", false, { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted });
        const document = live.documents.get(this.page(live));
        const restriction = document?.status === 429 && urlOrigin(observation.url)
          ? { origin: urlOrigin(observation.url)!, kind: "rate_limit" as const, detectedAt: Date.now(), retryAt: document.retryAt }
          : browserRestriction(observation.url, observation.title ?? "", observation.text);
        if (restriction) {
          if (restriction.kind !== "verification") live.gateway.restrict(restriction.origin, restriction.retryAt ?? restriction.detectedAt + 10 * 60000);
          live.epoch++; live.pending = undefined; live.observation = undefined; live.editing?.reset();
          const reason = restriction.kind === "verification" ? "verification" : "restricted";
          const current = this.row(session.id)!;
          this.update(current, { mode: "paused", pauseReason: reason, restrictions: [...(current.restrictions ?? []).filter(item => item.origin !== restriction.origin), restriction].slice(-16) });
          this.record(session.id, "restriction", restriction.kind, false);
          if (restriction.kind !== "verification") {
            // The document may also poll other API origins. Closing the whole
            // context stops those scripts and in-flight connections as well.
            this.saveWorkspace(session.id, live);
            void live.gateway.close().catch(() => {});
            await operation.wait(() => this.checkpoint(live), this.cleanupTimeout);
            live.disposing = true; clearInterval(live.cookieTimer);
            await operation.wait(() => this.closeContext(session.id, Promise.resolve(live.context), live), this.cleanupTimeout);
          }
          return { browser: session.id, status: "paused", pauseReason: reason, retryAt: restriction.retryAt, ...observation,
            message: reason === "verification" ? "A website security challenge requires manual verification. Do not solve, retry or refresh it. Wait for the user, then observe the current page."
              : "The website restricted access. Stop requests to this site; do not retry or change network. The account/IP scope and cause are unconfirmed." };
        }
        if (session.restrictions?.some(item => item.kind === "verification" && item.origin === new URL(observation.url).origin))
          this.update(this.row(session.id)!, { restrictions: this.row(session.id)!.restrictions?.filter(item => item.kind !== "verification" || item.origin !== new URL(observation.url).origin) });
        if (input.action !== "screenshot" && !input.visual) return { browser: session.id, network: session.network ?? "direct", ...observation };
        return { kind: "visual_observation", id: observation.observation, metadata: { browser: session.id, network: session.network ?? "direct", ...observation },
          images: [{ data: await wait(() => this.screenshot(scope, session.id), this.readTimeout), mimeType: "image/jpeg", observationId: observation.observation }] };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError" && !operation.signal.aborted) operation.cancel(new BrowserTimeoutError());
        if (operation.signal.aborted) {
          if (!actionCompleted) this.db.prepare("UPDATE commands SET state='uncertain' WHERE id=?").run(id);
          this.record(session.id, input.action, operation.signal.reason instanceof BrowserTimeoutError ? "timeout" : "cancelled", false,
            { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted, failureKind: browserFailureKind(error) });
          throw operation.signal.reason;
        }
        if (!actionCompleted) this.db.prepare("UPDATE commands SET state='uncertain' WHERE id=?").run(id);
        this.record(session.id, input.action, actionCompleted ? "observation_failed" : "uncertain", true,
          { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted, failureKind: browserFailureKind(error) });
        const halted = this.row(session.id);
        if (halted?.mode === "paused" && ["verification", "restricted", "navigation_loop"].includes(halted.pauseReason ?? ""))
          return { browser: session.id, status: "paused", pauseReason: halted.pauseReason, actionCompleted,
            message: browserStateMessage(halted.mode, halted.pauseReason) + ". Do not retry or replay the action. The user must inspect the browser before continuing." };
        if (live.pages.get(live.active)?.url() === "about:blank" && live.tabs.get(live.active)?.recoveryUrl) {
          const current = this.row(session.id)!;
          if (current.error !== "网页已变空，请恢复网页") this.update(current, { error: "网页已变空，请恢复网页" });
          throw new Error("网页已变空，请在浏览器中恢复网页后重试；不要重复提交");
        }
        throw new Error("浏览器操作未完成；请重新观察页面后决定下一步，不要自动重复提交");
      } finally {
        scope.signal?.removeEventListener("abort", abort);
        if (!operation.signal.aborted && !live.disposing) {
          await live.traffic.flush().catch(() => {});
          this.record(session.id, input.action, "checkpoint_started", false, { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted });
          try { await operation.wait(() => this.checkpoint(live), this.cleanupTimeout, BROWSER_OPERATION_TIMEOUT); }
          catch (error) {
            this.record(session.id, input.action, "checkpoint_failed", false,
              { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted, failureKind: browserFailureKind(error) });
            throw error;
          }
        } else this.record(session.id, input.action, "checkpoint_skipped", false,
          { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted, failureKind: browserFailureKind(operation.signal.reason) });
        if (!operation.signal.aborted && !live.disposing) this.record(session.id, input.action, "checkpoint_completed", false, { commandId: id, durationMs: Date.now() - commandStarted, actionCompleted });
      }
    }, true));
  }
  private notifyView(id: string): void { if (!this.closing) this.emit("view", id); }
  private record(id: string, action: string, state: string, notify = true, details?: BrowserEventDetails) {
    if (this.databaseClosed || this.closing && action !== "traffic") return;
    const inserted = this.db.prepare("INSERT INTO events(session_id,action,state,created_at,details_json) VALUES(?,?,?,?,?)").run(id, action, state, Date.now(), details ? JSON.stringify(details) : null);
    if (Number(inserted.lastInsertRowid) % 100 === 0) this.db.prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq)-10000 FROM events) OR created_at < ?")
      .run(Date.now() - 7 * 86400000);
    if (notify) this.notifyView(id);
  }
  async screenshot(scope: BrowserScope, id: string): Promise<Buffer> {
    this.session(scope, id); const live = this.live.get(id); if (!live) throw new Error("请先打开浏览器");
    if (!live.screenshot) live.screenshot = this.page(live).screenshot({ type: "jpeg", quality: 75, caret: "initial", timeout: 5000 }).finally(() => { live.screenshot = undefined; });
    return live.screenshot;
  }
  private async setNetwork(scope: BrowserScope, id: string, network: BrowserNetwork, revision: number): Promise<BrowserSession> {
    const session = this.session(scope, id), live = this.live.get(id);
    if (session.revision !== revision) throw new Error("浏览器状态已更新，请重试");
    browserConnection(network, this.options.proxyUrl); // Validate before changing saved state or closing anything.
    if (this.networkChanges.has(id) || this.starting.has(id) || live?.disposing || this.closingContexts.has(id))
      throw new Error("浏览器正在连接，请稍后重试");
    if ((session.network ?? "direct") === network) return session;
    if (live?.pending) throw new Error("请先确认或取消待提交操作");
    if (live?.dialog) throw new Error("请先处理页面弹窗");
    if (live?.downloads) throw new Error("请等待文件下载完成");
    const controller = live?.controller, viewport = live?.desiredViewport;
    this.touch(id);
    this.networkChanges.add(id);
    if (live) { live.epoch++; live.observation = undefined; live.editing?.reset(); live.controller = undefined; clearInterval(live.cookieTimer); }
    const changed = this.update(session, { network, error: undefined });
    const operation = this.operation(this.options.operationTimeoutMs ?? 30000, scope.signal, reason => {
      const current = this.live.get(id); if (current) this.interrupt(id, current, reason instanceof BrowserTimeoutError);
    });
    try {
      if (live) {
        // Fence immediately, then drain old commands and retain cookies before replacing the process.
        const closing = this.serial(live, async () => {
          await operation.wait(() => this.releasePointer(live));
          await operation.wait(() => this.checkpoint(live), this.cleanupTimeout);
          live.disposing = true;
          await operation.wait(() => this.closeContext(id, Promise.resolve(live.context), live), this.cleanupTimeout);
        }, true);
        void closing.catch(() => {});
        await operation.wait(() => this.stopLoading(live), this.cleanupTimeout);
        await operation.wait(() => closing);
      }
      this.networkChanges.delete(id);
      this.assert(scope);
      if (this.row(id)?.revision !== changed.revision) return this.row(id)!;
      if (live) {
        const next = await this.launch(changed, viewport, operation, controller);
        const current = this.row(id)!;
        if (current.revision !== changed.revision) {
          if (current.mode === "paused" || current.mode === "stopped") {
            next.disposing = true;
            await operation.wait(() => this.closeContext(id, Promise.resolve(next.context), next), this.cleanupTimeout);
          }
          return this.row(id)!;
        }
      }
      this.record(id, "set_network", "completed");
      return this.row(id)!;
    } catch (error) {
      // Never keep an old-route process usable under a newly saved route after a failed switch.
      if (live && !live.disposing) this.interrupt(id, live, error instanceof BrowserTimeoutError);
      throw error;
    } finally { this.networkChanges.delete(id); this.finishOperation(operation); }
  }
  async mode(scope: BrowserScope, id: string, action: "takeover" | "resume" | "pause" | "stop", credential?: string, revision?: number, pauseReason: BrowserPauseReason = "user", viewport?: Viewport): Promise<BrowserSession> {
    const session = this.session(scope, id); if (revision !== undefined && session.revision !== revision) throw new Error("浏览器状态已更新，请重试");
    if (this.networkChanges.has(id)) {
      if (action !== "stop" && action !== "pause") throw new Error("浏览器网络正在切换，请稍后重试");
      return this.update(session, { mode: action === "stop" ? "stopped" : "paused", pauseReason: action === "pause" ? pauseReason : undefined, resumeOnUse: undefined });
    }
    const live = this.live.get(id);
    if (action === "resume" && live && !live.disposing && await this.checkSafety(id, live, "resume", true)) return this.row(id)!;
    if (action === "takeover" && live) for (const item of session.restrictions ?? []) live.gateway.allowManual(item.origin);
    if (action === "resume" && live) for (const item of session.restrictions ?? []) if (item.kind !== "verification") live.gateway.restrict(item.origin, item.retryAt ?? item.detectedAt + 10 * 60000);
    if (action === "resume" && live && !live.disposing && session.restrictions?.some(item => item.kind !== "verification" && (item.retryAt ?? item.detectedAt + 10 * 60000) > Date.now())) {
      // Manual inspection can re-enable scripts on a restricted site. Returning
      // control must also stop their cross-origin background work.
      live.epoch++; live.controller = undefined; live.observation = undefined; live.pending = undefined;
      this.saveWorkspace(id, live); void live.gateway.close().catch(() => {});
      await boundedBrowserWork(() => this.checkpoint(live), this.cleanupTimeout);
      live.disposing = true; clearInterval(live.cookieTimer);
    }
    if (live?.disposing) {
      const closing = this.closingContexts.get(id) ?? this.closeContext(id, Promise.resolve(live.context), live);
      await boundedBrowserWork(() => closing, this.cleanupTimeout);
      return this.mode(scope, id, action, credential, revision, pauseReason, viewport);
    }
    this.touch(id);
    // Fence synchronously, before waiting for any in-flight command.
    if (live) { live.epoch++; live.observation = undefined; live.pending = undefined; live.editing?.reset(); live.controller = action === "takeover" ? credential : undefined; }
    const changed = this.update(session, { mode: action === "takeover" ? "user" : action === "resume" ? "agent" : action === "stop" ? "stopped" : "paused", pauseReason: action === "pause" ? pauseReason : undefined, resumeOnUse: undefined, error: undefined });
    if (live) {
      const epoch = live.epoch;
      // Queue the transition before yielding, so later input cannot overtake
      // the viewport change after seeing the new control revision.
      const transition = this.serial(live, async () => {
        if (live.epoch !== epoch || this.row(id)?.revision !== changed.revision) throw new Error("浏览器控制权已变化");
        await this.releasePointer(live);
        if (action === "takeover") await this.resize(live, viewport ?? { width: WIDTH, height: HEIGHT });
        if (action === "stop") { clearInterval(live.cookieTimer); await this.checkpoint(live); live.disposing = true; await this.closeContext(id, Promise.resolve(live.context), live); }
      }, true);
      // Explicit pause/stop may cancel loading; a handoff must preserve the site's
      // in-flight login redirects, challenge scripts and background requests.
      if (action === "stop" || action === "pause" && pauseReason !== "handoff") await this.stopLoading(live);
      await transition;
    }
    if (action === "takeover" || action === "resume") {
      const next = await this.launch(changed, action === "takeover" ? viewport : undefined);
      if (this.row(id)?.revision !== changed.revision || this.row(id)?.mode !== changed.mode) throw new Error("浏览器控制权已变化");
      const controller = action === "takeover" ? credential : undefined;
      // A launch already in progress may have been started with desktop bounds.
      // Establish the new fence before queuing its final viewport reconciliation.
      if (next !== live) { next.epoch++; next.observation = undefined; next.pending = undefined; next.editing?.reset(); next.controller = controller; }
      const epoch = next.epoch;
      await this.serial(next, async () => {
        const valid = () => next.epoch === epoch && this.row(id)?.revision === changed.revision && this.row(id)?.mode === changed.mode && next.controller === controller;
        if (!valid()) throw new Error("浏览器控制权已变化");
        if (action === "takeover") {
          const desired = viewport ?? { width: WIDTH, height: HEIGHT };
          if (next.desiredViewport.width !== desired.width || next.desiredViewport.height !== desired.height
            || [...next.pages.values()].some(page => page.viewportSize()?.width !== desired.width || page.viewportSize()?.height !== desired.height)) {
            await this.releasePointer(next); await this.resize(next, desired);
          }
        }
        if (!valid()) throw new Error("浏览器控制权已变化");
      }, true);
      await this.checkSafety(id, next, action, action === "resume");
    }
    return this.row(id)!;
  }
  async control(scope: BrowserScope, sessionId: string, input: BrowserControl, credential: string): Promise<BrowserView> {
    const session = this.session(scope, sessionId);
    const duplicate = this.db.prepare("SELECT session_id,state FROM commands WHERE id=?").get(input.id) as { session_id: string; state: string } | undefined;
    if (duplicate) { if (duplicate.session_id !== sessionId || duplicate.state !== "completed") throw new Error("操作结果不确定，请核对页面后重试"); return this.view(scope, sessionId); }
    if (session.revision !== input.revision) throw new Error("浏览器状态已更新，请重试");
    if ((input.viewportWidth === undefined) !== (input.viewportHeight === undefined) || input.action === "viewport" && input.viewportWidth === undefined) throw new Error("请指定完整页面尺寸");
    const viewport = input.viewportWidth !== undefined && input.viewportHeight !== undefined ? { width: input.viewportWidth, height: input.viewportHeight } : undefined;
    if (input.action === "confirm_submission" || input.action === "cancel_submission") {
      const live = this.live.get(sessionId), pending = live?.pending;
      if (!live || !pending || pending.id !== input.pendingId || pending.epoch !== live.epoch || session.mode !== "agent" || Date.now() - pending.at > 300000) throw new Error("提交确认已失效，请重新核对页面");
      if (input.action === "cancel_submission") { await this.mode(scope, sessionId, "pause", undefined, undefined, "submission_cancelled"); return this.view(scope, sessionId); }
      const check = this.operation(this.readTimeout, scope.signal, () => this.interrupt(sessionId, live, true));
      let hash: string;
      try { hash = await check.wait(() => this.formHash(live, check)); }
      finally { this.finishOperation(check); }
      if (pending.hash !== hash) throw new Error("表单已变化，请重新核对页面");
      if (live.pending !== pending || pending.epoch !== live.epoch || this.row(sessionId)?.mode !== "agent") throw new Error("提交确认已失效，请重新核对页面");
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(input.id, sessionId, input.revision, input.action, "running", Date.now());
      live.pending = undefined;
      // Never revisit a submitted form automatically when reopening the browser.
      live.tabs.get(live.active)!.restore = false;
      try {
        const result = await this.execute(scope, pending.input, SUBMISSION_APPROVED);
        if (result && typeof result === "object" && "status" in result && result.status !== "observation_pending") throw new Error("提交已停止");
        this.db.prepare("UPDATE commands SET state='completed' WHERE id=?").run(input.id); this.update(session, {});
      } catch { this.db.prepare("UPDATE commands SET state='uncertain' WHERE id=?").run(input.id); this.update(session, {}); throw new Error("提交结果不确定，请先核对页面，不要重复提交"); }
      return this.view(scope, sessionId);
    }
    if (["takeover", "resume", "pause", "stop"].includes(input.action)) {
      await this.mode(scope, sessionId, input.action as "takeover" | "resume" | "pause" | "stop", credential, input.revision, "user", viewport);
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(input.id, sessionId, input.revision, input.action, "completed", Date.now());
      return this.view(scope, sessionId);
    }
    const live = this.live.get(sessionId);
    if (!live || session.mode !== "user" || live.controller !== credential) throw new Error("请先接管浏览器");
    if (input.action === "set_network") {
      if (!input.network) throw new Error("请指定直连或代理");
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(input.id, sessionId, input.revision, input.action, "running", Date.now());
      try {
        await this.setNetwork(scope, sessionId, input.network, input.revision);
        this.db.prepare("UPDATE commands SET state='completed' WHERE id=?").run(input.id);
      } catch (error) { this.db.prepare("UPDATE commands SET state='uncertain' WHERE id=?").run(input.id); throw error; }
      return this.view(scope, sessionId);
    }
    const epoch = live.epoch;
    return this.serial(live, async () => {
      if (live.epoch !== epoch || this.row(sessionId)?.mode !== "user" || live.controller !== credential) throw new Error("浏览器控制权已变化");
      this.db.prepare("INSERT INTO commands VALUES(?,?,?,?,?,?)").run(input.id, sessionId, input.revision, input.action, "running", Date.now());
      try {
        let page = this.page(live); live.observation = undefined;
        if (["click", "key", "navigate", "new_tab", "restore_tab"].includes(input.action) || input.action === "pointer" && input.phase === "up")
          live.diagnostics.intent(page, "user", input.action, input.id);
        await live.viewportTasks.get(page);
        if (live.epoch !== epoch || this.row(sessionId)?.mode !== "user" || live.controller !== credential) throw new Error("浏览器控制权已变化");
        if (live.dialog && (input.action === "focus_editor" || input.action === "edit" || input.editorId)) throw new Error("请先处理页面弹窗");
        if (input.action !== "pointer") await this.releasePointer(live);
        if (input.action === "viewport") {
          const resizedEpoch = ++live.epoch; live.editing?.reset(); live.observation = undefined; live.pending = undefined;
          this.update(this.row(sessionId)!, {});
          await this.resize(live, viewport!);
          if (live.epoch !== resizedEpoch || this.row(sessionId)?.mode !== "user" || live.controller !== credential) throw new Error("浏览器控制权已变化");
        } else if (input.action === "focus_editor") {
          if (!input.editorId || (input.x === undefined) !== (input.y === undefined)) throw new Error("请指定输入框");
          if (!live.editing) throw new Error("输入框已变化，请重新同步后输入");
          await live.editing.focus(page, epoch, input.editorId, input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined,
            () => live.epoch === epoch && this.row(sessionId)?.mode === "user" && live.controller === credential && !live.dialog);
        } else if (input.action === "edit") {
          if (!live.editing || !input.editorId || input.editorVersion === undefined || input.editStart === undefined || input.editEnd === undefined || input.expectedLength === undefined || input.text === undefined) throw new Error("请重新同步输入框");
          await live.editing.edit(page, epoch, { editorId: input.editorId, editorVersion: input.editorVersion, editStart: input.editStart,
            editEnd: input.editEnd, expectedLength: input.expectedLength, text: input.text }, () => live.epoch === epoch && this.row(sessionId)?.mode === "user" && live.controller === credential && !live.dialog);
        } else if (input.action === "navigate" || input.action === "new_tab" || input.action === "restore_tab") {
          live.editing?.reset();
          const recovery = input.action === "restore_tab" ? live.tabs.get(live.active)?.recoveryUrl : undefined;
          if (input.action === "restore_tab" && !recovery) throw new Error("没有可恢复的网页");
          const url = recovery ? await browserUrl(recovery, this.options.testLocal) : input.url ? await browserUrl(input.url, this.options.testLocal) : "about:blank";
          if (input.action === "new_tab") page = await this.newPage(live);
          const tab = live.tabs.get(live.active)!; tab.restore = true; if (url !== "about:blank") tab.recoveryUrl = url;
          await page.goto(url, { waitUntil: "domcontentloaded" });
          if (page.url() !== "about:blank") this.update(this.row(sessionId)!, { error: undefined });
        } else if (input.action === "switch_tab" || input.action === "close_tab") {
          live.editing?.reset();
          if (!input.tab || !live.pages.has(input.tab)) throw new Error("标签页已关闭");
          if (input.action === "switch_tab") live.active = input.tab; else { await live.pages.get(input.tab)!.close(); if (!live.pages.size) await this.newPage(live); }
        } else if (input.action === "pointer") {
          if (!input.pointerId || !input.phase) throw new Error("请指定拖动操作");
          if (input.phase === "cancel") {
            if (live.pointer?.id === input.pointerId) await this.releasePointer(live);
          } else {
            const bounds = page.viewportSize() ?? live.desiredViewport;
            if (input.x === undefined || input.y === undefined || input.x >= bounds.width || input.y >= bounds.height) throw new Error("请指定页面内的位置");
            if (input.phase === "down") {
              await this.releasePointer(live);
              if (await this.submissionLabel(live, { action: "click", x: input.x, y: input.y })) live.tabs.get(live.active)!.restore = false;
              live.pointer = { id: input.pointerId, page };
              this.pointerTimeout(live);
              await page.mouse.move(input.x, input.y); await page.mouse.down();
            } else {
              if (live.pointer?.id !== input.pointerId || live.pointer.page !== page) throw new Error("拖动已结束，请重新操作");
              this.pointerTimeout(live);
              await page.mouse.move(input.x, input.y);
              if (input.phase === "up") {
                await page.mouse.up();
                clearTimeout(live.pointer.timer); live.pointer = undefined;
              }
            }
          }
        } else if (input.action === "click") {
          if (input.x === undefined || input.y === undefined) throw new Error("请指定位置");
          if (await this.submissionLabel(live, { action: "click", x: input.x, y: input.y })) live.tabs.get(live.active)!.restore = false;
          await page.mouse.click(input.x, input.y);
        }
        else if (input.action === "text") { if (input.text === undefined) throw new Error("请指定文字"); await page.keyboard.insertText(input.text); }
        else if (input.action === "key") {
          if (!input.key) throw new Error("请指定按键");
          if (input.editorId) {
            if (!live.editing) throw new Error("输入框已变化，请重新同步后输入");
            await live.editing.verifyFocus(page, epoch, input.editorId);
          }
          if (await this.submissionLabel(live, { action: "press", key: input.key })) live.tabs.get(live.active)!.restore = false;
          await page.keyboard.press(input.key);
        }
        else if (input.action === "scroll") await page.mouse.wheel(0, input.delta ?? 500);
        else if (input.action === "dialog") { if (!live.dialog) throw new Error("没有待处理的对话框"); if (input.accept) await live.dialog.accept(input.text); else await live.dialog.dismiss(); live.dialog = undefined; }
        this.db.prepare("UPDATE commands SET state='completed' WHERE id=?").run(input.id); this.record(sessionId, input.action, "completed");
        if (input.action !== "pointer" || input.phase === "up" || input.phase === "cancel") await this.checkpoint(live);
        if (input.action !== "pointer" || input.phase === "up") await this.checkSafety(sessionId, live, "manual_action");
        return this.view(scope, sessionId);
      } catch {
        if (input.action !== "pointer" || live.pointer?.id === input.pointerId) await this.releasePointer(live);
        this.db.prepare("UPDATE commands SET state='uncertain' WHERE id=?").run(input.id); throw new Error("操作未完成，请先核对页面");
      }
    }, true);
  }
  async upload(scope: BrowserScope, id: string, name: string, bytes: Buffer, credential: string): Promise<{ id: string; name: string }> {
    const session = this.session(scope, id), live = this.live.get(id);
    if (session.mode !== "user" || !live || live.controller !== credential) throw new Error("请先接管浏览器");
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) throw new Error("文件大小应在 25 MB 以内");
    const epoch = live.epoch;
    return this.serial(live, async () => {
    if (live.epoch !== epoch || this.row(id)?.mode !== "user" || live.controller !== credential) throw new Error("浏览器控制权已变化");
    const fileId = randomUUID(); name = safeName(name); const directory = join(this.options.directory, id, "files"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, fileId), bytes, { mode: 0o600 });
    this.db.prepare("INSERT INTO files VALUES(?,?,?,?,?)").run(fileId, id, name, "upload", bytes.length);
    if (live.chooser) { const chooser = live.chooser; live.chooser = undefined; await chooser.setFiles({ name, mimeType: "application/octet-stream", buffer: bytes }); }
    await this.checkpoint(live); this.notifyView(id); return { id: fileId, name };
    }, true);
  }
  async file(scope: BrowserScope, id: string, fileId: string, direction?: string) {
    this.session(scope, id);
    const row = this.db.prepare("SELECT id,name,direction FROM files WHERE id=? AND session_id=?").get(fileId, id) as { name: string; direction: string } | undefined;
    if (!row || direction && row.direction !== direction) throw new Error("文件不可用");
    return { name: row.name, data: await readFile(join(this.options.directory, id, "files", fileId)) };
  }
  pendingSubmission(id: string): { id: string; label: string } | undefined {
    const pending = this.live.get(id)?.pending; return pending ? { id: pending.id, label: pending.label } : undefined;
  }
  canControl(scope: BrowserScope, id: string, token: string): boolean {
    const session = this.session(scope, id); return session.mode === "user" && this.live.get(id)?.controller === this.controlIdentity(token);
  }
  async editors(scope: BrowserScope, id: string, token: string): Promise<BrowserEditor[]> {
    const session = this.session(scope, id), live = this.live.get(id), identity = this.controlIdentity(token);
    if (!live || session.mode !== "user" || live.controller !== identity) return [];
    const epoch = live.epoch, page = this.page(live);
    const valid = () => live.epoch === epoch && this.row(id)?.mode === "user" && live.controller === identity && live.pages.get(live.active) === page;
    return this.serial(live, async () => {
      if (!valid() || live.dialog) return [];
      live.editing ??= new BrowserEditing();
      const editing = live.editing;
      let timer: NodeJS.Timeout | undefined;
      try {
        // A site can open a modal while metadata is being read. Do not let a
        // blocked readonly evaluation hold the input queue needed to dismiss it.
        return await Promise.race([editing.collect(page, epoch, () => valid() && !live.dialog), new Promise<BrowserEditor[]>(resolve => {
          timer = setTimeout(() => { editing.reset(); resolve([]); }, 1500);
        })]);
      } finally { clearTimeout(timer); }
    });
  }
  async passwordField(scope: BrowserScope, id: string): Promise<boolean> {
    this.session(scope, id); const live = this.live.get(id); if (!live || live.disposing || live.dialog) return false;
    const operation = this.operation(Math.min(1500, this.readTimeout), scope.signal);
    try {
      for (const frame of this.page(live).frames()) {
        if (frame !== this.page(live).mainFrame()) {
          const host = await operation.wait(() => frame.frameElement());
          try { if (!await operation.wait(() => host.isVisible())) continue; }
          finally { void host.dispose().catch(() => {}); }
        }
        if (await operation.wait(() => frame.locator('input[type="password"]:focus').count())) return true;
      }
      return false;
    } catch { return true; } // Unknown focus must not enable remote typing into a password field.
    finally { this.finishOperation(operation); }
  }
  controlIdentity(token: string): string { return createHash("sha256").update(token).digest("hex"); }
  close(): Promise<void> { return this.shutdown ??= this.closeWithin(); }
  private async closeWithin() {
    this.closing = true; clearInterval(this.idleTimer);
    for (const operation of this.operations) operation.cancel(new DOMException("Service stopping", "AbortError"));
    const settle = (work: () => Promise<unknown>) => boundedBrowserWork(work, this.cleanupTimeout).catch(() => {});
    await settle(() => this.idleSweep ?? Promise.resolve());
    await settle(() => Promise.allSettled([...this.starting.values()]));
    const lives = [...this.live.values()];
    for (const live of lives) { live.epoch++; clearInterval(live.cookieTimer); }
    await Promise.all(lives.map(live => settle(() => live.tail)));
    await Promise.all(lives.map(live => settle(() => this.releasePointer(live))));
    await Promise.all(lives.filter(live => !live.disposing).map(live => settle(() => this.checkpoint(live))));
    for (const live of lives) live.disposing = true;
    for (const live of lives) clearInterval(live.safetyTimer);
    await Promise.all(lives.map(live => settle(async () => { await live.traffic.close(); await live.diagnostics.close(); })));
    await Promise.all(lives.map(live => settle(() => live.context.browser()?.close() ?? live.context.close())));
    await Promise.all(lives.map(live => settle(() => live.gateway.close())));
    await settle(() => Promise.allSettled([...this.closingContexts.values()]));
    await Promise.all([...this.contextsToClose].map(([id, context]) => settle(() => this.closeContext(id, Promise.resolve(context)))));
    this.activeRuns.clear(); this.databaseClosed = true; this.db.close();
  }
}
function safeName(name: string): string { return basename(name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f"<>:|?*]/g, "_").slice(0, 180) || "文件"; }
function urlOrigin(url: string): string | undefined { try { return new URL(url).origin; } catch { return undefined; } }

function browserFailureKind(error: unknown): string {
  if (error instanceof BrowserTimeoutError || error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AbortError") return "cancelled";
  if (error.message.includes("不能访问服务器内网地址")) return "address_blocked";
  if (error.message.includes("仅支持公开网站")) return "url_blocked";
  if (/net::ERR_(NAME_NOT_RESOLVED|DNS)/.test(error.message)) return "dns";
  if (/net::ERR_(CERT|SSL)/.test(error.message)) return "tls";
  if (/net::ERR_(CONNECTION|NETWORK|INTERNET|PROXY|TUNNEL)/.test(error.message)) return "connect";
  if (/closed|crash|disconnect/i.test(error.message)) return "disconnected";
  return "navigation";
}
