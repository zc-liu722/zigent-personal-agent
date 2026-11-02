import type { ModelDeployment } from "../config.js";
import type { ModelGatewayConfig } from "./gateway-config.js";

export type ContextPolicy = {
  window: number; inputLimit: number; output: number; trigger: number; target: number;
  /** Only a verified supplier limit or explicit operator cap may reject admission. */
  hardLimit: boolean;
  limitSource: "supplier" | "manufacturer" | "runtime" | "unknown";
  keepRecent: number; summary: number; safety: number;
  strategy: NonNullable<ModelDeployment["context"]>["strategy"];
  protectedTools: readonly string[];
};

export function contextPolicy(route: ModelDeployment, config: Pick<ModelGatewayConfig,
  "memoryContextWindowTokens" | "memoryCompressionRatio"> = {}): ContextPolicy {
  const settings = route.context;
  const window = Math.min(settings?.windowTokens ?? 32_768, config.memoryContextWindowTokens ?? Infinity);
  const safety = Math.min(Math.floor(window * 0.1), settings?.safetyTokens ?? Math.max(2048, Math.ceil(window * 0.05)));
  const output = Math.min(route.maxTokens ?? Math.min(settings?.maxOutputTokens ?? 16_384, Math.floor(window * 0.15)),
    settings?.maxOutputTokens ?? Infinity, Math.floor(window * 0.4));
  const inputLimit = Math.max(1024, Math.min(settings?.maxInputTokens ?? window, window - output - safety));
  const trigger = Math.floor(inputLimit * (config.memoryCompressionRatio ?? settings?.triggerRatio ?? 0.8));
  return { window, output, safety, inputLimit, trigger, target: Math.floor(trigger * 0.65),
    hardLimit: settings?.confidence === "verified" || config.memoryContextWindowTokens !== undefined,
    limitSource: settings?.limitSource ?? (settings?.confidence === "verified" ? "supplier" : "unknown"),
    keepRecent: Math.min(settings?.keepRecentTokens ?? 20_000, Math.floor(inputLimit * 0.3)),
    summary: Math.min(settings?.summaryTokens ?? 4096, Math.floor(inputLimit * 0.15)),
    strategy: settings?.strategy ?? "summary",
    protectedTools: settings?.protectedTools ?? ["ask_user_question", "long_term_memory", "proactive_tasks"] };
}
