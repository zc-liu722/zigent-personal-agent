export const BROWSER_READ_TIMEOUT = "网页读取超时，请继续浏览后重新观察；不要重复提交。";
export const BROWSER_OPERATION_TIMEOUT = "浏览器操作超时，请继续浏览后重新观察；不要重复提交。";

export class BrowserTimeoutError extends Error {
  constructor(message = BROWSER_OPERATION_TIMEOUT) { super(message); this.name = "BrowserTimeoutError"; }
}

/** One deadline across queued work and all continuations; late native results are discarded. */
export class BrowserOperation {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly timer: NodeJS.Timeout;
  private readonly parentAbort: () => void;
  constructor(timeoutMs: number, private readonly parent?: AbortSignal, private readonly interrupted?: (reason: unknown) => void) {
    this.parentAbort = () => this.abort(parent?.reason ?? new DOMException("Cancelled", "AbortError"));
    this.timer = setTimeout(() => this.abort(new BrowserTimeoutError()), timeoutMs);
    parent?.addEventListener("abort", this.parentAbort, { once: true });
    if (parent?.aborted) this.parentAbort();
  }
  private abort(reason: unknown): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    this.interrupted?.(reason);
  }
  async wait<T>(work: () => Promise<T>, timeoutMs?: number, message = BROWSER_READ_TIMEOUT): Promise<T> {
    this.signal.throwIfAborted();
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) timer = setTimeout(() => this.abort(new BrowserTimeoutError(message)), timeoutMs);
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
    });
    try {
      return await Promise.race([cancelled, Promise.resolve().then(() => {
        this.signal.throwIfAborted(); return work();
      }).then(value => { this.signal.throwIfAborted(); return value; })]);
    } finally {
      clearTimeout(timer); this.signal.removeEventListener("abort", abort);
    }
  }
  cancel(reason: unknown = new DOMException("Cancelled", "AbortError")): void { this.abort(reason); }
  close(): void { clearTimeout(this.timer); this.parent?.removeEventListener("abort", this.parentAbort); }
}

export async function boundedBrowserWork<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  const operation = new BrowserOperation(timeoutMs);
  try { return await operation.wait(work); } finally { operation.close(); }
}
