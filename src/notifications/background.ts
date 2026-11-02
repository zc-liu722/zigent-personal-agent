import type { CommunicationAdapter } from "../channels/communication.js";
import type { NotificationService } from "./service.js";

/** Keep chat delivery and phone delivery independent, with their own durable identities. */
export function withBackgroundNotifications<T extends CommunicationAdapter>(adapter: T,
  notifications?: NotificationService): T {
  if (!notifications || !adapter.sendBackgroundResult) return adapter;
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "sendBackgroundResult") return async (notice: Parameters<NonNullable<CommunicationAdapter["sendBackgroundResult"]>>[0]) => {
        const receipt = await target.sendBackgroundResult!(notice);
        const scope = { agentId: notice.agentId ?? "", userId: notice.userId ?? "", conversationKind: notice.conversationKind };
        if (notifications.canNotify(scope)) notifications.enqueue(scope, {
          idempotencyKey: `background:${notice.idempotencyKey}`, title: notice.title, body: notice.text
        });
        return receipt;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
