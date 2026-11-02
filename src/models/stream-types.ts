import type { TokenUsage } from "../memory/types.js";
import type { ModelFailureKind } from "./errors.js";
import type { ResponseThought } from "./responses-thoughts.js";
import type { ModelAssistantTextItem, ModelAssistantTextPhase, ModelToolCall, ModelUrlCitation, ModelWebSearchCall } from "./types.js";

export type StreamUpdate = {
  stopReason?: string;
  reset?: boolean;
  assistantText?: { text: string; itemId?: string; phase?: ModelAssistantTextPhase };
  textItemPhases?: Array<{ itemId: string; phase: ModelAssistantTextPhase }>;
  progress: boolean;
  completed?: boolean;
  thoughts?: ResponseThought[];
  reasoningContent?: string;
  toolCalls?: Array<{
    key: string;
    id?: string;
    name?: string;
    argumentsDelta?: string;
    arguments?: string;
  }>;
  usage?: TokenUsage;
  generationId?: string;
  inputTokensReported?: boolean;
  outputTokensReported?: boolean;
  webSearchCalls?: ModelWebSearchCall[];
  webSearchArguments?: Array<{ id: string; delta: string }>;
  webSearchError?: { code: string; retryable: boolean };
  citations?: ModelUrlCitation[];
  nativeItems?: unknown[];
  retry?: {
    attempt: number;
    maxAttempts: number;
    failureKind: ModelFailureKind;
  };
};
export type StreamEventReader = (event: unknown) => StreamUpdate;

export type ModelTextResult = {
  stopReason?: string;
  text: string;
  textItems: ModelAssistantTextItem[];
  usage: TokenUsage;
  toolCalls: ModelToolCall[];
  webSearchCalls: ModelWebSearchCall[];
  citations: ModelUrlCitation[];
  reasoningContent?: string;
  nativeItems: unknown[];
};
