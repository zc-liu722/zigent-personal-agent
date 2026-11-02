import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { registerApp } from "@larksuiteoapi/node-sdk";
import { FEISHU_USER_SCOPES, FeishuUserAuthorizationCoordinator, safeFeishuAuthorizationUrl, type FeishuUserIdentity } from "./feishu-user-authorization.js";

export const FEISHU_CONNECTED_USER_SCOPES = [...FEISHU_USER_SCOPES, "docx:document:readonly", "wiki:wiki:readonly"];

type Prompt = { authorizationUrl: string; expiresAt: number };
type Credentials = { appId: string; appSecret: string };
export type FeishuAccountConnection = Credentials & { accessToken?: string; readDocumentsAsUser?: boolean };
type Record = Credentials & { agentId: string; userId: string };

/** User-owned data applications are independent of the Agent's messaging bot. */
export class FeishuAccountConnectionCoordinator {
  private readonly active = new Map<string, Promise<void>>();
  constructor(
    private readonly root = join(dirname(resolve(process.env.AGENTS_CONFIG_PATH ?? "config/agents.json")), "feishu-account-connections"),
    private readonly personal = new FeishuUserAuthorizationCoordinator(undefined, undefined, undefined, undefined, FEISHU_CONNECTED_USER_SCOPES),
    private readonly register: typeof registerApp = registerApp,
    private readonly legacy = new FeishuUserAuthorizationCoordinator()
  ) {}

  private path(owner: FeishuUserIdentity): string {
    const key = createHash("sha256").update(JSON.stringify([owner.agentId, owner.userId])).digest("hex");
    return join(this.root, `${key}.json`);
  }
  private async credentials(owner: FeishuUserIdentity): Promise<Credentials | undefined> {
    try {
      const record = JSON.parse(await readFile(this.path(owner), "utf8")) as Record;
      if (record.agentId !== owner.agentId || record.userId !== owner.userId || typeof record.appId !== "string" || !record.appId.trim()
        || typeof record.appSecret !== "string" || !record.appSecret.trim()) throw new Error();
      return { appId: record.appId, appSecret: record.appSecret };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("飞书连接记录无法读取，请重新连接。");
    }
  }
  async getConnection(owner: FeishuUserIdentity): Promise<FeishuAccountConnection | undefined> {
    if (this.active.has(this.path(owner))) return { appId: owner.appId, appSecret: owner.appSecret, readDocumentsAsUser: true };
    const credentials = await this.credentials(owner);
    // Retain existing grants until the user explicitly reconnects.
    const identity = credentials ? { ...owner, ...credentials } : owner;
    if (!identity.appId || !identity.appSecret) return undefined;
    const accessToken = await (credentials ? this.personal : this.legacy).getAccessToken(identity);
    if (!credentials && !accessToken) return undefined;
    return { appId: identity.appId, appSecret: identity.appSecret, accessToken, readDocumentsAsUser: Boolean(credentials) };
  }
  async getAccessToken(owner: FeishuUserIdentity): Promise<string | undefined> {
    return (await this.getConnection(owner))?.accessToken;
  }
  async invalidate(owner: FeishuUserIdentity): Promise<void> {
    const credentials = await this.credentials(owner);
    await (credentials ? this.personal : this.legacy).invalidate({ ...owner, ...credentials });
  }
  start(owner: FeishuUserIdentity, send: (prompt: Prompt) => Promise<void>, notify: (outcome: "authorized" | "failed") => Promise<void>): void {
    const key = this.path(owner);
    if (this.active.has(key)) return;
    const operation = this.connect(owner, send).finally(() => this.active.delete(key));
    this.active.set(key, operation);
    void operation.then(() => notify("authorized"), () => notify("failed"))
      .catch(() => console.warn("Unable to send Feishu connection result notice"));
  }
  private async connect(owner: FeishuUserIdentity, send: (prompt: Prompt) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    let delivery = Promise.resolve();
    let deliveryFailed = false;
    const app = await this.register({
      signal, source: "zigent", createOnly: true,
      appPreset: { name: "Zigent 文档连接", desc: "连接个人文档读取、搜索与会议纪要" },
      addons: { preset: false, scopes: { user: [...FEISHU_CONNECTED_USER_SCOPES] } },
      onQRCodeReady: prompt => {
        if (!safeFeishuAuthorizationUrl(prompt.url)) throw new Error("飞书连接链接无效。");
        delivery = send({ authorizationUrl: prompt.url, expiresAt: Date.now() + prompt.expireIn * 1000 })
          .catch(() => { deliveryFailed = true; controller.abort(); });
      }
    });
    await delivery;
    if (deliveryFailed || !app.client_id?.trim() || !app.client_secret?.trim() || app.user_info?.tenant_brand === "lark") {
      throw new Error("飞书应用连接未完成，请重试。");
    }
    const identity = { ...owner, appId: app.client_id, appSecret: app.client_secret };
    // App creation does not grant personal data access: finish the separate user consent.
    await new Promise<void>((resolve, reject) => {
      this.personal.start(identity, send, async outcome => {
        if (outcome === "authorized") resolve();
        else reject(new Error("飞书个人授权未完成。"));
      });
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(owner), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ agentId: owner.agentId, userId: owner.userId,
        appId: app.client_id, appSecret: app.client_secret } satisfies Record), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
}
