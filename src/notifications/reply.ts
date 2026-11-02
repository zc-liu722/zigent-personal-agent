import type { NotificationScope, NotificationService } from "./service.js";

/** A completed turn has one durable phone notice, independent of chat delivery. */
export function enqueueReplyNotification(
  notifications: NotificationService | undefined,
  scope: NotificationScope,
  sessionId: string,
  turnId: number,
  reply: { text: string; images?: readonly unknown[]; videos?: readonly unknown[] }
): void {
  if (!notifications?.canNotify(scope)) return;
  const text = reply.text.trim() || (reply.images?.length && reply.videos?.length
    ? "已生成图片和视频，请打开对话查看。"
    : reply.images?.length ? "已生成图片，请打开对话查看。"
    : reply.videos?.length ? "已生成视频，请打开对话查看。" : "本轮回复已完成，请打开对话查看。");
  // Bound the outbox entry even for very long replies; never split a surrogate pair.
  const body = text.length <= 12000 ? text : `${text.slice(0, 11999).replace(/[\uD800-\uDBFF]$/, "")}…`;
  try {
    notifications.enqueue(scope, { idempotencyKey: `reply:${sessionId}:${turnId}`, title: "", body });
  } catch {
    // Notification storage failures must not turn a completed answer into a chat failure.
    console.warn("Unable to queue reply notification");
  }
}
