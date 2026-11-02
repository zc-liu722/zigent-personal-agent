import type { TaskStore } from "./store.js";
import type { TaskScope } from "./types.js";
import { parseReusableTriggerSpec } from "./reusable.js";

export const iphoneEventTriggers = [
  { event: "alarm_stopped", title: "闹钟停止" },
  { event: "charging_started", title: "开始充电" },
  { event: "notification_received", title: "收到通知" },
] as const;

/** Publish reusable device facts, without creating tasks or changing owner-edited points. */
export function configureIphoneTriggerPoints(store: TaskStore, owner: Pick<TaskScope, "agentId" | "userId" | "principalId">) {
  const scope: TaskScope = { ...owner, conversationKind: "p2p", conversationId: "web:automation" };
  const existing = store.listTriggers(scope);
  return iphoneEventTriggers.map(({ event, title }) => {
    const spec = parseReusableTriggerSpec({ source: { type: "external", source: "iphone", event }, maxAgeSeconds: 1800 });
    const prior = existing.find(point => {
      const saved = point.revisions.find(revision => revision.revision === point.activeRevision) ?? point.revisions.at(-1);
      return saved && saved.spec.source.type === "external" && saved.spec.source.source === "iphone" && saved.spec.source.event === event
        && !saved.spec.condition && !saved.spec.delaySeconds && !saved.spec.cooldownSeconds && !saved.spec.cancelOn.length;
    });
    if (prior) return prior;
    const fixtureEvent = { id: "matching", type: "external" as const, source: "iphone", event, occurredAt: 1000 };
    const point = store.stageTrigger(scope, { title, spec, fixtures: [
      { name: "匹配事件", steps: [{ at: 1000, event: fixtureEvent }], expectedFirings: 1 },
      { name: "排除其他事件", steps: [{ at: 1000, event: { ...fixtureEvent, event: "other_event" } }], expectedFirings: 0 },
      { name: "排除其他设备", steps: [{ at: 1000, event: { ...fixtureEvent, source: "other_device" } }], expectedFirings: 0 },
    ] }, `iphone-event-point:${event}:v1`);
    // A creation key can resolve to a previously edited or paused point. Never reset it.
    if (existing.some(saved => saved.id === point.id)) return point;
    const validation = store.validateTriggerRevision(scope, point.id, 1);
    if (!validation.validation?.passed) throw new Error("IPHONE_TRIGGER_VALIDATION_FAILED");
    return store.activateTriggerRevision(scope, point.id, 1);
  });
}
