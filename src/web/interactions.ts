import type { CodexEdits } from "../codex/confirmation.js";
import { safeFeishuAuthorizationUrl } from "../productivity/feishu-user-authorization.js";
import type { MemoryChangePreview } from "../memory/changes.js";
import type { ConversationOutput } from "../channels/output.js";
import type { AgentConfig } from "../config.js";
import { reasoningSelection } from "../models/reasoning.js";
import { modelTokenPrice, type TokenPriceQuote } from "../models/token-pricing.js";
import type { OperationNotice } from "../channels/operation-confirmations.js";
import type { UserQuestion, UserQuestionAnswers, UserQuestionNotice } from "../channels/user-questions.js";
import type { ChangeDocument, ChangePreview } from "../channels/change-preview.js";
import type { ModelFallbackNotice } from "../channels/communication.js";
import { modelFallbackPresentation } from "../channels/model-fallback.js";
import type { DiagramNode } from "../tasks/trigger-diagram.js";

export const AUTHORIZATION_SERVICES = {
  google_calendar: { label: "Google Calendar", description: "连接后可以查看日程、安排和修改日历事件。" },
  google_drive: { label: "Google Drive", description: "连接后可以查找、读取、新建和编辑云盘文件。" },
  todoist: { label: "Todoist", description: "连接后可以查看、创建和修改待办事项。" },
  notion: { label: "Notion", description: "连接后可以使用你授权的笔记和工作区。" },
  xmind: { label: "XMind", description: "连接后可以处理你授权的思维导图。" },
  feishu: { label: "飞书文档", description: "连接后可以查找和读取你有权限访问的文档与会议记录。" }
} as const;
export type WebAuthorizationService = keyof typeof AUTHORIZATION_SERVICES;
export function authorizationSetupRequiredText(service: WebAuthorizationService): string {
  return service === "google_calendar" || service === "google_drive"
    ? "Google 的应用连接尚未配置，请管理员完成一次性设置后重试。刚才的操作尚未执行。"
    : "此服务的授权入口尚未配置，请先完成服务端设置后重试。刚才的操作尚未执行。";
}
export type WebInteractionStatus = "pending" | "completed" | "failed" | "expired" | "cancelled";
export type WebInteractionValue =
  | { type: "file-delivery-retry"; deliveryId: string }
  | { type: "audio-transcription"; messageId: string }
  | { type: "browser-control"; browserId: string; revision: number; action: "view" | "resume" | "pause" | "stop" | "confirm_submission" | "cancel_submission"; pendingId?: string }
  | { type: "codex-task"; taskId: string; revision: number; action: "interrupt" }
  | { type: "question-answer"; requestId: string; cancel?: boolean }
  | { type: "authorization-retry"; service: WebAuthorizationService }
  | { type: "model-fallback"; requestId: string; confirm: boolean; model?: string; retry?: boolean }
  | { type: "model-picker"; requestId: string }
  | { type: "task-proposal"; proposalId: string; confirm: boolean }
  | { type: "memory-proposal"; proposalId: string; confirm: boolean }
  | { type: "operation-confirmation"; proposalId: string; confirm: boolean; codexEdits?: CodexEdits }
  | { type: "model-select"; model: string; reasoningEffort?: string };
export type WebInteractionAction =
  | { id: string; label: string; kind: "link"; url: string }
  | { id: string; label: string; kind: "submit"; value: WebInteractionValue; disabled?: boolean; selected?: boolean; pricing?: TokenPriceQuote; reasoning?: ReturnType<typeof reasoningSelection> };

/** A transport-only UI contract. Never include credentials or expose arbitrary tool execution. */
export type WebInteraction = {
  id: string;
  kind: "schedule-reminder" | "browser" | "authorization" | "actions" | "output" | "task-proposal" | "memory-proposal" | "operation-confirmation" | "user-question";
  /** Durable position of a question within its originating assistant turn. */
  placement?: { messageId: string; activityId: string };
  questions?: UserQuestion[];
  questionPurpose?: "workspace";
  answers?: UserQuestionAnswers;
  resumeAfterRestart?: boolean;
  memoryChanges?: MemoryChangePreview[];
  changes?: ChangePreview[];
  changeDocuments?: ChangeDocument[];
  documents?: Array<{ id: string; title: string; filename: string }>;
  memoryDocumentView?: boolean;
  taskPlan?: { schedule: string; instruction: string; delivery: string };
  output?: ConversationOutput;
  fileDelivery?: { id: string; createdAt: number; sequence: number };
  codexForm?: OperationNotice["codexForm"];
  operationView?: OperationNotice["view"];
  browserSession?: { id: string };
  codexTask?: { id: string; project: string; directory?: string };
  /** Server-recorded user saves only; generated blocks do not enter the reference context. */
  documentEdits?: Record<string, number>;
  title: string;
  description?: string;
  service?: WebAuthorizationService;
  status: WebInteractionStatus;
  expiresAt?: number;
  statusMessage?: string;
  actions: WebInteractionAction[];
};

