import type { AgentEvent } from "./events.js";
import type { ToolActivityPresentation } from "../tools/activity-presentation.js";
import type { ModelThoughtSource } from "../models/types.js";

export type AgentActivityItem =
  | SubagentActivityItem
  | {
      id: string;
      type: "response";
      status: "running" | "completed";
      text: string;
    }
  | {
      id: string;
      type: "thought";
      status: "running" | "completed";
      text: string;
      source: ModelThoughtSource;
    }
  | {
      id: string;
      type: "commentary";
      status: "running" | "completed";
      text: string;
    }
  | {
      id: string;
      type: "tool";
      status: "running" | "completed" | "failed";
      name: string;
      /** Logical visual output identity, shared only by retries/updates of that output. */
      operationKey?: string;
      presentation: ToolActivityPresentation;
      durationMs?: number;
    };

/** A child owns its process and result; neither is part of the coordinator's answer. */
export type SubagentActivityItem = {
  id: string;
  type: "subagent";
  status: "running" | "completed" | "failed" | "cancelled";
  agentId: string;
  generation: number;
  title: string;
  name: string;
  profession: string;
  model: string;
  task: string;
  startedAt: number;
  durationMs?: number;
  snapshot: AgentRunSnapshot;
};

export type AgentRunSnapshot = {
  status: "running" | "completed" | "failed" | "cancelled";
  items: readonly AgentActivityItem[];
  answerDraft: string;
  failureMessage?: string;
};

export type AgentActivityOperation =
  | { type: "add_item"; item: AgentActivityItem }
  | { type: "replace_item"; item: AgentActivityItem }
  | { type: "remove_item"; id: string }
  | { type: "append_text"; id: string; text: string }
  | { type: "set_answer"; text: string }
  | { type: "append_answer"; text: string }
  | { type: "run_state"; status: AgentRunSnapshot["status"]; failureMessage?: string };

/** Internal live view: consumers materialize the latest state at delivery/checkpoint time. */
export type AgentActivityUpdate = {
  status: AgentRunSnapshot["status"];
  readonly structure: string;
  operations?: AgentActivityOperation[];
  checkpoint?: boolean;
  snapshot: () => AgentRunSnapshot;
};

/** Text changes may be coalesced; tool contents and item transitions must be durable immediately. */
export function activityStructure(items: readonly AgentActivityItem[]): string {
  return JSON.stringify(items.map(item => item.type === "tool" || item.type === "subagent"
    ? item : { id: item.id, type: item.type, status: item.status }));
}

const MAX_ITEM_TEXT_LENGTH = 4_000;

