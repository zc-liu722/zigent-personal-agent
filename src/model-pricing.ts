import type { ImageGenerationUsage, Session, TokenUsage, VideoGenerationRecord } from "./memory/types.js";

import { toUsd } from "./models/currency.js";

type ModelPrice = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

type ImageModelPrice = {
  inputTextUsdPerMillion: number;
  cachedTextUsdPerMillion: number;
  inputImageUsdPerMillion: number;
  cachedImageUsdPerMillion: number;
  outputImageUsdPerMillion: number;
};

export type ModelCost = {
  model: string;
  usd: number;
};

export type SessionCostEstimate = {
  costs: ModelCost[];
  totalUsd: number;
  unpricedModels: string[];
  cacheHitUsageIncomplete: boolean;
};

// Official standard API list prices. All figures are USD per 1M tokens.
// Sources: https://developers.openai.com/api/docs/models/compare,
// https://platform.claude.com/docs/en/about-claude/models/whats-new-opus-5, and
// https://api-docs.deepseek.com/quick_start/pricing-details-usd.
const modelPrices: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-zenmux": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
  "gpt-6astra-zenmux": { inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 },
  "gpt-6sol-zenmux": { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10 },
  "gpt-6luna-zenmux": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5 },
  "deepseek-v4.1flash-official": { inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28 },
  "deepseek-v4pro-lemon": { inputUsdPerMillion: 0.435, cachedInputUsdPerMillion: 0.003625, outputUsdPerMillion: 0.87 },
  "deepseek-v4pro-official": { inputUsdPerMillion: 0.435, cachedInputUsdPerMillion: 0.003625, outputUsdPerMillion: 0.87 },
  // Legacy API-model identifiers remain readable for historical session rows.
  "gpt-5.6-sol": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "gpt-5.6-terra": { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
  "gpt-5.6-luna": { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 6 },
  "claude-opus-5": { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
  "deepseek-v4-flash": { inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28 },
  "deepseek-v4-pro": { inputUsdPerMillion: 0.435, cachedInputUsdPerMillion: 0.003625, outputUsdPerMillion: 0.87 }
};

// OpenAI standard image-token prices, USD per 1M tokens.
const imageModelPrices: Readonly<Record<string, ImageModelPrice>> = {
  "gpt-image-2.5-sunburst": {
    inputTextUsdPerMillion: 5,
    cachedTextUsdPerMillion: 1.25,
    inputImageUsdPerMillion: 8,
    cachedImageUsdPerMillion: 2,
    outputImageUsdPerMillion: 30
  },
  "gpt-image-2.5-flare": {
    inputTextUsdPerMillion: 5,
    cachedTextUsdPerMillion: 1.25,
    inputImageUsdPerMillion: 8,
    cachedImageUsdPerMillion: 2,
    outputImageUsdPerMillion: 30
  },
  "gpt-image-2": {
    inputTextUsdPerMillion: 5,
    cachedTextUsdPerMillion: 1.25,
    inputImageUsdPerMillion: 8,
    cachedImageUsdPerMillion: 2,
    outputImageUsdPerMillion: 30
  }
};

function canonicalModelId(model: string): string {
  return model.trim().toLowerCase().replace(/^(anthropic|openai|deepseek|minimax)\//, "");
}

export function estimateVideoUsageUsd(usage: VideoGenerationRecord): number | undefined {
  const model = canonicalModelId(usage.model);
  const multiplier = usage.modelCostMultiplier ?? 1;
  const seconds = Math.max(0, usage.outputSeconds);
  if (model === "minimax-h3max-official" || model === "minimax-h3-max") {
    const rate = usage.resolution === "480p" ? 0.33 : usage.resolution === "768p" ? 0.5 : undefined;
    return rate === undefined ? undefined : toUsd(seconds * rate * multiplier, "CNY");
  }
  if (model === "minimax-h3-official" || model === "minimax-h3") {
    const rate = usage.resolution === "2k" ? 0.8 : usage.resolution === "768p" ? 0.5 : undefined;
    if (rate === undefined) return undefined;
    return toUsd((seconds * rate + Math.max(0, usage.inputImageCount - 5) * 0.2) * multiplier, "CNY");
  }
  return undefined;
}

function estimateUsageUsd(price: ModelPrice, usage: TokenUsage): number {
  const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncachedInputTokens = usage.inputTokens - cachedInputTokens;
  const usd = (
    uncachedInputTokens * price.inputUsdPerMillion
    + cachedInputTokens * price.cachedInputUsdPerMillion
    + usage.outputTokens * price.outputUsdPerMillion
  ) / 1_000_000;
  return usd;
}

function estimateImageUsageUsd(price: ImageModelPrice, usage: ImageGenerationUsage): number {
  const cachedImageTokens = Math.min(usage.inputImageTokens, usage.cachedInputTokens);
  const cachedTextTokens = Math.min(
    usage.inputTextTokens,
    Math.max(0, usage.cachedInputTokens - cachedImageTokens)
  );
  const uncachedImageTokens = Math.max(0, usage.inputImageTokens - cachedImageTokens);
  const uncachedTextTokens = Math.max(0, usage.inputTextTokens - cachedTextTokens);
  const usd = (
    uncachedTextTokens * price.inputTextUsdPerMillion
    + cachedTextTokens * price.cachedTextUsdPerMillion
    + uncachedImageTokens * price.inputImageUsdPerMillion
    + cachedImageTokens * price.cachedImageUsdPerMillion
    + usage.outputImageTokens * price.outputImageUsdPerMillion
  ) / 1_000_000;
  return usd;
}

export function estimateSessionCost(session: Session): SessionCostEstimate {
  const costByModel = new Map<string, number>();
  const unpricedModels = new Set<string>();
  let cacheHitUsageIncomplete = false;

  for (const message of [...(session.messages ?? []), ...(session.rewoundUsage ?? [])]) {
    // Request input usage is stored with the user message; output usage is stored
    // with the assistant message. Compressor messages hold a whole invocation.
    if (!message.model) continue;
    const model = canonicalModelId(message.modelName ?? message.model);
    const multiplier = message.modelCostMultiplier ?? 1;
    const costKey = message.modelName
      ? model
      : message.modelSupplier ? `${model} · ${message.modelSupplier}` : model;
    if (multiplier === 0) {
      costByModel.set(costKey, costByModel.get(costKey) ?? 0);
      continue;
    }
    const price = modelPrices[model];
    if (!price) {
      unpricedModels.add(message.model);
      continue;
    }
    if (message.cacheHitTokensReported === false) cacheHitUsageIncomplete = true;
    costByModel.set(costKey, (costByModel.get(costKey) ?? 0) + estimateUsageUsd(price, message) * multiplier);
  }

  for (const usage of session.imageUsages ?? []) {
    const model = canonicalModelId(usage.model);
    const multiplier = usage.modelCostMultiplier ?? 1;
    const costKey = usage.modelSupplier ? `${model} · ${usage.modelSupplier}` : model;
    if (multiplier === 0) {
      costByModel.set(costKey, costByModel.get(costKey) ?? 0);
      continue;
    }
    const price = imageModelPrices[model];
    if (!price) {
      unpricedModels.add(usage.model);
      continue;
    }
    costByModel.set(costKey, (costByModel.get(costKey) ?? 0) + estimateImageUsageUsd(price, usage) * multiplier);
  }

  for (const usage of session.videoUsages ?? []) {
    const usd = estimateVideoUsageUsd(usage);
    const costKey = usage.modelSupplier ? `${canonicalModelId(usage.model)} · ${usage.modelSupplier}` : canonicalModelId(usage.model);
    if (usd === undefined) unpricedModels.add(usage.model);
    else costByModel.set(costKey, (costByModel.get(costKey) ?? 0) + usd);
  }

  const costs = [...costByModel.entries()]
    .map(([model, usd]) => ({ model, usd }))
    .sort((left, right) => left.model.localeCompare(right.model));
  return {
    costs,
    totalUsd: costs.reduce((total, item) => total + item.usd, 0),
    unpricedModels: [...unpricedModels].sort(),
    cacheHitUsageIncomplete
  };
}

export function formatUsd(usd: number): string {
  return usd.toFixed(usd > 0 && usd < .01 ? 6 : 4);
}