export function modelFallbackInteraction(notice: ModelFallbackNotice): WebInteraction {
  const { description, recharge } = modelFallbackPresentation(notice);
  if (notice.selectableProviders) return { id: notice.requestId, kind: "actions", title: "模型连接未完成", status: "pending", description,
    actions: [
      { id: "retry", label: "再次尝试", kind: "submit", value: { type: "model-fallback", requestId: notice.requestId, confirm: true, retry: true } },
      { id: "switch", label: "切换模型", kind: "submit", value: { type: "model-picker", requestId: notice.requestId } }
    ] };
  return { id: notice.requestId, kind: "actions", title: "切换模型继续", status: "pending", description,
    actions: [
      ...[true, false].map(confirm => ({ id: confirm ? "confirm" : "cancel", label: confirm ? "切换并继续" : "取消",
        kind: "submit" as const, value: { type: "model-fallback" as const, requestId: notice.requestId, confirm } })),
      ...(recharge ? [{ id: "recharge", kind: "link" as const, ...recharge }] : [])
    ] };
}

export function questionInteraction(notice: UserQuestionNotice): WebInteraction {
  return { id: notice.id, kind: "user-question", title: notice.purpose === "workspace" ? "选择项目区" : "需要你补充", questions: notice.questions, questionPurpose: notice.purpose,
    answers: notice.answers, status: notice.resumeAfterRestart ? "pending" : notice.status,
    resumeAfterRestart: notice.resumeAfterRestart, statusMessage: notice.statusMessage, expiresAt: notice.expiresAt,
    actions: notice.status === "pending" || notice.resumeAfterRestart ? [
      { id: "answer", label: notice.purpose === "workspace" ? "确认并继续" : "提交并继续", kind: "submit", value: { type: "question-answer", requestId: notice.id } },
      { id: "cancel", label: notice.purpose === "workspace" ? "暂不开始" : "暂不回答", kind: "submit", value: { type: "question-answer", requestId: notice.id, cancel: true } }
    ] : [] };
}

export function operationInteraction(notice: OperationNotice): WebInteraction {
  const version = notice.actionId?.split(":")[1];
  return { id: notice.id, kind: "operation-confirmation", title: notice.title, description: notice.changes?.some(change => change.task) ? undefined : notice.description,
    operationView: notice.view, changes: webTaskChanges(notice.changes), changeDocuments: notice.changeDocuments, codexForm: notice.codexForm,
    documents: notice.changeDocuments?.map(({ id, title, filename }) => ({ id, title, filename })),
    status: notice.status, statusMessage: notice.statusMessage, expiresAt: notice.expiresAt,
    actions: notice.retryable && (notice.status === "pending" || notice.status === "failed") ? [true, false].map(confirm => ({
      id: `${confirm ? "confirm" : "cancel"}${version ? `:${version}` : ""}`,
      label: confirm ? notice.status === "failed" ? "重试核对" : notice.codexForm ? "确认派发" : "确认执行" : "取消",
      kind: "submit", value: { type: "operation-confirmation", proposalId: notice.actionId ?? notice.id, confirm } })) : [] };
}

