import type { ModelCostPolicy } from "../config.js";
import type { ImageGenerationUsage, TokenUsage } from "../memory/types.js";

export type UsageKind = "text" | "image" | "video" | "historical";
export type UsageObservation = {
  id?: string;
  model: string;
  supplier: string;
  apiModel?: string;
  cost?: ModelCostPolicy;
  kind: UsageKind;
  createdAt: number;
  timeKnown?: boolean;
  usage?: TokenUsage;
  usageComplete?: boolean;
  generationId?: string;
  outcome: "completed" | "failed" | "rejected" | "historical";
  estimatedTokens?: boolean;
  outputImages?: number;
  outputVideos?: number;
  outputSeconds?: number;
  mediaRecordId?: string;
  historical?: boolean;
  imageUsage?: ImageGenerationUsage & { cacheBilling?: "none" | "split"; cachedTextTokens?: number; cachedImageTokens?: number; breakdownComplete?: boolean };
  videoUsage?: { outputSeconds: number; resolution: string; inputImageCount: number };
};
export type UsageRecorder = (observation: UsageObservation) => void;
export type RequestMeter = Pick<UsageObservation, "createdAt" | "usage" | "usageComplete" | "generationId" | "outcome">;
export type RequestRecorder = (meter: RequestMeter) => void;
export type Currency = "USD";
export type UsageTotals = {
  requests: number; inputTokens: number; outputTokens: number; cachedInputTokens: number;
  cacheWriteTokens: number; outputSeconds: number; outputImages: number; outputVideos: number; imageRequests: number; videoRequests: number; costs: Record<Currency, number>;
  estimatedCosts: Record<Currency, number>; unpriced: number; unpricedUsage: number; sourceMissing: number; awaitingBill: number; missingUsage: number;
  historical: number; undated: number; failed: number;
};
export type UsageReport = {
  period: string; from: number; through: number; timezone: "Asia/Shanghai";
  totals: UsageTotals;
  models: Array<UsageTotals & { key: string; model: string; supplier: string; kinds: UsageKind[]; billingTypes?: Array<"subscription" | "free" | "api"> }>;
  days: Array<UsageTotals & { date: string }>;
  availableModels: Array<{ key: string; model: string; supplier: string; kinds: UsageKind[] }>;
};
export function modelUsageKey(model: string, supplier: string): string { return JSON.stringify([model, supplier]); }
export function emptyTotals(): UsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputSeconds: 0, outputImages: 0, outputVideos: 0, imageRequests: 0, videoRequests: 0, costs: { USD: 0 }, estimatedCosts: { USD: 0 },
    unpriced: 0, unpricedUsage: 0, sourceMissing: 0, awaitingBill: 0, missingUsage: 0, historical: 0, undated: 0, failed: 0 };
}
