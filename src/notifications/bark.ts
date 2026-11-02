import type { NotificationConfig } from "./config.js";

/** An empty title requests a body-only notification. */
export type NotificationContent = { title: string; body: string };
export class NotificationTransportError extends Error {
  constructor(readonly kind: "retryable" | "failed" | "uncertain") {
    // Never include an endpoint, response, key, message body or upstream error.
    super(`Notification transport ${kind}`);
  }
}
export interface NotificationTransport { send(content: NotificationContent): Promise<void> }

function clipUtf8(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result) + Buffer.byteLength(char) > limit - 3) break;
    result += char;
  }
  return `${result}…`;
}

export class BarkTransport implements NotificationTransport {
  constructor(private readonly config: NotificationConfig, private readonly agentName: string,
    private readonly fetcher: typeof fetch = fetch) {}

  async send(content: NotificationContent): Promise<void> {
    const payload = {
      device_key: this.config.deviceKey,
      ...(content.title ? { title: clipUtf8(content.title, 180) } : {}),
      body: clipUtf8(content.body, 1800),
      group: clipUtf8(`Zigent · ${this.agentName}`, 100),
      level: this.config.level,
      ...(this.config.sound ? { sound: this.config.sound } : {}),
      ...(this.config.detailUrl ? { url: this.config.detailUrl } : {})
    };
    // APNs caps its JSON payload at 4 KiB; leave room for Bark's APS envelope.
    if (Buffer.byteLength(JSON.stringify(payload)) > 3000) throw new NotificationTransportError("failed");
    try {
      const response = await this.fetcher(`${this.config.serverUrl.replace(/\/$/, "")}/push`, {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        throw new NotificationTransportError(response.status === 429 || response.status >= 500 ? "retryable" : "failed");
      }
      const result: unknown = await response.json();
      const code = result && typeof result === "object" ? (result as { code?: unknown }).code : undefined;
      if (code !== 200) throw new NotificationTransportError(typeof code !== "number" ? "uncertain"
        : code === 429 || code >= 500 ? "retryable" : "failed");
    } catch (error) {
      if (error instanceof NotificationTransportError) throw error;
      // A timeout or malformed response may follow a successful remote delivery.
      throw new NotificationTransportError("uncertain");
    }
  }
}
