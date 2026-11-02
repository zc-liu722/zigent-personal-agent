import { createHash } from "node:crypto";
import type { ModelDeployment } from "../config.js";
import type { TokenUsage } from "../memory/types.js";
import type { ModelGatewayConfig } from "./gateway-config.js";
import { contextPolicy, type ContextPolicy } from "./context-policy.js";
import { estimateMessageTokens, estimateNativeTokens, estimateRequestTokens, estimateTextTokens, messageFingerprint, renderContextTranscript, safeCut } from "./context-projection.js";
import { addTokenUsage, ContextSummaryError } from "./context-summary.js";
import { contextEvidence, renderContextEvidence, type ContextEvidence } from "./context-evidence.js";
import { modelRequestDispatcher } from "./http-transport.js";
import { ModelContextOverflowError } from "./errors.js";
import { anthropicConversation, openAiConversation } from "./provider-formats.js";
import type { ModelConversationMessage, ModelRoundRequest, ModelRoundResult } from "./types.js";

type Checkpoint = { hashes: string[]; summary?: string; native?: Record<string, unknown>[]; nativeTokens?: number;
  anchors: ModelConversationMessage[]; promptHash: string; binding: string; evidence?: ContextEvidence; generation?: number;
  stats?: { createdAt: number; before: number; after: number; reason: "threshold" | "overflow" | "source_rebuild";
    durationMs: number; strategy: ContextPolicy["strategy"]; generation: number } };
export type SavedContextCheckpoint = { model: string; checkpoint: Checkpoint };
export type ContextPersistence = {
  load(): Promise<SavedContextCheckpoint[]>;
  save(checkpoints: SavedContextCheckpoint[]): Promise<void>;
};
export type ContextRunState = {
  checkpoints: Map<string, Checkpoint>;
  calibration: Map<string, number>;
  nativeUnavailable: Set<string>;
  /** Applied projection edits remain stable throughout the run; raw messages never change. */
  prunedResults: Map<string, Set<string>>;
  /** Supplier-reported rejection limits belong to this run, never other sessions. */
  reportedWindows: Map<string, number>;
  persistence?: ContextPersistence;
};
export const createContextRunState = (): ContextRunState => ({ checkpoints: new Map(), calibration: new Map(), nativeUnavailable: new Set(), prunedResults: new Map(), reportedWindows: new Map() });
export type ContextPreparation = { request: ModelRoundRequest; estimated: number; usage: TokenUsage; policy: ContextPolicy };
type SummaryGenerator = (route: ModelDeployment, transcript: string, previous?: string,
  signal?: AbortSignal, reasoningEfforts?: ModelRoundRequest["reasoningEfforts"], policy?: ContextPolicy) => Promise<{ text: string; usage: TokenUsage }>;
type NativeGenerator = (route: ModelDeployment, request: ModelRoundRequest,
  signal?: AbortSignal) => Promise<{ items: Record<string, unknown>[]; usage: TokenUsage }>;

function withoutReasoning(messages: readonly ModelConversationMessage[]): ModelConversationMessage[] {
  return messages.map(message => message.role === "assistant" ? { ...message, reasoningContent: undefined,
    nativeState: message.nativeState ? { ...message.nativeState, items: message.nativeState.items.filter(item =>
      item && typeof item === "object" && !["thinking", "redacted_thinking", "reasoning", "compaction"].includes(String((item as { type?: unknown }).type))) } : undefined } : message);
}

/** OpenAI may preserve original user items verbatim. Keep fallback anchors in the
 * checkpoint, but do not append the same text/images to its canonical window again.
 * Opaque-only (including Anthropic) output cannot establish exact preservation. */
