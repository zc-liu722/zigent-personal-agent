import { randomUUID } from "node:crypto";
import { bridgeSignature } from "../xmind/auth-bridge.js";
import type { PersonalIntegrationConfig, ProductivityIntegration } from "./config.js";
import { networkFailure, productivityFetch, type NetworkFailure } from "./http.js";

type Finding = {
  route: "configured-proxy" | "direct";
  target: "todoist-registration" | "google-authorization" | "google-token" | "google-calendar-api" | "google-drive-api" | "authorization-bridge" | "bridge-signature" | "web-oauth-callback";
  ready: boolean;
  status?: number;
  failure?: NetworkFailure | "http";
};

/** Read-only probes through the runtime transport. No registration, token refresh or account data reads. */
export async function diagnoseProductivityAuthorization(config: PersonalIntegrationConfig,
  requestFactory: (proxyUrl?: string) => typeof fetch = productivityFetch, options: { webCallbackUrl?: string; integration?: ProductivityIntegration } = {}): Promise<Finding[]> {
  const routes = [...(config.proxyUrl ? [{ route: "configured-proxy" as const, proxyUrl: config.proxyUrl }] : []), { route: "direct" as const }];
  return (await Promise.all(routes.map(async route => {
    const request = requestFactory("proxyUrl" in route ? route.proxyUrl : undefined);
    const probes: Array<{ target: Finding["target"]; url: string; expected: number; headers?: Record<string,string> }> = options.integration?.startsWith("google_") ? [
      { target: "google-authorization", url: "https://accounts.google.com/.well-known/openid-configuration", expected: 200 },
      { target: "google-token", url: "https://oauth2.googleapis.com/token", expected: 404 },
      options.integration === "google_calendar"
        ? { target: "google-calendar-api", url: "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest", expected: 200 }
        : { target: "google-drive-api", url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest", expected: 200 }
    ] : [{ target: "todoist-registration", url: "https://api.todoist.com/oauth/register", expected: 405 }];
    if (options.webCallbackUrl) probes.push({ target:"web-oauth-callback",url:options.webCallbackUrl,expected:400 });
    else if (config.authorization) {
      const base = config.authorization.bridgeUrl.replace(/\/$/, ""), path = `/v1/requests/${randomUUID()}`;
      const timestamp = String(Date.now()), nonce = randomUUID();
      probes.push({ target: "authorization-bridge", url: `${base}/healthz`, expected: 200 },
        { target: "bridge-signature", url: `${base}${path}`, expected: 404, headers: {
          "X-Zigent-Timestamp": timestamp, "X-Zigent-Nonce": nonce,
          "X-Zigent-Signature": bridgeSignature(config.authorization.bridgeSecret, timestamp, nonce, "GET", path, "")
        } });
    }
    return Promise.all(probes.map(async ({ target, url, expected, headers }): Promise<Finding> => {
      try {
        const response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(12_000), headers });
        await response.body?.cancel();
        return { route: route.route, target, ready: response.status === expected, status: response.status,
          ...(response.status === expected ? {} : { failure: "http" as const }) };
      } catch (error) { return { route: route.route, target, ready: false, failure: networkFailure(error) }; }
    }));
  }))).flat();
}
