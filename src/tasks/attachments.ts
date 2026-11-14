import { validateAttachments, type MessageAttachment } from "../channels/attachments.js";
import { sleepTimelineAttachment } from "../health/sleep-timeline.js";
import type { HealthStore } from "../health/store.js";
import type { ActiveTask, TaskRun } from "./types.js";

type AttachmentProgram = {
  id: string;
  matches(task: ActiveTask): boolean;
  render(input: { task: ActiveTask; run: TaskRun; health: HealthStore }): MessageAttachment;
};

/** Code-owned bindings, independent of saved model instructions and trigger configuration. */
export const taskAttachmentPrograms: readonly AttachmentProgram[] = [{
  id: "sleep-timeline",
  matches: task => task.skill === "health" && ["睡眠复盘", "晨间睡眠复盘"].includes(task.title)
    && task.trigger.type === "health_change" && task.trigger.metrics?.includes("sleep_analysis") === true,
  render: ({ run, health }) => {
    const capturedAt = (run.result?.dataSnapshot as { capturedAt?: number } | undefined)?.capturedAt ?? run.triggeredAt;
    return sleepTimelineAttachment(health, capturedAt);
  }
}];

/** Call only with a currently authorized owner health store, at background delivery. */
export function taskAttachments(task: ActiveTask, run: TaskRun, health?: HealthStore): MessageAttachment[] {
  if (!health) return [];
  const attachments: MessageAttachment[] = [];
  for (const program of taskAttachmentPrograms) if (program.matches(task)) {
    try { attachments.push(...validateAttachments([program.render({ task, run, health })])); }
    catch { console.warn(`Task attachment program ${program.id} failed; the reply remains deliverable`); }
  }
  return attachments;
}
