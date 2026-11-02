export type RunCancellationReason = "service_shutdown" | "user_stop" | "new_message" | "session_change";

const messages: Record<RunCancellationReason, string> = {
  service_shutdown: "服务更新中断，请重试。",
  user_stop: "已手动停止。",
  new_message: "新消息已接替本次回复。",
  session_change: "会话已切换。"
};

/** Preserve a fixed diagnostic category through model and tool cancellation. */
export class AgentRunInterruption extends DOMException {
  constructor(readonly kind: RunCancellationReason) {
    super(messages[kind], "AbortError");
  }
}
