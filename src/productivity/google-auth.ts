import { readFile } from "node:fs/promises";
import type { GoogleOAuthConfig } from "./config.js";
import { productivityFetch, record, requestJson } from "./http.js";
import { ProductivityAuthorizationRequiredError } from "./credentials.js";

export async function googleRefreshToken(config: GoogleOAuthConfig, service = "Google Calendar"): Promise<string | undefined> {
  try {
    const stored = record(JSON.parse(await readFile(config.tokenPath, "utf8")));
    if (stored.agentId !== config.agentId || stored.ownerUserId !== config.ownerUserId || stored.clientId !== config.clientId) return config.refreshToken;
    return typeof stored.refreshToken === "string" && stored.refreshToken ? stored.refreshToken : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return config.refreshToken;
    throw new ProductivityAuthorizationRequiredError(service, "authorization file could not be read; reconnect the account");
  }
}

/** Each service has an independent grant, scope and owner binding, sharing only the OAuth protocol. */
export class GoogleOAuthClient {
  private token?: { value: string; expiresAt: number; refreshToken: string };
  constructor(protected readonly config: GoogleOAuthConfig, protected readonly request = productivityFetch(config.proxyUrl), protected readonly service = "Google Calendar") {}

  async configured(): Promise<boolean> {
    return Boolean(this.config.ownerUserId && this.config.clientId && this.config.clientSecret && await googleRefreshToken(this.config, this.service));
  }

  protected async accessToken(signal?: AbortSignal): Promise<string> {
    const refreshToken = await googleRefreshToken(this.config, this.service);
    if (!refreshToken || !this.config.clientId || !this.config.clientSecret) throw new ProductivityAuthorizationRequiredError(this.service);
    if (!this.token || this.token.refreshToken !== refreshToken || Date.now() + 60_000 >= this.token.expiresAt) {
      let result: Record<string, unknown>;
      try {
        result = record(await requestJson(this.request, `${this.service} authorization`, "https://oauth2.googleapis.com/token", {
          method: "POST", signal, headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: refreshToken })
        }));
      } catch (error) {
        if (error instanceof Error && /HTTP (400|401)/.test(error.message)) throw new ProductivityAuthorizationRequiredError(this.service);
        throw error;
      }
      if (typeof result.access_token !== "string" || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
        throw new Error(`${this.service}: invalid authorization response; reconnect the account`);
      this.token = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000, refreshToken };
    }
    return this.token.value;
  }

  protected invalidateToken(): void { this.token = undefined; }
}
