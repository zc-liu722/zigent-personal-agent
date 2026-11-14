import { randomUUID } from "node:crypto";
import type { Provider } from "../config.js";
import type { ModelConversationMessage } from "../models/types.js";
import type { TokenUsage } from "../memory/types.js";
import { addTokenUsage } from "../models/context-summary.js";
import type { SubagentControl, SubagentInput } from "../tools/subagents.js";
import type { ToolExecutionContext } from "../tools/tool-contracts.js";
import type { AgentEventObserver } from "./events.js";
import type { GeneratedReply } from "./executor.js";
import type { SubagentStore } from "./subagent-store.js";
import { AgentTranscript } from "./transcript.js";
import { AgentRunInterruption } from "./interruption.js";

type ChildState = "running" | "completed" | "failed" | "cancelled" | "interrupted";
type Child = {
  id: string; title: string; name: string; profession: string; model: Provider; generation: number; state: ChildState; startedAt: number;
  task: string; controller: AbortController; settled: Promise<void>; history: ModelConversationMessage[];
  transcript: AgentTranscript; result?: GeneratedReply; report?: string; error?: string; observed: boolean; usage: TokenUsage; trace: readonly ModelConversationMessage[];
};
export type ChildRequest = {
  id: string; generation: number;
  task: string; name: string; profession: string; history: ModelConversationMessage[]; model: Provider; signal: AbortSignal;
  onEvent: AgentEventObserver; onUsage: (usage: TokenUsage) => void;
  onTrace: (trace: readonly ModelConversationMessage[]) => void;
};
const zero = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
export type TeamCheckpoint = {
  id: string; observed: Record<string, number>;
  /** Cumulative usage already included in the parent's checkpoint, keyed by child AND generation. */
  accountedUsage?: Record<string, TokenUsage>;
};
const usageKey = (child: Pick<Child, "id" | "generation">): string => `subagent:${child.id}:${child.generation}`;
const tokenFields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "cacheWriteTokens5m", "cacheWriteTokens1h"] as const;
function usageDifference(total: TokenUsage, accounted: TokenUsage): TokenUsage {
  const delta = zero();
  for (const field of tokenFields) {
    if (total[field] !== undefined || accounted[field] !== undefined) delta[field] = Math.max(0, (total[field] ?? 0) - (accounted[field] ?? 0));
  }
  delta.cacheHitTokensReported = total.cacheHitTokensReported;
  return delta;
}
const PAGE_SIZE = 12000;

