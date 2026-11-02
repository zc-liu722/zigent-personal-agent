import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { GoogleOAuthConfig, ProductivityIntegration, TodoistConfig } from "./config.js";
import { XmindAuthBridgeClient } from "../xmind/auth-bridge.js";
import { GOOGLE_CALENDAR_SCOPES } from "./google-calendar.js";
import { GOOGLE_DRIVE_SCOPES } from "./google-drive.js";
import { TODOIST_SCOPES, TODOIST_TOKEN_URL, tokenGrant } from "./todoist-auth.js";
import { withTokenLock, writePrivateJson, type OAuthGrant } from "./credentials.js";
import { productivityFetch, record, requestJson } from "./http.js";
import { authorizationFailure, authorizationFailureText, type AuthorizationFailure, type AuthorizationStage } from "./authorization-failure.js";

export const PRODUCTIVITY_LABELS = { google_calendar: "Google Calendar", google_drive: "Google Drive", todoist: "Todoist" } as const;
export function productivityAuthorizationResultText(integration: ProductivityIntegration, authorized: boolean, failure?: AuthorizationFailure): string {
  return authorized ? `${PRODUCTIVITY_LABELS[integration]} 授权已完成并验证连接。请重新告诉我需要处理什么；刚才的操作尚未执行。`
    : failure ? `${PRODUCTIVITY_LABELS[integration]} ${authorizationFailureText(failure)}`
    : `${PRODUCTIVITY_LABELS[integration]} 授权未完成或已过期。你可以继续聊天，需要时重新发起授权。`;
}
export type ProductivityOAuthConfig = GoogleOAuthConfig | TodoistConfig;
export type ProductivityAuthorizationPrompt = { service: ProductivityIntegration; authorizationUrl: string; expiresAt: number };
export type ProductivityAuthorizationOutcome = "authorized" | "failed";
type Bridge = Pick<XmindAuthBridgeClient, "callbackUrl" | "register" | "waitForCode">;
async function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new Error("Account authorization timed out"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try { return await Promise.race([operation, timeout]); }
  finally { signal.removeEventListener("abort", aborted); }
}

