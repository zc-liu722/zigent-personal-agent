import { assertSubagentToolInput } from "./subagents.js";
import type { ModelHostedTool } from "../models/types.js";
import { taskReadPolicy } from "../productivity/task-access.js";
import { isConfirmedOperation } from "./confirmed-operation.js";
import { buildOperationDraft, object, operationReads, operationSnapshots, operationTitle } from "./operation-policy.js";
import type { ToolAccessPolicy } from "./tool-access.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";

export function createToolExecutor(options: {
  agentId: string;
  allowed: ReadonlySet<string>;
  catalog: ReadonlyMap<string, AgentToolRegistration>;
  hostedCatalog: ReadonlyMap<string, { definition: ModelHostedTool }>;
  isAvailable: ToolAccessPolicy;
  verifyProactiveRun?: (context: ToolExecutionContext) => boolean;
}): (name: string, input: unknown, context: ToolExecutionContext) => Promise<unknown> {
  const { agentId, allowed, catalog, hostedCatalog, isAvailable, verifyProactiveRun } = options;
  return async (name, input, context) => {
    if (context.agentId !== agentId) {
      throw new Error(`Tool execution context belongs to agent ${context.agentId}; ${agentId} cannot use it`);
    }
    if (!allowed.has(name)) throw new Error(`Tool ${name} is not allowed for agent ${agentId}`);
    if (!isAvailable(name, context)) throw new Error(catalog.get(name)?.requiredSkill
      ? `Tool ${name} is unavailable; load the project skill in an authorized private conversation first`
      : `Tool ${name} is unavailable for this identity, session, task run or configuration`);
    if (context.subagent) assertSubagentToolInput(name, input);
    const productivityRead = taskReadPolicy(name);
    if ((context.taskRunId || context.backgroundTaskKind) && name === "schedule" && !["list", "get"].includes(String(object(input).action))) throw new Error("后台任务只能读取日程。");
    if (context.taskRunId && productivityRead && (!input || typeof input !== "object"
      || !productivityRead.actions.includes(String((input as Record<string, unknown>).action))))
      throw new Error("Background productivity tools are read-only; confirmation and writes require a user turn");
    if (context.backgroundTaskKind === "proactive" && name === "health_data"
      && (!input || typeof input !== "object" || !["status", "query", "diary", "view_photos"].includes(String((input as Record<string, unknown>).action))))
      throw new Error("Proactive health tasks may only read health data; user reports require a user turn");
    if (context.taskRunId && name === "user_location"
      && (!input || typeof input !== "object" || (input as Record<string, unknown>).action !== "get")) {
      throw new Error("Background tasks may only read location; binding and deletion require a user turn");
    }
    if (hostedCatalog.has(name)) {
      throw new Error(`Hosted tool ${name} is executed by the model provider, not the local registry`);
    }
    const prepare = catalog.get(name)?.prepare;
    if (prepare && !isConfirmedOperation(context, name, input)) {
      const prepared = await prepare(input, context);
      input = prepared.input; context = prepared.context;
    }
    // MCP parsers historically trim these strings. Reject noncanonical values
    // here so normalization cannot turn a classified read into a hidden write.
    if (["notion", "xmind"].includes(name)) for (const key of ["action", "operation"]) {
      const value = object(input)[key];
      if (typeof value === "string" && value !== value.trim()) throw new Error("Use exact action and operation names without surrounding whitespace");
    }
    if (["notion", "xmind", "feishu_cli"].includes(name) && object(input).action === "confirm") throw new Error("Legacy model confirmation is disabled; only the authenticated confirmation component may execute changes");
    if (operationTitle(name, input) && !isConfirmedOperation(context, name, input)
      && !(name === "codex" && ["dispatch", "message"].includes(String(object(input).action))
        && context.backgroundTaskKind === "proactive" && context.taskRunId && context.taskLeaseToken && verifyProactiveRun?.(context))) {
      if (context.taskRunId || context.backgroundTaskKind) throw new Error("Background runs cannot change user arrangements or request confirmation; use a user turn");
      if (!context.proposeOperation || context.conversationKind !== "p2p" || !context.conversationId) throw new Error("A trusted confirmation component is required; no change was performed");
      const value = object(input), reads = operationReads(name, value);
      const results: unknown[] = [];
      for (const read of reads) {
        if (read.tool !== name || operationTitle(read.tool, read.input)) throw new Error("Invalid confirmation read");
        results.push(await catalog.get(name)!.execute(read.input, context));
      }
      const incomplete = results.find(result => object(result).ok === false || object(result).isError === true);
      if (incomplete) return incomplete;
      const authorization = results.find(result => ["authorization_pending", "authorization_required", "not_configured"].includes(String(object(result).status)));
      if (authorization) return authorization;
      const draft = buildOperationDraft(name, value, operationSnapshots(reads, results, value));
      if (name === "codex") draft.delegationEvidence = context.delegationRequest;
      const offered = await context.proposeOperation(draft);
      return { status: "pending_confirmation", ...offered, message: "Exact changes are displayed in the confirmation component. NO change has run. Only a real user button click executes it. Do not ask for verbal confirmation, retry in this turn or claim success." };
    }
    return catalog.get(name)!.execute(input, context);
  };
}
