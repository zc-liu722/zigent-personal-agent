import { calendarEvent, type GoogleCalendarClient } from "./google-calendar.js";
import { ProductivityRequestError, record } from "./http.js";
import { ProductivityAuthorizationRequiredError } from "./credentials.js";

/** Partial time edits preserve the other boundary from the reviewed event. */
export function calendarChangeBody(input: Record<string, unknown>, before: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of ["summary", "description", "location", "recurrence"]) if (input[key] !== undefined) body[key] = input[key];
  for (const key of ["start", "end"]) if (typeof input[key] === "string") body[key] = input[key].length === 10
    ? { date: input[key] } : { dateTime: input[key], timeZone: input.time_zone ?? "Asia/Shanghai" };
  if (body.start || body.end) {
    const start = record(body.start ?? before.start), end = record(body.end ?? before.end);
    const first = start.date ?? start.dateTime, last = end.date ?? end.dateTime;
    if (typeof first !== "string" || typeof last !== "string" || Boolean(start.date) !== Boolean(end.date)
      || !Number.isFinite(Date.parse(first)) || !Number.isFinite(Date.parse(last)) || Date.parse(last) <= Date.parse(first))
      throw new Error("Calendar time change is invalid: start and end must have matching date/dateTime types, with end after start. Read the event and supply the intended boundaries.");
  }
  return body;
}

/** Fixed outcomes only; upstream messages and event contents stay out of notices/logs. */
export class CalendarMutationError extends Error {
  constructor(readonly outcome: "not_applied" | "conflict" | "uncertain", cause?: unknown) {
    super(`Google Calendar: ${outcome}`, { cause });
  }
}

function transient(error: unknown): boolean {
  return error instanceof ProductivityRequestError && (error.failure !== "http"
    || [429, 500, 502, 503, 504].includes(error.status ?? 0));
}
function absent(error: unknown): boolean {
  return error instanceof ProductivityRequestError && [404, 410].includes(error.status ?? 0);
}
function sameBoundary(actual: unknown, expected: unknown): boolean {
  const a = record(actual), b = record(expected);
  if (b.date !== undefined) return a.date === b.date && a.dateTime === undefined;
  return typeof a.dateTime === "string" && typeof b.dateTime === "string"
    && Date.parse(a.dateTime) === Date.parse(b.dateTime) && a.timeZone === b.timeZone;
}
function matches(event: Record<string, unknown>, body: Record<string, unknown>): boolean {
  return event.status !== "cancelled" && Object.entries(body).every(([key, value]) => {
    if (key === "start" || key === "end") return sameBoundary(event[key], value);
    if (key === "recurrence") return JSON.stringify(event[key] ?? []) === JSON.stringify(value);
    return (event[key] ?? "") === value;
  });
}

/** Replays use the SAME ETag: at most one write can commit, even if its response is lost. */
export async function mutateCalendarEvent(client: GoogleCalendarClient, path: string, method: "PATCH" | "DELETE",
  body: Record<string, unknown> | undefined, before: Record<string, unknown>, signal?: AbortSignal) {
  const etag = before.etag;
  if (typeof etag !== "string" || !etag) throw new CalendarMutationError("not_applied");
  for (let attempt = 0; ; attempt++) {
    let writeError: unknown;
    try {
      const result = await client.call(path, method, body, {}, signal, { ifMatch: etag });
      if (method === "DELETE") return { status: "deleted", event_id: before.id };
      const event = calendarEvent(result);
      if (!matches(event, body!)) throw new CalendarMutationError("uncertain");
      return { event };
    } catch (error) { writeError = error; }
    if (attempt === 0 && writeError instanceof ProductivityAuthorizationRequiredError) throw writeError;
    // A non-transient 4xx is a definitive rejection, not an ambiguous transport failure.
    if (attempt === 0 && writeError instanceof ProductivityRequestError && writeError.failure === "http"
      && (writeError.status ?? 0) < 500 && ![404, 410, 412, 429].includes(writeError.status ?? 0))
      throw new CalendarMutationError("not_applied", writeError);
    let current: Record<string, unknown>;
    try { current = calendarEvent(await client.call(path, "GET", undefined, {}, signal)); }
    catch (error) {
      if (method === "DELETE" && absent(error)) return { status: "deleted", event_id: before.id, reconciled: true };
      throw new CalendarMutationError(absent(error) ? "conflict" : "uncertain", writeError);
    }
    if (method === "DELETE" ? current.status === "cancelled" : matches(current, body!))
      return method === "DELETE" ? { status: "deleted", event_id: before.id, reconciled: true } : { event: current, reconciled: true };
    if (current.etag !== etag) throw new CalendarMutationError("conflict", writeError);
    // A late first request and this retry cannot both commit with the original ETag.
    if (transient(writeError) && attempt < 1 && !signal?.aborted) continue;
    // Only a definitive HTTP rejection proves no in-flight request can still apply later.
    if (attempt === 0 && writeError instanceof ProductivityRequestError && writeError.failure === "http" && (writeError.status ?? 0) < 500)
      throw new CalendarMutationError("not_applied", writeError);
    throw new CalendarMutationError("uncertain", writeError);
  }
}
