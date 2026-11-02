import type { CodexTask } from "../codex/types.js";
import type { WebInteraction } from "./interactions.js";

export function codexInteraction(task: CodexTask, publicUrl?: string): WebInteraction {
  const reviewing = task.state === "succeeded" && Boolean(task.review && ["pending", "running"].includes(task.review.state));
  const active = reviewing || ["queued", "running", "waiting_user", "reconciling"].includes(task.state);
  return { id: "codex:" + task.id, kind: "actions", title: task.title, status: active ? "pending" : task.state === "succeeded" ? "completed" : "failed",
    codexTask: { id: task.id, project: task.project?.name ?? task.projectId, directory: task.project?.directory },
    statusMessage: task.review && task.review.state !== "pending" ? task.phase : task.execution?.publication === "conflict" ? "成果已保留 · 输入有更新" : task.phase, description: task.summary, actions: active ? [
      { id: "interrupt", kind: "submit", label: reviewing ? "停止跟进" : task.state === "queued" ? "取消" : "中断", value: { type: "codex-task", taskId: task.id, revision: task.revision, action: "interrupt" } }
    ] : task.state === "succeeded" && task.execution && task.execution.mode !== "project" && publicUrl ? [
      { id: "results", kind: "link", label: "领取成果", url: new URL("api/codex/result?" + new URLSearchParams({ taskId: task.id }), publicUrl).href }
    ] : [] };
}
