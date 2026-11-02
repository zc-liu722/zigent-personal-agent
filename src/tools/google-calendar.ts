import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoogleCalendarConfig } from "../productivity/config.js";
import { GoogleCalendarClient, calendarEvent } from "../productivity/google-calendar.js";
import { pick, ProductivityRequestError, record } from "../productivity/http.js";
import { assertProductivityAccess, type VerifyProductivityRun } from "../productivity/task-access.js";
import type { AgentToolRegistration } from "./registry.js";
import { productivityActivity } from "./productivity-activity.js";
import { withProductivityAuthorization } from "./productivity-authorization.js";

const id = z.string().trim().min(1).max(1024);
const timestamp = z.string().datetime({ offset: true });
const boundary = z.union([z.string().date(), timestamp]);
const timeZone = z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "Use an IANA time zone");
const actions = ["authorize", "status", "list_calendars", "list_events", "get_event", "create_event", "update_event", "delete_event"] as const;
const inputSchema = z.object({
  action: z.enum(actions),
  calendar_id: id.default("primary"), event_id: id.optional(),
  time_min: timestamp.optional(), time_max: timestamp.optional(), query: z.string().max(1024).optional(),
  page_token: id.optional(), limit: z.number().int().min(1).max(100).default(50),
  summary: z.string().trim().min(1).max(1024).optional(), description: z.string().max(8000).optional(), location: z.string().max(1024).optional(),
  start: boundary.optional(), end: boundary.optional(), time_zone: timeZone.default("Asia/Shanghai"),
  recurrence: z.array(z.string().max(1024).regex(/^(RRULE|RDATE|EXDATE):/)).max(10).optional()
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (["get_event", "update_event", "delete_event"].includes(input.action) && !input.event_id) issue("event_id is required; obtain it from a read operation");
  if (input.action === "list_events" && (!input.time_min || !input.time_max)) issue("list_events requires time_min and time_max with explicit UTC offsets");
  if (input.time_min && input.time_max && Date.parse(input.time_max) <= Date.parse(input.time_min)) issue("time_max must be after time_min");
  if (input.action === "create_event" && (!input.summary || !input.start || !input.end)) issue("create_event requires summary, start and end");
  if (input.start || input.end) {
    if (!input.start || !input.end) issue("Supply start and end together; read the event first for partial time changes");
    else if ((input.start.length === 10) !== (input.end.length === 10) || Date.parse(input.end) <= Date.parse(input.start)) issue("start and end must use the same date/dateTime format, and end must be later (all-day end is exclusive)");
  }
  if (input.action === "update_event" && ![input.summary, input.description, input.location, input.start, input.recurrence].some(value => value !== undefined)) issue("update_event requires at least one changed field");
});

