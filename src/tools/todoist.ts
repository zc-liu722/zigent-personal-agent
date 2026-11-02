import { createHash } from "node:crypto";
import { z } from "zod";
import type { TodoistConfig } from "../productivity/config.js";
import { pick, productivityFetch, record, requestJson } from "../productivity/http.js";
import { assertProductivityAccess, type VerifyProductivityRun } from "../productivity/task-access.js";
import type { AgentToolRegistration } from "./registry.js";
import { productivityActivity } from "./productivity-activity.js";
import { withProductivityAuthorization } from "./productivity-authorization.js";
import { todoistAccessToken, todoistConfigured } from "../productivity/todoist-auth.js";

const id = z.string().trim().min(1).max(256);
const changes = {
  content: z.string().trim().min(1).max(500).optional(), description: z.string().max(8000).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(), priority: z.number().int().min(1).max(4).optional(),
  due_string: z.string().min(1).max(512).optional(), due_lang: z.string().min(2).max(10).optional(),
  due_date: z.string().date().optional(), due_datetime: z.string().datetime({ offset: true }).optional()
};
const actions = ["authorize", "status", "list_projects", "list_tasks", "get_task", "create_task", "update_task", "complete_task", "reopen_task", "delete_task"] as const;
const inputSchema = z.object({
  action: z.enum(actions), task_id: id.optional(), project_id: id.optional(), section_id: id.optional(), parent_id: id.optional(),
  filter: z.string().min(1).max(1024).optional(), lang: z.string().min(2).max(10).optional(),
  cursor: z.string().min(1).max(4096).optional(), limit: z.number().int().min(1).max(100).default(50), ...changes
}).strict().superRefine((input, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (["get_task", "update_task", "complete_task", "reopen_task", "delete_task"].includes(input.action) && !input.task_id) issue("task_id is required; obtain it from a read operation");
  if (input.action === "create_task" && !input.content) issue("create_task requires content");
  if ([input.due_string, input.due_date, input.due_datetime].filter(value => value !== undefined).length > 1) issue("Specify only one of due_string, due_date and due_datetime");
  if (input.filter && (input.project_id || input.section_id || input.parent_id)) issue("Use a Todoist filter containing the project/section restriction, or list by ID without filter");
  if (input.action === "update_task" && !Object.keys(changes).some(key => key !== "due_lang" && input[key as keyof typeof changes] !== undefined)) issue("update_task requires at least one changed field");
  if (input.action === "update_task" && (input.project_id || input.section_id || input.parent_id)) issue("Moving tasks is not supported by update_task");
});

function task(value: unknown) {
  const source = record(value);
  if (typeof source.id !== "string" || !source.id) throw new Error("Todoist: invalid task response; read current state before retrying a change");
  return { ...pick(source, ["id", "content", "description", "project_id", "section_id", "parent_id", "labels", "priority", "is_completed"]),
    due: source.due ? pick(source.due, ["date", "datetime", "timezone", "string", "lang", "is_recurring"]) : null,
    url: typeof source.id === "string" ? `https://app.todoist.com/app/task/${encodeURIComponent(source.id)}` : undefined };
}

