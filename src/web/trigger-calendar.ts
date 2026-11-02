import type { TaskTrigger } from "../tasks/types.js";
import { nextOccurrence, localTaskTime } from "../tasks/schedule.js";
import { record } from "../productivity/http.js";
import type { GoogleCalendarClient } from "../productivity/google-calendar.js";

export type CalendarWindow = { at: number; from: number; to: number; day: string; timezone: string;
  events: Array<{ title: string; start: number; end: number; allDay: boolean }>; truncated: boolean };

export async function triggerCalendar(trigger: Extract<TaskTrigger, { type: "time" }>, client: Pick<GoogleCalendarClient, "call">, now = Date.now()): Promise<CalendarWindow> {
  // One-shot rules keep their actual date, including completed reminders.
  const at = trigger.schedule === "once" ? Date.parse(trigger.at) : nextOccurrence(trigger, now - 1)!;
  const timezone = trigger.timezone ?? "Asia/Shanghai", day = localTaskTime(at, timezone).day;
  const from = at - 90 * 60000, to = at + 90 * 60000;
  const signal = AbortSignal.timeout(18000);
  const events: CalendarWindow["events"] = [];
  let truncated = false, calendarPage: string | undefined;
  const calendars = new Set<string>();
  for (let page = 0; page < 3; page++) {
    const result = record(await client.call("users/me/calendarList", "GET", undefined,
      { maxResults: 100, pageToken: calendarPage, showHidden: "false", fields: "items(id,primary,selected,accessRole,deleted,hidden),nextPageToken" }, signal));
    if (!Array.isArray(result.items)) throw new Error("CALENDAR_RESPONSE_INVALID");
    for (const value of result.items) {
      const calendar = record(value);
      if (!calendar.deleted && !calendar.hidden && (calendar.primary || calendar.selected) && calendar.accessRole === "freeBusyReader") truncated = true;
      if (typeof calendar.id === "string" && !calendar.deleted && !calendar.hidden && (calendar.primary || calendar.selected)
        && ["reader", "writer", "owner"].includes(String(calendar.accessRole))) calendars.add(calendar.id);
    }
    calendarPage = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined;
    if (!calendarPage) break;
  }
  if (calendarPage || calendars.size > 8) truncated = true;
  for (const id of [...calendars].slice(0, 8)) {
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = record(await client.call(`calendars/${encodeURIComponent(id)}/events`, "GET", undefined, {
        timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), timeZone: timezone,
        singleEvents: "true", orderBy: "startTime", maxResults: 100, pageToken,
        fields: "items(status,summary,start,end,transparency),nextPageToken"
      }, signal));
      if (!Array.isArray(result.items)) throw new Error("CALENDAR_RESPONSE_INVALID");
      for (const value of result.items) {
        const event = record(value), start = record(event.start), end = record(event.end);
        if (event.status === "cancelled") continue;
        const allDay = typeof start.date === "string" && typeof end.date === "string";
        let first: number, last: number;
        if (allDay) {
          // Date-only events use the calendar date, with an exclusive end. Never parse as UTC midnight.
          if (!(String(start.date) <= day && day < String(end.date))) continue;
          first = from; last = to;
        } else {
          if (typeof start.dateTime !== "string" || typeof end.dateTime !== "string"
            || !/([zZ]|[+-]\d\d:\d\d)$/.test(start.dateTime) || !/([zZ]|[+-]\d\d:\d\d)$/.test(end.dateTime)) continue;
          first = Date.parse(start.dateTime); last = Date.parse(end.dateTime);
          if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first || first >= to || last <= from) continue;
        }
        events.push({ title: typeof event.summary === "string" ? event.summary.slice(0, 160) : "日程", start: first, end: last, allDay });
      }
      pageToken = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined;
      if (!pageToken || events.length >= 200) break;
    }
    if (pageToken || events.length > 200) truncated = true;
    if (events.length >= 200) { truncated = true; break; }
  }
  return { at, from, to, day, timezone, events: events.sort((a, b) => a.start - b.start).slice(0, 200), truncated };
}
