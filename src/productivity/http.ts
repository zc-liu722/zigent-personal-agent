import { createXmindAuthBridgeFetch } from "../xmind/auth-bridge.js";
import type { PersonalIntegrationConfig } from "./config.js";
import type { ToolExecutionContext } from "../tools/registry.js";
import { ProductivityAuthorizationRequiredError } from "./credentials.js";

const OAUTH_ERRORS = ["invalid_scope", "invalid_client_metadata", "invalid_client", "invalid_grant", "access_denied", "temporarily_unavailable", "server_error", "unauthorized_client", "unsupported_grant_type", "incorrect_application_credentials", "bad_authorization_code"] as const;
export type OAuthResponseError = typeof OAUTH_ERRORS[number];
export type NetworkFailure = "timeout" | "tls" | "dns" | "connect" | "network";
export function networkFailure(error: unknown): NetworkFailure {
  const source = record(error), cause = record(source.cause);
  const code = typeof cause.code === "string" ? cause.code : typeof source.code === "string" ? source.code : "";
  if (source.name === "TimeoutError" || source.name === "AbortError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return "timeout";
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_VERIFY_LEAF_SIGNATURE$)/.test(code)) return "tls";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"].includes(code)) return "connect";
  return "network";
}
export class ProductivityRequestError extends Error {
  constructor(message: string, readonly failure: "http" | NetworkFailure, readonly status?: number, readonly oauthError?: OAuthResponseError) { super(message); }
}

export function assertPersonalAccess(config: PersonalIntegrationConfig | undefined, context: ToolExecutionContext): void {
  context.signal?.throwIfAborted();
  if (context.conversationKind !== "p2p" || context.taskRunId || config && (
    config.agentId !== context.agentId || config.ownerUserId && config.ownerUserId !== context.userId
  )) throw new Error("This integration is only available to its configured owner in a private user conversation");
}

export function productivityFetch(proxyUrl?: string): typeof fetch {
  return createXmindAuthBridgeFetch(proxyUrl);
}

/** No automatic replay of writes; raw upstream bodies and fetch errors may contain secrets. */
export async function requestResponse(request: typeof fetch, service: string, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const write = init.method !== undefined && init.method !== "GET";
  let response: Response;
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    response = await request(url, { ...init, redirect: "error", signal });
  } catch (error) {
    throw new ProductivityRequestError(write ? `${service}: request outcome is uncertain; read current state before retrying any change` : `${service}: connection failed or timed out`, networkFailure(error));
  }
  if (!response.ok) {
    if (response.status === 401) throw new ProductivityAuthorizationRequiredError(service, "HTTP 401; authorization expired or invalid; reconnect the account");
    if (response.status === 403 && service.startsWith("Google")) {
      const error = record(record(await response.clone().json().catch(() => undefined)).error);
      const errors = Array.isArray(error.errors) ? error.errors : [];
      const details = Array.isArray(error.details) ? error.details : [];
      if (errors.some(value => record(value).reason === "insufficientPermissions") || details.some(value => record(value).reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
        throw new ProductivityAuthorizationRequiredError(service, "HTTP 403; required permissions were not granted; reconnect the account");
      if (errors.some(value => record(value).reason === "accessNotConfigured") || details.some(value => record(value).reason === "SERVICE_DISABLED"))
        throw new ProductivityRequestError(`${service}: HTTP 403; enable the Google API used by this action in the OAuth application's Cloud project`, "http", 403);
    }
    const hint = response.status === 401 ? "authorization expired or invalid; reconnect the account"
      : response.status === 403 ? "access denied; check account permissions"
      : response.status === 429 ? "rate limited; try later"
      : write && response.status >= 500 ? "outcome may be uncertain; read current state before retrying"
      : "request rejected";
    let oauthError: OAuthResponseError | undefined;
    if (["Todoist client registration", "Account authorization", "Todoist authorization"].includes(service)) {
      const value = record(await response.clone().json().catch(() => undefined)).error;
      if (OAUTH_ERRORS.includes(value as OAuthResponseError)) oauthError = value as OAuthResponseError;
    }
    throw new ProductivityRequestError(`${service}: HTTP ${response.status}; ${hint}`, "http", response.status, oauthError);
  }
  return response;
}

export async function requestJson(request: typeof fetch, service: string, url: string | URL, init: RequestInit = {}): Promise<unknown> {
  const response = await requestResponse(request, service, url, init);
  const write = init.method !== undefined && init.method !== "GET";
  if (response.status === 204) return undefined;
  try { return await response.json(); }
  catch { throw new Error(`${service}: invalid response${write ? "; outcome is uncertain; read current state before retrying" : ""}`); }
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function pick(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
