import { z } from "zod";
import type { AgentToolRegistration } from "./registry.js";
import { scheduleFields, type ScheduleStore } from "../schedule/store.js";
import { scheduleInstant } from "../schedule/temporal.js";
import { productivityActivity } from "./productivity-activity.js";

const actions = ["list", "get", "create", "update", "complete", "reopen", "delete"] as const;
const input = z.object({ action: z.enum(actions), id: z.string().uuid().optional(), revision: z.number().int().positive().optional(),
  item: z.record(z.unknown()).optional(), kind: z.enum(["todo", "event"]).optional(), query: z.string().max(500).optional(),
  from: z.string().optional(), to: z.string().optional(), include_completed: z.boolean().optional() }).strict();
export function createScheduleTool(store?: ScheduleStore): AgentToolRegistration {
  const parse = (value: unknown) => {
    const parsed = input.parse(value);
    if (["get", "update", "complete", "reopen", "delete"].includes(parsed.action) && !parsed.id) throw new Error("请先读取事项并指定 ID。");
    if (["update", "complete", "reopen", "delete"].includes(parsed.action) && !parsed.revision) throw new Error("请指定读取到的事项修订号。");
    if (parsed.action === "create") scheduleFields.parse(parsed.item);
    if (parsed.action === "update" && (!parsed.item || !Object.keys(parsed.item).length)) throw new Error("请指定修改内容。");
    if (parsed.action === "update" && parsed.item?.recurrence) throw new Error("暂不支持重复事项。");
    return parsed;
  };
  return {
    available: Boolean(store), executionMode: "sequential",
    definition: { type: "function", name: "schedule", description: "管理内置日程和待办。list 查看事项，get 查看详情；create、update、complete、reopen、delete 通过网页组件确认后执行。先读取目标和 revision，保留未要求修改的字段。kind=todo 是待办，due 为截止日期或带偏移的时间；kind=event 是日程，start/end 为全天日期或带偏移的时间，全天结束日期不包含当天。需预留时间时创建日程，截止日期不会自动创建日程。日期使用 YYYY-MM-DD，具体时间使用带偏移的 RFC3339；list 的 from/to 为半开区间，日期形式按北京时间零点解释。只支持单次事项。对有具体开始时间的日程可设置 reminderMinutes（提前分钟数，0 表示开始时提醒，null 表示不提醒）；提醒通过已配置的通知渠道发送。修改或删除日程时提醒随之更新。仅在用户要求时创建或修改。", input_schema: { type: "object", properties: {
      action: { type: "string", enum: [...actions] }, id: { type: "string" }, revision: { type: "integer" }, kind: { type: "string", enum: ["todo", "event"] }, query: { type: "string" }, from: { type: "string" }, to: { type: "string" }, include_completed: { type: "boolean" },
      item: { type: "object", description: "事项字段：kind、title、description、start、end、due、timezone、location、priority（1 普通至 4 紧急）、labels、project、parentId、completed、reminderMinutes（0–10080，null 表示无提醒）。", additionalProperties: true }
    }, required: ["action"], additionalProperties: false } },
    activity: productivityActivity("日程", { list: "查看日程与待办", get: "查看事项", create: "新建事项", update: "修改事项", complete: "完成待办", reopen: "重新打开待办", delete: "删除事项" }),
    async prepare(value, context) {
      const args = parse(value);
      if (!store || context.agentId !== store.agentId || context.userId !== store.ownerId || context.conversationKind !== "p2p") throw new Error("日程只对账户本人开放。");
      if (args.item?.reminderMinutes !== undefined && args.item.reminderMinutes !== null && !store.canRemind()) throw new Error("提醒服务尚未配置。");
      if (["update", "complete", "reopen", "delete"].includes(args.action)) {
        const current = store.get(args.id!);
        if (current.revision !== args.revision) throw new Error("事项已更改，请重新查看后操作。");
        if ((args.action === "complete" || args.action === "reopen") && current.kind !== "todo") throw new Error("只有待办可以完成。");
        if (args.action === "update") {
          const { id: _id, revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = current;
          const next = scheduleFields.parse({ ...fields, ...args.item });
          if (next.kind !== current.kind) throw new Error("不能更改事项类型。");
        }
      }
      return { input: value, context };
    },
    async execute(value, context) {
      const args = parse(value);
      if (!store || context.agentId !== store.agentId || context.userId !== store.ownerId || context.conversationKind !== "p2p") throw new Error("日程只对账户本人开放。");
      if (args.action === "list") {
        const bounds = (value: string | undefined) => {
          if (!value) return undefined;
          const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00+08:00` : value);
          if (!Number.isFinite(parsed) || (value.length !== 10 && !/(Z|[+-]\d{2}:\d{2})$/.test(value))) throw new Error("日期范围必须是日期或带时区偏移的时间。");
          return parsed;
        };
        const from = bounds(args.from), to = bounds(args.to);
        if (from !== undefined && to !== undefined && from >= to) throw new Error("结束日期必须晚于开始日期。");
        return { items: store.list().filter(item => {
          if (args.kind && item.kind !== args.kind || !args.include_completed && item.completed || args.query && !`${item.title}\n${item.description}`.toLowerCase().includes(args.query.toLowerCase())) return false;
          if (item.kind === "todo") return !item.due || (from === undefined || scheduleInstant(item.due, item.timezone) >= from) && (to === undefined || scheduleInstant(item.due, item.timezone) < to);
          return (from === undefined || scheduleInstant(item.end!, item.timezone) > from) && (to === undefined || scheduleInstant(item.start!, item.timezone) < to);
        }) };
      }
      if (args.action === "get") return { item: store.get(args.id!) };
      if (context.taskRunId || context.backgroundTaskKind) throw new Error("后台任务只能读取日程。");
      if (args.action === "create") return { item: store.create(args.item) };
      if (args.action === "delete") { store.delete(args.id!, args.revision!); return { status: "deleted" }; }
      if (args.action === "complete" || args.action === "reopen") {
        const current = store.get(args.id!); if (current.kind !== "todo") throw new Error("只有待办可以完成。");
        if (current.recurrence) throw new Error("暂不能完成重复事项。");
        return { item: store.update(args.id!, args.revision!, { completed: args.action === "complete" }) };
      }
      return { item: store.update(args.id!, args.revision!, args.item) };
    }
  };
}
