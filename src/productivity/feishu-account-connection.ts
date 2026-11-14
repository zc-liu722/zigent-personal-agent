import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { authorizationFailure, type AuthorizationFailure, type AuthorizationStage } from "./authorization-failure.js";
import { FeishuAuthorizationError, registerFeishuApplication, type FeishuAuthorizationOptions, type FeishuAuthorizationPrompt } from "./feishu-authorization-protocol.js";
import { FEISHU_USER_SCOPES, FeishuUserAuthorizationCoordinator, safeFeishuAuthorizationUrl, type FeishuAccount, type FeishuUserIdentity } from "./feishu-user-authorization.js";

export const FEISHU_CONNECTED_USER_SCOPES = [...FEISHU_USER_SCOPES, "docx:document:readonly", "wiki:wiki:readonly"];

type Prompt = FeishuAuthorizationPrompt;
type Credentials = { appId: string; appSecret: string };
type Application = Credentials & Partial<FeishuAccount> & { tenantName?: string };
export type FeishuAccountConnection = Application & { accessToken?: string; readDocumentsAsUser?: boolean };
type ConnectionRecord = { version: 2; agentId: string; userId: string; defaultAppId?: string; pendingAppId?: string; applications: Application[] };
type Attempt = { controller: AbortController; operation: Promise<void> };

function validCredentials(value: unknown): value is Application {
  const app = value as Application | undefined;
  return Boolean(app && typeof app.appId === "string" && app.appId.trim() && typeof app.appSecret === "string" && app.appSecret.trim());
}

function needsApplicationUpdate(failure: AuthorizationFailure): boolean {
  return failure.reason === "permissions" || ["invalid_client", "incorrect_application_credentials", "unauthorized_client"].includes(failure.oauthError ?? "");
}

/** Connections belong to the web owner. A verified tenant keeps one account/application. */
export class FeishuAccountConnectionCoordinator {
  private readonly active = new Map<string, Attempt>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly maintaining = new Set<string>();
  constructor(
    private readonly root = join(dirname(resolve(process.env.AGENTS_CONFIG_PATH ?? "config/agents.json")), "feishu-account-connections"),
    private readonly personal = new FeishuUserAuthorizationCoordinator(undefined, undefined, undefined, undefined, FEISHU_CONNECTED_USER_SCOPES),
    private readonly register = (options: Parameters<typeof registerFeishuApplication>[0]) => registerFeishuApplication(options, FEISHU_CONNECTED_USER_SCOPES),
    private readonly request: typeof fetch = fetch
  ) {}

