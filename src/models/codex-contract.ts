import type { TokenUsage } from "../memory/types.js";
import type { currentPerformance } from "../performance/store.js";
import type { ModelRoundAdapter, NativeModelService } from "./types.js";

export type CodexPerformance = NonNullable<ReturnType<typeof currentPerformance>>;
export type CodexImageTask = {
  prompt: string;
  threadId?: string;
  history?: readonly unknown[];
  usageBaseline?: TokenUsage;
  ephemeral?: boolean;
  started?(): void;
  rendered?(): void;
  imageCompleted?(item: Record<string, unknown>, workspace: string): Promise<void>;
  complete(items: readonly Record<string, unknown>[], workspace: string, text: string,
    state: { threadId: string; totalUsage?: TokenUsage }): Promise<void>;
};

type AppServerFailureKind = "authentication" | "rate-limit" | "unavailable" | "request" | "invalid-response" | "result-unknown";

export class CodexAppServerError extends Error {
  readonly codexFailure: AppServerFailureKind;
  constructor(message: string, readonly kind: AppServerFailureKind, readonly status?: number) {
    super(message);
    this.name = "CodexAppServerError";
    this.codexFailure = kind;
  }
}

export function isCodexAppServerError(error: unknown): error is CodexAppServerError {
  return error instanceof Error && "codexFailure" in error && error.name === "CodexAppServerError";
}

export type CodexImageRound = (config: Parameters<ModelRoundAdapter>[0], route: Parameters<ModelRoundAdapter>[1],
  request: Parameters<ModelRoundAdapter>[2], signal: AbortSignal | undefined, record: Parameters<ModelRoundAdapter>[5],
  task: CodexImageTask, performance?: CodexPerformance) => ReturnType<ModelRoundAdapter>;
export type CodexModelService = NativeModelService & { imageRound: CodexImageRound };