export function createGoogleCalendarTool(config?: GoogleCalendarConfig, client = config ? new GoogleCalendarClient(config) : undefined,
  verifyProactiveRun?: VerifyProductivityRun): AgentToolRegistration {
  return withProductivityAuthorization({
    definition: {
      type: "function", name: "google_calendar",
      description: "Use Google Calendar for viewing schedules, finding existing events, and scheduling/rescheduling/cancelling events. Use Todoist for todos. authorize opens a channel-appropriate account connection step; missing/expired grants also trigger it automatically. On the web, the current operation automatically continues after verified authorization; do not ask the user to repeat it. If authorization_pending is returned by another channel, the operation has not run; do not poll or retry. status checks configuration only, not live authorization. list_events requires a bounded RFC3339 time range with offsets; follow next_page_token until exhausted before claiming the list is complete. Read IDs before modifying existing events; clarify ambiguous matches. Use date strings for all-day events (exclusive end date) or RFC3339 timestamps with offsets for timed events; default time zone Asia/Shanghai. Change only requested fields; preserve recurrence unless explicitly asked. For recurring events, edit the returned instance ID unless the user explicitly requests the series. Do not mirror todos into Calendar without a request. Writes require user intent. No invitation/guest management is exposed. If not_configured, explain that account connection is required, and never ask for credentials in chat. After an uncertain write, read current state before retrying.",
      input_schema: { type: "object", properties: {
        action: { type: "string", enum: [...actions] },
        calendar_id: { type: "string", description: "Calendar ID from list_calendars; default primary" }, event_id: { type: "string" },
        time_min: { type: "string", description: "Inclusive start, RFC3339 with offset" }, time_max: { type: "string", description: "Exclusive end, RFC3339 with offset" },
        query: { type: "string" }, page_token: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 },
        summary: { type: "string" }, description: { type: "string" }, location: { type: "string" },
        start: { type: "string" }, end: { type: "string" }, time_zone: { type: "string", description: "IANA zone; default Asia/Shanghai" },
        recurrence: { type: "array", items: { type: "string" }, description: "Explicit RRULE/RDATE/EXDATE entries; [] removes recurrence" }
      }, required: ["action"], additionalProperties: false }
    },
    executionMode: "sequential",
    activity: productivityActivity("Google Calendar", { authorize: "连接日历账号", status: "检查日历连接", list_calendars: "查看日历列表", list_events: "查看日程", get_event: "查看日程详情", create_event: "安排日程", update_event: "修改日程", delete_event: "取消日程" }),
    async execute(value, context) {
      assertProductivityAccess(config, context, "google_calendar", record(value).action, verifyProactiveRun);
      const input = inputSchema.parse(value);
      if (!client || !await client.configured()) return { status: "not_configured", message: "Connect Google Calendar using the operator setup in docs/integrations/calendar-todoist.md. No calendar operation was performed. Never request tokens in chat." };
      if (input.action === "status") return { status: "configured", authorization_verified: false };
      const call = (path: string, method = "GET", body?: unknown, query?: Record<string, string | number | undefined>) => client.call(path, method, body, query, context.signal);
      if (input.action === "list_calendars") {
        const result = record(await call("users/me/calendarList", "GET", undefined, { maxResults: input.limit, pageToken: input.page_token }));
        return { calendars: Array.isArray(result.items) ? result.items.map(item => pick(item, ["id", "summary", "timeZone", "primary", "accessRole"])) : [], next_page_token: result.nextPageToken ?? null };
      }
      const path = `calendars/${encodeURIComponent(input.calendar_id)}/events`;
      if (input.action === "list_events") {
        const result = record(await call(path, "GET", undefined, { timeMin: input.time_min, timeMax: input.time_max, q: input.query, singleEvents: "true", orderBy: "startTime", maxResults: input.limit, pageToken: input.page_token, timeZone: input.time_zone }));
        return { events: Array.isArray(result.items) ? result.items.map(calendarEvent) : [], next_page_token: result.nextPageToken ?? null, time_zone: result.timeZone };
      }
      const eventPath = `${path}/${encodeURIComponent(input.event_id ?? "")}`;
      if (input.action === "get_event") return { event: calendarEvent(await call(eventPath)) };
      if (input.action === "delete_event") {
        await call(eventPath, "DELETE");
        return { status: "deleted", event_id: input.event_id };
      }
      const body: Record<string, unknown> = {};
      for (const key of ["summary", "description", "location", "recurrence"] as const) if (input[key] !== undefined) body[key] = input[key];
      for (const key of ["start", "end"] as const) if (input[key]) body[key] = input[key].length === 10 ? { date: input[key] } : { dateTime: input[key], timeZone: input.time_zone };
      if (input.action === "create_event") {
        // Stable per turn and payload, within Google's base32hex event ID alphabet.
        body.id = createHash("sha256").update(JSON.stringify([context.agentId, context.sessionId, context.turnId, input])).digest("hex");
        try { return { event: calendarEvent(await client.call(path, "POST", body, {}, context.signal, { stableCreate: true })) }; }
        catch (error) {
          const conflict = error instanceof Error && error.message.includes("HTTP 409");
          const uncertain = error instanceof ProductivityRequestError && (error.failure !== "http" || (error.status ?? 0) >= 500);
          if (!conflict && (!uncertain || context.signal?.aborted)) throw error;
          try { return { event: calendarEvent(await call(`${path}/${body.id}`)), deduplicated: true }; }
          catch (lookupError) { if (conflict) throw lookupError; throw error; }
        }
      }
      return { event: calendarEvent(await call(eventPath, "PATCH", body)) };
    }
  }, "google_calendar", config, verifyProactiveRun);
}
