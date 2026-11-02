import { z } from "zod";

const httpsUrl = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "Notification URLs must use HTTPS without credentials, query or fragment");

export const notificationSettingsSchema = z.object({
  bark: z.object({
    serverUrl: httpsUrl.default("https://api.day.app"),
    level: z.enum(["passive", "active", "timeSensitive", "critical"]).default("active"),
    sound: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
    detailUrl: httpsUrl.optional()
  }).default({})
});
export type NotificationConfig = z.infer<typeof notificationSettingsSchema>["bark"] & {
  deviceKey: string;
  ownerUserId: string;
};

/** Secrets and recipient identities are operator-owned, never model arguments. */
export function loadNotificationConfig(prefix: string, environment: Record<string, string | undefined>,
  settings?: z.infer<typeof notificationSettingsSchema>, defaultDetailUrl?: string, defaultOwnerUserId?: string): NotificationConfig | undefined {
  const deviceKey = environment[`${prefix}_BARK_DEVICE_KEY`]?.trim();
  const explicitOwner = environment[`${prefix}_NOTIFICATION_OWNER_USER_ID`]?.trim();
  if (!deviceKey && !explicitOwner) return undefined;
  const ownerUserId = explicitOwner || defaultOwnerUserId;
  if (defaultOwnerUserId && explicitOwner && explicitOwner !== defaultOwnerUserId) throw new Error("Notification recipient must match the web account");
  if (!deviceKey || !ownerUserId) throw new Error(`Both ${prefix}_BARK_DEVICE_KEY and ${prefix}_NOTIFICATION_OWNER_USER_ID are required`);
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(deviceKey) || ownerUserId.length > 256) throw new Error("Invalid notification binding");
  const bark = settings?.bark ?? notificationSettingsSchema.parse({}).bark;
  return { ...bark, deviceKey, ownerUserId, detailUrl: bark.detailUrl ?? defaultDetailUrl };
}
