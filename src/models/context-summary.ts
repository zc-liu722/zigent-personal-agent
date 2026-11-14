import type { TokenUsage } from "../memory/types.js";
import type { ContextPolicy } from "./context-policy.js";
import { ContextAnalysis, estimateTextTokens } from "./context-projection.js";
import { ModelInvalidResponseError } from "./errors.js";
import type { ModelConversationMessage, ModelRoundRequest, ModelRoundResult } from "./types.js";

/*
 * Prompt and checkpoint framing from DeepSeek Harness, pinned to
 * https://github.com/deepseek-ai/deepseek-harness/blob/e8f7b93a344964de3dca1ace9e72b6e4d6de87cb/packages/compaction/compaction-basic/src/summarizer.ts
 *
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const SUMMARY_OPEN_TAG = '<compacted-summary>';
const SUMMARY_CLOSE_TAG = '</compacted-summary>';

/**
 * The summarization directive, delivered as the FINAL user message after the
 * replayed conversation rather than as a distinct summarizer system prompt.
 * Keeping the conversation's own system prompt, tools, and message prefix in
 * front of it makes the auxiliary call a genuine prefix of the last routed
 * request, so the provider's KV cache is reused instead of invalidated.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');

/** Framing that makes the replacement user message established context. */
const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return { inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    ...(left.cacheWriteTokens !== undefined || right.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0) } : {}),
    ...(left.cacheWriteTokens5m !== undefined || right.cacheWriteTokens5m !== undefined
      ? { cacheWriteTokens5m: (left.cacheWriteTokens5m ?? 0) + (right.cacheWriteTokens5m ?? 0) } : {}),
    ...(left.cacheWriteTokens1h !== undefined || right.cacheWriteTokens1h !== undefined
      ? { cacheWriteTokens1h: (left.cacheWriteTokens1h ?? 0) + (right.cacheWriteTokens1h ?? 0) } : {}),
    cacheHitTokensReported: left.cacheHitTokensReported || right.cacheHitTokensReported };
}

/** Completed auxiliary calls still count when a later chunk or validation fails. */
export class ContextSummaryError extends ModelInvalidResponseError {
  constructor(public readonly usage: TokenUsage, cause: unknown) {
    super("Context checkpoint generation failed");
    this.name = "ContextSummaryError";
    this.cause = cause;
  }
}

export function harnessCheckpoint(text: string): ModelConversationMessage {
  return { role: "user", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${text}\n${SUMMARY_CLOSE_TAG}` };
}

export function harnessRequest(prefix: ModelRoundRequest, policy: ContextPolicy, scale: number): ModelRoundRequest | undefined {
  const maxOutputTokens = Math.min(policy.output, policy.summary * 4);
  const request: ModelRoundRequest = {
    ...prefix,
    codexChat: undefined,
    messages: [...prefix.messages, { role: "user", text: COMPACTION_INSTRUCTION }],
    toolChoice: "none",
    maxOutputTokens
  };
  const analysis = new ContextAnalysis();
  const inputLimit = Math.min(policy.inputLimit + policy.output - maxOutputTokens, policy.window - policy.safety - maxOutputTokens);
  return Math.ceil(analysis.requestTokens(request) * scale) < inputLimit ? request : undefined;
}

export async function summarizeWithDeepSeekHarness(
  prefix: ModelRoundRequest,
  policy: ContextPolicy,
  scale: number,
  call: (request: ModelRoundRequest) => Promise<ModelRoundResult>,
  signal?: AbortSignal
): Promise<{ text: string; usage: TokenUsage }> {
  const request = harnessRequest(prefix, policy, scale);
  if (!request) throw new ModelInvalidResponseError("DeepSeek Harness compaction input exceeds its budget");
  signal?.throwIfAborted();
  const result = await call(request);
  signal?.throwIfAborted();
  const text = (result.textItems.some(item => item.phase === "final_answer")
    ? result.textItems.filter(item => item.phase === "final_answer").map(item => item.text).join("\n\n")
    : result.text).trim();
  if (!text || result.toolCalls.length || result.webSearchCalls.length || result.requiresContinuation
    || /length|max[-_]tokens|incomplete/.test(result.stopReason ?? "") || estimateTextTokens(text) > policy.summary * 1.5) {
    throw new ContextSummaryError(result.usage, new ModelInvalidResponseError("DeepSeek Harness checkpoint is incomplete or exceeds its budget"));
  }
  return { text, usage: result.usage };
}
