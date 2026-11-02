import type { TodoistConfig } from "./config.js";
import { ProductivityAuthorizationRequiredError, readGrant, withTokenLock, writePrivateJson, type OAuthGrant } from "./credentials.js";
import { productivityFetch, record, requestJson } from "./http.js";

export const TODOIST_SCOPES = ["data:read_write", "data:delete"] as const;
export const TODOIST_TOKEN_URL = "https://api.todoist.com/oauth/access_token";

export function tokenGrant(tokens: unknown, previous?: OAuthGrant): Pick<OAuthGrant, "accessToken" | "refreshToken" | "expiresAt" | "scopes"> {
  const value = record(tokens);
  if (typeof value.access_token !== "string" || !value.access_token) throw new Error("Account returned an invalid token response");
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) throw new Error("Account returned an invalid token lifetime");
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" && value.refresh_token ? value.refresh_token : previous?.refreshToken,
    expiresAt: typeof value.expires_in === "number" ? Date.now() + value.expires_in * 1000 : undefined,
    scopes: typeof value.scope === "string" ? value.scope.split(/[ ,]+/).filter(Boolean) : previous?.scopes
  };
}

export async function todoistConfigured(config?: TodoistConfig): Promise<boolean> {
  return Boolean(config?.ownerUserId && (await readGrant(config) || config.apiToken));
}

export async function todoistAccessToken(config: TodoistConfig, request = productivityFetch(config.proxyUrl), signal?: AbortSignal): Promise<string> {
  const read = async (): Promise<string> => {
    const grant = await readGrant(config);
    if (!grant) {
      if (config.apiToken) return config.apiToken;
      throw new ProductivityAuthorizationRequiredError("Todoist");
    }
    if (grant.accessToken && (grant.expiresAt === undefined || grant.expiresAt > Date.now() + 60_000)) return grant.accessToken;
    if (!grant.refreshToken) throw new ProductivityAuthorizationRequiredError("Todoist");
    let result: unknown;
    try {
      result = await requestJson(request, "Todoist authorization", TODOIST_TOKEN_URL, {
        method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: grant.clientId, refresh_token: grant.refreshToken,
          ...(grant.clientSecret ? { client_secret: grant.clientSecret } : {}) })
      });
    } catch (error) {
      if (error instanceof Error && /HTTP (400|401)/.test(error.message)) throw new ProductivityAuthorizationRequiredError("Todoist");
      throw error;
    }
    const next = { ...grant, ...tokenGrant(result, grant) };
    await writePrivateJson(config.tokenPath!, next);
    return next.accessToken!;
  };
  return config.tokenPath ? withTokenLock(config.tokenPath, read, signal) : read();
}