function missingNativeAnchors(anchors: readonly ModelConversationMessage[], native?: readonly Record<string, unknown>[]): ModelConversationMessage[] {
  if (!native) return [...anchors];
  return anchors.filter(anchor => {
    if (anchor.role !== "user") return true;
    const images = (anchor.images ?? []).map(image => `data:${image.mimeType};base64,${image.data.toString("base64")}`);
    return !native.some(item => {
      if (item.role !== "user") return false;
      const parts: Record<string, unknown>[] = typeof item.content === "string" ? [{ type: "input_text", text: item.content }]
        : Array.isArray(item.content) ? item.content.filter(part => part && typeof part === "object") : [];
      const texts = parts.filter(part => ["input_text", "text"].includes(String(part.type))).map(part => part.text).join("");
      const urls = parts.filter(part => part.type === "input_image").map(part => part.image_url);
      return (anchor.contextRole === "pinned" && images.length > 0 || texts === anchor.text)
        && images.every(url => urls.includes(url));
    });
  });
}

export class ModelContextManager {
  private readonly discoveries = new Map<string, { until: number; value: Promise<ModelDeployment> }>();
  private readonly catalogues = new Map<string, { until: number; value: Promise<Array<Record<string, unknown>>> }>();
  private readonly runtimeWindows = new Map<string, number>();
  private readonly nativeDeniedUntil = new Map<string, number>();
  constructor(private readonly config: ModelGatewayConfig, private readonly summarize: SummaryGenerator,
    private readonly native: NativeGenerator) {}

