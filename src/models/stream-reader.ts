import type { ModelProtocol } from "../config.js";
import { createAnthropicStreamReader } from "./anthropic-stream.js";
import { createResponsesStreamReader } from "./responses-stream.js";
import type { StreamEventReader } from "./stream-types.js";

/** A fresh reader per request attempt keeps protocol state out of retries and fallback. */
export function streamReaderFor(protocol: ModelProtocol): StreamEventReader {
  return protocol === "anthropic-messages" ? createAnthropicStreamReader() : createResponsesStreamReader();
}
