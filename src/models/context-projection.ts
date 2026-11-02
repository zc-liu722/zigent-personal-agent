import { createHash } from "node:crypto";
import type { ModelConversationMessage, ModelRoundRequest } from "./types.js";
import { assistantReplayText } from "./search-evidence.js";

/** Conservative Unicode-aware fallback. Provider-reported counts calibrate complete requests. */
export function estimateTextTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const character of text) { if (character.codePointAt(0)! <= 127) ascii++; else other++; }
  return Math.ceil(ascii / 3.5 + other * 1.25);
}

export function estimateMessageTokens(message: ModelConversationMessage): number {
  if (message.role === "tool") return 12 + estimateTextTokens(message.value);
  if (message.role === "user") return 12 + estimateTextTokens(message.text) + (message.images?.length ?? 0) * 4096;
  // Opaque reasoning is accounted conservatively, never logged or converted to plain instructions.
  return 12 + estimateTextTokens(assistantReplayText(message) + JSON.stringify(message.toolCalls)
    + (message.nativeState ? JSON.stringify(message.nativeState.items) : message.reasoningContent ?? ""));
}

export function estimateRequestTokens(request: ModelRoundRequest): number {
  return 64 + estimateTextTokens(request.systemPrompt ?? "")
    + estimateTextTokens(JSON.stringify(request.tools))
    + (request.nativeContext ? estimateNativeTokens(request.nativeContext.items, 0)
      : request.messages.reduce((total, message) => total + estimateMessageTokens(message), 0));
}

export function messageFingerprint(message: ModelConversationMessage): string {
  if (message.role === "assistant") return createHash("sha256").update(JSON.stringify({
    role: message.role, text: message.text, toolCalls: message.toolCalls, searchEvidence: message.searchEvidence
  })).digest("hex");
  const { contextRole: _contextRole, sourceTurnId: _sourceTurnId, ...plain } = message.role === "user" ? message : { ...message, contextRole: undefined, sourceTurnId: undefined };
  const value = message.role === "user" ? { ...plain, images: message.images?.map(image => ({
    mimeType: image.mimeType, sha256: createHash("sha256").update(image.data).digest("hex")
  })) } : message;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Retained canonical items count as well as the opaque item's reported output tokens. */
export function estimateNativeTokens(items: readonly Record<string, unknown>[], outputTokens: number): number {
  const text = JSON.stringify(items, (key, value) => {
    if (["encrypted_content", "signature"].includes(key)) return undefined;
    if (value && typeof value === "object" && ["image", "input_image"].includes(value.type)) return { image_token_estimate: 4096 };
    return value;
  });
  const images = (text.match(/image_token_estimate/g) ?? []).length;
  return outputTokens + estimateTextTokens(text) + images * 4096;
}

/** Cut only after complete tool exchanges; prefer a user-turn boundary near the token budget. */
export function safeCut(messages: readonly ModelConversationMessage[], keepTokens: number): number {
  const safe: number[] = [];
  const pending = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (!pending.size && index > 0) safe.push(index);
    if (message.role === "assistant") for (const call of message.toolCalls) pending.add(call.id);
    if (message.role === "tool") pending.delete(message.toolCallId);
  }
  if (!pending.size && messages.length) safe.push(messages.length);
  if (keepTokens === 0) return safe.at(-1) ?? 0;
  let tokens = 0, candidate = messages.length;
  for (let index = messages.length - 1; index >= 0; index--) {
    tokens += estimateMessageTokens(messages[index]!);
    candidate = index;
    if (tokens >= keepTokens) break;
  }
  const cuts = safe.filter(index => index <= candidate);
  const userBoundary = cuts.filter(index => messages[index]?.role === "user").at(-1);
  // A long single user turn may contain dozens of closed tool steps. Keep its
  // original user input separately while compacting an older closed prefix.
  if (userBoundary && messages.slice(userBoundary).reduce((sum, message) => sum + estimateMessageTokens(message), 0) <= keepTokens * 1.5) return userBoundary;
  return cuts.at(-1) ?? 0;
}

export function renderContextTranscript(messages: readonly ModelConversationMessage[]): string {
  return messages.map(message => message.role === "tool"
    ? `[tool result ${message.toolCallId}${message.failed ? " failed" : ""}]\n${message.value}`
    : message.role === "user" ? `[user${message.sourceTurnId ? ` turn=${message.sourceTurnId}` : ""}]\n${message.text}${message.images?.length ? `\n[${message.images.length} images; originals retained separately]` : ""}`
    : `[assistant]\n${assistantReplayText(message)}${message.toolCalls.length ? `\n[tool calls] ${JSON.stringify(message.toolCalls.map(call => ({ id: call.id, name: call.name, input: call.input })))}` : ""}`
  ).join("\n\n");
}
