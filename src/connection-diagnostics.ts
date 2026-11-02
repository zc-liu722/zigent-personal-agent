import type { AgentConfig } from "./config.js";
import { modelRequestDispatcher } from "./llm.js";
import { ProductivityAuthorizationRequiredError, readGrant } from "./productivity/credentials.js";
import type { GoogleOAuthConfig } from "./productivity/config.js";
import { GoogleOAuthClient } from "./productivity/google-auth.js";
import { GOOGLE_CALENDAR_SCOPES } from "./productivity/google-calendar.js";
import { GOOGLE_DRIVE_SCOPES } from "./productivity/google-drive.js";
import { networkFailure, productivityFetch, record, requestResponse, ProductivityRequestError } from "./productivity/http.js";

type ZenmuxFinding = {
  supplier: "zenmux"; protocol: "openai-responses" | "anthropic-messages";
  route: "configured-proxy" | "direct"; keyConfigured: boolean; proxyPort?: number;
  ready: boolean; status?: number; modelCount?: number; failure?: string;
};

/** Reuse the model transport, without a generation, fallback, usage charge or conversation. */
export async function diagnoseZenmux(config: Pick<AgentConfig, "zenmuxProxyUrl" | "modelConnectTimeoutMs" | "suppliers">, request: typeof fetch = fetch): Promise<ZenmuxFinding[]> {
  const supplier = config.suppliers?.zenmux;
  const network = supplier?.network ?? "proxy";
  const route = network === "proxy" ? "configured-proxy" : "direct";
  return Promise.all((["openai-responses", "anthropic-messages"] as const).map(async (protocol): Promise<ZenmuxFinding> => {
    const base = { supplier: "zenmux", protocol, route, keyConfigured: Boolean(supplier?.apiKey),
      proxyPort: network === "proxy" && config.zenmuxProxyUrl ? Number(new URL(config.zenmuxProxyUrl).port) : undefined } as const;
    if (network === "proxy" && !config.zenmuxProxyUrl) return { ...base, ready: false, failure: "proxy_not_configured" };
    const url = protocol === "openai-responses" ? "https://zenmux.ai/api/v1/models" : "https://zenmux.ai/api/anthropic/v1/models";
    try {
      const response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(12_000),
        headers: supplier?.apiKey ? protocol === "openai-responses" ? { Authorization: `Bearer ${supplier.apiKey}` }
          : { "x-api-key": supplier.apiKey, "anthropic-version": "2023-06-01" } : undefined,
        dispatcher: modelRequestDispatcher(config, url, network)
      } as RequestInit);
      if (!response.ok) { await response.body?.cancel(); return { ...base, ready: false, status: response.status, failure: "http" }; }
      const body = record(await response.json());
      return { ...base, status: response.status, ready: Array.isArray(body.data),
        ...(Array.isArray(body.data) ? { modelCount: body.data.length } : { failure: "invalid_response" }) };
    } catch (error) { return { ...base, ready: false, failure: networkFailure(error) }; }
  }));
}

class GoogleConnectionProbe extends GoogleOAuthClient {
  async verify(integration: "google_calendar" | "google_drive") {
    const signal = AbortSignal.timeout(30_000);
    if (!await this.configured()) return { ready: false, status: "authorization_required" };
    const grant = await readGrant(this.config);
    const scopes = integration === "google_calendar" ? GOOGLE_CALENDAR_SCOPES : GOOGLE_DRIVE_SCOPES;
    if (grant?.scopes && !scopes.every(scope => grant.scopes!.includes(scope))) return { ready: false, status: "scope_upgrade_required" };
    const token = await this.accessToken(signal);
    const response = await requestResponse(this.request, this.service, integration === "google_calendar"
      ? "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=items(id)"
      : "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)", {
      method: "GET", signal, headers: { Authorization: `Bearer ${token}` }
    });
    await response.body?.cancel();
    return { ready: true, status: "authorized", permissionsVerified: Boolean(grant?.scopes), httpStatus: response.status };
  }
}

/** Explicit account verification only: refresh an existing grant and discard one minimal read.
 * Never starts authorization, writes a grant, replays an operation or emits account data. */
export async function verifyGoogleConnection(integration: "google_calendar" | "google_drive", config: GoogleOAuthConfig, request = productivityFetch(config.proxyUrl)) {
  try { return { integration, ...await new GoogleConnectionProbe(config, request, integration === "google_calendar" ? "Google Calendar" : "Google Drive").verify(integration) }; }
  catch (error) {
    return { integration, ready: false, status: error instanceof ProductivityAuthorizationRequiredError ? "authorization_required" : "verification_failed",
      ...(error instanceof ProductivityRequestError ? { httpStatus: error.status, failure: error.failure } : {}) };
  }
}
