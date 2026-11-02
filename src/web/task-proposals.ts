import { prepareSql } from "../sqlite.js";
import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntime } from "../runtime.js";
import type { TaskProposal, TaskScope } from "../tasks/types.js";
import { taskScheduleText } from "../tasks/schedule-text.js";
import type { WebInteraction } from "./interactions.js";
import type { WebStore } from "./store.js";
import { executeConfirmedOperation } from "../tools/confirmed-operation.js";
import { buildOperationDraft } from "../tools/operation-policy.js";
import { webTaskChanges } from "./interactions.js";

type SavedProposal = { proposal: TaskProposal; scope: TaskScope; expiresAt: number };
type ProposalRow = { id: string; conversation_id: string; message_id: string; payload: string };
const proposalInput = (draft: TaskProposal) => ({ action: "create", title: draft.title, instruction: draft.instruction,
  trigger: draft.trigger, ...(draft.skill ? { skill: draft.skill } : {}), ...(draft.deliveryPolicy ? { delivery_policy: draft.deliveryPolicy } : {}) });

/** Durable proposals hold trusted routing separately from browser-visible actions. */
export class WebTaskProposals {
  private readonly inFlight = new Set<string>();
  constructor(private readonly store: WebStore, private readonly runtime: Pick<AgentRuntime, "config" | "tools">) {}

  preview(conversationId: string, messageId: string, id: string) {
    const row = prepareSql(this.store.db, "SELECT * FROM task_proposals WHERE id=?").get(id) as ProposalRow | undefined;
    if (!row || row.conversation_id !== conversationId || row.message_id !== messageId) return undefined;
    const saved = JSON.parse(row.payload) as SavedProposal;
    if (saved.scope.userId !== this.store.owner || saved.scope.agentId !== this.runtime.config.id
      || saved.scope.principalId && saved.scope.principalId !== this.runtime.config.web?.ownerPrincipalId) return undefined;
    const display = buildOperationDraft("proactive_tasks", proposalInput(saved.proposal), []);
    return { changes: display.changes, triggers: display.taskTriggers };
  }

  async supersede(conversationId: string): Promise<void> {
    const rows = prepareSql(this.store.db, "SELECT * FROM task_proposals WHERE conversation_id=?").all(conversationId) as ProposalRow[];
    for (const row of rows) {
      const message = this.store.message(row.message_id);
      if (!message?.interactions?.some(item => item.id === row.id && ["pending", "failed"].includes(item.status))) continue;
      this.store.save({ ...message, interactions: message.interactions.map(item => item.id === row.id ? { ...item, status: "cancelled",
        statusMessage: "已有新的对话请求，旧提议已失效。需要时请重新提出。", actions: [] } : item) });
    }
  }

  async offer(proposal: TaskProposal, scope: TaskScope, conversationId: string, turnKey: string): Promise<{ proposalId: string }> {
    if (scope.userId !== this.store.owner || scope.agentId !== this.runtime.config.id || scope.conversationKind !== "p2p") throw new Error("Task proposal scope is unavailable");
    if (!proposal.title.trim() || [...proposal.title.trim()].length > 4) throw new Error("任务名称需要具体且不超过四个字符。");
    const key = createHash("sha256").update(JSON.stringify([scope, conversationId, turnKey, proposal])).digest("hex");
    const prior = prepareSql(this.store.db, "SELECT * FROM task_proposals WHERE proposal_key=?").get(key) as ProposalRow | undefined;
    const id = prior?.id ?? randomUUID(), messageId = prior?.message_id ?? randomUUID();
    const saved: SavedProposal = prior ? JSON.parse(prior.payload) : { proposal, scope, expiresAt: Date.now() + 24 * 60 * 60_000 };
    if (!prior) prepareSql(this.store.db, "INSERT INTO task_proposals(id,proposal_key,conversation_id,message_id,payload) VALUES(?,?,?,?,?)")
      .run(id, key, conversationId, messageId, JSON.stringify(saved));
    if (!this.store.message(messageId)) {
      const display = buildOperationDraft("proactive_tasks", proposalInput(saved.proposal), []);
      const interaction: WebInteraction = { id, kind: "task-proposal", title: proposal.title, status: "pending", expiresAt: saved.expiresAt,
        changes: webTaskChanges(display.changes),
        statusMessage: "同意后，我会按这个安排自动跟进。", taskPlan: { schedule: taskScheduleText(proposal.trigger), instruction: proposal.instruction,
          delivery: proposal.deliveryPolicy === "always" ? "每次跟进后通知你" : "有需要时再通知你" },
        actions: this.actions(id) };
      this.store.save({ id: messageId, conversationId, role: "notice", text: "", createdAt: Date.now(), interactions: [interaction] });
    }
    return { proposalId: id };
  }

