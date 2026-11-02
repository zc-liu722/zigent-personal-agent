import { z } from "zod";
import type { AgentRuntime } from "../runtime.js";
import type { WebStore } from "./store.js";
import type { TaskTrigger } from "../tasks/types.js";
import { validateTrigger, nextOccurrence, localTaskTime } from "../tasks/schedule.js";
import { scheduleInstant } from "../schedule/temporal.js";
import { GoogleCalendarClient } from "../productivity/google-calendar.js";
import { ProductivityAuthorizationRequiredError } from "../productivity/credentials.js";
import { productivityFetch } from "../productivity/http.js";
import { wgs84ToGcj02 } from "../location/coordinates.js";
import { TriggerBasemapClient } from "./trigger-basemap.js";
import { triggerCalendar } from "./trigger-calendar.js";
import { deviceTimeIsUsable } from "../time-policy.js";

const zone = z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const time = z.union([
  z.object({ type: z.literal("time"), schedule: z.literal("once"), at: z.string().datetime({ offset: true }), timezone: zone }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("once"), date: z.string().date(), time: clock, timezone: zone }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("daily"), time: clock, timezone: zone }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("weekly"), time: clock, timezone: zone, weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7) }).strict()
]);
const location = z.object({ type: z.literal("location"), mode: z.enum(["region", "current", "coordinates"]),
  region: z.string().trim().min(1).max(200).optional(), latitude: z.number().min(-84).max(84).optional(), longitude: z.number().min(-179).max(179).optional(),
  radiusMeters: z.number().min(100).max(50000).optional() }).strict().superRefine((value, context) => {
    if (value.mode === "region" ? !value.region : !value.radiusMeters || value.mode === "coordinates" && (value.latitude === undefined || value.longitude === undefined)) context.addIssue({ code: "custom", message: "Select a location" });
  });
export const triggerContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("point"), id: z.string().uuid(), revision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("interaction"), conversationId: z.string().regex(/^[a-f0-9]{64}$/), messageId: z.string().min(1).max(200), id: z.string().uuid(),
    index: z.number().int().min(0).max(10), side: z.enum(["before", "after"]) }).strict(),
  z.object({ kind: z.literal("preview"), trigger: z.union([time, location]) }).strict()
]);
export type TriggerContextInput = z.infer<typeof triggerContextSchema>;
export type TriggerContextNetwork = { mapRequest?: typeof fetch; calendarRequest?: typeof fetch };
export class TriggerContextError extends Error { constructor(readonly code: number, message: string) { super(message); } }