export class ProductivityAuthorizationCoordinator {
  private active?: Promise<void>;
  private stage: AuthorizationStage = "prepare";
  private readonly bridge?: Bridge;
  private readonly request: typeof fetch;
  constructor(readonly integration: ProductivityIntegration, private readonly config: ProductivityOAuthConfig, request = productivityFetch(config.proxyUrl), bridge?: Bridge) {
    this.request = (input, init) => request(input, { ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: "error" });
    this.bridge = bridge ?? (config.authorization ? new XmindAuthBridgeClient(config.authorization.bridgeUrl, config.authorization.bridgeSecret, this.request, integration) : undefined);
  }
  get available(): boolean {
    return Boolean(this.bridge && this.config.ownerUserId && this.config.tokenPath
      && (this.integration === "todoist" ? !this.config.clientId || this.config.clientSecret : this.config.clientId && this.config.clientSecret));
  }
  /** Independent of model turns: newer messages or a cancelled tool turn must not cancel OAuth. */
  start(sendPrompt: (prompt: ProductivityAuthorizationPrompt) => Promise<void>, notify: (outcome: ProductivityAuthorizationOutcome, failure?: AuthorizationFailure) => Promise<void>): void {
    if (!this.available || this.active) return;
    this.stage = "prepare";
    const tracked = this.authorize(sendPrompt).then(() => notify("authorized"), error => {
      const failure = authorizationFailure(this.stage, error);
      console.warn(`ACCOUNT_AUTHORIZATION ${JSON.stringify({ integration: this.integration, ...failure })}`);
      return notify("failed", failure);
    })
      .catch(() => { console.warn("Unable to deliver account authorization result"); })
      .finally(() => { if (this.active === tracked) this.active = undefined; });
    this.active = tracked;
  }
  private async authorize(sendPrompt: (prompt: ProductivityAuthorizationPrompt) => Promise<void>): Promise<void> {
    const config = this.config, bridge = this.bridge!;
    const leasePath = `${config.tokenPath}.authorizing`;
    await mkdir(dirname(leasePath), { recursive: true });
    // The web channel supplies its own callback and does not need a remote bridge secret.
    const timeoutMs = config.authorization?.timeoutMs ?? 10 * 60_000;
    const id = randomUUID(), expiresAt = Date.now() + timeoutMs;
    // Runtime prevents concurrent processes for one Agent; this lease also survives a crash.
    try {
      const prior = record(JSON.parse(await readFile(leasePath, "utf8")));
      if (typeof prior.expiresAt !== "number" || prior.expiresAt + 90_000 > Date.now()) throw new Error("Account authorization is already running");
      await rm(leasePath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const handle = await open(leasePath, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ id, expiresAt })); } finally { await handle.close(); }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const state = `${randomUUID()}.${randomBytes(32).toString("base64url")}`;
      const requestId = state.split(".")[0]!;
      const verifier = randomBytes(48).toString("base64url");
      const scope = this.integration === "google_calendar" ? GOOGLE_CALENDAR_SCOPES : this.integration === "google_drive" ? GOOGLE_DRIVE_SCOPES : TODOIST_SCOPES;
      let clientId = config.clientId, clientSecret = config.clientSecret;
      if (this.integration === "todoist" && !clientId) {
        this.stage = "client_registration";
        const registration = record(await requestJson(this.request, "Todoist client registration", "https://api.todoist.com/oauth/register", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_name: "Zigent personal agent", redirect_uris: [bridge.callbackUrl], scope: scope.join(" "),
            grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" })
        }));
        if (typeof registration.client_id !== "string" || !registration.client_id) throw new Error("Todoist did not register the OAuth client");
        clientId = registration.client_id;
      }
      const url = new URL(this.integration === "todoist" ? "https://todoist.com/oauth/authorize" : "https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries({ client_id: clientId!, redirect_uri: bridge.callbackUrl, response_type: "code", state,
        scope: scope.join(this.integration === "todoist" ? "," : " "), code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        ...(this.integration === "todoist" ? {} : { access_type: "offline", prompt: "consent" }) })) url.searchParams.set(key, value);
      this.stage = "bridge_registration";
      await beforeDeadline(bridge.register(requestId, state, expiresAt), signal);
      this.stage = "user_authorization";
      await beforeDeadline(sendPrompt({ service: this.integration, authorizationUrl: url.toString(), expiresAt }), signal);
      const code = await beforeDeadline(bridge.waitForCode(requestId, expiresAt, signal), signal);
      this.stage = "token_exchange";
      const tokens = await requestJson(this.request, "Account authorization", this.integration === "todoist" ? TODOIST_TOKEN_URL : "https://oauth2.googleapis.com/token", {
        method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId!, ...(clientSecret ? { client_secret: clientSecret } : {}),
          redirect_uri: bridge.callbackUrl, code, code_verifier: verifier })
      });
      const grant = tokenGrant(tokens);
      this.stage = "verify";
      // OAuth allows an omitted scope to mean the full requested scope (legacy Todoist apps).
      if (this.integration === "todoist" && !grant.scopes) grant.scopes = [...scope];
      if (!grant.scopes || !scope.every(required => grant.scopes!.includes(required))) throw new Error("Required account permissions were not granted");
      if (this.integration !== "todoist" && !grant.refreshToken) throw new Error("Google did not grant offline access");
      // Verify one harmless read before saving and announcing success. Response content is discarded.
      await requestJson(this.request, PRODUCTIVITY_LABELS[this.integration], this.integration === "todoist" ? "https://api.todoist.com/api/v1/tasks?limit=1"
        : this.integration === "google_drive" ? "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)"
        : "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=items(id)", {
        signal, headers: { Authorization: `Bearer ${grant.accessToken}` }
      });
      signal.throwIfAborted();
      this.stage = "save";
      await withTokenLock(config.tokenPath!, async () => {
        signal.throwIfAborted();
        await writePrivateJson(config.tokenPath!, { agentId: config.agentId, ownerUserId: config.ownerUserId!, clientId: clientId!,
          ...(clientSecret && this.integration === "todoist" ? { clientSecret } : {}), ...grant } satisfies OAuthGrant);
      }, signal);
    } finally {
      const current = record(JSON.parse(await readFile(leasePath, "utf8").catch(() => "{}")));
      if (current.id === id) await rm(leasePath, { force: true });
    }
  }
}
