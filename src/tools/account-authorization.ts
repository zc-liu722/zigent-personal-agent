import type { ToolExecutionContext } from "./tool-contracts.js";

/** Keep the original tool call suspended; cancelling it must not cancel account login. */
export async function waitForAccountAuthorization(context: ToolExecutionContext,
  service: Parameters<NonNullable<ToolExecutionContext["authorizeAccount"]>>[0]): Promise<boolean> {
  if (!context.authorizeAccount || context.taskRunId || context.backgroundTaskKind) return false;
  context.signal?.throwIfAborted();
  await context.authorizeAccount(service, context.signal);
  context.signal?.throwIfAborted();
  return true;
}
