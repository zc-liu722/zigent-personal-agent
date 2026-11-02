import { pick, ProductivityRequestError, record, requestJson } from "./http.js";
import { GoogleOAuthClient } from "./google-auth.js";
import { setTimeout as delay } from "node:timers/promises";
export { googleRefreshToken } from "./google-auth.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
] as const;

export function calendarEvent(value: unknown) {
  const source = record(value);
  if (typeof source.id !== "string" || !source.id) throw new Error("Google Calendar: invalid event response; read current state before retrying a change");
  return {
    ...pick(source, ["id", "summary", "description", "location", "htmlLink", "status", "transparency", "eventType", "recurrence", "recurringEventId"]),
    start: pick(source.start, ["date", "dateTime", "timeZone"]),
    end: pick(source.end, ["date", "dateTime", "timeZone"])
  };
}

export class GoogleCalendarClient extends GoogleOAuthClient {
  async call(path: string, method = "GET", body?: unknown, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal,
    options: { stableCreate?: boolean } = {}): Promise<unknown> {
    const token = await this.accessToken(signal);
    const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    // Only reads and an event creation with a stable client-supplied ID can be
    // retried. A repeated create is reconciled by the caller on HTTP 409.
    const safeRetry = method === "GET" || method === "POST" && options.stableCreate === true
      && /^calendars\/[^/]+\/events$/.test(path) && typeof record(body).id === "string" && Boolean(record(body).id);
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestJson(this.request, "Google Calendar", url, {
          method, signal, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes("HTTP 401")) this.invalidateToken();
        const transient = error instanceof ProductivityRequestError &&
          (["connect", "timeout", "dns", "network"].includes(error.failure) || error.failure === "http" && [500, 502, 503, 504].includes(error.status ?? 0));
        if (!safeRetry || !transient || attempt >= 2 || signal?.aborted) throw error;
        await delay(300 * 2 ** attempt, undefined, { signal });
      }
    }
  }
}
