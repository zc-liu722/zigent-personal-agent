import type { TaskStore } from "./store.js";
import type { TaskScope } from "./types.js";
import { parseReusableTriggerSpec, type TriggerFixture } from "./reusable.js";

const windowPattern = /23:00\s*[–—\-~～至]\s*03:00/;

/** Remove only the known fallback scheduling clauses; keep health lookback and all reminder wording. */
export function removeWatchScheduling(instruction: string): string {
  const paragraphs = instruction.trim().split(/\n\s*\n/);
  if (!/^先看手机插电时的北京时间。/.test(paragraphs[0] ?? "") || !windowPattern.test(paragraphs[0] ?? "")
    || !/^落在 23:00–03:00 之间时，/.test(paragraphs[1] ?? "")) throw new Error("WATCH_INSTRUCTION_CHANGED");
  paragraphs.shift();
  paragraphs[0] = paragraphs[0]!.replace(/^落在 23:00–03:00 之间时，/, "");
  const cooldown = paragraphs.findIndex(paragraph => paragraph.startsWith("十分钟内反复插拔只判断一次；"));
  if (cooldown < 0) throw new Error("WATCH_INSTRUCTION_CHANGED");
  paragraphs.splice(cooldown, 1);
  const result = paragraphs.join("\n\n");
  if (/23:00|03:00|十分钟内反复插拔/.test(result)) throw new Error("WATCH_INSTRUCTION_CHANGED");
  return result;
}

/** Explicitly requested migration of the existing reminder, never create or revive a task. */
export function gateWatchReminder(store: TaskStore, scope: TaskScope) {
  const matches = store.list(scope).filter(task => task.principalId === scope.principalId && task.title === "戴表" && task.status !== "cancelled");
  if (matches.length !== 1) throw new Error("WATCH_TASK_AMBIGUOUS");
  const task = matches[0]!;
  if (task.skill !== "health" || task.deliveryPolicy !== "conditional") throw new Error("WATCH_TASK_CHANGED");
  const spec = parseReusableTriggerSpec({ source: { type: "external", source: "iphone", event: "charging_started" },
    condition: { type: "time_window", after: "23:00", before: "03:00", timezone: "Asia/Shanghai" },
    cooldownSeconds: 600, maxAgeSeconds: 1800 });
  if (task.trigger.type === "reference") {
    const point = store.getTrigger(scope, task.trigger.triggerId);
    const active = point?.revisions.find(value => value.revision === point.activeRevision);
    if (point?.status === "active" && active && JSON.stringify(active.spec) === JSON.stringify(spec)
      && !/23:00|03:00|十分钟内反复插拔/.test(task.instruction)) return { task, point, changed: false };
    throw new Error("WATCH_TASK_CHANGED");
  }
  if (task.trigger.type !== "external" || task.trigger.source !== "iphone" || task.trigger.event !== "charging_started"
    || task.trigger.cooldownSeconds !== 600 || task.trigger.maxAgeSeconds !== 1800) throw new Error("WATCH_TASK_CHANGED");
  const instruction = removeWatchScheduling(task.instruction);
  const event = (id: string, at: number) => ({ id, type: "external" as const, source: "iphone", event: "charging_started", occurredAt: at });
  const night = Date.parse("2030-01-01T17:10:00Z"), daytime = Date.parse("2030-01-01T06:00:00Z");
  const fixtures: TriggerFixture[] = [
    { name: "凌晨充电", steps: [{ at: night, event: event("night", night) }], expectedFirings: 1 },
    { name: "白天不触发", steps: [{ at: daytime, event: event("day", daytime) }], expectedFirings: 0 },
    { name: "23点含边界", steps: [{ at: night - 130 * 60000, event: event("start", night - 130 * 60000) }], expectedFirings: 1 },
    { name: "03点排除", steps: [{ at: night + 110 * 60000, event: event("end", night + 110 * 60000) }], expectedFirings: 0 },
    { name: "手机快28秒", steps: [{ at: night, event: event("skew", night + 28000) }], expectedFirings: 1 },
    { name: "十分钟去重", steps: [{ at: night, event: event("one", night) },
      { at: night + 300000, event: event("two", night + 300000) }, { at: night + 600000, event: event("three", night + 600000) }], expectedFirings: 2 },
  ];
  const point = store.stageTrigger(scope, { title: "睡前充电", spec, fixtures }, `watch-time-gate:${task.id}:v1`);
  if (point.status === "paused" || point.revision !== 1 || JSON.stringify(point.revisions[0]?.spec) !== JSON.stringify(spec)) throw new Error("WATCH_TRIGGER_CHANGED");
  if (!store.validateTriggerRevision(scope, point.id, 1).validation?.passed) throw new Error("WATCH_TRIGGER_VALIDATION_FAILED");
  const updated = store.updateWithTriggerRevision(scope, task.id, { instruction, trigger: { type: "reference", triggerId: point.id } }, 1, task.revision);
  return { task: updated, point: store.getTrigger(scope, point.id)!, changed: true };
}
