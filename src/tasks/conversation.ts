/** A task occurrence owns its conversation independently of the chat that configured it. */
export function taskRunConversationId(runId: string): string {
  return `background:${runId}`;
}
