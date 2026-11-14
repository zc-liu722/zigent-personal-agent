// Image rendering can remain silent for several minutes, independently of the
// text-model progress deadline. Keep one default for both image transports.
export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 6 * 60_000;
export const DEFAULT_IMAGE_GENERATION_RETRY_ATTEMPTS = 3;

// Completed images are persisted and delivered before this independent text budget.
export const DEFAULT_IMAGE_FINISH_TIMEOUT_MS = 30_000;

/** Only confirmed generation timeouts enter the retry loop, never text finalization. */
export class ImageGenerationTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "ImageGenerationTimeoutError"; }
}

export function isImageTransportTimeout(error: unknown): boolean {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause) {
    const code = (error as Error & { code?: string }).code;
    if (error.name === "TimeoutError" || code && ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)) return true;
  }
  return false;
}

export async function retryImageTimeouts<T>(operation: (retry: number) => Promise<T>, options: {
  maxRetries?: number; signal?: AbortSignal; canRetry?: () => boolean;
} = {}): Promise<T> {
  const maxRetries = Math.min(DEFAULT_IMAGE_GENERATION_RETRY_ATTEMPTS, options.maxRetries ?? DEFAULT_IMAGE_GENERATION_RETRY_ATTEMPTS);
  for (let retry = 0; ; retry++) {
    options.signal?.throwIfAborted();
    try { return await operation(retry); }
    catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof ImageGenerationTimeoutError) || options.canRetry?.() === false) throw error;
      if (retry >= maxRetries) throw new ImageGenerationTimeoutError(
        `${error.message} 自动重试已用尽（${maxRetries} 次）。`);
      console.warn("Image generation timed out; retrying", { retryAttempt: retry + 1, maxRetries });
    }
  }
}
