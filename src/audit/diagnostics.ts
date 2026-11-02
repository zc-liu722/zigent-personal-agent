import type { RunCancellationReason } from "../agent/interruption.js";

/** Metadata only: never add prompts, tool arguments, URLs or exception messages here. */
export type ConversationDiagnostic = {
  phase: "accepted" | "cancel_requested" | "started" | "message_ready" | "settled" | "model_route" | "tool_started" | "tool_completed" | "tool_failed" | "steer_requested";
  status?: string;
  model?: string;
  supplier?: string;
  tool?: string;
  itemId?: string;
  failureKind?: string;
  cancellationReason?: RunCancellationReason | "unknown";
  retryAttempt?: number;
  durationMs?: number;
};
