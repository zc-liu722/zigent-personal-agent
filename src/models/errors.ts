import type { Provider } from "../config.js";
import type { SupplierFailure } from "./supplier-health.js";

export type ModelFailureKind =
  | "first-progress-timeout"
  | "stream-idle-timeout"
  | "transport-timeout"
  | "request-aborted"
  | "http-timeout"
  | "authentication"
  | "payment-required"
  | "rate-limit"
  | "service-unavailable"
  | "connection-error"
  | "circuit-open"
  | "unsupported-input"
  | "request-error"
  | "boundary-violation"
  | "result-unknown"
  | "invalid-response";

export class ModelError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ModelError";
  }
}

/** Admission/overflow is local to this request, not a supplier-health failure. */
export class ModelContextOverflowError extends ModelError {
  constructor(public readonly contextWindowTokens?: number) {
    super("当前输入超过模型上下文预算，请缩短输入或选择更大窗口的模型。", 413);
    this.name = "ModelContextOverflowError";
  }
}

/** An isolated runtime must never be retried or enter supplier/model fallback. */
export class ModelHardStopError extends ModelError {
  constructor(public readonly failureKind: "boundary-violation" | "result-unknown", message: string) {
    super(message);
    this.name = "ModelHardStopError";
  }
}

/** Retry the same native search request without entering model/delegation fallback. */
export class ModelWebSearchError extends ModelError {
  constructor(public readonly code: string, public readonly retryable: boolean, status?: number) {
    super(`Web search failed (${code})`, status);
    this.name = "ModelWebSearchError";
  }
}

export class ProviderUnavailableError extends ModelError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "ProviderUnavailableError";
  }
}

export class ModelTimeoutError extends ProviderUnavailableError {
  constructor(
    message: string,
    public readonly failureKind: Extract<
      ModelFailureKind,
      "first-progress-timeout" | "stream-idle-timeout" | "transport-timeout"
    >
  ) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelRequestAbortedError extends ProviderUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestAbortedError";
  }
}

export class ModelConnectionError extends ProviderUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ModelConnectionError";
  }
}

export class ModelInvalidResponseError extends ProviderUnavailableError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "ModelInvalidResponseError";
  }
}

export class ModelUnsupportedInputError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnsupportedInputError";
  }
}

export function classifyModelFailure(error: ModelError): ModelFailureKind {
  if (error instanceof ModelHardStopError) return error.failureKind;
  if (error instanceof ModelWebSearchError) return error.retryable ? "service-unavailable" : "request-error";
  if (error instanceof ModelTimeoutError) return error.failureKind;
  if (error instanceof ModelRequestAbortedError) return "request-aborted";
  if (error instanceof ModelConnectionError) return "connection-error";
  if (error instanceof ModelInvalidResponseError) return "invalid-response";
  if (error instanceof ModelUnsupportedInputError) return "unsupported-input";
  if (error.status === 402) return "payment-required";
  if (error.status === 401 || error.status === 403) return "authentication";
  if (error.status === 408) return "http-timeout";
  if (error.status === 429) return "rate-limit";
  if (error.status !== undefined && error.status >= 500) return "service-unavailable";
  if (error.status !== undefined && error.status >= 400 && error.status < 500) return "request-error";
  if (error instanceof ProviderUnavailableError) return "service-unavailable";
  return "invalid-response";
}

/**
 * Raised for user-facing replies when the primary provider failed but a
 * configured alternate provider can continue the turn after confirmation.
 */
export class ModelFallbackRequiredError extends ProviderUnavailableError {
  constructor(
    message: string,
    public readonly failedProvider: Provider,
    public readonly fallbackProvider: Provider,
    public readonly kind: ModelFailureKind,
    status?: number,
    public readonly elapsedMs?: number,
    public readonly failedSupplier?: string,
    public readonly lastFailure?: SupplierFailure,
    public readonly selectableProviders?: Provider[]
  ) {
    super(message, status);
    this.name = "ModelFallbackRequiredError";
  }
}
