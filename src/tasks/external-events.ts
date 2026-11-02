import { z } from "zod";

export { DEVICE_CLOCK_SKEW_MS as EXTERNAL_EVENT_CLOCK_SKEW_MS } from "../time-policy.js";

export const externalName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** The device reports facts only. Owner, source provenance, routing and task instructions are server-owned. */
export const externalEventSchema = z.object({ eventId: z.string().uuid().transform(value => value.toLowerCase()), event: externalName,
  occurredAt: z.string().datetime({ offset: true }), location: z.object({ latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180), system: z.literal("WGS84"), observedAt: z.string().datetime({ offset: true }) }).strict().optional(),
  notification: z.object({ appId: z.string().trim().min(1).max(200).optional(), appName: z.string().trim().max(200).optional(),
    title: z.string().max(2000).optional(), subtitle: z.string().max(2000).optional(), body: z.string().max(16000).optional() }).strict()
    .refine(value => Boolean(value.appId || value.appName), "An app identifier or name is required").optional() }).strict()
  .refine(value => value.event !== "notification_received" || Boolean(value.notification), "Notification events require notification details");

export function externalEventDescription(event: string, source: string): string {
  const device = source === "iphone" ? "iPhone" : "设备";
  if (event === "alarm_stopped") return `${device} 通知：闹钟已停止。`;
  if (event === "charging_started") return `${device} 通知：已开始充电。`;
  if (event === "notification_received") return `${device} 通知：收到应用通知。`;
  return `${device}通知：收到 ${event} 事件。`;
}
