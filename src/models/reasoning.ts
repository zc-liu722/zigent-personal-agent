import type { ModelDeployment, ReasoningEffort } from "../config.js";
import type { ModelRoundRequest } from "./types.js";

export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极限"
};

export function savedReasoningEffort(route: ModelDeployment, saved: string | undefined): ReasoningEffort | undefined {
  return route.reasoning?.mode === "effort" && route.reasoning.levels.some(level => level === saved)
    ? saved as ReasoningEffort : undefined;
}

/** Resolve against the actual route, never reuse another supplier's effort enum. */
export function effectiveReasoningEffort(route: ModelDeployment, request: ModelRoundRequest): ReasoningEffort {
  const saved = savedReasoningEffort(route, request.reasoningEfforts?.[route.name]);
  if (saved) return saved;
  if (request.reasoningEffort === "maximum") {
    if (route.reasoning) return route.reasoning.levels.at(-1)!;
    return route.protocol === "anthropic-messages" || route.supplier === "moonshot-official" ? "max" : "xhigh";
  }
  return route.reasoningEffort ?? "high";
}

export function reasoningSelection(route: ModelDeployment, saved?: string) {
  const selected = savedReasoningEffort(route, saved) ?? route.reasoningEffort ?? "high";
  return {
    selected,
    default: route.reasoningEffort ?? "high",
    levels: (route.reasoning?.levels ?? [selected]).map(value => ({ value, label: reasoningLabels[value] })),
    adjustable: route.reasoning?.mode === "effort",
    note: route.reasoning?.note ?? (!route.reasoning ? "此模型尚未配置可调档位，使用模型默认设置。" : undefined)
  };
}
