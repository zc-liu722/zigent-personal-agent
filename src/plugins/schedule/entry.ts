import { z } from "zod";
import type { PluginInstance } from "../contracts.js";
import { ScheduleReminders, scheduleReminderDue, type ScheduleDelivery } from "./reminders.js";
import { createScheduleTool } from "./tool.js";
import type { ScheduleStore, ScheduleItem } from "../../schedule/store.js";
import type { NotificationService } from "../../notifications/service.js";
import type { BackgroundScheduler } from "../../background-scheduler.js";

export type ScheduleConnection = { delivery?: ScheduleDelivery; started: boolean; paused: boolean };
export type ScheduleServices = {
  scheduleStore?: ScheduleStore;
  notifications?: NotificationService;
  scheduler: BackgroundScheduler;
  scheduleConnection: ScheduleConnection;
};
export type ScheduleCapability = {
  reminders: ScheduleReminders;
  isDue(item: ScheduleItem): boolean;
  request(method: string, input: Record<string, unknown>): { code: number; value: unknown };
};

/** No framework, database opening, notification, timer or business write during preparation. */
export async function create(services: Readonly<Record<string, unknown>>): Promise<PluginInstance> {
  const { scheduleStore: store, notifications, scheduler, scheduleConnection: connection } = services as ScheduleServices;
  const reminders = new ScheduleReminders(store!, notifications, scheduler);
  const capability: ScheduleCapability = {
    reminders,
    isDue: scheduleReminderDue,
    request(method, value) {
      if (!store) return { code: 404, value: { error: "not_found" } };
      if (method === "GET") return { code: 200, value: { items: store.list() } };
      if (method !== "POST") return { code: 405, value: { error: "method_not_allowed" } };
      if (value.action === "create") return { code: 200, value: { item: store.create(value.item) } };
      const id = String(value.id), revision = Number(value.revision);
      if (value.action === "delete") { store.delete(id, revision); return { code: 200, value: { ok: true } }; }
      const current = store.get(id);
      if (current.recurrence && (value.item as Record<string, unknown> | undefined)?.completed !== undefined) throw new Error("暂不能完成重复事项。");
      if (current.revision !== revision) throw new Error("事项已更改，请刷新后重试。");
      return { code: 200, value: { item: store.update(id, revision, value.item) } };
    }
  };
  return {
    routes: store ? { "api/schedule": { methods: ["GET", "POST"], handle(method, input) {
      try {
        const value = method === "POST" ? z.object({action:z.enum(["create","update","delete"]),id:z.string().uuid().optional(),revision:z.number().int().positive().optional(),item:z.record(z.unknown()).optional()}).strict().parse(input) : {};
        if ("action" in value && value.action !== "create" && (!(value as {id?:string}).id || !(value as {revision?:number}).revision)) throw Error("请刷新后重试。");
        return capability.request(method,value);
      } catch(error) { return {code:400,value:{error:error instanceof z.ZodError?"请检查事项内容。":error instanceof Error?error.message:"操作未完成。"}}; }
    } } } : {},
    tools: [createScheduleTool(store)],
    prompts: { schedule: "Use schedule for the built-in todos and events. Read relevant items before changing them; a due date is not a reserved event. Changes require the confirmation component." },
    services: { schedule: capability },
    async ready() {
      if (!connection || typeof scheduler?.register !== "function" || typeof connection.started !== "boolean"
        || typeof connection.paused !== "boolean" || store && typeof store.operation !== "function"
        || connection.started && !connection.delivery) throw new Error("SCHEDULE_HOST_INTERFACE_INCOMPATIBLE");
      store?.list();
      if (connection.delivery) reminders.connect(connection.delivery);
    },
    start() { reminders.pause(connection.paused); if (connection.started) reminders.start(); },
    pause() { reminders.suspend(); },
    resume() { if (connection.started) reminders.start(); reminders.pause(connection.paused); },
    activeWork: () => reminders.activeCount,
    dispose: () => reminders.close()
  };
}
