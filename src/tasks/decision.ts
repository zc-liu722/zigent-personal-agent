type TaskDecision = { summary: string; notify: boolean; message?: string };
/** Tasks explicitly configured to deliver a result cannot silently discard a qualifying execution. */
export function parseProactiveTaskResult(text: string): { summary: string; message: string } {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid proactive task result: message is required");
  const result = value as Record<string, unknown>;
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 4000
    || typeof result.message !== "string" || !result.message.trim() || result.message.length > 12000) {
    throw new Error("Invalid proactive task result: message is required");
  }
  // Ignore a legacy notify flag when a real message exists; it is no longer a delivery decision here.
  return { summary: result.summary, message: result.message };
}
export function parseTaskDecision(text: string): TaskDecision {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid task result");
  const result = value as Record<string, unknown>;
  if (typeof result.summary !== "string" || !result.summary.trim() || result.summary.length > 4000
    || typeof result.notify !== "boolean"
    || (result.notify && (typeof result.message !== "string" || !result.message.trim() || result.message.length > 12000))) {
    throw new Error("Invalid task result");
  }
  return { summary: result.summary, notify: result.notify,
    ...(result.notify ? { message: result.message as string } : {}) };
}
