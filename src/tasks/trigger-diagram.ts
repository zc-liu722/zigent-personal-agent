import type { TaskTrigger } from "./types.js";
import { locationSpeedText } from "./location-speed.js";
import type { ReusableTriggerSpec, TriggerCondition } from "./reusable.js";
import { taskScheduleText } from "./schedule-text.js";
import { triggerVisual, type TriggerVisual } from "./trigger-visual.js";

export type DiagramNode = {
  kind: "event" | "condition" | "delay" | "action" | "stop";
  label: string;
  detail?: string;
  operator?: "all" | "any" | "not";
  conditions?: DiagramNode[];
  cancelOn?: DiagramNode[];
};
export type TriggerDiagram = { version: 1; steps: DiagramNode[]; visual?: TriggerVisual };
type Names = { taskTitle?: (id: string) => string | undefined };
const duration = (seconds: number) => seconds > 0 && seconds % 3600 === 0 ? `${seconds / 3600} 小时` : seconds > 0 && seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
const zone = (timezone = "Asia/Shanghai") => timezone === "Asia/Shanghai" ? "" : timezone;
const eventName = (event: string) => event === "alarm_stopped" ? "闹钟停止" : event === "charging_started" ? "开始充电" : event === "notification_received" ? "收到通知" : event;
const sourceName = (source?: string) => source === "iphone" ? "iPhone" : source || "设备";
const condition = (label: string, detail?: string): DiagramNode => ({ kind: "condition", label, ...(detail ? { detail } : {}) });
const cooldown = (seconds: number) => condition("冷却已结束", `距上次触发 ≥ ${duration(seconds)}`);

/** A display-only projection: never serialize executable specs, coordinates, identities or fixtures. */
function sourceNode(source: Exclude<TaskTrigger, { type: "reference" }>): DiagramNode {
  if (source.type === "external") return { kind: "event", label: `${sourceName(source.source)} · ${eventName(source.event)}` };
  if (source.type === "location") return { kind: "event", label: `${source.event === "enter" ? "到达" : "离开"}${source.regionName || "所选地点"}`,
    ...(source.radiusMeters ? { detail: `围栏半径 ${source.radiusMeters} 米` } : {}) };
  if (source.type === "health_change") return { kind: "event", label: "健康数据更新" };
  return { kind: "event", label: "时间到达", detail: [taskScheduleText(source), source.schedule === "once" ? zone(source.timezone) : ""].filter(Boolean).join(" · ") };
}
function expression(value: TriggerCondition, names: Names): DiagramNode {
  if (value.type === "all" || value.type === "any") return { kind: "condition", label: value.type === "all" ? "全部满足" : "任一满足",
    operator: value.type, conditions: value.conditions.map(child => expression(child, names)) };
  if (value.type === "not") return { kind: "condition", label: "取反", operator: "not", conditions: [expression(value.condition, names)] };
  if (value.type === "recent_event") return condition(`${duration(value.withinSeconds)}内收到`, `${sourceName(value.source)} · ${eventName(value.event)}`);
  if (value.type === "task_delivered") return condition(`${names.taskTitle?.(value.taskId) || "前置任务"}已送达`, `最近 ${duration(value.withinSeconds)}`);
  const days = value.weekdays?.map(day => ["日", "一", "二", "三", "四", "五", "六"][day]).join("、");
  const hours = value.after && value.before ? value.after > value.before ? `时间 ≥ ${value.after} 或 < ${value.before}` : `${value.after} ≤ 时间 < ${value.before}`
    : value.after ? `时间 ≥ ${value.after}` : value.before ? `时间 < ${value.before}` : "全天";
  return condition("时间范围", [days ? `周${days}` : "", hours, zone(value.timezone)].filter(Boolean).join(" · "));
}

