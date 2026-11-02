import { createHash, createHmac, randomUUID } from "node:crypto";
import { ProxyAgent, type Dispatcher } from "undici";

const DEFAULT_POLL_INTERVAL_MS = 1_500;

type BridgeStatus =
  | { status: "pending" }
  | { status: "completed"; code: string }
  | { status: "error"; error: string };
export type AuthorizationBridgeIntegration = "xmind" | "notion" | "google_calendar" | "google_drive" | "todoist";

export type XmindAuthBridgeFetch = typeof fetch;

export function createXmindAuthBridgeFetch(
  proxyUrl?: string,
  request: XmindAuthBridgeFetch = fetch,
  dispatcher?: Dispatcher
): XmindAuthBridgeFetch {
  if (!proxyUrl) return request;
  const proxyDispatcher = dispatcher ?? new ProxyAgent({ uri: proxyUrl });
  return ((input, init) => request(input, {
    ...init,
    dispatcher: proxyDispatcher
  } as RequestInit & { dispatcher: Dispatcher })) as XmindAuthBridgeFetch;
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function bridgeSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  method: string,
  pathname: string,
  body: string
): string {
  const canonical = [timestamp, nonce, method.toUpperCase(), pathname, bodyDigest(body)].join("\n");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function abortError(): Error {
  return new DOMException("XMind authorization was cancelled", "AbortError");
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? abortError());
    }, { once: true });
  });
}

function parseStatus(value: unknown): BridgeStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("XMind authorization bridge returned an invalid response");
  }
  const record = value as Record<string, unknown>;
  if (record.status === "pending") return { status: "pending" };
  if (record.status === "completed" && typeof record.code === "string" && record.code) {
    return { status: "completed", code: record.code };
  }
  if (record.status === "error" && typeof record.error === "string" && record.error) {
    return { status: "error", error: record.error };
  }
  throw new Error("XMind authorization bridge returned an invalid status");
}

export class XmindAuthBridgeClient {
  readonly callbackUrl: string;

  constructor(
    baseUrl: string,
    private readonly secret: string,
    private readonly request: XmindAuthBridgeFetch = fetch,
    private readonly integration: AuthorizationBridgeIntegration = "xmind"
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      throw new Error("XMind authorization bridge must use HTTPS");
    }
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.callbackUrl = `${this.baseUrl}/v1/${integration}/callback`;
    if (!secret.trim()) throw new Error("XMind authorization bridge secret is missing");
  }

  private readonly baseUrl: string;

  async register(requestId: string, state: string, expiresAt: number): Promise<void> {
    const pathname = `/v1/requests/${encodeURIComponent(requestId)}`;
    const body = JSON.stringify({
      stateHash: createHash("sha256").update(state).digest("hex"),
      ...(this.integration !== "xmind" ? { integration: this.integration } : {}),
      expiresAt
    });
    const response = await this.signedFetch("PUT", pathname, body);
    if (!response.ok) throw new Error(`XMind authorization bridge rejected the request (${response.status})`);
  }

  async waitForCode(
    requestId: string,
    expiresAt: number,
    signal?: AbortSignal,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
  ): Promise<string> {
    const pathname = `/v1/requests/${encodeURIComponent(requestId)}`;
    while (Date.now() < expiresAt) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      const response = await this.signedFetch("GET", pathname, "", signal);
      if (response.status === 202) {
        await delay(Math.min(pollIntervalMs, Math.max(1, expiresAt - Date.now())), signal);
        continue;
      }
      if (response.status === 404 || response.status === 410) {
        throw new Error("XMind authorization request expired; please start again");
      }
      if (!response.ok) throw new Error(`XMind authorization bridge failed (${response.status})`);
      const status = parseStatus(await response.json());
      if (status.status === "completed") return status.code;
      if (status.status === "error") {
        throw new Error(status.error === "access_denied"
          ? "XMind authorization was cancelled"
          : `XMind authorization failed: ${status.error}`);
      }
    }
    throw new Error("XMind authorization timed out; please start again");
  }

  private async signedFetch(
    method: "GET" | "PUT",
    pathname: string,
    body: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    return this.request(`${this.baseUrl}${pathname}`, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Zigent-Timestamp": timestamp,
        "X-Zigent-Nonce": nonce,
        "X-Zigent-Signature": bridgeSignature(this.secret, timestamp, nonce, method, pathname, body)
      },
      ...(body ? { body } : {})
    });
  }
}
