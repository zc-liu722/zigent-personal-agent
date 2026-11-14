import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { networkFailure, OAUTH_ERRORS, type OAuthResponseError } from "./http.js";
import type { AuthorizationFailure, AuthorizationStage } from "./authorization-failure.js";

export type FeishuAuthorizationPrompt = {
  authorizationUrl: string; expiresAt: number; message?: string;
  stage?: "application" | "user"; actionLabel?: string;
};
export type FeishuAuthorizationOptions = { switchAccount?: boolean; repairAppId?: string };
export class FeishuAuthorizationError extends Error {
  constructor(readonly failure: AuthorizationFailure) { super(`Feishu authorization: ${failure.stage}/${failure.reason}`); }
}
export function feishuOAuthError(stage: AuthorizationStage, code: unknown, status?: number): FeishuAuthorizationError {
  const reason = code === "invalid_scope" || code === "insufficient_scope" ? "permissions"
    : code === "access_denied" || code === "abort" ? "cancelled"
    : code === "expired_token" || code === "invalid_grant" ? "expired" : status ? "http" : "unknown";
  return new FeishuAuthorizationError({ stage, reason, ...(status ? { status } : {}),
    ...(OAUTH_ERRORS.includes(code as OAuthResponseError) ? { oauthError: code as OAuthResponseError } : {}) });
}
export async function feishuJson(request: typeof fetch, url: string, init: RequestInit,
  stage: AuthorizationStage, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await request(url, { ...init, redirect: "error", signal: AbortSignal.any([
      ...signal ? [signal] : [], AbortSignal.timeout(30_000)
    ]) });
    let body: unknown;
    try { body = await response.json(); }
    catch (error) { if (!response.ok) throw new FeishuAuthorizationError({ stage, reason: "http", status: response.status }); throw error; }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid Feishu response");
    const value = body as Record<string, unknown>;
    if (!response.ok && typeof value.error !== "string") throw new FeishuAuthorizationError({ stage, reason: "http", status: response.status });
    // Transient HTTP failures must not be mistaken for a terminal OAuth rejection.
    if (response.status === 429 || response.status >= 500) throw new FeishuAuthorizationError({ stage, reason: "http", status: response.status });
    if (value.error === "temporarily_unavailable" || value.error === "server_error")
      throw new FeishuAuthorizationError({ stage, reason: "network", oauthError: value.error });
    return value;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof FeishuAuthorizationError) throw error;
    throw new FeishuAuthorizationError({ stage, reason: networkFailure(error) });
  }
}
export function transientFeishuFailure(error: unknown): boolean {
  return error instanceof FeishuAuthorizationError && (["timeout", "tls", "dns", "connect", "network"].includes(error.failure.reason)
    || error.failure.status === 429 || (error.failure.status ?? 0) >= 500);
}

type RegistrationOptions = {
  signal: AbortSignal; appId?: string;
  onQRCodeReady(prompt: { url: string; expireIn: number }): void;
};
type RegistrationResult = { client_id: string; client_secret: string; user_info?: { tenant_brand?: string } };
/** Same official SDK registration protocol, with bounded, abortable HTTP and resilient polling.
 * https://github.com/larksuite/node-sdk (App Registration)
 * https://github.com/larksuite/cli/blob/v1.0.83/internal/auth/app_registration.go
 */
export async function registerFeishuApplication(options: RegistrationOptions, scopes: readonly string[], request: typeof fetch = fetch): Promise<RegistrationResult> {
  const stage = "client_registration", endpoint = "https://accounts.feishu.cn/oauth/v1/app/registration";
  const post = (form: Record<string, string>, signal: AbortSignal) => feishuJson(request, endpoint, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form)
  }, stage, signal);
  options.signal.throwIfAborted();
  const begin = await post({ action: "begin", archetype: "PersonalAgent", auth_method: "client_secret", request_user_info: "open_id tenant_brand" }, options.signal);
  if (begin.error) throw feishuOAuthError(stage, begin.error);
  if (typeof begin.device_code !== "string" || !begin.device_code)
    throw new FeishuAuthorizationError({ stage, reason: "unknown" });
  const verification = typeof begin.verification_uri_complete === "string" ? begin.verification_uri_complete
    : typeof begin.user_code === "string" && begin.user_code ? `https://open.feishu.cn/page/cli?${new URLSearchParams({ user_code: begin.user_code })}` : undefined;
  if (!verification) throw new FeishuAuthorizationError({ stage, reason: "unknown" });
  const url = new URL(verification);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".feishu.cn") || url.username || url.password)
    throw new FeishuAuthorizationError({ stage, reason: "unknown" });
  url.searchParams.set("from", "sdk"); url.searchParams.set("source", "node-sdk/zigent"); url.searchParams.set("tp", "sdk");
  url.searchParams.set("name", "Zigent 文档连接"); url.searchParams.set("desc", "连接个人文档读取、搜索与会议纪要");
  url.searchParams.set("addons", gzipSync(Buffer.from(JSON.stringify({ preset: false,
    scopes: { user: [...scopes], tenant: ["tenant:tenant:readonly"] } }))).toString("base64url"));
  if (options.appId) url.searchParams.set("clientID", options.appId);
  const expireIn = Math.min(600, Math.max(1, Number(begin.expire_in ?? begin.expires_in) || 600));
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(expireIn * 1000)]);
  let interval = Math.min(60, Math.max(1, Number(begin.interval) || 5)) * 1000;
  signal.throwIfAborted();
  options.onQRCodeReady({ url: url.toString(), expireIn });
  while (true) {
    signal.throwIfAborted();
    let body: Record<string, unknown>;
    try { body = await post({ action: "poll", device_code: begin.device_code }, signal); }
    catch (error) {
      if (!transientFeishuFailure(error)) throw error;
      interval = Math.min(60_000, interval + 1000);
      await delay(interval, undefined, { signal }); continue;
    }
    const user = body.user_info as { tenant_brand?: string } | undefined;
    // This integration is Feishu-only; do not send a device code to an unselected brand.
    if (user?.tenant_brand === "lark") throw new FeishuAuthorizationError({ stage, reason: "permissions" });
    if (typeof body.client_id === "string" && body.client_id.trim() && typeof body.client_secret === "string" && body.client_secret.trim())
      return { client_id: body.client_id, client_secret: body.client_secret, user_info: user };
    if (body.error === "slow_down") interval = Math.min(60_000, interval + 5000);
    else if (body.error && body.error !== "authorization_pending") throw feishuOAuthError(stage, body.error);
    await delay(interval, undefined, { signal });
  }
}
