import { ProductivityRequestError, networkFailure, type NetworkFailure, type OAuthResponseError } from "./http.js";
import { ProductivityAuthorizationRequiredError } from "./credentials.js";

export type AuthorizationStage = "prepare" | "client_registration" | "bridge_registration" | "user_authorization" | "token_exchange" | "verify" | "save";
export type AuthorizationFailure = {
  stage: AuthorizationStage;
  reason: NetworkFailure | "http" | "busy" | "expired" | "cancelled" | "permissions" | "unknown";
  status?: number;
  oauthError?: OAuthResponseError;
};

/** Fixed categories only: raw provider errors, URLs, OAuth state and tokens must never leave the coordinator. */
export function authorizationFailure(stage: AuthorizationStage, error: unknown): AuthorizationFailure {
  if (error instanceof ProductivityRequestError) return { stage, reason: error.failure,
    ...(error.status ? { status: error.status } : {}), ...(error.oauthError ? { oauthError: error.oauthError } : {}) };
  const message = error instanceof Error ? error.message : "";
  if (error instanceof ProductivityAuthorizationRequiredError) {
    const status = message.match(/: HTTP (401|403);/)?.[1];
    if (status) return { stage, reason: "http", status: Number(status) };
  }
  if (message === "Account authorization is already running" || (error as NodeJS.ErrnoException)?.code === "EEXIST") return { stage, reason: "busy" };
  if (/expired|timed out/i.test(message) || error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) return { stage, reason: "expired" };
  if (/authorization was cancelled/i.test(message)) return { stage, reason: "cancelled" };
  if (message === "Required account permissions were not granted") return { stage, reason: "permissions" };
  const status = message.match(/^XMind authorization bridge (?:rejected the request|failed) \((\d{3})\)$/)?.[1];
  if (status) return { stage, reason: "http", status: Number(status) };
  if (error instanceof TypeError && message === "fetch failed") return { stage, reason: networkFailure(error) };
  return { stage, reason: "unknown" };
}

export function authorizationFailureText(failure: AuthorizationFailure): string {
  const stages: Record<AuthorizationStage, string> = {
    prepare: "准备账号连接", client_registration: "注册授权应用", bridge_registration: "准备授权回调",
    user_authorization: "等待账号授权", token_exchange: "完成授权验证", verify: "验证账号连接", save: "保存账号连接"
  };
  const reason = failure.reason === "busy" ? "上次连接仍在处理中，请稍后重试。"
    : failure.reason === "expired" ? "授权等待已超时，请重新连接。"
    : failure.reason === "cancelled" || failure.oauthError === "access_denied" ? "授权已取消，可以重新连接。"
    : failure.reason === "permissions" || failure.oauthError === "invalid_scope" ? "服务拒绝了请求的权限，需要修正接入配置。"
    : failure.reason === "http" ? `服务暂未接受请求${failure.status ? `（HTTP ${failure.status}）` : ""}，请稍后重试。`
    : ["timeout", "tls", "dns", "connect", "network"].includes(failure.reason) ? "服务连接暂未成功，请稍后重试；持续失败时需要检查服务端连接。"
    : "这一步未能完成，请重新连接。";
  return `${stages[failure.stage]}未完成：${reason} 刚才的操作尚未执行。`;
}
