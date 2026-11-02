import type { ToolActivityPresenter } from "./activity-presentation.js";
import { record } from "../productivity/http.js";

/** Only code-owned action labels enter the activity trail; no event/task bodies or upstream errors. */
export function productivityActivity(service: string, labels: Readonly<Record<string, string>>): ToolActivityPresenter {
  const label = (input: unknown) => {
    const action = record(input).action;
    return typeof action === "string" && Object.hasOwn(labels, action) ? labels[action] : `处理${service}`;
  };
  return {
    started: input => ({ message: `我正在${label(input)}。` }),
    completed: (input, result) => ({ message: record(result).status === "not_configured" ? `${service} 尚未连接，需要先完成账号配置。`
      : record(result).status === "authorization_pending" ? `我已开始${service}授权，授权入口和结果会单独发送。`
      : record(result).status === "authorization_required" ? `${service} 需要重新授权。` : `我已完成${label(input)}。` }),
    failed: () => ({ message: `这次我未能完成${service}操作。` })
  };
}
