import type { ModelCostPolicy } from "../config.js";
import type { ImageGenerationUsage } from "../memory/types.js";
import type { UsagePrice } from "./pricing.js";
import { toUsd } from "../models/currency.js";

/** Provider-reported token categories; guessed image tokens are never a price basis. */
export type MediaImageUsage = ImageGenerationUsage & {
  breakdownComplete?: boolean;
  /** Direct Images API inputs have no cache discount; Responses inputs may have one. */
  cacheBilling?: "none" | "split";
  cachedTextTokens?: number;
  cachedImageTokens?: number;
};

export type MediaVideoUsage = {
  outputSeconds: number;
  resolution: string;
  inputImageCount: number;
};

const imageSource = "https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst";
const videoSources = {
  "minimax-official": "https://platform.minimax.cn/docs/pricing/overview",
  zenmux: "https://platform.minimax.io/docs/pricing/overview"
};

// Official standard API prices checked 2026-10-20. ZenMux uses the publisher's list price.
// Rates are per million tokens. Image cache discounts are restricted to Responses:
// https://developers.openai.com/api/docs/guides/image-generation#cached-input-pricing
const imageRates = { text: 5, cachedText: 1.25, image: 8, cachedImage: 2, output: 30 };

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function costMultiplier(policy: ModelCostPolicy | undefined): number | undefined {
  if (policy?.type === "free" || policy?.type === "subscription") return 0;
  const multiplier = policy?.type === "official" ? policy.multiplier ?? 1 : 1;
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : undefined;
}

function zeroCostSource(policy: ModelCostPolicy | undefined): string {
  return policy?.type === "subscription" ? "subscription" : "free";
}

function imageIdentity(model: string, supplier: string): boolean {
  if (supplier !== "zenmux" && supplier !== "openai-official") return false;
  const suffix = supplier === "zenmux" ? "zenmux" : "official";
  // Explicit API names are accepted for historical rows only when the supplier was recorded.
  return ["sunburst", "flare"].some(variant => [
    `gpt-image2.5${variant}-${suffix}`,
    `openai/gpt-image-2.5-${variant}`,
    `gpt-image-2.5-${variant}`
  ].includes(model.toLowerCase()));
}

/** Standard, synchronous image requests only; returns no quote for ambiguous usage. */
export function priceImage(model: string, supplier: string, policy: ModelCostPolicy | undefined,
  usage: MediaImageUsage | undefined): UsagePrice | undefined {
  if (policy?.type === "subscription") return { currency: "USD", amount: 0, source: "subscription" };
  if (!imageIdentity(model, supplier)) return undefined;
  const multiplier = costMultiplier(policy);
  if (multiplier === undefined) return undefined;
  if (multiplier === 0) return { currency: "USD", amount: 0, source: zeroCostSource(policy) };
  if (!usage || usage.estimated || usage.breakdownComplete !== true) return undefined;
  const counts = [usage.inputTokens, usage.inputTextTokens, usage.inputImageTokens, usage.cachedInputTokens,
    usage.outputTokens, usage.outputTextTokens, usage.outputImageTokens];
  if (!counts.every(validCount)
    || usage.inputTextTokens + usage.inputImageTokens !== usage.inputTokens
    || usage.outputTextTokens + usage.outputImageTokens !== usage.outputTokens
    || usage.cachedInputTokens > usage.inputTokens) return undefined;
  let cachedText = 0, cachedImage = 0;
  if (usage.cachedTextTokens !== undefined && !validCount(usage.cachedTextTokens)
    || usage.cachedImageTokens !== undefined && !validCount(usage.cachedImageTokens)) return undefined;
  if (usage.cachedInputTokens > 0 && usage.cacheBilling !== "none") {
    if (usage.cacheBilling !== "split") return undefined;
    cachedText = usage.cachedTextTokens ?? (usage.inputImageTokens === 0 ? usage.cachedInputTokens : 0);
    cachedImage = usage.cachedImageTokens ?? (usage.inputTextTokens === 0 ? usage.cachedInputTokens : 0);
    if (cachedText + cachedImage !== usage.cachedInputTokens) return undefined;
  } else if (usage.cachedInputTokens === 0
    && ((usage.cachedTextTokens ?? 0) > 0 || (usage.cachedImageTokens ?? 0) > 0)) return undefined;
  if (cachedText > usage.inputTextTokens || cachedImage > usage.inputImageTokens) return undefined;
  // The publisher explicitly does not bill image-model text output; retain its count for validation.
  const amount = ((usage.inputTextTokens - cachedText) * imageRates.text + cachedText * imageRates.cachedText
    + (usage.inputImageTokens - cachedImage) * imageRates.image + cachedImage * imageRates.cachedImage
    + usage.outputImageTokens * imageRates.output) / 1e6 * multiplier;
  return { currency: "USD", amount, source: imageSource };
}

function videoIdentity(model: string, supplier: string): "h3" | "h3max" | undefined {
  if (supplier !== "minimax-official" && supplier !== "zenmux") return undefined;
  const suffix = supplier === "zenmux" ? "zenmux" : "official";
  const name = model.toLowerCase();
  if ([`minimax-h3max-${suffix}`, "minimax-h3-max", "minimax/minimax-h3-max"].includes(name)) return "h3max";
  if ([`minimax-h3-${suffix}`, "minimax-h3", "minimax/minimax-h3"].includes(name)) return "h3";
  return undefined;
}

/** Current image/text-to-video requests; input-video and regeneration routes need separate metering. */
export function priceVideo(model: string, supplier: string, policy: ModelCostPolicy | undefined,
  usage: MediaVideoUsage | undefined): UsagePrice | undefined {
  const variant = videoIdentity(model, supplier);
  if (!variant) return undefined;
  const domestic = supplier === "minimax-official", currency = domestic ? "CNY" : "USD";
  const multiplier = costMultiplier(policy);
  if (multiplier === undefined) return undefined;
  if (multiplier === 0) return { currency: "USD", amount: 0, source: zeroCostSource(policy) };
  if (!usage || !Number.isFinite(usage.outputSeconds) || usage.outputSeconds < 0 || !validCount(usage.inputImageCount)) return undefined;
  const resolution = usage.resolution.toLowerCase();
  const rates: Record<string, number | undefined> = variant === "h3max"
    ? domestic ? { "480p": .33, "768p": .5 } : { "480p": .05, "768p": .08 }
    : domestic ? { "768p": .5, "2k": .8 } : { "768p": .08, "2k": .13 };
  const outputRate = rates[resolution];
  if (outputRate === undefined) return undefined;
  const includedImages = variant === "h3max" ? 2 : 5;
  const imageRate = variant === "h3max" ? domestic ? .5 : .074 : domestic ? .2 : .04;
  return { currency: "USD", amount: toUsd((usage.outputSeconds * outputRate
    + Math.max(0, usage.inputImageCount - includedImages) * imageRate) * multiplier, currency),
  source: videoSources[supplier as keyof typeof videoSources] };
}
