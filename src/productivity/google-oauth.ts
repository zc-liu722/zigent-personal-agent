import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GoogleCalendarConfig, GoogleOAuthConfig } from "./config.js";
import { GOOGLE_CALENDAR_SCOPES } from "./google-calendar.js";
import { productivityFetch, record, requestJson } from "./http.js";

/** Interactive setup only: credentials and callback codes never enter model tools or history. */
export async function authorizeGoogleCalendar(config: GoogleCalendarConfig, openAuthorization: (url: string) => void, request = productivityFetch(config.proxyUrl)): Promise<void> {
  return authorizeGoogleAccount(config, "Google Calendar", GOOGLE_CALENDAR_SCOPES, openAuthorization, request);
}

export async function authorizeGoogleAccount(config: GoogleOAuthConfig, service: string, scopes: readonly string[], openAuthorization: (url: string) => void, request = productivityFetch(config.proxyUrl)): Promise<void> {
  if (!config.ownerUserId || !config.clientId || !config.clientSecret)
    throw new Error(`Configure the verified ${service} owner and OAuth desktop client ID/secret first; see the integration setup documentation`);
  if (config.refreshToken) throw new Error("Remove the environment refresh-token override before using file-based authorization");
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // A user may close the browser while the prompt callback itself fails.
  void codePromise.catch(() => undefined);
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname !== "/callback") { response.writeHead(404).end("Not found"); return; }
    if (url.searchParams.get("state") !== state) { response.writeHead(400).end("Invalid authorization state"); return; }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      response.writeHead(400).end("Authorization was not completed. Return to the terminal.");
      rejectCode(new Error(`${service} authorization was cancelled or rejected`));
      return;
    }
    response.writeHead(200).end("Authorization received. Return to the terminal to check completion.");
    resolveCode(code);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start the local OAuth callback");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: scopes.join(" "),
      access_type: "offline", prompt: "consent", state, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url")
    })) url.searchParams.set(key, value);
    timer = setTimeout(() => rejectCode(new Error(`${service} authorization timed out`)), 5 * 60_000);
    openAuthorization(url.toString());
    const code = await codePromise;
    const tokens = record(await requestJson(request, `${service} authorization`, "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: redirectUri, code, code_verifier: verifier })
    }));
    if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) throw new Error("Google did not grant offline access; run authorization again");
    if (typeof tokens.scope !== "string" || !scopes.every(scope => (tokens.scope as string).split(" ").includes(scope)))
      throw new Error(`${service} permissions were not fully granted; run authorization again`);
    await mkdir(dirname(config.tokenPath), { recursive: true });
    const temporary = `${config.tokenPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ agentId: config.agentId, ownerUserId: config.ownerUserId, clientId: config.clientId, refreshToken: tokens.refresh_token }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, config.tokenPath);
    } finally { await rm(temporary, { force: true }); }
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
