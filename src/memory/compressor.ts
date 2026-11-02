import type { ChatMessage, CompressionResult, ConversationCompressor, Session, TokenUsage, ModelUsageIdentity } from "./types.js";
import type { Provider, ReasoningEffort } from "../config.js";
import { renderMessageForSummary } from "./transcript.js";
import { estimateTextTokens } from "../models/context-projection.js";
import type { ContextPolicy } from "../models/context-policy.js";

export type SummaryGenerator = (input: {
  previousSummary?: string; messages: ChatMessage[];
  signal?: AbortSignal; reasoningEfforts?: Readonly<Record<string, ReasoningEffort>>;
}, provider?: Provider) => Promise<{ text: string; usage: TokenUsage; model?: string; modelIdentity?: ModelUsageIdentity }>;

export const estimateTokens = estimateTextTokens;

function messagesSinceLatestSummary(session: Session, currentTurnId: number): ChatMessage[] {
  return session.messages.filter(message => (message.role === "user" || message.role === "assistant")
    && message.turnId >= (session.summary?.turnId ?? 1) && message.turnId < currentTurnId);
}

export class RollingSummaryCompressor implements ConversationCompressor {
  constructor(private readonly generateSummary: SummaryGenerator,
    private readonly policy: (provider?: Provider, signal?: AbortSignal) => Promise<ContextPolicy>) {}

  private async plan(session: Session, currentTurnId: number, provider?: Provider, overhead = 0, signal?: AbortSignal) {
    const policy = await this.policy(provider, signal);
    const messages = messagesSinceLatestSummary(session, currentTurnId);
    const turns = [...new Set(messages.map(message => message.turnId))];
    let keptTokens = 0, boundary = currentTurnId;
    // Retain complete recent turns, including all their tool exchanges.
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index]!;
      const tokens = estimateTokens(messages.filter(message => message.turnId === turn).map(renderMessageForSummary).join("\n"));
      if (boundary !== currentTurnId && keptTokens + tokens > policy.keepRecent) break;
      keptTokens += tokens; boundary = turn;
    }
    const older = messages.filter(message => message.turnId < boundary);
    const current = session.messages.find(message => message.role === "user" && message.turnId === currentTurnId);
    const total = overhead + estimateTokens([session.summary?.content ?? "", ...messages.map(renderMessageForSummary),
      current ? renderMessageForSummary(current) : ""].join("\n"));
    // Native routes persist their exact-route checkpoint at the request boundary.
    // A portable archive must not preempt the native driver's first compaction.
    return { older, boundary, needed: !["openai-native", "anthropic-native"].includes(policy.strategy)
      && older.length > 0 && total >= policy.trigger };
  }

  async shouldCompress(session: Session, currentTurnId: number, provider?: Provider, overhead = 0, signal?: AbortSignal): Promise<boolean> {
    return (await this.plan(session, currentTurnId, provider, overhead, signal)).needed;
  }

  async compress(session: Session, currentTurnId: number, provider?: Provider, signal?: AbortSignal,
    reasoningEfforts?: Readonly<Record<string, ReasoningEffort>>): Promise<CompressionResult> {
    const plan = await this.plan(session, currentTurnId, provider, 0, signal);
    if (!plan.older.length) throw new Error("No safe historical turns to compress");
    const generated = await this.generateSummary({ previousSummary: session.summary?.content, messages: plan.older, signal, reasoningEfforts }, provider);
    if (estimateTokens(generated.text) >= estimateTokens([session.summary?.content ?? "", ...plan.older.map(renderMessageForSummary)].join("\n"))) {
      throw new Error("Context summary did not reduce the historical prefix");
    }
    return { summary: { content: generated.text, updatedAt: Date.now(), turnId: plan.boundary }, usage: generated.usage,
      model: generated.model, modelIdentity: generated.modelIdentity };
  }
}
