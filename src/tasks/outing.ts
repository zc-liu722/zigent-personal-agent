import { z } from "zod";
import type { UserLocationAccess } from "../location/service.js";
import type { ActiveTask, ExternalTaskEvent, TaskScope } from "./types.js";
import type { TaskStore } from "./store.js";
import { deviceTimeIsUsable } from "../time-policy.js";

export const outingTask = {
  title: "出行准备",
  deliveryPolicy: "conditional" as const,
  trigger: { type: "external" as const, source: "iphone", event: "alarm_stopped", cooldownSeconds: 1800, maxAgeSeconds: 1800,
    preparation: "outing_weather" as const },
  instruction: [
    "用户在 iPhone 停止起床闹钟后，检查今天出行需要准备什么。停止闹钟只是触发信号，不证明马上出门。",
    "先依据程序附带的 outingWeather 逐小时预报，覆盖从现在到当天晚间的体感温度、降雨概率/量、风和紫外线；注意早晚温差及昨日同时段体感差异。数值为 null 表示未知，不能当成 0 或正常。预报不是实测。",
    "按需只读当天日程和待办，帮助判断户外活动、晚归或异地出行；没有访问权限就说明背景未知，不开启授权，不把日程空白当作不出门。异地活动不能拿当前位置预报冒充目的地天气，确有必要再查询可靠来源。",
    "模型综合证据决定是否提醒，不使用固定阈值替代判断。只提醒当天值得准备的衣服或随身用品，例如添减衣物、挡风外套、雨伞/雨具、防晒用品、帽子、太阳镜或饮水；不要机械列全套物品。",
    "有可执行的准备建议才 notify=true，将原因和建议合成一条简短自然的中文消息，通常两三句；无特别事项 notify=false。不要发送例行天气报告、追问式问卷或声称知道用户今天穿了什么。",
    "参考已确认的个人习惯和体感反馈；一次穿少了不等于长期怕冷，不自行写入稳定偏好。定位或关键天气缺失时明确限制，只在需要用户处理时提醒，绝不把查询失败视为无需准备。",
    "不创建其他提醒、不修改日历或待办、不发送额外消息。提醒由系统在本任务原私聊和已配置的手机通知交付。"
  ].join("\n")
};

/** Only the explicitly provisioned task is changed; preserve an existing pause. */
export function configureOutingTask(store: TaskStore, scope: TaskScope): ActiveTask {
  const matches = store.list(scope).filter(task => task.title === outingTask.title || task.title === "起床后出行准备");
  if (matches.length > 1 || matches.some(task => task.status === "cancelled" || task.conversationId !== scope.conversationId
    || task.principalId !== scope.principalId || task.skill)) throw new Error("OUTING_TASK_BINDING_AMBIGUOUS");
  const task = matches[0];
  return task ? store.update(scope, task.id, outingTask) : store.create(scope, outingTask, Date.now(), "outing-weather:v1");
}

type Point = { latitude: number; longitude: number; observedAt: string; source: "shortcut" | "bound_location" };
export function outingLocation(task: ActiveTask, event: ExternalTaskEvent, location: UserLocationAccess | undefined, now = Date.now()): Point | undefined {
  const fresh = (at: number) => deviceTimeIsUsable(at, now, 1800000);
  const supplied = event.location;
  if (supplied?.system === "WGS84" && Number.isFinite(supplied.latitude) && Math.abs(supplied.latitude) <= 90
    && Number.isFinite(supplied.longitude) && Math.abs(supplied.longitude) <= 180 && fresh(Date.parse(supplied.observedAt)))
    return { latitude: supplied.latitude, longitude: supplied.longitude, observedAt: supplied.observedAt, source: "shortcut" };
  if (!location?.store.isOwner(task.principalId ?? task.userId, [task.userId])) return undefined;
  const point = location.store.latest();
  if (!point || !fresh(point.observedAt) || point.accuracyMeters !== undefined && point.accuracyMeters > 10000) return undefined;
  return { latitude: point.wgs84Latitude, longitude: point.wgs84Longitude, observedAt: new Date(point.observedAt).toISOString(), source: "bound_location" };
}

const fields = ["temperature_2m", "apparent_temperature", "precipitation_probability", "precipitation", "wind_speed_10m", "wind_gusts_10m", "uv_index"] as const;
const values = z.array(z.number().finite().nullable()).min(24).max(100);
const forecastSchema = z.object({ timezone: z.string().min(1), utc_offset_seconds: z.number().int().min(-43200).max(50400),
  hourly: z.object({ time: z.array(z.number().int()).min(24).max(100), temperature_2m: values, apparent_temperature: values,
    precipitation_probability: values, precipitation: values, wind_speed_10m: values, wind_gusts_10m: values, uv_index: values }) });

/** Bounded, structured evidence from a fixed supplier endpoint. Never accept a URL from an event. */
export async function fetchOutingForecast(point: Point, signal: AbortSignal, request: typeof fetch = fetch, now = Date.now()) {
  try {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({ latitude: String(point.latitude), longitude: String(point.longitude), hourly: fields.join(","),
      timezone: "auto", timeformat: "unixtime", wind_speed_unit: "kmh", forecast_days: "2", past_days: "1" }).toString();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const response = await request(url, { signal: bounded, redirect: "error" });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 128000) throw new Error();
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 128000) throw new Error(); chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const forecast = forecastSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const h = forecast.hourly;
    if (fields.some(field => h[field].length !== h.time.length) || h.time.some((time, i) => i > 0 && time - h.time[i - 1]! !== 3600)) throw new Error();
    const localDay = (time: number) => new Date(time * 1000 + forecast.utc_offset_seconds * 1000).toISOString().slice(0, 10);
    const today = localDay(now / 1000), firstHour = h.time.filter(at => at <= now / 1000).at(-1) ?? now / 1000;
    const indices = h.time.flatMap((at, i) => at >= firstHour && localDay(at) === today ? [i] : []);
    if (!indices.length || h.time[indices[0]!]! > now / 1000 + 3600
      || new Date(h.time[indices.at(-1)!]! * 1000 + forecast.utc_offset_seconds * 1000).getUTCHours() !== 23
      || indices.every(i => h.apparent_temperature[i] === null) || indices.every(i => h.precipitation_probability[i] === null)) throw new Error();
    const prior = h.time.indexOf(h.time[indices[0]!]! - 86400);
    return { status: "available" as const, source: "Open-Meteo", sourceUrl: "https://open-meteo.com/", fetchedAt: new Date(now).toISOString(),
      timezone: forecast.timezone, location: point, units: { temperature: "°C", wind: "km/h", precipitation: "mm", precipitation_probability: "%", uv_index: "index" },
      yesterdaySameHourApparentTemperature: prior >= 0 ? h.apparent_temperature[prior] : null,
      hours: indices.map(i => ({ at: new Date(h.time[i]! * 1000).toISOString(), ...Object.fromEntries(fields.map(field => [field, h[field][i]])) })) };
  } catch {
    signal.throwIfAborted();
    // Keep coordinates, raw provider responses and private request URLs out of errors/logs.
    throw new Error("OUTING_WEATHER_UNAVAILABLE");
  }
}