/** One owner-scoped team per foreground turn. No model-supplied identity or cross-team lookup. */
export class SubagentTeam implements SubagentControl {
  private id: string = randomUUID();
  private readonly children = new Map<string, Child>();
  private readonly accountedUsage = new Map<string, TokenUsage>();
  private closed = false;
  private closing?: Promise<void>;
  readonly availableModels: readonly Provider[];
  private readonly abort = () => { void this.close(); };
  constructor(private readonly scope: ToolExecutionContext, private readonly store: SubagentStore,
    private readonly run: (request: ChildRequest) => Promise<GeneratedReply>,
    private readonly onEvent: AgentEventObserver | undefined,
    private readonly onUsage: (usage: TokenUsage) => void,
    private readonly onResult: (result: GeneratedReply) => void,
    private readonly onClose: (team: SubagentTeam) => void,
    availableModels: readonly Provider[]) {
    this.availableModels = Object.freeze([...availableModels]);
    scope.signal?.addEventListener("abort", this.abort, { once: true });
  }
  checkpoint(): TeamCheckpoint {
    return { id: this.id, observed: Object.fromEntries([...this.children.values()].filter(child => child.observed)
      .map(child => [child.id, child.generation])), accountedUsage: Object.fromEntries(this.accountedUsage) };
  }
  restore(checkpoint?: TeamCheckpoint): void {
    const saved = this.store.restoreTeam(this.scope, checkpoint?.id);
    if (!saved) return;
    this.id = saved.id;
    for (const [key, usage] of Object.entries(checkpoint?.accountedUsage ?? {})) this.accountedUsage.set(key, usage);
    const latest = new Map(saved.runs.map(row => [row.id, row.generation]));
    for (const row of saved.runs) {
      const record = row.record;
      const interrupted = row.state === "running" || row.state === "interrupted";
      const resume = interrupted && latest.get(row.id) === row.generation;
      const task = record.task ?? "";
      let history = record.history ?? [...(this.children.get(row.id)?.history ?? []),
        { role: "user" as const, text: task }, ...(record.trace ?? []),
        { role: "assistant" as const, text: record.text ?? record.error ?? "Previous attempt ended.", toolCalls: [] }];
      // The previous recovery implementation appended an artificial interruption to history.
      // Resume from the original journal, with only prior generations as the input history.
      if (resume && (!record.history || record.historyIncludesAttempt)) history = history.slice(0, -(2 + (record.trace?.length ?? 0)));
      const child: Child = { id: row.id, generation: row.generation, title: row.title,
        name: record.name ?? row.title, profession: record.profession ?? "", model: row.model,
        state: resume ? "running" : row.state === "completed" ? "completed" : row.state === "failed" ? "failed" : "cancelled",
        startedAt: row.started_at, task, history, controller: new AbortController(), settled: Promise.resolve(),
        transcript: new AgentTranscript(false, record.activity),
        observed: checkpoint?.observed[row.id] === row.generation, usage: record.usage ?? zero(), trace: record.trace ?? [],
        result: resume ? undefined : record.result, report: resume ? undefined : record.text, error: resume ? undefined : record.error };
      // Pre-ledger checkpoints cannot distinguish already included tokens from a later child write.
      // Preserve their existing totals rather than charging all historical usage a second time.
      if (checkpoint && !checkpoint.accountedUsage) this.accountedUsage.set(usageKey(child), { ...child.usage });
      this.accountUsage(child);
      this.children.set(child.id, child);
      if (!resume) {
        if (child.state === "completed") child.transcript.complete(child.result?.text ?? child.report ?? "");
        else if (child.state === "failed") child.transcript.fail(child.error ?? "子任务执行失败。");
        else child.transcript.cancel();
      }
      this.publish(child);
    }
    // Reserve the entire team before starting asynchronous work. Never increment generation here.
    for (const child of this.children.values()) if (child.state === "running") this.launch(child);
  }
  private accountUsage(child: Child): void {
    const key = usageKey(child), previous = this.accountedUsage.get(key) ?? zero();
    const delta = usageDifference(child.usage, previous);
    this.onUsage(delta);
    this.accountedUsage.set(key, addTokenUsage(previous, delta));
  }
  private publish(child: Child): void {
    if (this.closed) return;
    const eventId = usageKey(child);
    this.onEvent?.({ type: "subagent.updated", itemId: eventId, item: {
      id: eventId, type: "subagent", agentId: child.id, generation: child.generation,
      title: child.title, name: child.name, profession: child.profession,
      model: child.model, task: child.task, startedAt: child.startedAt,
      status: child.state === "interrupted" ? "running" : child.state,
      ...(child.state === "running" || child.state === "interrupted" ? {} : { durationMs: Date.now() - child.startedAt }),
      snapshot: { ...child.transcript.snapshot(), ...(child.error ? { failureMessage: child.error } : {}) }
    } });
  }
  get pending(): boolean { return [...this.children.values()].some(child => child.state === "running" || !child.observed); }
  private get(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error("Unknown subagent in this reply");
    return child;
  }
  private save(child: Child): void {
    this.store.save(this.scope, this.id, child, { name: child.name, profession: child.profession,
      task: child.task, usage: child.usage, trace: child.trace, activity: child.transcript.snapshot(),
      text: child.result?.text ?? child.report, result: child.result, history: child.history, historyIncludesAttempt: child.state !== "running" && child.state !== "interrupted", error: child.error, reasoningEfforts: this.scope.reasoningEfforts });
  }
  private snapshot(child: Child, includeResult = false, offset = 0, part: "report" | "tools" = "report"): Record<string, unknown> {
    const text = part === "tools" ? JSON.stringify(child.trace) : child.result?.text ?? child.report ?? child.error ?? "";
    if (includeResult && offset > text.length) throw new Error("Result offset exceeds its current length");
    if (includeResult && part === "report" && child.state !== "running") child.observed = true;
    return { id: child.id, title: child.title, name: child.name, profession: child.profession,
      model: child.model, generation: child.generation, status: child.state, has_tool_trace: child.trace.length > 0,
      ...(includeResult ? { part, text: text.slice(offset, offset + PAGE_SIZE), offset, length: text.length,
        ...(text.length > offset + PAGE_SIZE ? { next_offset: offset + PAGE_SIZE } : {}), usage: child.usage, trust: "reference" } : {}) };
  }
  private start(child: Child, task: string): void {
    this.scope.signal?.throwIfAborted();
    if (this.closed || this.closing) throw new Error("This reply has ended");
    if ([...this.children.values()].filter(item => item.state === "running" && item !== child).length >= 3) throw new Error("Three subagents are already running; wait for one to finish");
    child.task = task; child.state = "running"; child.observed = false; child.result = undefined; child.report = undefined; child.error = undefined;
    child.controller = new AbortController(); child.startedAt = Date.now(); child.generation++;
    child.usage = zero(); child.trace = [];
    child.transcript = new AgentTranscript();
    this.launch(child);
  }
  private launch(child: Child): void {
    const task = child.task, transcript = child.transcript;
    this.save(child);
    this.publish(child);
    const signal = AbortSignal.any([child.controller.signal, ...(this.scope.signal ? [this.scope.signal] : [])]);
    // Schedule after reservation and persistence, so concurrent spawns cannot oversubscribe.
    child.settled = Promise.resolve().then(async () => {
      try {
        signal.throwIfAborted();
        const result = await this.run({ id: child.id, generation: child.generation, task, name: child.name, profession: child.profession,
          history: [...child.history], model: child.model, signal,
          onUsage: usage => { child.usage = addTokenUsage(child.usage, usage); this.save(child); this.accountUsage(child); },
          onTrace: trace => { child.trace = trace; this.save(child); },
          onEvent: event => {
            if (!event.type.startsWith("tool.") || !("presentation" in event) || this.closed) return;
            transcript.advance(event);
            this.save(child); this.publish(child);
          }
        });
        signal.throwIfAborted();
        // Cached generated replies bypass live callbacks; reconcile their cumulative usage too.
        child.usage = addTokenUsage(child.usage, usageDifference(result.usage, child.usage));
        this.save(child); this.accountUsage(child);
        child.result = result; child.state = "completed";
        transcript.complete(result.text);
        child.history.push({ role: "user", text: task }, ...result.toolTrace, { role: "assistant", text: result.text, toolCalls: [] });
        this.onResult(result);
      } catch (error) {
        if (signal.aborted && signal.reason instanceof AgentRunInterruption && signal.reason.kind === "service_shutdown") {
          child.state = "interrupted";
          return;
        }
        child.state = signal.aborted ? "cancelled" : "failed";
        child.error = signal.aborted ? "子任务已停止；未完成的工作不能视为成功。"
          : error instanceof Error ? error.message : String(error);
        if (signal.aborted) transcript.cancel(); else transcript.fail(child.error);
      } finally {
        if (!child.result && child.state !== "interrupted") child.history.push({ role: "user", text: task }, ...child.trace,
          { role: "assistant", text: `Previous attempt stopped: ${child.error}. Inspect existing state before retrying any side effect.`, toolCalls: [] });
        this.save(child);
        this.publish(child);
      }
    }).catch(() => {
      child.state = "failed"; child.error = "子任务记录保存失败。";
      transcript.fail(child.error); this.publish(child);
    });
  }
  async execute(input: SubagentInput, model: Provider): Promise<unknown> {
    this.scope.signal?.throwIfAborted();
    if (this.closed || this.closing) throw new Error("This reply has ended");
    switch (input.action) {
      case "spawn": {
        const selectedModel = input.model ?? model;
        if (!this.availableModels.includes(selectedModel)) throw new Error(`Unknown subagent model. Choose one of: ${this.availableModels.join(", ")}`);
        const child: Child = { id: randomUUID(), title: input.title, name: input.name, profession: input.profession, model: selectedModel, generation: 0,
          state: "failed", startedAt: Date.now(), task: input.task, controller: new AbortController(), settled: Promise.resolve(),
          history: [], transcript: new AgentTranscript(), observed: false, usage: zero(), trace: [] };
        this.start(child, input.task); this.children.set(child.id, child);
        return this.snapshot(child);
      }
      case "list": return { agents: [...this.children.values()].map(child => this.snapshot(child)) };
      case "read": return this.snapshot(this.get(input.id), true, input.offset, input.part);
      case "continue": {
        const child = this.get(input.id);
        if (child.state === "running") throw new Error("Wait for or cancel the running child before continuing it");
        this.start(child, input.task); return this.snapshot(child);
      }
      case "cancel": {
        const child = this.get(input.id); child.controller.abort(new Error("Cancelled by parent"));
        await child.settled; return this.snapshot(child, true);
      }
      case "wait": {
        const children = [...new Set(input.ids)].map(id => this.get(id));
        if (children.every(child => child.state === "running") && input.timeout_ms) await this.waitFor(children, input.timeout_ms);
        this.scope.signal?.throwIfAborted();
        return { timed_out: children.every(child => child.state === "running"), agents: children.map(child => this.snapshot(child, true)) };
      }
    }
  }
  private async waitFor(children: Child[], timeout: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([...children.map(child => child.settled), new Promise<void>(resolve => {
        abort = () => resolve(); timer = setTimeout(resolve, timeout);
        this.scope.signal?.addEventListener("abort", abort, { once: true });
        if (this.scope.signal?.aborted) resolve();
      })]);
    } finally {
      clearTimeout(timer);
      if (abort) this.scope.signal?.removeEventListener("abort", abort);
    }
  }
  /** Before final delivery, collect all still-required work and give the coordinator another model round. */
  async collect(): Promise<unknown[]> {
    await Promise.all([...this.children.values()].map(child => child.settled));
    this.scope.signal?.throwIfAborted();
    return [...this.children.values()].filter(child => !child.observed).map(child => ({ ...this.snapshot(child, true), text: child.result?.text ?? child.report ?? child.error ?? "", next_offset: undefined }));
  }
  close(): Promise<void> { return this.closing ??= this.finishClose(); }
  private async finishClose(): Promise<void> {
    for (const child of this.children.values()) child.controller.abort(this.scope.signal?.reason);
    await Promise.all([...this.children.values()].map(child => child.settled));
    this.closed = true;
    this.scope.signal?.removeEventListener("abort", this.abort);
    this.onClose(this);
  }
}
