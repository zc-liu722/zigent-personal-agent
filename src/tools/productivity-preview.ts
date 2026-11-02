import type { CalendarPreviewState, OperationPresentation, TodoPreviewState } from "../channels/change-preview.js";

type Fields = Record<string, unknown>;
const object = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

function calendarState(value: Fields): CalendarPreviewState {
  const boundary = (value: unknown) => {
    const source = object(value);
    return { ...(text(source.date) !== undefined ? { date: text(source.date) } : {}),
      ...(text(source.dateTime) !== undefined ? { dateTime: text(source.dateTime) } : {}),
      ...(text(source.timeZone) !== undefined ? { timeZone: text(source.timeZone) } : {}) };
  };
  return { title: text(value.summary) ?? "日程", description: text(value.description), location: text(value.location),
    ...(value.start ? { start: boundary(value.start) } : {}), ...(value.end ? { end: boundary(value.end) } : {}), recurrence: strings(value.recurrence) };
}

function todoState(value: Fields): TodoPreviewState {
  const due = object(value.due);
  return { title: text(value.content) ?? "待办", description: text(value.description),
    ...(value.due ? { due: { label: text(due.due_string ?? due.string), date: text(due.due_date ?? due.date),
      dateTime: text(due.due_datetime ?? due.datetime), ...(typeof due.is_recurring === "boolean" ? { recurring: due.is_recurring } : {}) } } : {}),
    priority: typeof value.priority === "number" ? value.priority : undefined, labels: strings(value.labels),
    completed: typeof value.is_completed === "boolean" ? value.is_completed : undefined };
}

/** Project reviewed provider fields, never IDs, credentials or transport options. */
export function productivityPresentation(tool: string, action: string, before: Fields | undefined, after: Fields | undefined): OperationPresentation | undefined {
  if (tool === "schedule") {
    const state = after ?? before;
    if (state?.kind === "event") {
      const calendar = (value: Fields) => {
        const boundary = (point: unknown) => typeof point === "string" ? point.length === 10 ? { date: point } : { dateTime: point, timeZone: text(value.timezone) } : undefined;
        return { title: text(value.title) ?? "日程", description: text(value.description), location: text(value.location), start: boundary(value.start), end: boundary(value.end),
          ...(typeof value.reminderMinutes === "number" || value.reminderMinutes === null ? { reminderMinutes: value.reminderMinutes } : {}) };
      };
      return { kind: "calendar", action: action === "create" ? "create_event" : action === "delete" ? "delete_event" : "update_event", ...(before ? { before: calendar(before) } : {}), ...(after ? { after: calendar(after) } : {}) };
    }
    const todo = (value: Fields) => ({ title: text(value.title) ?? "待办", description: text(value.description),
      ...(typeof value.due === "string" ? { due: value.due.length === 10 ? { date: value.due } : { dateTime: value.due } } : {}),
      priority: typeof value.priority === "number" ? value.priority : undefined, labels: strings(value.labels), completed: typeof value.completed === "boolean" ? value.completed : undefined });
    const actions: Record<string, string> = { create: "create_task", update: "update_task", complete: "complete_task", reopen: "reopen_task", delete: "delete_task" };
    return { kind: "todo", action: actions[action] ?? action, ...(before ? { before: todo(before) } : {}), ...(after ? { after: todo(after) } : {}) };
  }
  if (tool === "google_calendar") return { kind: "calendar", action,
    ...(before ? { before: calendarState(before) } : {}), ...(after ? { after: calendarState(after) } : {}) };
  if (tool !== "todoist") return undefined;
  let next = after ? todoState(after) : undefined;
  if (next?.due && before?.due) {
    const previous = object(before.due), changed = object(after?.due);
    // Explicit dates retain a recurring task's recurrence, while a free-form
    // expression is displayed literally until the provider resolves it.
    if (!Object.hasOwn(changed, "due_string") && typeof previous.is_recurring === "boolean") next.due.recurring = previous.is_recurring;
  }
  if (next && object(after?.due).due_string === "no date") delete next.due;
  return { kind: "todo", action, ...(before ? { before: todoState(before) } : {}), ...(next ? { after: next } : {}) };
}