export function taskTriggerDiagram(trigger: TaskTrigger): TriggerDiagram {
  if (trigger.type === "reference") return { version: 1, steps: [{ kind: "stop", label: "触发点未启用" }] };
  const steps: DiagramNode[] = [sourceNode(trigger)];
  if (trigger.type === "time") steps.push(condition("补跑仍有效", `迟到 ≤ ${duration(trigger.maxLatenessSeconds ?? 3600)}`));
  if (trigger.type === "location" && locationSpeedText(trigger)) steps.push(condition(locationSpeedText(trigger)!));
  if (trigger.type === "external" || trigger.type === "location") {
    steps.push(condition("事件仍有效", `事件距今 ≤ ${duration(trigger.maxAgeSeconds ?? 600)}`));
    const seconds = trigger.cooldownSeconds ?? (trigger.type === "location" ? 300 : 0);
    if (seconds) steps.push(cooldown(seconds));
    if (trigger.type === "location" && trigger.repeat === false) steps.push(condition("本版本尚未触发"));
  }
  if (trigger.type === "health_change") {
    if (trigger.metrics?.length) steps.push(condition("匹配健康指标", trigger.metrics.map(metric => ({ heart_rate_variability: "HRV", sleep_analysis: "睡眠", heart_rate: "心率" })[metric] || metric).join("、")));
    if (trigger.afterTime) steps.push(condition(`当天 ${trigger.afterTime} 后收到`, zone(trigger.timezone)));
    if (trigger.afterTime || trigger.oncePerDay) steps.push(condition("执行时仍在当天窗口"));
    if (trigger.condition === "hrv_realtime_v2") steps.push(condition("睡眠门控放行", "无复盘任务、04:00前或当日全部复盘已送达"));
    if (trigger.condition) steps.push(condition("HRV 异常规则命中", trigger.condition === "hrv_realtime_v2" ? "实时规则 v2" : "异常规则 v1"));
    if (trigger.condition === "hrv_realtime_v2") steps.push(condition("排除重复异常", "90 分钟内同类异常去重；加重可再通知"));
    steps.push({ kind: "delay", label: "合并数据更新", detail: `${duration(trigger.debounceSeconds ?? 30)}防抖` });
    if (trigger.oncePerDay) steps.push(condition("当天尚未通知", "待发送时继续等待"));
  }
  steps.push({ kind: "action", label: "执行任务提示词" });
  return { version: 1, steps, visual: triggerVisual(trigger) };
}

export function reusableTriggerDiagram(spec: ReusableTriggerSpec, names: Names = {}, action = "触发订阅任务"): TriggerDiagram {
  const steps: DiagramNode[] = [sourceNode(spec.source), condition("事件仍有效", `事件距今 ≤ ${duration(spec.maxAgeSeconds)}`)];
  if (spec.source.type === "time") steps.push(condition("补跑仍有效", `迟到 ≤ ${duration(spec.source.maxLatenessSeconds ?? 3600)}`));
  if (spec.source.type === "location" && locationSpeedText(spec.source)) steps.push(condition(locationSpeedText(spec.source)!));
  if (spec.condition) steps.push(expression(spec.condition, names));
  if (spec.cooldownSeconds) steps.push(cooldown(spec.cooldownSeconds));
  if (spec.delaySeconds) {
    steps.push({ kind: "delay", label: `等待 ${duration(spec.delaySeconds)}`,
      ...(spec.cancelOn.length ? { cancelOn: spec.cancelOn.map(sourceNode) } : {}) });
    steps.push(condition("定时器仍有效", `超时 ≤ ${duration(spec.maxAgeSeconds)}`));
    if (spec.condition) steps.push(expression(spec.condition, names));
    if (spec.cooldownSeconds) steps.push(cooldown(spec.cooldownSeconds));
  }
  steps.push({ kind: "action", label: action });
  const visual = triggerVisual(spec.source);
  // Shared rules own their cooldown; the source has none of the standalone defaults.
  if (visual && "cooldownSeconds" in visual) visual.cooldownSeconds = spec.cooldownSeconds;
  return { version: 1, steps, visual };
}
