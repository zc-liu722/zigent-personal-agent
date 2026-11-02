import type { PersonalIntegrationConfig, ProductivityIntegration } from "../productivity/config.js";
import { ProductivityAuthorizationRequiredError } from "../productivity/credentials.js";
import { record } from "../productivity/http.js";
import { assertProductivityAccess, type VerifyProductivityRun } from "../productivity/task-access.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./registry.js";
import { waitForAccountAuthorization } from "./account-authorization.js";

/** URLs and callback codes travel only through the channel, never the model/tool trace. */
export function withProductivityAuthorization(tool: AgentToolRegistration, integration: ProductivityIntegration, config?: PersonalIntegrationConfig,
  verifyProactiveRun?: VerifyProductivityRun): AgentToolRegistration {
  const pending = async (context: ToolExecutionContext) => {
    if (context.taskRunId) return {
      status: "authorization_required", authorized: false,
      message: "This account is unavailable for this background read. Continue with the available information and say its schedule/tasks are unknown, not empty. Account reconnection must happen in a user conversation; do not start authorization, wait or retry here."
    };
    if (config?.ownerUserId && await waitForAccountAuthorization(context, integration)) return { status: "authorized", authorized: true };
    if (!config?.ownerUserId || !context.startProductivityAuthorization?.(integration)) return {
      status: "not_configured", authorized: false,
      message: "Interactive account authorization needs one-time operator setup (OAuth application, callback endpoint and verified owner). No requested operation was performed. Never ask the user to paste tokens or run authorization commands in chat."
    };
    return {
      status: "authorization_pending", authorized: false,
      message: "Account authorization is running independently. An account connection step with authorization controls is delivered through the current private conversation and updates independently. The user may keep chatting. Do not poll, retry, request tokens, or claim the original operation completed when authorization_pending is returned."
    };
  };
  return { ...tool, async execute(value, context) {
    assertProductivityAccess(config, context, integration, record(value).action, verifyProactiveRun);
    if (record(value).action === "authorize") return pending(context);
    const resume = async () => {
      const authorization = await pending(context);
      return authorization.authorized ? tool.execute(value, context) : authorization;
    };
    try {
      const result = await tool.execute(value, context);
      return record(result).status === "not_configured" ? resume() : result;
    } catch (error) {
      if (error instanceof ProductivityAuthorizationRequiredError) return resume();
      throw error;
    }
  } };
}