export class WebTriggerContext {
  private readonly maps: TriggerBasemapClient;
  private readonly calendar?: GoogleCalendarClient;
  private calendarPending = 0;
  constructor(private readonly store: WebStore, private readonly runtime: AgentRuntime, network: TriggerContextNetwork = {},
    private readonly interactionTrigger?: (input: Extract<TriggerContextInput, { kind: "interaction" }>) => TaskTrigger | undefined) {
    // Public map tiles work directly in China; keep the model proxy as a bounded
    // fallback so either network route can fail without losing the map.
    this.maps = new TriggerBasemapClient(network.mapRequest ?? productivityFetch(),
      !network.mapRequest && runtime.config.zenmuxProxyUrl ? productivityFetch(runtime.config.zenmuxProxyUrl) : undefined);
    const config = runtime.config.toolSettings?.google_calendar;
    if (config) this.calendar = new GoogleCalendarClient(config, network.calendarRequest ?? productivityFetch(config.proxyUrl));
  }
  capabilities() {
    const scope = this.scope(), config = this.runtime.config.toolSettings?.google_calendar;
    return { location: Boolean(this.runtime.location?.store.isOwner(scope.principalId ?? scope.userId, [scope.userId])),
      calendar: Boolean(this.runtime.schedule || this.runtime.config.allowedTools?.includes("google_calendar") && config?.agentId === scope.agentId && config.ownerUserId === scope.userId) };
  }
  private scope() { return { agentId: this.runtime.config.id, userId: this.store.owner, principalId: this.runtime.config.web!.ownerPrincipalId, conversationId: "web:automation", conversationKind: "p2p" as const }; }
  private locationStore() {
    const scope = this.scope(), store = this.runtime.location?.store;
    if (!store?.isOwner(scope.principalId ?? scope.userId, [scope.userId])) throw new TriggerContextError(403, "请先接入定位。");
    return store;
  }
  private resolve(input: TriggerContextInput): TaskTrigger {
    const scope = this.scope(), tasks = this.runtime.proactiveTasks;
    if (input.kind === "interaction") {
      const trigger = this.interactionTrigger?.(input);
      if (!trigger) throw new TriggerContextError(404, "确认内容不存在，请刷新后重试。");
      if (trigger.type !== "reference") return trigger;
      const point = tasks?.getTrigger(scope, trigger.triggerId), revision = point?.revisions.find(revision => revision.revision === point.activeRevision);
      if (!revision) throw new TriggerContextError(404, "触发点未启用。");
      return revision.spec.source;
    }
    if (input.kind === "preview") {
      const value = input.trigger;
      if (value.type === "time") {
        if (value.schedule === "once" && "date" in value) {
          let after = Date.parse(`${value.date}T00:00:00Z`) - 15 * 3600000 - 1;
          for (let i = 0; i < 3; i++) {
            const at = nextOccurrence({ type: "time", schedule: "daily", time: value.time, timezone: value.timezone }, after)!;
            if (localTaskTime(at, value.timezone).day === value.date) return { type: "time", schedule: "once", at: new Date(at).toISOString(), timezone: value.timezone };
            after = at;
          }
          throw new TriggerContextError(400, "该日期没有这个本地时刻，请调整时间。");
        }
        return validateTrigger(value);
      }
      const store = this.locationStore();
      if (value.mode === "region") return { type: "location", event: "enter", regionName: value.region };
      const latest = value.mode === "current" ? store.latest() : undefined;
      if (value.mode === "current" && (!latest || !deviceTimeIsUsable(latest.observedAt, Date.now(), 600000)))
        throw new TriggerContextError(409, "请先更新当前位置。");
      const center = latest ? wgs84ToGcj02(latest.wgs84Latitude, latest.wgs84Longitude) : { latitude: value.latitude!, longitude: value.longitude! };
      return { type: "location", event: "enter", center: { system: "GCJ-02", ...center }, radiusMeters: value.radiusMeters };
    }
    if (!tasks) throw new TriggerContextError(404, "触发条件不存在。");
    if (input.kind === "point") {
      const point = tasks.getTrigger(scope, input.id), revision = point?.revisions.find(revision => revision.revision === input.revision);
      if (!revision) throw new TriggerContextError(404, "触发条件不存在。");
      return revision.spec.source;
    }
    const task = tasks.get(input.id);
    if (!task || task.userId !== scope.userId || task.principalId && task.principalId !== scope.principalId) throw new TriggerContextError(404, "任务不存在。");
    if (task.revision !== input.revision) throw new TriggerContextError(409, "任务已变化，请刷新后重试。");
    if (task.trigger.type !== "reference") return task.trigger;
    const point = tasks.getTrigger(scope, task.trigger.triggerId), revision = point?.revisions.find(revision => revision.revision === point.activeRevision);
    if (!revision) throw new TriggerContextError(404, "触发点未启用。");
    return revision.spec.source;
  }
  async load(input: TriggerContextInput) {
    const trigger = this.resolve(input);
    const check = () => {
      if (input.kind !== "preview" && JSON.stringify(this.resolve(input)) !== JSON.stringify(trigger)) throw new TriggerContextError(409, "触发条件已变化，请刷新后重试。");
    };
    if (trigger.type === "location") {
      const store = this.locationStore();
      let center = trigger.center, radius = trigger.radiusMeters, place = trigger.regionName;
      if (!center) {
        const regions = store.knownRegions(500).regions.filter(region => trigger.regionId ? region.regionId === trigger.regionId
          : trigger.regionName ? region.description === trigger.regionName : false);
        if (regions.length !== 1) throw new TriggerContextError(409, "请核对已同步的地点。");
        center = regions[0]!.center; radius = regions[0]!.radiusMeters; place ||= regions[0]!.description;
      }
      if (!center || !radius || radius <= 0) throw new TriggerContextError(409, "请同步地点坐标和半径。");
      let map;
      try { map = await this.maps.load(center, radius); }
      catch { throw new TriggerContextError(503, "地图暂不可用，请重试。"); }
      this.locationStore(); check();
      return { type: "location" as const, map, ...(place ? { place } : {}) };
    }
    if (trigger.type === "time") {
      const config = this.runtime.config.toolSettings?.google_calendar, scope = this.scope();
      if (this.runtime.schedule) {
        const at = trigger.schedule === "once" ? Date.parse(trigger.at) : nextOccurrence(trigger, Date.now() - 1)!;
        const timezone = trigger.timezone ?? "Asia/Shanghai", day = localTaskTime(at, timezone).day, from = at - 90 * 60000, to = at + 90 * 60000;
        const events = this.runtime.schedule.list().filter(item => item.kind === "event" && item.start && item.end).flatMap(item => {
          const allDay = item.start!.length === 10;
          const start = scheduleInstant(item.start!, item.timezone), end = scheduleInstant(item.end!, item.timezone);
          return start < to && end > from ? [{ title: item.title, start: allDay ? Math.max(start, from) : start, end: allDay ? Math.min(end, to) : end, allDay }] : [];
        }).sort((a, b) => a.start - b.start);
        check();
        return { type: "time" as const, status: "ready" as const, calendar: { at, from, to, day, timezone, events: events.slice(0, 200), truncated: events.length > 200 } };
      }
      if (!this.runtime.config.allowedTools?.includes("google_calendar") || !config?.ownerUserId || config.agentId !== scope.agentId || config.ownerUserId !== scope.userId)
        throw new TriggerContextError(403, "日程暂不可用。");
      if (this.calendarPending >= 2) throw new TriggerContextError(429, "日程正在加载，请稍后重试。");
      this.calendarPending++;
      try {
        if (!this.calendar || !await this.calendar.configured()) return { type: "time" as const, status: "connect" as const };
        const calendar = await triggerCalendar(trigger, this.calendar); check();
        // Recheck the grant on every read, including after a network request.
        if (!await this.calendar.configured()) return { type: "time" as const, status: "connect" as const };
        return { type: "time" as const, status: "ready" as const, calendar };
      } catch (error) {
        if (error instanceof ProductivityAuthorizationRequiredError) return { type: "time" as const, status: "connect" as const };
        if (error instanceof TriggerContextError) throw error;
        throw new TriggerContextError(503, "日程暂不可用，请重试。");
      } finally { this.calendarPending--; }
    }
    throw new TriggerContextError(400, "该触发器没有地图或日程。");
  }
}
