import { z } from "zod";
import { dispatchSchema, promptSchema, type CodexDevice } from "./types.js";
import { buildOperationDraft, object, type OperationDraft } from "../tools/operation-policy.js";
import { operationDigest } from "../tools/confirmed-operation.js";

export const codexEditsSchema = z.object({ projectKey: z.string().min(1).max(260), sessionId: z.string().max(128), prompt: promptSchema, reviewAfterCompletion: z.boolean().default(false) }).strict();
export type CodexEdits = z.infer<typeof codexEditsSchema>;
export type CodexForm = CodexEdits & {
  title: string; timeoutMinutes: number; originalRequest?: string;
  projects: Array<{ key: string; deviceId: string; deviceName: string; project: CodexDevice["projects"][number] }>;
  sessions: Array<{ id: string; title: string; threadId: string; deviceId: string; projectId: string; project: CodexDevice["projects"][number] }>;
};
export function codexForm(draft: OperationDraft, devices: CodexDevice[], tasks: unknown[]): CodexForm {
  const target = object(draft.input.task), previous = draft.input.action === "message" ? tasks.find(task => object(task).id === draft.input.id) : tasks.find(task => object(task).id === target.continueTaskId);
  const recipient = draft.input.action === "message" ? object(previous) : target;
  const projects = devices.flatMap(device => device.projects.map(project => ({
    key: `${device.id}/${project.id}`, deviceId: device.id, deviceName: device.name, project
  })));
  const seen = new Set<string>();
  const sessions = (previous ? [previous, ...tasks] : tasks).flatMap(value => {
    const task = object(value), project = projects.find(item => item.deviceId === task.deviceId && item.project.id === task.projectId);
    if (!task.threadId || !["running", "waiting_user", "succeeded", "blocked", "cancelled"].includes(String(task.state)) || !project
      || operationDigest(project.project) !== operationDigest(task.project) || seen.has(`${task.deviceId}/${task.threadId}`)) return [];
    seen.add(`${task.deviceId}/${task.threadId}`);
    return [{ id: String(task.id), title: String(task.title), threadId: String(task.threadId), deviceId: project.deviceId, projectId: project.project.id, project: project.project }];
  });
  return { title: String(target.title ?? object(previous).title ?? "发消息"), timeoutMinutes: Number(target.timeoutMinutes ?? 120), projects, sessions, projectKey: `${recipient.deviceId}/${recipient.projectId}`, sessionId: previous ? String(object(previous).id) : "",
    reviewAfterCompletion: Boolean(draft.input.reviewAfterCompletion ?? target.reviewAfterCompletion ?? object(previous).review),
    prompt: String(draft.input.action === "message" ? draft.input.text : target.prompt) };
}
/** Only saved catalogue entries can become recipients. The normal consent preflight rechecks their snapshots. */
export function editCodexDraft(draft: OperationDraft, form: CodexForm, edits: CodexEdits): OperationDraft {
  const selected = form.projects.find(item => item.key === edits.projectKey);
  if (!selected || selected.project.available === false) throw new Error("请选择卡片中的可用项目和执行器");
  const session = edits.sessionId ? form.sessions.find(item => item.id === edits.sessionId && item.deviceId === selected.deviceId && item.projectId === selected.project.id) : undefined;
  if (edits.sessionId && !session) throw new Error("请选择该项目的会话");
  const deviceSnapshot = { device: { id: selected.deviceId, name: selected.deviceName }, project: selected.project };
  if (session) return buildOperationDraft("codex", { action: "message", id: session.id, text: edits.prompt, reviewAfterCompletion: edits.reviewAfterCompletion }, [{ task: session }, deviceSnapshot]);
  const task = dispatchSchema.parse({ deviceId: selected.deviceId, projectId: selected.project.id, title: form.title,
    prompt: edits.prompt, reviewAfterCompletion: edits.reviewAfterCompletion, timeoutMinutes: form.timeoutMinutes });
  return buildOperationDraft("codex", { action: "dispatch", task }, [deviceSnapshot]);
}
