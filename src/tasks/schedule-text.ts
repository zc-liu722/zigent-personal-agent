import { locationSpeedText } from "./location-speed.js";
import type { TaskTrigger } from "./types.js";

export function taskScheduleText(trigger: TaskTrigger): string {
  if (trigger.type === "reference") return "触发点命中时";
  if (trigger.type === "external") return trigger.event === "alarm_stopped" ? "闹钟停止时" : trigger.event === "charging_started" ? "开始充电时" : trigger.event === "notification_received" ? "收到应用通知时" : "收到设备事件时";
  if (trigger.type === "time") {
    if (trigger.schedule === "once") return new Date(trigger.at).toLocaleString("zh-CN", { timeZone: trigger.timezone ?? "Asia/Shanghai", hour12: false });
    const days = ["日", "一", "二", "三", "四", "五", "六"];
    const timezone = trigger.timezone && trigger.timezone !== "Asia/Shanghai" ? `（${trigger.timezone}）` : "";
    return `${trigger.schedule === "daily" ? "每天" : `每周${[1, 2, 3, 4, 5, 6, 0].filter(day => trigger.weekdays?.includes(day)).map(day => days[day]).join("、")}`}${trigger.time}${timezone}`;
  }
  if (trigger.type === "health_change") return `健康数据更新后${trigger.afterTime ? `，每天 ${trigger.afterTime} 之后` : ""}`;
  return `${trigger.event === "enter" ? "到达" : "离开"}${trigger.regionName ? `「${trigger.regionName}」` : "所选地点"}时${locationSpeedText(trigger) ? `，${locationSpeedText(trigger)}` : ""}`;
}
