import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEVICE_URL = "https://accounts.feishu.cn/oauth/v1/device_authorization";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
export const FEISHU_USER_SCOPES = ["offline_access", "search:docs:read", "minutes:minutes.search:read", "minutes:minutes.basic:read", "minutes:minutes.artifacts:read"];
export type FeishuUserIdentity = { agentId: string; userId: string; appId: string; appSecret: string };
type TokenRecord = { appId: string; userId: string; accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt: number; scopes: string[] };
type Prompt = { authorizationUrl: string; expiresAt: number };
type Json = Record<string, unknown>;

export function safeFeishuAuthorizationUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && (u.hostname === "accounts.feishu.cn" || u.hostname.endsWith(".feishu.cn")); }
  catch { return false; }
}

/** Device flow and refresh follow the pinned official lark-cli 1.0.83 protocol. */
export class FeishuUserAuthorizationCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
  constructor(
    private readonly root = join(dirname(resolve(process.env.AGENTS_CONFIG_PATH ?? "config/agents.json")), "feishu-user-oauth"),
    private readonly request: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly sleep = (ms: number) => new Promise<void>(r => { const timer = setTimeout(r, ms); timer.unref?.(); }),
    private readonly scopes: readonly string[] = FEISHU_USER_SCOPES
  ) {}

  private path(identity: FeishuUserIdentity): string {
    const key = createHash("sha256").update(JSON.stringify([identity.agentId, identity.appId, identity.userId])).digest("hex");
    return join(this.root, `${key}.json`);
  }
  private async post(url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<Json> {
    const response = await this.request(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(form) });
    const body = await response.json() as Json;
    if (!response.ok && !body.error) throw new Error("飞书个人授权请求未完成，请稍后重试。");
    return body;
  }
  private async save(identity: FeishuUserIdentity, record: TokenRecord): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(identity), temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  async invalidate(identity: FeishuUserIdentity): Promise<void> { await rm(this.path(identity), { force: true }); }
  getAccessToken(identity: FeishuUserIdentity): Promise<string | undefined> {
    const key = this.path(identity);
    if (this.active.has(key)) return Promise.resolve(undefined);
    const existing = this.refreshing.get(key);
    if (existing) return existing;
    const operation = this.loadOrRefresh(identity).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, operation);
    return operation;
  }
  private async loadOrRefresh(identity: FeishuUserIdentity): Promise<string | undefined> {
    let record: TokenRecord;
    try { record = JSON.parse(await readFile(this.path(identity), "utf8")) as TokenRecord; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("飞书个人授权记录无法读取，请重新授权。"); }
    if (record.appId !== identity.appId || record.userId !== identity.userId) throw new Error("飞书个人授权账号不匹配，请重新授权。");
    if (!Array.isArray(record.scopes) || this.scopes.filter(scope => scope !== "offline_access").some(scope => !record.scopes.includes(scope))) return undefined;
    if (record.expiresAt > this.now() + 60_000) return record.accessToken;
    if (!record.refreshToken || record.refreshExpiresAt <= this.now()) return undefined;
    const body = await this.post(TOKEN_URL, { grant_type: "refresh_token", refresh_token: record.refreshToken, client_id: identity.appId, client_secret: identity.appSecret });
    if (body.error === "invalid_grant" || body.error === "invalid_token") { await this.invalidate(identity); return undefined; }
    if (body.error || typeof body.access_token !== "string") throw new Error("飞书个人授权刷新未完成，请稍后重试。");
    record = { ...record, accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : record.refreshToken,
      expiresAt: this.now() + Number(body.expires_in ?? 7200) * 1000,
      refreshExpiresAt: body.refresh_token_expires_in ? this.now() + Number(body.refresh_token_expires_in) * 1000 : record.refreshExpiresAt,
      scopes: typeof body.scope === "string" ? body.scope.split(/\s+/) : record.scopes };
    await this.save(identity, record);
    if (this.scopes.filter(scope => scope !== "offline_access").some(scope => !record.scopes.includes(scope))) return undefined;
    return record.accessToken;
  }
  start(identity: FeishuUserIdentity, sendPrompt: (prompt: Prompt) => Promise<void>, notify: (outcome: "authorized" | "failed") => Promise<void>): void {
    const key = this.path(identity);
    if (this.active.has(key)) return;
    const operation = this.authorize(identity, sendPrompt).finally(() => this.active.delete(key));
    this.active.set(key, operation);
    void operation.then(() => notify("authorized"), () => notify("failed")).catch(() => console.warn("Unable to send Feishu personal authorization result notice"));
  }
  private async authorize(identity: FeishuUserIdentity, sendPrompt: (prompt: Prompt) => Promise<void>): Promise<void> {
    const refresh = this.refreshing.get(this.path(identity));
    if (refresh) await refresh.catch(() => undefined);
    const device = await this.post(DEVICE_URL, { client_id: identity.appId, scope: this.scopes.join(" ") },
      { authorization: `Basic ${Buffer.from(`${identity.appId}:${identity.appSecret}`).toString("base64")}` });
    const url = device.verification_uri_complete ?? device.verification_uri;
    if (device.error || typeof url !== "string" || !safeFeishuAuthorizationUrl(url) || typeof device.device_code !== "string") throw new Error("无法创建飞书个人授权链接。");
    const expiresAt = this.now() + Math.min(900, Math.max(1, Number(device.expires_in) || 240)) * 1000;
    let interval = Math.min(60, Math.max(1, Number(device.interval) || 5)) * 1000;
    await sendPrompt({ authorizationUrl: url, expiresAt });
    while (this.now() < expiresAt) {
      await this.sleep(Math.min(interval, expiresAt - this.now()));
      if (this.now() >= expiresAt) break;
      const token = await this.post(TOKEN_URL, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: identity.appId, client_secret: identity.appSecret });
      if (token.error === "authorization_pending") continue;
      if (token.error === "slow_down") { interval = Math.min(60_000, interval + 5_000); continue; }
      if (token.error || typeof token.access_token !== "string") throw new Error("飞书个人授权未完成。");
      const response = await this.request("https://open.feishu.cn/open-apis/authen/v1/user_info", {
        redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token.access_token}` }
      });
      const info = await response.json() as { code?: number; data?: { open_id?: string; user_id?: string } };
      // The requesting user owns this connection; the authorized Feishu account may differ.
      if (!response.ok || info.code !== 0 || typeof info.data?.open_id !== "string" || !info.data.open_id.trim()) {
        throw new Error("飞书账号验证未完成，请重新连接。");
      }
      const scopes = typeof token.scope === "string" ? token.scope.split(/\s+/) : [];
      if (this.scopes.filter(scope => scope !== "offline_access").some(scope => !scopes.includes(scope))) throw new Error("飞书个人授权缺少所需权限。");
      await this.save(identity, { appId: identity.appId, userId: identity.userId, accessToken: token.access_token,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : "",
        expiresAt: this.now() + Number(token.expires_in ?? 7200) * 1000,
        refreshExpiresAt: this.now() + Number(token.refresh_token_expires_in ?? 604800) * 1000, scopes });
      return;
    }
    throw new Error("飞书个人授权链接已过期。");
  }
}