function truncate(text: string, limit = MAX_ITEM_TEXT_LENGTH): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 16)}\n[内容已截断]`;
}

function truncatePresentation(value: ToolActivityPresentation): ToolActivityPresentation {
  return {
    ...value,
    message: truncate(value.message),
    title: value.title ? truncate(value.title, 160) : undefined,
    command: value.command ? truncate(value.command, 64_000) : undefined,
    resourcesLabel: value.resourcesLabel ? truncate(value.resourcesLabel, 80) : undefined,
    details: value.details?.map((detail) => ({
      ...detail,
      label: truncate(detail.label, 80),
      value: truncate(detail.value)
    })),
    resources: value.resources?.slice(0, 8).map((resource) => ({
      ...resource,
      title: truncate(resource.title, 240),
      description: resource.description ? truncate(resource.description, 500) : undefined
    }))
  };
}

function mergePresentation(
  previous: ToolActivityPresentation,
  next: ToolActivityPresentation
): ToolActivityPresentation {
  return truncatePresentation({
    ...previous,
    ...next,
    details: next.details ?? previous.details,
    resources: next.resources ?? previous.resources,
    resourcesLabel: next.resourcesLabel ?? previous.resourcesLabel
  });
}

export class AgentTranscript {
  private status: AgentRunSnapshot["status"] = "running";
  private readonly items = new Map<string, AgentActivityItem>();
  private readonly open = new Set<string>();
  private readonly responses = new Map<string, string>();
  private streamedAnswer = "";
  private lastResponseId: string | undefined;
  private answerDraft = "";
  private failureMessage: string | undefined;
  private structure: string | undefined;
  private operations: AgentActivityOperation[] = [];
  private checkpoint = false;

  constructor(private readonly recordOperations = false) {}

  apply(event: AgentEvent): AgentRunSnapshot { this.advance(event); return this.snapshot(); }

  private record(operation: AgentActivityOperation): void {
    if (this.recordOperations) this.operations.push(operation);
  }

  private answer(): string { return this.streamedAnswer || this.answerDraft; }

  /** Item replacement also covers supplier reclassification and bounded commentary. */
  private put(item: AgentActivityItem, appendText?: string): void {
    const previous = this.items.get(item.id), beforeAnswer = this.answer();
    this.items.set(item.id, item);
    if (item.status === "running") this.open.add(item.id); else this.open.delete(item.id);
    const structural = !previous || previous.type !== item.type || previous.status !== item.status || item.type === "tool" || item.type === "subagent";
    if (structural) { this.structure = undefined; this.checkpoint = true; }
    if (!previous) this.record({ type: "add_item", item: { ...item } });
    else if (!structural && appendText !== undefined) this.record({ type: "append_text", id: item.id, text: appendText });
    else this.record({ type: "replace_item", item: { ...item } });
    if (item.type === "response" || previous?.type === "response") {
      const lastResponse = this.lastResponseId;
      if (previous?.type === "response" && item.type === "response" && appendText !== undefined && lastResponse === item.id) {
        this.responses.set(item.id, item.text);
        const appendingAnswer = Boolean(this.streamedAnswer) || !this.answerDraft;
        this.streamedAnswer += appendText;
        if (appendingAnswer) {
          if (appendText) this.record({ type: "append_answer", text: appendText });
          return;
        }
      } else {
        // Reclassification can insert a response before another response.
        this.responses.clear();
        for (const value of this.items.values()) if (value.type === "response") this.responses.set(value.id, value.text);
        this.lastResponseId = Array.from(this.responses.keys()).at(-1);
        this.streamedAnswer = Array.from(this.responses.values()).join("\n\n");
      }
      if (beforeAnswer !== this.answer()) this.record({ type: "set_answer", text: this.answer() });
    }
  }

  private finishOpen(predicate: (item: AgentActivityItem) => boolean): void {
    for (const id of this.open) {
      const item = this.items.get(id)!;
      if (predicate(item)) this.put({ ...item, status: "completed" });
    }
  }

  advance(event: AgentEvent): void {
    // Parallel child activity must not close a streaming parent thought/answer.
    if (event.type === "subagent.updated") { this.put({ ...event.item, id: event.itemId }); return; }
    if (event.type !== "thought.delta") this.finishOpen(item => item.type === "thought");
    if (event.type !== "response.delta" && event.type !== "response.completed") this.finishOpen(item => item.type === "response");
    switch (event.type) {
      case "response.reset": {
        const before = this.answer();
        for (const [id, item] of this.items) {
          if (item.type !== "tool" && item.type !== "subagent" && event.prefixes.some(prefix => id === prefix || id.startsWith(`${prefix}-`))) {
            this.items.delete(id); this.open.delete(id); this.responses.delete(id);
            this.record({ type: "remove_item", id }); this.structure = undefined; this.checkpoint = true;
          }
        }
        this.lastResponseId = Array.from(this.responses.keys()).at(-1);
        this.streamedAnswer = Array.from(this.responses.values()).join("\n\n");
        if (before !== this.answer()) this.record({ type: "set_answer", text: this.answer() });
        break;
      }
      case "model.route": {
        if (event.status === "connecting" || event.status === "connected") break;
        const action = event.status === "retrying" ? "模型请求异常，正在重试" : event.status === "switching" ? "正在切换线路至" : "连接失败";
        const reason = event.failureKind ? `（${event.failureKind}）` : "";
        const attempt = event.status === "retrying" && event.retryAttempt && event.maxAttempts ? `，第 ${event.retryAttempt}/${event.maxAttempts} 次尝试` : "";
        this.put({ id: event.itemId, type: "commentary", status: "completed", text: `${action} ${event.model}${attempt}${reason}` });
        this.checkpoint = true;
        break;
      }
      case "thought.delta": {
        const previous = this.items.get(event.itemId);
        if (previous?.type === "thought") this.put({ ...previous, text: previous.text + event.text }, event.text);
        else {
          this.finishOpen(item => item.type === "thought");
          this.put({ id: event.itemId, type: "thought", status: "running", text: event.text, source: event.source });
        }
        break;
      }
      case "response.delta":
      case "response.completed": {
        if (event.type === "response.completed") this.checkpoint = true;
        const found = this.items.get(event.itemId);
        const previous = found?.type === "response" || found?.type === "commentary" ? found : undefined;
        const type = event.role === "commentary" ? "commentary" : event.role === "answer" ? "response" : previous?.type === "commentary" ? "commentary" : "response";
        const text = event.type === "response.delta" ? (previous?.text ?? "") + event.text : event.text;
        const visible = type === "commentary" ? truncate(text) : text;
        const append = event.type === "response.delta" && previous?.type === type && visible === text ? event.text : undefined;
        this.put({ id: event.itemId, type, status: event.type === "response.completed" ? "completed" : "running", text: visible }, append);
        break;
      }
      case "tool.started": {
        if (event.presentation.hidden) break;
        const previous = this.items.get(event.itemId);
        this.put(previous?.type === "tool"
          ? { ...previous, status: "running", presentation: truncatePresentation(event.presentation) }
          : { id: event.itemId, type: "tool", status: "running", name: event.name,
            ...(event.operationKey ? { operationKey: event.operationKey } : {}), presentation: truncatePresentation(event.presentation) });
        break;
      }
      case "tool.completed":
      case "tool.failed": {
        if (event.presentation.hidden) break;
        const previous = this.items.get(event.itemId);
        const tool = previous?.type === "tool" ? previous : { id: event.itemId, type: "tool" as const, name: event.name,
          ...(event.operationKey ? { operationKey: event.operationKey } : {}), presentation: truncatePresentation(event.presentation) };
        this.put({ ...tool, status: event.type === "tool.completed" ? "completed" : "failed",
          presentation: mergePresentation(tool.presentation, event.presentation), durationMs: event.durationMs });
        break;
      }
    }
  }

  activityUpdate(): AgentActivityUpdate {
    const transcript = this, operations = this.operations, checkpoint = this.checkpoint;
    this.operations = []; this.checkpoint = false;
    return { status: this.status, operations: this.recordOperations ? operations : undefined, checkpoint,
      get structure() { return transcript.structure ??= activityStructure(Array.from(transcript.items.values())); },
      snapshot: () => this.snapshot() };
  }

  complete(answer: string): AgentRunSnapshot {
    this.finishOpen(item => item.type !== "tool" && item.type !== "subagent");
    const responses = Array.from(this.items.values()).filter(item => item.type === "response");
    if (responses.length === 1 && responses[0]!.text.trim() !== answer.trim()) this.put({ ...responses[0]!, text: answer });
    const before = this.answer();
    this.answerDraft = answer;
    if (before !== this.answer()) this.record({ type: "set_answer", text: this.answer() });
    this.status = "completed";
    this.record({ type: "run_state", status: this.status });
    return this.snapshot();
  }

  fail(message: string): AgentRunSnapshot {
    this.finishOpen(item => item.type !== "tool" && item.type !== "subagent");
    this.status = "failed"; this.failureMessage = message;
    this.record({ type: "run_state", status: this.status, failureMessage: message });
    return this.snapshot();
  }

  cancel(): AgentRunSnapshot {
    this.finishOpen(item => item.type !== "tool" && item.type !== "subagent");
    this.status = "cancelled";
    this.record({ type: "run_state", status: this.status });
    return this.snapshot();
  }

  snapshot(): AgentRunSnapshot {
    return { status: this.status, items: Array.from(this.items.values(), item => ({ ...item })),
      answerDraft: this.answer(), failureMessage: this.failureMessage };
  }
}
