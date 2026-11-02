import type { ToolActivityPresentation } from "../tools/activity-presentation.js";
import type { ModelThoughtSource } from "../models/types.js";
import type { SubagentActivityItem } from "./transcript.js";

export type AgentEvent =
  | { type: "subagent.updated"; itemId: string; item: SubagentActivityItem }
  | { type: "response.reset"; prefixes: string[] }
  | { type: "visual.preparing"; itemId: string }
  | {
      type: "model.route";
      itemId: string;
      status: "connecting" | "connected" | "retrying" | "failed" | "switching";
      model: string;
      brand: string;
      supplier: string;
      failureKind?: string;
      retryAttempt?: number;
      maxAttempts?: number;
    }
  | { type: "thought.delta"; itemId: string; text: string; source: ModelThoughtSource }
  | { type: "response.delta"; itemId: string; text: string; role?: "commentary" | "answer" }
  | { type: "response.completed"; itemId: string; role: "commentary" | "answer"; text: string }
  | { type: "tool.started"; itemId: string; name: string; operationKey?: string; presentation: ToolActivityPresentation }
  | { type: "tool.completed"; itemId: string; name: string; operationKey?: string; presentation: ToolActivityPresentation; durationMs: number }
  | { type: "tool.failed"; itemId: string; name: string; operationKey?: string; presentation: ToolActivityPresentation; durationMs: number };

export type AgentEventObserver = (event: AgentEvent) => void;