  async policy(route: ModelDeployment, signal?: AbortSignal): Promise<ContextPolicy> {
    signal?.throwIfAborted();
    // Discovery is shared with other turns and may already be warming. Cancel
    // this caller's wait without cancelling the shared bounded request.
    const discovery = this.discover(route);
    const resolved = signal ? await new Promise<ModelDeployment>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      discovery.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    }) : await discovery;
    const runtime = this.runtimeWindows.get(route.name);
    const window = runtime ?? resolved.context?.windowTokens ?? 32_768;
    const policy = contextPolicy({ ...resolved, ...(resolved.context ? { context: { ...resolved.context, windowTokens: window } } : {}) }, this.config);
    return { ...policy, hardLimit: policy.hardLimit || runtime !== undefined,
      limitSource: runtime !== undefined ? "runtime" : policy.limitSource };
  }

  private async discover(route: ModelDeployment): Promise<ModelDeployment> {
    const url = route.context?.discoveryUrl;
    if (!url) return route;
    const existing = this.discoveries.get(route.name);
    if (existing && existing.until > Date.now()) return existing.value;
    const value = (async () => {
      try {
        const key = `${url}:${route.network}:${createHash("sha256").update(route.apiKey ?? "").digest("hex")}`;
        let catalogue = this.catalogues.get(key);
        if (!catalogue || catalogue.until <= Date.now()) {
          const listing = (async () => {
            const response = await fetch(url, { headers: route.apiKey ? { Authorization: `Bearer ${route.apiKey}` } : {},
              signal: AbortSignal.timeout(5000),
              ...({ dispatcher: modelRequestDispatcher(this.config, url, route.network) } as object) });
            if (!response.ok) { await response.body?.cancel(); return []; }
            const data = await response.json() as { data?: Array<Record<string, unknown>> };
            return Array.isArray(data.data) ? data.data : [];
          })();
          catalogue = { until: Date.now() + 15 * 60_000, value: listing };
          this.catalogues.set(key, catalogue);
          void listing.catch(() => this.catalogues.delete(key));
        }
        const model = (await catalogue.value).find(entry => entry && entry.id === route.apiModel);
        const count = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0 ? entry : undefined;
        const reportedWindow = count(model?.context_length ?? model?.context_window ?? model?.context_size);
        if (!reportedWindow || reportedWindow < 4096 || !route.context) return route;
        const window = reportedWindow;
        console.info("MODEL_CONTEXT_DISCOVERY", { agent: this.config.id, model: route.name, windowTokens: window });
        return { ...route, context: { ...route.context, windowTokens: window, confidence: "verified" as const, limitSource: "supplier" as const,
          maxInputTokens: count(model?.max_input_tokens) ?? route.context.maxInputTokens,
          maxOutputTokens: count(model?.max_output_tokens ?? model?.max_tokens) ?? route.context.maxOutputTokens } };
      } catch {
        console.warn("MODEL_CONTEXT_DISCOVERY_UNAVAILABLE", { agent: this.config.id, model: route.name });
        return route;
      }
    })();
    this.discoveries.set(route.name, { until: Date.now() + 15 * 60_000, value });
    try { return await value; } catch (error) { this.discoveries.delete(route.name); throw error; }
  }

  observe(route: ModelDeployment, prepared: ContextPreparation, result: ModelRoundResult): void {
    if (result.contextWindowTokens && result.contextWindowTokens >= 4096) this.runtimeWindows.set(route.name, result.contextWindowTokens);
    const state = prepared.request.contextState;
    if (state && route.protocol !== "codex-app-server" && route.protocol !== "claude-code"
      && !result.webSearchCalls.length && result.usage.inputTokens > 0 && prepared.estimated > 0) {
      // prepared.estimated already includes the previous calibration; recover
      // the absolute factor so a second under-estimate can increase it again.
      const factor = Math.max(1, (state.calibration.get(route.name) ?? 1) * result.usage.inputTokens / prepared.estimated * 1.1);
      state.calibration.set(route.name, Math.max(state.calibration.get(route.name) ?? 1, Math.min(8, factor)));
    }
  }

  async prepare(route: ModelDeployment, original: ModelRoundRequest, signal?: AbortSignal,
    recovery?: { reason: "overflow" | "native-replay"; window?: number; rejectedEstimate: number }): Promise<ContextPreparation> {
    signal?.throwIfAborted();
    let policy = await this.policy(route, signal);
    const force = recovery !== undefined;
    const state = original.contextState ?? createContextRunState();
    const scale = state.calibration.get(route.name) ?? 1;
    const estimate = (request: ModelRoundRequest) => Math.ceil(estimateRequestTokens(request) * scale);
    const emptyUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    let usage = emptyUsage();
    if (recovery?.reason === "overflow" && recovery.window !== undefined && recovery.window >= 4096) {
      state.reportedWindows.set(route.name, Math.min(state.reportedWindows.get(route.name) ?? Infinity, recovery.window));
    }
    const reportedWindow = state.reportedWindows.get(route.name);
    if (reportedWindow !== undefined) {
      // Do not turn an estimated request size (or a native replay error) into a
      // fictitious model window. An exact numeric rejection applies to this run.
      policy = contextPolicy({ ...route, context: { ...route.context!, windowTokens: reportedWindow, confidence: "verified", limitSource: "supplier" } }, this.config);
    }
    if (force) {
      state.checkpoints.delete(route.name);
      state.nativeUnavailable.add(route.name);
      this.nativeDeniedUntil.set(route.name, Date.now() + 60 * 60_000);
    }
    const pinned = original.messages.filter(message => message.role === "user" && message.contextRole === "pinned");
    const volatile = original.messages.filter(message => message.role === "user" && message.contextRole === "volatile");
    let source = original.messages.filter(message => message.role !== "user" || !["pinned", "volatile"].includes(message.contextRole ?? ""));
    if (!source.some(message => message.role === "user" && message.contextRole === "current")) {
      const lastUser = source.map(message => message.role).lastIndexOf("user");
      source = source.map((message, index) => index === lastUser && message.role === "user" ? { ...message, contextRole: "current" } : message);
    }
    const hashes = source.map(messageFingerprint);
    const credentialScope = createHash("sha256").update(route.apiKey ?? route.codexHome ?? route.supplier).digest("hex");
    const binding = `${route.name}:${route.protocol}:${route.supplier}:${route.apiModel}:${credentialScope}`;
    const promptHash = createHash("sha256").update(original.systemPrompt ?? "").update(JSON.stringify(original.tools)).digest("hex");
    let checkpoint = state.checkpoints.get(route.name);
    if (checkpoint && (checkpoint.binding !== binding || checkpoint.native && checkpoint.promptHash !== promptHash
      || checkpoint.evidence && (checkpoint.evidence.messageCount !== checkpoint.hashes.length
        || checkpoint.evidence.sourceHash !== createHash("sha256").update(checkpoint.hashes.join("\n")).digest("hex"))
      || !checkpoint.hashes.every((hash, index) => hashes[index] === hash))) {
      state.checkpoints.delete(route.name); checkpoint = undefined;
    }
    if (checkpoint) {
      const current = new Set(source.filter(message => message.role === "user" && message.contextRole === "current").map(messageFingerprint));
      checkpoint = { ...checkpoint, anchors: checkpoint.anchors.filter(message => message.role !== "user"
        || message.contextRole !== "current" || current.has(messageFingerprint(message))) };
    }
    const startedAt = Date.now();
    const liveRecall = original.tools.some(tool => tool.type === "function" && tool.name === "conversation_history");
    const ambiguousCalls = new Set<string>(), resultHashes = new Map<string, string>();
    for (const message of source) if (message.role === "tool") {
      const hash = messageFingerprint(message), previousHash = resultHashes.get(message.toolCallId);
      if (previousHash && previousHash !== hash) ambiguousCalls.add(message.toolCallId);
      resultHashes.set(message.toolCallId, hash);
    }
    const pruned = state.prunedResults.get(route.name) ?? new Set<string>();
    state.prunedResults.set(route.name, pruned);
    const omission = (message: Extract<ModelConversationMessage, { role: "tool" }>): ModelConversationMessage => ({ ...message,
      value: `[Older tool output offloaded; failed=${message.failed}. Recover exact reference evidence with conversation_history ${JSON.stringify({
        action: "read_live_tool", tool_call_id: message.toolCallId,
        expected_hash: createHash("sha256").update(message.value).digest("hex") })}. Do not infer omitted details or repeat the original action.]` });
    let messages = source.slice(checkpoint?.hashes.length ?? 0);
    if (liveRecall && pruned.size) messages = withoutReasoning(messages.map(message => message.role === "tool"
      && !ambiguousCalls.has(message.toolCallId) && pruned.has(messageFingerprint(message)) ? omission(message) : message));
    const format = (history: readonly ModelConversationMessage[]) => route.protocol === "openai-responses"
      ? openAiConversation(withoutReasoning(history), { ...route, capabilities: route.capabilities! })
      : anthropicConversation(withoutReasoning(history), { ...route, capabilities: route.capabilities! });
    const build = (history: readonly ModelConversationMessage[], summary = checkpoint?.summary): ModelRoundRequest => {
      const projected: ModelRoundRequest = {
        ...original, contextState: state, maxOutputTokens: Math.min(original.maxOutputTokens ?? policy.output, policy.output),
        messages: [...pinned, ...(summary ? [{ role: "user" as const, text: `<session_checkpoint trust="derived">\n${summary}\n</session_checkpoint>` }] : []),
          ...(checkpoint?.evidence ? [{ role: "user" as const,
            text: renderContextEvidence(checkpoint.evidence, liveRecall, Math.min(1024, Math.max(256, policy.summary / 4))) }] : []),
          ...missingNativeAnchors(checkpoint?.anchors ?? [], checkpoint?.native), ...history, ...volatile], nativeContext: undefined
      };
      if (checkpoint?.native) projected.nativeContext = { route: route.name, protocol: route.protocol,
        items: [...checkpoint.native, ...format(projected.messages)] };
      return projected;
    };
    let request = build(messages);
    const measured = () => checkpoint?.native && request.nativeContext
      ? Math.ceil(Math.max(estimateRequestTokens(request), (checkpoint.nativeTokens ?? policy.target)
        + estimateRequestTokens({ ...request, nativeContext: undefined })) * scale)
      : estimate(request);
    const irreducible = estimate({ ...original, nativeContext: undefined, messages: [...pinned, ...volatile,
      ...source.filter(message => message.role === "user" && message.contextRole === "current"),
      ...source.filter(message => message.role === "user" && message.contextRole !== "current" && message.images?.length)
        .map(message => ({ ...message, text: "" }))] });
    // An advisory window smaller than fixed tools/instructions must not force a
    // summary after every tiny tool result. Wait for a useful historical prefix
    // beyond the retained tail and checkpoint allowance; this is not a new model limit.
    const trigger = policy.hardLimit ? policy.trigger : Math.max(policy.trigger, irreducible + policy.keepRecent + policy.summary);
    if (!force && measured() < trigger) return { request, estimated: measured(), usage, policy };

    const before = measured();
    const fits = (tokens: number) => !policy.hardLimit || tokens <= policy.inputLimit;
    const canContinue = (tokens: number) => fits(tokens)
      && (recovery?.reason !== "overflow" || tokens < recovery.rejectedEstimate);
    const diagnostic = (reason: string, after = before) => ({ agent: this.config.id, model: route.name, reason,
      hardLimit: policy.hardLimit, window: policy.window, inputLimit: policy.inputLimit, trigger, irreducible, before, after,
      systemTokens: estimateTextTokens(original.systemPrompt ?? ""), toolTokens: estimateTextTokens(JSON.stringify(original.tools)),
      pinnedTokens: pinned.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
      sourceMessages: source.length, sourceImages: source.reduce((sum, message) => sum + (message.role === "user" ? message.images?.length ?? 0 : 0), 0),
      calibration: scale, recovery: recovery?.reason });
    const unchanged = (reason: string): ContextPreparation => {
      console.info("MODEL_CONTEXT_ADMISSION", diagnostic(reason, measured()));
      if (!canContinue(measured())) throw new ModelContextOverflowError();
      return { request, estimated: measured(), usage, policy };
    };
    // First reclaim old bulky observations, preserving pending decisions and protected tools.
    const calls = new Map(source.flatMap(message => message.role === "assistant" ? message.toolCalls.map(call => [call.id, call.name] as const) : []));
    let recent = 0, reclaimed = 0;
    const newlyPruned: string[] = [];
    const edited = [...messages];
    for (let index = edited.length - 1; index >= 0; index--) {
      const message = edited[index]!;
      recent += estimateMessageTokens(message);
      if (!liveRecall || recent <= policy.keepRecent || message.role !== "tool" || ambiguousCalls.has(message.toolCallId)
        || policy.protectedTools.includes(calls.get(message.toolCallId) ?? "")
        || /pending_confirmation|requires_confirmation|"status"\s*:\s*"pending"/.test(message.value)) continue;
      if (estimateMessageTokens(message) < 512) continue;
      const replacement = omission(message);
      reclaimed += estimateMessageTokens(message) - estimateMessageTokens(replacement);
      edited[index] = replacement;
      newlyPruned.push(messageFingerprint(message));
    }
    if (reclaimed >= Math.max(1024, policy.window * 0.01)) {
      for (const hash of newlyPruned) pruned.add(hash);
      messages = withoutReasoning(edited); request = build(messages);
      if (measured() < trigger && canContinue(measured())) {
        console.info("MODEL_CONTEXT_PRUNED", { agent: this.config.id, model: route.name, before, after: measured(), reclaimed });
        return { request, estimated: measured(), usage, policy };
      }
    }
    let cut = safeCut(messages, Math.min(policy.keepRecent, force ? policy.target * 0.5 : policy.keepRecent));
    if ((policy.hardLimit || recovery?.reason === "overflow")
      && estimate(build(messages.slice(cut))) + policy.summary >= policy.inputLimit) cut = safeCut(messages, 0);
    if (!cut) return unchanged("no_closed_prefix");
    // A current-only prefix cannot shrink: the user input must be restored as
    // an anchor, so adding its summary would only make the request larger.
    if (!messages.slice(0, cut).some(message => message.role !== "user" || message.contextRole !== "current")) {
      return unchanged("current_input_only");
    }
    if (policy.hardLimit && irreducible > policy.inputLimit) {
      console.warn("MODEL_CONTEXT_IRREDUCIBLE", diagnostic("fixed_context_exceeds_verified_limit", irreducible));
      throw new ModelContextOverflowError();
    }
    original.onContextProgress?.();
    // Projection edits must never become the evidence used to generate a checkpoint.
    const prefixStart = checkpoint?.hashes.length ?? 0;
    const prefix = source.slice(prefixStart, prefixStart + cut), tail = messages.slice(cut);
    const fullPrefix = source.slice(0, prefixStart + cut);
    const evidence = contextEvidence(fullPrefix);
    const generation = (checkpoint?.generation ?? 0) + 1;
    // Periodically rebuild from all source still available to this run. This cannot
    // restore session history already archived before the run; its references remain.
    const rebuild = Boolean(checkpoint && (checkpoint.native || !checkpoint.evidence || generation % 4 === 0));
    const previous = checkpoint;
    // Successful reversible tool offloading remains a valid fallback even if
    // summarization fails. Keep this complete projection before staging a new
    // checkpoint; rebuilding from raw source can needlessly overflow again.
    const fallbackRequest = request;
    const fallbackEstimate = measured();
    let checkpointEstimate: number | undefined;
    try {
      let native: Record<string, unknown>[] | undefined, nativeTokens: number | undefined;
      let sourceRebuilt = false;
      let summary = rebuild ? undefined : checkpoint?.summary;
      if (["openai-native", "anthropic-native"].includes(policy.strategy) && !state.nativeUnavailable.has(route.name)
        && (this.nativeDeniedUntil.get(route.name) ?? 0) < Date.now()) {
        const nativeMessages: ModelConversationMessage[] = [
          ...(checkpoint?.summary ? [{ role: "user" as const, text: `<session_checkpoint trust="derived">${checkpoint.summary}</session_checkpoint>` }] : []),
          ...missingNativeAnchors(checkpoint?.anchors ?? [], checkpoint?.native), ...prefix];
        const nativeRequest: ModelRoundRequest = { ...build(prefix), messages: nativeMessages, nativeContext: undefined };
        if (checkpoint?.native) nativeRequest.nativeContext = { route: route.name, protocol: route.protocol,
          items: [...checkpoint.native, ...format(nativeMessages)] };
        // Native compact inputs must themselves fit. Oversized prefixes use the portable chunked summarizer.
        const nativeEstimate = checkpoint?.native ? Math.ceil(Math.max(estimateRequestTokens(nativeRequest),
          (checkpoint.nativeTokens ?? policy.target) + estimateRequestTokens({ ...nativeRequest, nativeContext: undefined })) * scale) : estimate(nativeRequest);
        if (nativeEstimate < policy.inputLimit) {
          try {
            const compacted = await this.native(route, nativeRequest, signal);
            usage = addTokenUsage(usage, compacted.usage); native = compacted.items;
            nativeTokens = estimateNativeTokens(compacted.items, compacted.usage.outputTokens);
          } catch (error) {
            if (signal?.aborted) throw error;
            state.nativeUnavailable.add(route.name);
            this.nativeDeniedUntil.set(route.name, Date.now() + 60 * 60_000);
            console.warn("MODEL_CONTEXT_NATIVE_UNAVAILABLE", { agent: this.config.id, model: route.name, kind: error instanceof Error ? error.name : "unknown" });
          }
        }
      }
      if (!native) {
        const generated = await this.summarize(route, renderContextTranscript(rebuild ? fullPrefix : prefix), summary, signal, original.reasoningEfforts, policy);
        usage = addTokenUsage(usage, generated.usage); summary = generated.text;
        sourceRebuilt = rebuild;
      }
      // Keep original image bytes independently from a lossy text summary.
      const imageMemory = prefix.flatMap(message => message.role === "user" && message.images?.length
        && message.contextRole !== "current"
        ? [{ ...message, text: `[Images from compressed history${message.sourceTurnId ? ` turn ${message.sourceTurnId}` : ""}]`, contextRole: "pinned" as const }] : []);
      const currentInput = prefix.filter(message => message.role === "user" && message.contextRole === "current");
      let next: Checkpoint = { hashes: hashes.slice(0, prefixStart + cut), promptHash, binding, evidence, generation,
        anchors: [...(checkpoint?.anchors ?? []), ...imageMemory, ...currentInput],
        ...(native ? { native, nativeTokens } : { summary }) };
      checkpoint = next;
      request = build(withoutReasoning(tail));
      messages = tail;
      let after = measured();
      if (native && (after >= before || !fits(after))) {
        // Some native endpoints retain all user messages. A large user document
        // can therefore need portable compression even after a valid native pass.
        checkpoint = previous;
        const generated = await this.summarize(route, renderContextTranscript(fullPrefix), undefined, signal, original.reasoningEfforts, policy);
        usage = addTokenUsage(usage, generated.usage);
        sourceRebuilt = true;
        native = undefined;
        next = { ...next, native: undefined, nativeTokens: undefined, summary: generated.text };
        checkpoint = next;
        request = build(withoutReasoning(tail));
        after = measured();
        state.nativeUnavailable.add(route.name);
      }
      checkpointEstimate = after;
      if (after >= before || !canContinue(after)) { checkpoint = previous; throw new ModelContextOverflowError(); }
      signal?.throwIfAborted();
      next.stats = { createdAt: Date.now(), before, after, reason: force ? "overflow" : sourceRebuilt ? "source_rebuild" : "threshold",
        durationMs: Date.now() - startedAt, strategy: native ? policy.strategy : "summary", generation };
      state.checkpoints.set(route.name, next);
      if (state.persistence) {
        const serializable = [...state.checkpoints].filter(([, entry]) => !entry.anchors.some(message => message.role === "user" && message.images?.length))
          .map(([model, checkpoint]) => ({ model, checkpoint }));
        try { await state.persistence.save(serializable); }
        catch (error) { console.warn("MODEL_CONTEXT_CHECKPOINT_SAVE_FAILED", { agent: this.config.id, kind: error instanceof Error ? error.name : "unknown" }); }
      }
      console.info("MODEL_CONTEXT_COMPACTED", { agent: this.config.id, model: route.name, strategy: native ? policy.strategy : "summary",
        window: policy.window, trigger, before, after, keptMessages: tail.length, recovery: force,
        sourceMessages: evidence.messageCount, generation, sourceRebuilt, durationMs: next.stats.durationMs });
      return { request, estimated: after, usage, policy };
    } catch (error) {
      checkpoint = previous;
      if (error instanceof ContextSummaryError) usage = addTokenUsage(usage, error.usage);
      if (signal?.aborted) throw error;
      console.warn("MODEL_CONTEXT_COMPACTION_FAILED", { ...diagnostic("checkpoint_rejected", checkpointEstimate ?? fallbackEstimate),
        kind: error instanceof Error ? error.name : "unknown" });
      // A provider-rejected request never retries unchanged. Ordinary auxiliary
      // failures may use the earlier complete projection only while it fits.
      if (canContinue(fallbackEstimate)) return { request: fallbackRequest, estimated: fallbackEstimate, usage, policy };
      throw new ModelContextOverflowError();
    }
  }
}