/** The web uses display projections; executable region IDs and coordinates stay on the server. */
export function webTaskChanges(changes: ChangePreview[] | undefined): ChangePreview[] | undefined {
  return changes?.map(change => {
    if (!change.task) return change;
    const steps = (nodes: DiagramNode[], depth = 0): string[] => nodes.flatMap(node => [
      `${"  ".repeat(depth)}${node.label}${node.detail ? `：${node.detail}` : ""}`,
      ...steps(node.conditions ?? [], depth + 1),
      ...(node.cancelOn?.length ? [`${"  ".repeat(depth + 1)}取消条件：`, ...steps(node.cancelOn, depth + 2)] : [])
    ]);
    const text = (state: NonNullable<ChangePreview["task"]>["after"]) => state
      ? [`标题：${state.title}`, ...steps(state.diagram.steps), `执行内容：${state.instruction}`,
        ...(state.project ? [`关联项目：${state.project}`] : []), `通知方式：${state.delivery}`,
        `状态：${({ active: "已启用", paused: "已暂停", cancelled: "已取消" } as Record<string, string>)[state.status] ?? state.status}`].join("\n") : undefined;
    return { ...change, before: text(change.task.before), after: text(change.task.after) };
  });
}

/** Only expose the enabled catalogue identities, never supplier connection settings. */
export function modelSelectionInteraction(config: Pick<AgentConfig, "modelOrder" | "models">, selected: string, savedReasoning: (name: string) => string | undefined = () => undefined, selectableProviders?: readonly string[]): WebInteraction {
  const enabled = new Map(config.models?.map(model => [model.name, model]) ?? []);
  // Compare displayed base input + output rates; unpriced models go last.
  const priceTotal = (pricing: TokenPriceQuote) => {
    const total = Number.parseFloat(pricing.input) + Number.parseFloat(pricing.output);
    return Number.isFinite(total) ? total : Infinity;
  };
  const models = (config.modelOrder ?? []).filter(name => enabled.has(name))
    .map(name => ({ name, pricing: modelTokenPrice(enabled.get(name)!) }))
    .sort((a, b) => priceTotal(a.pricing) - priceTotal(b.pricing) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  return {
    id: "model-library", kind: "actions", title: "模型库", status: "pending",
    actions: models.map(({ name, pricing }) => ({
      id: name, kind: "submit", label: name, selected: name === selected, value: { type: "model-select", model: name }, pricing,
      ...(selectableProviders ? { disabled: !selectableProviders.includes(name) } : {}),
      reasoning: reasoningSelection(enabled.get(name)!, savedReasoning(name))
    }))
  };
}

export function safeWebAuthorizationUrl(service: WebAuthorizationService, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (service === "google_calendar" || service === "google_drive") return url.hostname === "accounts.google.com";
    if (service === "todoist") return url.hostname === "todoist.com";
    if (service === "feishu") return safeFeishuAuthorizationUrl(value);
    return true; // Notion and XMind return their OAuth endpoint through the configured MCP server.
  } catch { return false; }
}

export function authorizationInteraction(id: string, service: WebAuthorizationService, status: WebInteractionStatus,
  prompt?: { authorizationUrl: string; expiresAt: number }, statusMessage?: string): WebInteraction {
  const details = AUTHORIZATION_SERVICES[service];
  if (prompt && (!safeWebAuthorizationUrl(service, prompt.authorizationUrl) || !Number.isFinite(prompt.expiresAt))) throw new Error("Invalid authorization prompt");
  return {
    id, kind: "authorization", title: `连接 ${details.label}`, service, status,
    ...(status === "pending" && prompt ? { description: details.description } : {}),
    ...(prompt && status === "pending" ? { expiresAt: prompt.expiresAt } : {}),
    statusMessage: statusMessage ?? (status === "completed" ? `${details.label} 已连接。`
      : status === "failed" ? "授权未完成，刚才的操作未执行。"
      : status === "expired" ? "授权已过期，刚才的操作未执行。"
      : prompt ? "" : "正在准备授权链接…"),
    actions: status === "completed" || status === "cancelled" ? [] : [
      ...(status === "pending" && prompt ? [{ id: "open", label: "前往授权", kind: "link" as const, url: prompt.authorizationUrl }] : []),
      { id: "retry", label: "重新连接", kind: "submit", value: { type: "authorization-retry", service } }
    ]
  };
}

/** The event snapshot is saved with the same message as the Agent's short reminder. */
export function scheduleReminderInteraction(id: string, event: import("../channels/change-preview.js").CalendarPreviewState): WebInteraction {
  return { id, kind: "schedule-reminder", title: event.title, status: "completed", operationView: "calendar", actions: [],
    changes: [{ title: event.title, after: event.title, presentation: { kind: "calendar", action: "remind", after: event } }] };
}
