import type { AgentConfig } from "../config/types.js";

/** Text routes bound to the host's supplier and Agent configuration. */
export type ModelCatalogSnapshot = Pick<AgentConfig, "models" | "modelOrder" | "providerOrder" | "providers" | "imageGeneration">;
export type ModelCatalogBinding = {
  variant: "local" | "production";
  bind(data: unknown): ModelCatalogSnapshot;
};

export function modelCatalogSnapshot(config: ModelCatalogSnapshot): ModelCatalogSnapshot {
  const { models, modelOrder, providerOrder, providers, imageGeneration } = config;
  return { models, modelOrder, providerOrder, providers, imageGeneration };
}
