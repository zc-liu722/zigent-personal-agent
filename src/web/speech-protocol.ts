import type { IncomingMessage } from "node:http";
import { gunzipSync, gzipSync } from "node:zlib";
import type WebSocket from "ws";
import type { WebChannelConfig } from "../config.js";

export const SPEECH_PATH = "/deepmind/api/speech";
export const SPEECH_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";

// Provider controls verified 2026-11-01 against https://www.volcengine.com/docs/6561/1354869
// and https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1.
// Accelerated interim text is revised by the second pass; full snapshots let the
// composer reconcile those revisions without duplicating previously shown words.
export function speechRequest(uid: string) {
  return { user: { uid }, audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_nonstream: true,
      result_type: "full", enable_accelerate_text: true, accelerate_score: 20, end_window_size: 400 } };
}

// Adapted from the local AI Call project's tested Volcengine binary protocol.
export function speechFrame(payload: Buffer | object, audio = false, last = false): Buffer {
  const compressed = gzipSync(Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload)));
  const size = Buffer.alloc(4); size.writeUInt32BE(compressed.length);
  return Buffer.concat([Buffer.from([0x11, audio ? last ? 0x22 : 0x20 : 0x10, audio ? 0x01 : 0x11, 0]), size, compressed]);
}

export function parseSpeechFrame(bytes: Buffer): { text: string; final: boolean } {
  if (bytes.length < 8 || bytes[0] >> 4 !== 1) throw new Error("Invalid speech frame");
  const type = bytes[1] >> 4, flags = bytes[1] & 15;
  let offset = (bytes[0] & 15) * 4;
  if (offset < 4) throw new Error("Invalid speech header");
  const read = () => {
    if (offset + 4 > bytes.length) throw new Error("Truncated speech frame");
    const value = bytes.readUInt32BE(offset); offset += 4; return value;
  };
  // Provider error bodies may contain private data; never forward or log them.
  if (type === 15) throw new Error("Speech provider rejected request");
  if (type !== 9 || flags & 4) throw new Error("Unexpected speech frame");
  if (flags & 1) read();
  const size = read();
  if (size !== bytes.length - offset) throw new Error("Invalid speech payload size");
  let payload = bytes.subarray(offset);
  if ((bytes[2] & 15) === 1) payload = gunzipSync(payload, { maxOutputLength: 256_000 });
  else if ((bytes[2] & 15) !== 0) throw new Error("Unsupported speech compression");
  if (bytes[2] >> 4 !== 1) throw new Error("Unsupported speech serialization");
  const value = JSON.parse(payload.toString());
  if (value.code && ![1000, 20000000].includes(value.code)) throw new Error("Speech provider error");
  const results: unknown[] = Array.isArray(value.result) ? value.result : [value.result];
  const text = results.map(result => result && typeof result === "object" && "text" in result && typeof result.text === "string" ? result.text : "").join("");
  if (text.length > 16000) throw new Error("Speech result too long");
  return { text, final: Boolean(flags & 2) };
}

export type SpeechSocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
export type WebSpeechOptions = {
  config?: WebChannelConfig["speech"]; origin: string; path?: string;
  authenticate: (request: IncomingMessage) => boolean;
  device: (request: IncomingMessage) => string;
  connect?: SpeechSocketFactory;
};
