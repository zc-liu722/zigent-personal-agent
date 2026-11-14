import { z } from "zod";
import { dispatchSchema, promptSchema, type CodexDevice } from "./types.js";
import { directorySchema, directoryProject, dispatchProject } from "./target.js";
import { buildOperationDraft, object, type OperationDraft } from "../tools/operation-policy.js";

export const codexEditsSchema = z.object({ projectKey: z.string().min(1).max(260), directory: directorySchema.optional(), sessionId: z.string().max(128), prompt: promptSchema, reviewAfterCompletion: z.boolean().default(false) }).strict();
export type CodexEdits = z.infer<typeof codexEditsSchema>;
export type CodexForm = CodexEdits & {
  title: string; timeoutMinutes: number; originalRequest?: string;
  devices: Array<{ id: string; name: string }>;
  projects: Array<{ key: string; deviceId: string; deviceName: string; project: CodexDevice["projects"][number] }>;
  sessions: Array<{ id: string; title: string; threadId: string; deviceId: string; projectId: string; project: CodexDevice["projects"][number] }>;
};
export function codexForm(draft: OperationDraft, devices: CodexDevice[], tasks: unknown[]): CodexForm {
  const target = object(draft.input.task), previous = draft.input.action === "message" ? tasks.find(task => object(task).id === draft.input.id) : tasks.find(task => object(task).id === target.continueTaskId);
  const recipient = draft.input.action === "message" ? object(previous) : target;
  const device = devices.find(d => d.id === recipient.deviceId);
  if (!device) throw new Error("桌面 Codex 连接已失效");
  const selected = draft.input.action === "message" ? directoryProject(object(recipient.project).directory) : dispatchProject(device, target);
  const projects = [{ key: device.id + "/" + selected.id, deviceId: device.id, deviceName: device.name, project: selected }];
  const seen = new Set<string>();
  const sessions = (previous ? [previous, ...tasks] : tasks).flatMap(value => {
    const task = object(value), project = object(task.project), key = task.deviceId + "/" + task.threadId;
    if (!task.threadId || !project.directory || !["running", "waiting_user", "succeeded", "blocked", "cancelled"].includes(String(task.state))
      || !devices.some(d => d.id === task.deviceId) || object(task.execution).mode !== "direct" || seen.has(key)) return [];
    seen.add(key);
    return [{ id: String(task.id), title: String(task.title), threadId: String(task.threadId), deviceId: String(task.deviceId), projectId: String(task.projectId), project: project as CodexDevice["projects"][number] }];
  });
  return { title: String(target.title ?? object(previous).title ?? "发消息"), timeoutMinutes: Number(target.timeoutMinutes ?? 120), projects, sessions,
    devices: devices.map(({ id, name }) => ({ id, name })), projectKey: projects[0]!.key, directory: selected.directory, sessionId: previous ? String(object(previous).id) : "",
    reviewAfterCompletion: Boolean(draft.input.reviewAfterCompletion ?? target.reviewAfterCompletion ?? object(previous).review),
    prompt: String(draft.input.action === "message" ? draft.input.text : target.prompt) };
}
/** Directory edits use the same confirmation and recheck the chosen desktop. */
export function editCodexDraft(draft: OperationDraft, form: CodexForm, edits: CodexEdits): OperationDraft {
  const deviceId = edits.projectKey.split("/")[0], device = form.devices.find(d => d.id === deviceId);
  if (!device) throw new Error("请选择已连接的桌面 Codex");
  const project = directoryProject(edits.directory ?? form.projects.find(p => p.key === edits.projectKey)?.project.directory);
  const session = edits.sessionId ? form.sessions.find(s => s.id === edits.sessionId && s.deviceId === device.id && directoryProject(s.project.directory).id === project.id) : undefined;
  if (edits.sessionId && !session) throw new Error("请选择该目录的会话");
  const snapshot = { device: { id: device.id, name: device.name }, project };
  if (session) return buildOperationDraft("codex", { action: "message", id: session.id, text: edits.prompt, reviewAfterCompletion: edits.reviewAfterCompletion }, [{ task: session }, snapshot]);
  const task = dispatchSchema.parse({ deviceId: device.id, directory: project.directory, title: form.title,
    prompt: edits.prompt, reviewAfterCompletion: edits.reviewAfterCompletion, timeoutMinutes: form.timeoutMinutes });
  return buildOperationDraft("codex", { action: "dispatch", task }, [snapshot]);
}