export function createTodoistTool(config?: TodoistConfig, request = productivityFetch(config?.proxyUrl),
  verifyProactiveRun?: VerifyProductivityRun): AgentToolRegistration {
  return withProductivityAuthorization({
    definition: {
      type: "function", name: "todoist",
      description: "Use Todoist to view, create, modify, complete, reopen or delete todos; use Google Calendar for schedules and time-blocked events. authorize opens a channel-appropriate account connection step; missing/expired grants also trigger it automatically. On the web, the current operation automatically continues after verified authorization; do not ask the user to repeat it. If authorization_pending is returned by another channel, the operation has not run; do not poll or retry. status checks configuration only, not live authorization. Read task/project IDs before changes; clarify ambiguous matches. list_tasks returns ACTIVE tasks only; follow next_cursor until null before claiming the list is complete. filter uses Todoist syntax (e.g. today | overdue); do not combine filter with project_id/section_id. priority is API scale: 4=urgent/P1, 1=normal/P4. Set ONE of due_date (all day), due_datetime (RFC3339 with explicit offset), due_string (natural-language or recurrence, with due_lang). To clear a due date use due_string='no date', due_lang='en'. Preserve recurrence unless explicitly asked to change it; read before rescheduling recurring todos. complete_task closes the current occurrence of a recurring todo and may schedule the next one. Only mutate on user intent; do not mirror Calendar events without a request. If not_configured explain account connection is required; never request tokens in chat. After an uncertain write, inspect current state before retrying.",
      input_schema: { type: "object", properties: {
        action: { type: "string", enum: [...actions] }, task_id: { type: "string" }, project_id: { type: "string" }, section_id: { type: "string" }, parent_id: { type: "string" },
        filter: { type: "string" }, lang: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 },
        content: { type: "string" }, description: { type: "string" }, labels: { type: "array", items: { type: "string" } }, priority: { type: "integer", minimum: 1, maximum: 4 },
        due_string: { type: "string" }, due_lang: { type: "string" }, due_date: { type: "string" }, due_datetime: { type: "string" }
      }, required: ["action"], additionalProperties: false }
    },
    executionMode: "sequential",
    activity: productivityActivity("Todoist", { authorize: "连接待办账号", status: "检查待办连接", list_projects: "查看待办项目", list_tasks: "查看待办", get_task: "查看待办详情", create_task: "创建待办", update_task: "修改待办", complete_task: "完成待办", reopen_task: "重新打开待办", delete_task: "删除待办" }),
    async execute(value, context) {
      assertProductivityAccess(config, context, "todoist", record(value).action, verifyProactiveRun);
      const input = inputSchema.parse(value);
      if (!config || !await todoistConfigured(config)) return { status: "not_configured" };
      if (input.action === "status") return { status: "configured", authorization_verified: false };
      const accessToken = await todoistAccessToken(config, request, context.signal);
      const call = (path: string, method = "GET", body?: unknown, query: Record<string, string | number | undefined> = {}) => {
        const url = new URL(`https://api.todoist.com/api/v1/${path}`);
        for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
        const hash = createHash("sha256").update(JSON.stringify([context.agentId, context.sessionId, context.turnId, input])).digest("hex");
        const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        return requestJson(request, "Todoist", url, {
          method, signal: context.signal, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(method === "GET" ? {} : { "X-Request-Id": requestId }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      };
      if (input.action === "list_projects" || input.action === "list_tasks") {
        const projects = input.action === "list_projects";
        const path = projects ? "projects" : input.filter ? "tasks/filter" : "tasks";
        const result = record(await call(path, "GET", undefined, {
          limit: input.limit, cursor: input.cursor,
          ...(projects ? {} : input.filter ? { query: input.filter, lang: input.lang } : { project_id: input.project_id, section_id: input.section_id, parent_id: input.parent_id })
        }));
        if (!Array.isArray(result.results)) throw new Error("Todoist: invalid list response; the task list could not be verified");
        return { [projects ? "projects" : "tasks"]: result.results.map(projects ? value => pick(value, ["id", "name", "is_inbox_project"]) : task), next_cursor: result.next_cursor ?? null };
      }
      const path = `tasks/${encodeURIComponent(input.task_id ?? "")}`;
      if (input.action === "get_task") return { task: task(await call(path)) };
      if (input.action === "delete_task" || input.action === "complete_task" || input.action === "reopen_task") {
        const suffix = input.action === "complete_task" ? "/close" : input.action === "reopen_task" ? "/reopen" : "";
        await call(`${path}${suffix}`, input.action === "delete_task" ? "DELETE" : "POST");
        return { status: input.action === "delete_task" ? "deleted" : input.action === "complete_task" ? "completed" : "reopened", task_id: input.task_id };
      }
      const body = pick(input, [...Object.keys(changes), ...(input.action === "create_task" ? ["project_id", "section_id", "parent_id"] : [])]);
      return { task: task(await call(input.action === "create_task" ? "tasks" : path, "POST", body)) };
    }
  }, "todoist", config, verifyProactiveRun);
}
