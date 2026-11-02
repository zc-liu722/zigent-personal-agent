import type { AgentConfig } from "../config.js";
import type { UsageKind } from "./types.js";

export type UsageModelIdentity = { model: string; supplier: string; kind: UsageKind; apiModel?: string };
/** Billing identities contain no credentials and include every independently routed media model. */
export function configuredUsageModels(config: AgentConfig): UsageModelIdentity[] {
  const models: UsageModelIdentity[] = (config.models ?? []).map(route => ({ model: route.name, supplier: route.supplier, apiModel: route.apiModel, kind: "text" }));
  const image = config.imageGeneration;
  if (image) models.push({ model: image.modelName ?? canonicalMediaModel(image.model, image.supplier ?? "unknown", "image"), supplier: image.supplier ?? "unknown", apiModel: image.model, kind: "image" });
  const video = config.videoGeneration;
  if (video?.model) models.push({ model: video.modelName ?? canonicalMediaModel(video.model, video.supplier ?? "unknown", "video"), supplier: video.supplier ?? "unknown", apiModel: video.model, kind: "video" });
  if (video?.official) {
    const route = video.official;
    models.push({ model: route.modelName ?? canonicalMediaModel(route.model, route.supplier, "video"), supplier: route.supplier, apiModel: route.model, kind: "video" });
    models.push({ model: route.highResolutionModelName ?? canonicalMediaModel(route.highResolutionModel, route.supplier, "video"), supplier: route.supplier, apiModel: route.highResolutionModel, kind: "video" });
  }
  return models;
}
/** Known transport spellings may be normalized only when the supplier was recorded. */
export function canonicalMediaModel(model: string, supplier: string, kind: "image" | "video", models: UsageModelIdentity[] = []): string {
  if (supplier === "unknown") return model;
  const configured = models.find(route => route.kind === kind && route.supplier === supplier && (route.model === model || route.apiModel === model));
  if (configured) return configured.model;
  const transport = model.toLowerCase().replace(/^(openai|minimax)\//, "");
  if (kind === "image" && (supplier === "zenmux" || supplier === "openai-official" || supplier === "chatgpt")) {
    const version = ({ "gpt-image-2.5-sunburst": "image2.5sunburst", "gpt-image-2.5-flare": "image2.5flare", "gpt-image-2": "image2" } as Record<string,string>)[transport];
    if (version) return `gpt-${version}-${supplier === "openai-official" ? "official" : supplier}`;
  }
  if (kind === "video" && (supplier === "zenmux" || supplier === "minimax-official")) {
    const version = ({ "minimax-h3-max": "h3max", "minimax-h3": "h3" } as Record<string,string>)[transport];
    if (version) return `minimax-${version}-${supplier === "zenmux" ? "zenmux" : "official"}`;
  }
  return model;
}
