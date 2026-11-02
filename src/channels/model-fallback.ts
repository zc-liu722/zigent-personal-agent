import type { ModelFallbackNotice } from "./communication.js";
import type { ModelFailureKind } from "../llm.js";

type SupplierBilling = { label: string; url?: string };

// Official account portals only. Resolve by the deployment's supplier, never by model brand
// or an upstream error body. Free/unknown suppliers have no invented payment destination.
const suppliers = new Map<string, SupplierBilling>([
  ["deepseek-official", { label: "DeepSeek 官方", url: "https://platform.deepseek.com/balance" }],
  ["zenmux", { label: "ZenMux", url: "https://zenmux.ai/platform/pay-as-you-go" }],
  ["moonshot-official", { label: "Moonshot 官方", url: "https://platform.kimi.com/console/pay" }],
  ["minimax-official", { label: "MiniMax 官方", url: "https://platform.minimax.cn/user-center/payment/balance" }],
  ["volcengine-official", { label: "火山引擎", url: "https://console.volcengine.com/finance/fund/recharge" }],
  ["chatgpt", { label: "ChatGPT" }]
]);

const descriptions: Record<ModelFailureKind, string> = {
  "boundary-violation": "隔离条件未满足",
  "result-unknown": "任务结果未确认",
  "first-progress-timeout": "首个响应进度超时",
  "stream-idle-timeout": "流式响应停滞超时",
  "transport-timeout": "模型传输层超时",
  "request-aborted": "模型请求提前中止",
  "http-timeout": "上游 HTTP 请求超时",
  authentication: "鉴权失败：模型服务拒绝了当前凭据",
  "payment-required": "供应商账户余额不足或付款受限（Payment Required）",
  "rate-limit": "请求受限：模型服务当前触发限流",
  "service-unavailable": "模型服务暂时不可用",
  "connection-error": "模型连接失败",
  "circuit-open": "供应商线路暂时停用，本次未重新请求",
  "unsupported-input": "当前模型不支持本次输入",
  "request-error": "请求错误：模型服务无法处理当前请求",
  "invalid-response": "响应异常：模型没有返回可用的结果"
};

export type ModelFallbackDetails = Pick<ModelFallbackNotice,
  "failedProvider" | "fallbackProvider" | "kind" | "status" | "elapsedMs" | "failedSupplier" | "lastFailure" | "selectableProviders">;

/** Shared, safe explanation for every channel; no credentials or raw provider response. */
export function modelFallbackPresentation(notice: ModelFallbackDetails): {
  description: string; recharge?: { label: string; url: string };
} {
  const supplier = notice.failedSupplier ? suppliers.get(notice.failedSupplier) : undefined;
  const failure = notice.kind === "circuit-open" ? notice.lastFailure : undefined;
  const kind = failure?.kind ?? notice.kind, status = failure?.status ?? notice.status;
  const paymentRequired = kind === "payment-required" || status === 402;
  const reason = (failureKind: ModelFailureKind): string => failureKind === "payment-required" && notice.failedSupplier === "deepseek-official"
    ? "DeepSeek 官方账户余额不足（Insufficient Balance）" : descriptions[failureKind];
  if (notice.selectableProviders) return { description: [notice.failedProvider, reason(kind), status ? `HTTP ${status}` : undefined].filter(Boolean).join("\n") };
  const details = [
    `失败模型：${notice.failedProvider}`,
    notice.failedSupplier ? `供应商：${supplier?.label ?? notice.failedSupplier}` : undefined,
    `错误原因：${reason(notice.kind)}`,
    failure ? `最近错误：${reason(failure.kind)}` : undefined,
    status === undefined ? undefined : `${failure ? "最近" : ""}状态码：HTTP ${status}`,
    notice.elapsedMs === undefined || notice.elapsedMs === 0 ? undefined
      : `失败发生于：请求开始后 ${notice.elapsedMs < 1_000 ? `${notice.elapsedMs} 毫秒`
        : `${(notice.elapsedMs / 1_000).toFixed(notice.elapsedMs < 10_000 ? 1 : 0)} 秒`}`,
    paymentRequired ? "请登录当前 API Key 所属的供应商账户检查余额并充值；充值后可重新发送问题。" : undefined,
    notice.selectableProviders ? undefined : `是否切换到 ${notice.fallbackProvider} 继续？`
  ];
  return {
    description: details.filter((line): line is string => Boolean(line)).join("\n"),
    ...(paymentRequired && supplier?.url ? { recharge: { label: `前往 ${supplier.label} 充值`, url: supplier.url } } : {})
  };
}