  private path(owner: FeishuUserIdentity): string {
    const key = createHash("sha256").update(JSON.stringify([owner.agentId, owner.userId])).digest("hex");
    return join(this.root, `${key}.json`);
  }
  private async record(owner: FeishuUserIdentity): Promise<ConnectionRecord> {
    const empty: ConnectionRecord = { version: 2, agentId: owner.agentId, userId: owner.userId, applications: [] };
    let raw: string;
    try { raw = await readFile(this.path(owner), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw new Error("飞书连接记录无法读取，请重新连接。");
    }
    try {
      const record = JSON.parse(raw);
      if (record.agentId !== owner.agentId || record.userId !== owner.userId) throw new Error();
      // Migrate the former single-app record without losing its credentials or grant.
      const applications: Application[] = Array.isArray(record.applications) ? record.applications.filter(validCredentials)
        : validCredentials(record) ? [{ appId: record.appId, appSecret: record.appSecret }] : [];
      return { ...empty, defaultAppId: record.defaultAppId ?? applications[0]?.appId, pendingAppId: record.pendingAppId,
        applications: [...new Map(applications.map(app => [app.appId, app])).values()] };
    } catch { throw new Error("飞书连接记录无法解析，请修复连接记录后重试。"); }
  }
  private async update(owner: FeishuUserIdentity, edit: (record: ConnectionRecord) => void): Promise<void> {
    const path = this.path(owner), previous = this.writes.get(path);
    const operation = (async () => {
      await previous?.catch(() => undefined);
      const record = await this.record(owner);
      edit(record);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
    })();
    this.writes.set(path, operation);
    try { await operation; }
    finally { if (this.writes.get(path) === operation) this.writes.delete(path); }
  }
  async getConnections(owner: FeishuUserIdentity): Promise<FeishuAccountConnection[]> {
    const record = await this.record(owner);
    const ordered = [...record.applications].sort((a, b) => Number(b.appId === record.defaultAppId) - Number(a.appId === record.defaultAppId));
    const connections: FeishuAccountConnection[] = [];
    const failures: unknown[] = [];
    for (const app of ordered) {
      // A broken/expired grant must not hide the other team's working connection.
      const accessToken = await this.personal.getAccessToken({ ...owner, ...app }).catch(error => {
        if (!needsApplicationUpdate(authorizationFailure("token_exchange", error))) failures.push(error);
        return undefined;
      });
      if (accessToken) connections.push({ ...app, accessToken, readDocumentsAsUser: true });
    }
    if (!connections.length && failures.length) throw failures[0];
    return connections;
  }
  async getConnection(owner: FeishuUserIdentity): Promise<FeishuAccountConnection | undefined> {
    const connected = (await this.getConnections(owner))[0];
    if (connected) return connected;
    const record = await this.record(owner);
    const app = record.applications.find(app => app.appId === record.defaultAppId) ?? record.applications[0];
    return app ? { ...app, readDocumentsAsUser: true } : undefined;
  }
  async getAccessToken(owner: FeishuUserIdentity): Promise<string | undefined> { return (await this.getConnection(owner))?.accessToken; }
  async succeeded(owner: FeishuUserIdentity, appId: string): Promise<void> {
    await this.update(owner, record => { if (record.applications.some(app => app.appId === appId)) record.defaultAppId = appId; });
  }
  async invalidate(owner: FeishuUserIdentity, appId?: string): Promise<void> {
    const record = await this.record(owner);
    const app = record.applications.find(app => app.appId === (appId ?? record.defaultAppId));
    if (app) await this.personal.invalidate({ ...owner, ...app });
  }
  cancel(owner: FeishuUserIdentity): void { this.active.get(this.path(owner))?.controller.abort(); }
  start(owner: FeishuUserIdentity, send: (prompt: Prompt) => Promise<void>,
    notify: (outcome: "authorized" | "failed", failure?: AuthorizationFailure) => Promise<void>, options?: FeishuAuthorizationOptions): void {
    const key = this.path(owner), previous = this.active.get(key);
    if (this.maintaining.has(key)) { void notify("failed", { stage: "prepare", reason: "busy" }); return; }
    if (previous && !previous.controller.signal.aborted) return;
    const controller = new AbortController();
    const attempt: Attempt = { controller, operation: Promise.resolve() };
    attempt.operation = (async () => {
      await previous?.operation.catch(() => undefined);
      controller.signal.throwIfAborted();
      await this.connect(owner, send, controller.signal, options);
    })().finally(() => { if (this.active.get(key) === attempt) this.active.delete(key); });
    this.active.set(key, attempt);
    void attempt.operation.then(() => notify("authorized"), error => notify("failed", authorizationFailure("prepare", error)))
      .catch(() => console.warn("Unable to send Feishu connection result notice"));
  }
  private async connect(owner: FeishuUserIdentity, send: (prompt: Prompt) => Promise<void>, signal: AbortSignal,
    { switchAccount, repairAppId }: FeishuAuthorizationOptions = {}): Promise<void> {
    let stage: AuthorizationStage = "prepare";
    const enter = (next: AuthorizationStage) => {
      stage = next;
      console.info("FEISHU_AUTH_DIAGNOSTIC " + JSON.stringify({ agent: owner.agentId, at: new Date().toISOString(), stage, event: "started" }));
    };
    try {
      const record = await this.record(owner);
      // Reuse credentials saved before user consent, including apps created by older versions.
      const repairApp = repairAppId && !switchAccount ? record.applications.find(app => app.appId === repairAppId) : undefined;
      let app = switchAccount ? undefined : repairApp ?? record.applications.find(app => app.appId === record.pendingAppId)
        ?? record.applications.find(app => app.appId === record.defaultAppId) ?? record.applications.at(-1);
      if (!app || repairApp) {
        enter("client_registration");
        app = await this.registerApplication(owner, send, signal, repairApp?.appId);
      }
      enter("verify");
      let account: FeishuAccount | undefined;
      if (!switchAccount && !repairApp) {
        try { account = await this.personal.account({ ...owner, ...app }); }
        catch (error) {
          const failure = authorizationFailure(stage, error);
          if (!needsApplicationUpdate(failure)) throw error;
          enter("client_registration");
          app = await this.registerApplication(owner, send, signal, app.appId);
        }
      }
      if (!account) {
        enter("user_authorization");
        try { account = await this.personal.authorize({ ...owner, ...app }, send, signal, enter); }
        catch (error) {
          // Missing app scopes need an update of the same app, never another creation.
          const failure = authorizationFailure(stage, error);
          if (repairApp || !needsApplicationUpdate(failure)) throw error;
          signal.throwIfAborted();
          enter("client_registration");
          app = await this.registerApplication(owner, send, signal, app.appId);
          enter("user_authorization");
          account = await this.personal.authorize({ ...owner, ...app }, send, signal, enter);
        }
      }
      signal.throwIfAborted();
      enter("save");
      await this.keepAccount(owner, { ...app, ...account }, signal);
      console.info("FEISHU_AUTH_DIAGNOSTIC " + JSON.stringify({ agent: owner.agentId, at: new Date().toISOString(), stage, event: "completed" }));
    } catch (error) {
      const failure = authorizationFailure(stage, error);
      console.info("FEISHU_AUTH_DIAGNOSTIC " + JSON.stringify({ agent: owner.agentId, at: new Date().toISOString(), event: "failed", ...failure }));
      throw new FeishuAuthorizationError(failure);
    }
  }
  private async registerApplication(owner: FeishuUserIdentity, send: (prompt: Prompt) => Promise<void>, signal: AbortSignal, appId?: string): Promise<Application> {
    const controller = new AbortController();
    const registrationSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(10 * 60_000)]);
    let delivery = Promise.resolve();
    let deliveryFailed = false;
    const app = await this.register({
      signal: registrationSignal, appId,
      onQRCodeReady: prompt => {
        if (!safeFeishuAuthorizationUrl(prompt.url)) throw new Error("飞书连接链接无效。");
        delivery = send({ authorizationUrl: prompt.url, expiresAt: Date.now() + prompt.expireIn * 1000,
          stage: "application", actionLabel: appId ? "更新权限" : "连接应用" }).catch(() => { deliveryFailed = true; controller.abort(); });
      }
    });
    await delivery;
    signal.throwIfAborted();
    if (deliveryFailed || !app.client_id?.trim() || !app.client_secret?.trim() || app.user_info?.tenant_brand === "lark") throw new Error("飞书应用连接未完成，请重试。");
    const credentials = { appId: app.client_id, appSecret: app.client_secret };
    // Preserve the selected app immediately, even if the separate user consent later expires.
    await this.update(owner, record => {
      const existing = record.applications.find(entry => entry.appId === credentials.appId);
      if (existing) Object.assign(existing, credentials);
      else record.applications.push(credentials);
      record.pendingAppId = credentials.appId;
    });
    return credentials;
  }
  private async tenant(app: Credentials, signal?: AbortSignal): Promise<{ tenantKey?: string; tenantName?: string }> {
    const timeout = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const response = await this.request("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", redirect: "error", signal: timeout(), headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret })
    });
    const token = await response.json() as { code?: number; tenant_access_token?: string };
    if (!response.ok || token.code !== 0 || !token.tenant_access_token) return {};
    const details = await this.request("https://open.feishu.cn/open-apis/tenant/v2/tenant/query", {
      redirect: "error", signal: timeout(), headers: { authorization: `Bearer ${token.tenant_access_token}` }
    });
    const body = await details.json() as { code?: number; data?: { tenant?: { tenant_key?: string; name?: string } } };
    return details.ok && body.code === 0 ? { tenantKey: body.data?.tenant?.tenant_key, tenantName: body.data?.tenant?.name } : {};
  }
  private async keepAccount(owner: FeishuUserIdentity, app: Application, signal?: AbortSignal): Promise<number> {
    const tenant: { tenantKey?: string; tenantName?: string } = await this.tenant(app, signal).catch(() => ({}));
    signal?.throwIfAborted();
    // Only verified tenant identity may merge connections; never group accounts by display name.
    const verified = { ...app, ...Object.fromEntries(Object.entries(tenant).filter(([, value]) => value)) };
    if (app.tenantKey && tenant.tenantKey && app.tenantKey !== tenant.tenantKey) throw new Error("飞书应用与授权账号不属于同一团队。");
    const removed: Application[] = [];
    await this.update(owner, record => {
      record.applications = record.applications.filter(entry => {
        const duplicate = entry.appId !== app.appId && Boolean(verified.tenantKey && entry.tenantKey === verified.tenantKey);
        if (duplicate) removed.push(entry);
        return !duplicate;
      });
      const existing = record.applications.find(entry => entry.appId === app.appId);
      if (existing) Object.assign(existing, verified);
      else record.applications.push(verified);
      record.defaultAppId = app.appId;
      if (record.pendingAppId === app.appId) delete record.pendingAppId;
    });
    for (const old of removed) await this.personal.invalidate({ ...owner, ...old });
    return removed.length;
  }
  /** Supported maintenance: verify saved grants and consolidate one connection per tenant. */
  async summary(owner: FeishuUserIdentity): Promise<{ accounts: Array<{ team: string; authorized: boolean }>; applications: number }> {
    const record = await this.record(owner), connections = await this.getConnections(owner);
    return { applications: record.applications.length, accounts: record.applications.map(app => ({
      team: app.tenantName ?? "待确认团队", authorized: connections.some(connection => connection.appId === app.appId)
    })) };
  }
  async consolidate(owner: FeishuUserIdentity): Promise<{ removed: number; accounts: Array<{ team: string; authorized: boolean }>; applications: number }> {
    const key = this.path(owner);
    if (this.active.has(key) || this.maintaining.has(key)) throw new Error("飞书连接仍在进行，请完成后再整理。");
    this.maintaining.add(key);
    try { return await this.consolidateAccounts(owner); }
    finally { this.maintaining.delete(key); }
  }
  private async consolidateAccounts(owner: FeishuUserIdentity): Promise<{ removed: number; accounts: Array<{ team: string; authorized: boolean }>; applications: number }> {
    const record = await this.record(owner);
    // Gather identity before deleting anything: a duplicate may still be the preferred usable grant.
    for (const app of record.applications) {
      const account = await this.personal.account({ ...owner, ...app }).catch(() => undefined);
      const tenant = await this.tenant(app).catch(() => undefined);
      if (account?.tenantKey && tenant?.tenantKey && account.tenantKey !== tenant.tenantKey) continue;
      await this.update(owner, current => {
        const entry = current.applications.find(entry => entry.appId === app.appId);
        if (entry) Object.assign(entry, account ?? {}, tenant ?? {});
      });
    }
    const connections = await this.getConnections(owner), authorized = new Set(connections.map(app => app.appId));
    const removed: Application[] = [];
    await this.update(owner, current => {
      const ordered = [...current.applications].sort((a, b) => Number(authorized.has(b.appId)) - Number(authorized.has(a.appId))
        || Number(b.appId === current.defaultAppId) - Number(a.appId === current.defaultAppId));
      const winners = new Set<string>();
      current.applications = ordered.filter(app => {
        // Unknown tenants remain intact until they can be verified, never guessed from names.
        if (!app.tenantKey) return true;
        if (winners.has(app.tenantKey)) { removed.push(app); return false; }
        winners.add(app.tenantKey); return true;
      });
      if (!current.applications.some(app => app.appId === current.defaultAppId)) current.defaultAppId = current.applications[0]?.appId;
    });
    for (const app of removed) await this.personal.invalidate({ ...owner, ...app });
    return { removed: removed.length, ...await this.summary(owner) };
  }
}
