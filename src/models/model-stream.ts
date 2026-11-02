import { ModelInvalidResponseError } from "./errors.js";
import { readSseData } from "./sse.js";
import { createStreamAccumulator } from "./stream-accumulator.js";
import type { ModelTextResult, StreamEventReader, StreamUpdate } from "./stream-types.js";

/** Connect framing, protocol normalization and aggregation without owning request retries. */
export async function readModelStream(body: ReadableStream<Uint8Array>, readEvent: StreamEventReader,
  markProgress: () => void, onUpdate?: (update: StreamUpdate) => void
): Promise<ModelTextResult & { completed: boolean }> {
  const accumulator = createStreamAccumulator();
  await readSseData(body, data => {
    if (data === "[DONE]") { accumulator.complete(); markProgress(); return true; }
    let parsed: unknown;
    try { parsed = JSON.parse(data); }
    catch { throw new ModelInvalidResponseError("Model returned an invalid stream event"); }
    const update = readEvent(parsed);
    if (update.progress) markProgress();
    const normalized = accumulator.apply(update);
    onUpdate?.(normalized);
    return accumulator.completed;
  });
  return accumulator.result();
}