  private actions(id: string, retry = false): WebInteraction["actions"] {
    return [true, false].map(confirm => ({ id: confirm ? "agree" : "decline", label: confirm ? retry ? "重试设置" : "同意并启用" : "暂不需要",
      kind: "submit", value: { type: "task-proposal", proposalId: id, confirm } }));
  }

  async act(conversationId: string, messageId: string, interactionId: string, proposalId: string, confirm: boolean): Promise<{ code: number; error?: string }> {
    const row = prepareSql(this.store.db, "SELECT * FROM task_proposals WHERE id=?").get(proposalId) as ProposalRow | undefined;
    const message = this.store.message(messageId);
    const interaction = message?.interactions?.find(item => item.id === interactionId);
    if (!row || row.conversation_id !== conversationId || row.message_id !== messageId || message?.conversationId !== conversationId
      || interactionId !== proposalId || interaction?.kind !== "task-proposal") return { code: 404, error: "跟进提议已失效。" };
    const saved = JSON.parse(row.payload) as SavedProposal;
    if (saved.scope.userId !== this.store.owner || saved.scope.agentId !== this.runtime.config.id) return { code: 404, error: "跟进提议已失效。" };
    if (interaction.status === "completed" || interaction.status === "cancelled") return { code: 200 };
    const settle = (patch: Partial<WebInteraction>) => {
      const latest = this.store.message(messageId)!;
      this.store.save({ ...latest, interactions: latest.interactions?.map(item => item.id === interactionId ? { ...item, ...patch } : item) });
    };
    if (saved.expiresAt <= Date.now()) { settle({ status: "expired", statusMessage: "提议已过期，请让我重新安排。", actions: [] }); return { code: 409, error: "提议已过期。" }; }
    if (this.inFlight.has(proposalId)) return { code: 409, error: "正在设置，请稍候。" };
    if (!confirm) { settle({ status: "cancelled", statusMessage: "已取消，未设置跟进任务。", actions: [] }); return { code: 200 }; }
    this.inFlight.add(proposalId);
    settle({ status: "pending", statusMessage: "我正在设置这个安排…" });
    try {
      // Execute the same deployed validator, permissions, idempotency and seeding
      // used by ordinary task creation. Never accept task arguments from a browser.
      const draft = saved.proposal;
      const input = proposalInput(draft);
      const context = { ...saved.scope, sessionId: `task-proposal:${proposalId}`, turnId: 0 };
      const result = await executeConfirmedOperation(context, "proactive_tasks", input,
        approved => this.runtime.tools.execute("proactive_tasks", input, approved));
      if (!(result as { task?: { id?: string } })?.task?.id) throw new Error("Task creation was not confirmed");
      settle({ status: "completed", statusMessage: "已设置并启用，我会按这个安排跟进。", actions: [] });
      return { code: 200 };
    } catch {
      settle({ status: "failed", statusMessage: "这次未能完成设置，可以重试；如果约定时间已过，请让我调整安排。", actions: this.actions(proposalId, true) });
      return { code: 200 };
    } finally { this.inFlight.delete(proposalId); }
  }
}
