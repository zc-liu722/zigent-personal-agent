import { SseDataFramer } from "./sse-framer.js";

/** Decode SSE data frames; the consumer decides when its protocol has completed. */
export async function readSseData(body: ReadableStream<Uint8Array>, onData: (data: string) => boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseDataFramer(onData);
  while (!frames.completed) {
    const { done, value } = await reader.read();
    frames.push(decoder.decode(value, { stream: !done }));
    if (done) break;
  }
  frames.finish();
  if (frames.completed) await reader.cancel().catch(() => undefined);
}
