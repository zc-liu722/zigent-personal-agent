import { setTimeout as delay } from "node:timers/promises";
import type { ModelDeployment } from "../config.js";
import type { ModelFailureKind } from "./errors.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import type { ModelRoundUpdate } from "./types.js";
import { modelCapabilities } from "./capabilities.js";

/** Failures recoverable by reconnecting without changing credentials or input. */
export function isNetworkFailure(kind: ModelFailureKind): boolean {
  return ["connection-error", "transport-timeout", "first-progress-timeout", "stream-idle-timeout",
    "http-timeout", "service-unavailable", "invalid-response"].includes(kind);
}

export function networkRetryDelay(baseMs: number, retry: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, retry - 1), 16_000);
}

export function nativeModelProxyOrder(config: ModelGatewayConfig, route: ModelDeployment,
  explicitProxy?: string): readonly (string | undefined)[] {
  if (route.network === "direct") return [undefined];
  if (explicitProxy) return [explicitProxy];
  const urls = [config.zenmuxProxyUrl, ...(config.modelProxyFallbackUrls ?? [])]
    .filter((proxy): proxy is string => Boolean(proxy));
  return [...new Set(urls)];
}

/** Try another configured proxy only when the adapter knows the input can safely be retried. */
export async function withNativeProxyFailover<T>(config: ModelGatewayConfig, route: ModelDeployment,
  proxies: readonly (string | undefined)[], attempt: (proxy?: string) => Promise<T>,
  failureKind: (error: unknown) => ModelFailureKind | undefined,
  onUpdate?: (update: ModelRoundUpdate) => void, signal?: AbortSignal): Promise<T> {
  for (let index = 0; ; index++) {
    signal?.throwIfAborted();
    try {
      return await attempt(proxies[index]);
    } catch (error) {
      signal?.throwIfAborted();
      if (index + 1 >= proxies.length) throw error;
      const kind = failureKind(error);
      if (!kind || !isNetworkFailure(kind)) throw error;
      onUpdate?.({ provider: route.name, name: route.name, brand: route.brand, supplier: route.supplier,
        apiModel: route.apiModel, protocol: route.protocol, cost: route.cost, capabilities: modelCapabilities(route),
        type: "route", status: "retrying", failureKind: kind, retryAttempt: index + 2, maxAttempts: proxies.length });
      console.warn("Retrying native model on the next proxy", {
        agentId: config.id, model: route.name, failureKind: kind, attempt: index + 2, maxAttempts: proxies.length
      });
      await delay(networkRetryDelay(config.modelRetryDelayMs ?? 1000, index + 1), undefined, { signal });
    }
  }
}
