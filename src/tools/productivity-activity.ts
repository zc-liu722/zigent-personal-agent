import { activitySubject, type ToolActivityPresentation, type ToolActivityPresenter } from "./activity-presentation.js";
// Presentation must not initialize a network transport when loaded as a component.
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only code-owned action labels enter the activity trail; no event/task bodies or upstream errors. */
export function productivityActivity(service: string, labels: Readonly<Record<string, string>>,
  describe?: (action: string, input: Record<string, unknown>, result: Record<string, unknown>) =>
    { subject?: unknown; actionKind?: ToolActivityPresentation["actionKind"] }): ToolActivityPresenter {
  const heading = (input: unknown, result?: unknown) => {
    const args = record(input), action = args.action;
    if (typeof action !== "string" || !Object.hasOwn(labels, action)) return { title: `检查${service}操作` };
    const description = describe?.(action, args, record(result));
    const subject = activitySubject(description?.subject);
    const label = labels[action];
    return { title: subject ? `${label} · ${subject}` : label, actionKind: description?.actionKind };
  };
  return {
    started: input => {
      const summary = heading(input);
      return { ...summary, message: `我正在${summary.title}。` };
    },
    completed: (input, result) => {
      const summary = heading(input, result), { status } = record(result);
      return { ...summary, message: status === "not_configured" ? `${service} 尚未连接，需要先完成账号配置。`
        : status === "authorization_pending" ? `我已开始${service}授权，授权入口和结果会单独发送。`
        : status === "authorization_required" ? `${service} 需要重新授权。` : `我已完成${summary.title}。` };
    },
    failed: input => ({ ...heading(input), message: `这次我未能完成${service}操作。` })
  };
}
