import type { DatabaseSync } from "node:sqlite";
import { prepareSql } from "../sqlite.js";
import type { ActiveTask, TaskScope } from "./types.js";
import type { ReusableTriggerSpec, SharedTrigger, TriggerFacts } from "./reusable.js";

type Row = Record<string, unknown>;
type Scope = Pick<TaskScope, "userId" | "principalId">;
export type RuntimeTrigger = Scope & {
  id: string; status: SharedTrigger["status"]; activeRevision?: number;
  spec?: ReusableTriggerSpec; hash?: string; activatedAt?: number; nextAt?: number;
};
const projection = `SELECT t.id,t.user_id,t.principal_id,t.status,t.active_revision,t.activated_at,t.next_at,r.spec_json,r.hash
  FROM shared_triggers t LEFT JOIN shared_trigger_revisions r ON r.trigger_id=t.id AND r.revision=t.active_revision`;
const scopeKey = (scope: Scope) => JSON.stringify([scope.userId, scope.principalId ?? null]);
const subscriberKey = (scope: Scope, id: string) => JSON.stringify([scope.userId, scope.principalId ?? null, id]);

/** Runtime reads never hydrate revision history, validation fixtures or presentation counts. */
export class ReusableTriggerReads {
  constructor(private readonly db: DatabaseSync, private readonly agentId: string, private readonly tasks: () => ActiveTask[]) {}
  private decode(row: Row): RuntimeTrigger {
    return { id: String(row.id), userId: String(row.user_id), status: row.status as SharedTrigger["status"],
      ...(row.principal_id ? { principalId: String(row.principal_id) } : {}),
      ...(row.active_revision == null ? {} : { activeRevision: Number(row.active_revision) }),
      ...(row.spec_json == null ? {} : { spec: JSON.parse(String(row.spec_json)) as ReusableTriggerSpec, hash: String(row.hash) }),
      ...(row.activated_at == null ? {} : { activatedAt: Number(row.activated_at) }),
      ...(row.next_at == null ? {} : { nextAt: Number(row.next_at) }) };
  }
  active(): RuntimeTrigger[] {
    return (prepareSql(this.db, `${projection} WHERE t.agent_id=? AND t.status='active'`).all(this.agentId) as Row[])
      .map(row => this.decode(row));
  }
  owned(scope: TaskScope, id: string): RuntimeTrigger | undefined {
    const row = prepareSql(this.db, `${projection} WHERE t.id=? AND t.agent_id=? AND t.user_id=? AND t.principal_id=?`)
      .get(id, scope.agentId, scope.userId, scope.principalId ?? "") as Row | undefined;
    return row && this.decode(row);
  }
  evaluation(): TriggerEvaluationReads { return new TriggerEvaluationReads(this.db, this.agentId, this.tasks); }
}

/** One synchronous evaluation only. Enqueue changes runs, not these facts or subscriptions.
 * Never retain this across polls, events, awaits, or the execution/delivery freshness checks.
 * Trigger state and occurrence deduplication remain live transactional reads in the writer. */
export class TriggerEvaluationReads {
  private tasksByScope?: Map<string, ActiveTask[]>;
  private readonly subscribersByTrigger = new Map<string, ActiveTask[]>();
  private readonly factsByScope = new Map<string, TriggerFacts>();
  constructor(private readonly db: DatabaseSync, private readonly agentId: string, private readonly tasks: () => ActiveTask[]) {}
  private indexTasks(): void {
    if (this.tasksByScope) return;
    this.tasksByScope = new Map();
    // Keep TaskStore's Agent/owner filtering and creation order as the source of truth.
    for (const task of this.tasks()) {
      const key = scopeKey(task), group = this.tasksByScope.get(key) ?? [];
      group.push(task); this.tasksByScope.set(key, group);
      if (task.status === "active" && task.trigger.type === "reference") {
        const key = subscriberKey(task, task.trigger.triggerId), group = this.subscribersByTrigger.get(key) ?? [];
        group.push(task); this.subscribersByTrigger.set(key, group);
      }
    }
  }
  subscribers(record: RuntimeTrigger): readonly ActiveTask[] {
    this.indexTasks();
    return this.subscribersByTrigger.get(subscriberKey(record, record.id)) ?? [];
  }
  facts(scope: Scope): TriggerFacts {
    const key = scopeKey(scope), cached = this.factsByScope.get(key);
    if (cached) return cached;
    const recentEvents = (prepareSql(this.db, `SELECT e.event_id,e.occurred_at,s.source,e.payload_json FROM agent_external_events e JOIN agent_external_sources s ON s.id=e.source_id
      WHERE s.user_id=? AND s.principal_id=? AND s.status='active' AND COALESCE(json_extract(e.payload_json,'$.historyOnly'),0)=0
      ORDER BY e.occurred_at DESC LIMIT 100`).all(scope.userId, scope.principalId ?? "") as Row[])
      .map(row => ({ id: String(row.event_id), type: "external" as const, occurredAt: Number(row.occurred_at), source: String(row.source), event: (JSON.parse(String(row.payload_json)) as { event: string }).event }));
    const deliveries = (prepareSql(this.db, `SELECT r.task_id,MAX(r.delivered_at) AS delivered_at FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.agent_id=? AND t.user_id=? AND COALESCE(t.principal_id,'')=? AND r.notification_status='delivered' AND r.delivered_at IS NOT NULL GROUP BY r.task_id`)
      .all(this.agentId, scope.userId, scope.principalId ?? "") as Row[]).map(row => ({ taskId: String(row.task_id), deliveredAt: Number(row.delivered_at) }));
    const externalSources = (prepareSql(this.db, "SELECT source,allowed_events_json FROM agent_external_sources WHERE user_id=? AND principal_id=? AND status='active'")
      .all(scope.userId, scope.principalId ?? "") as Row[]).map(row => ({ source: String(row.source), events: JSON.parse(String(row.allowed_events_json)) as string[] }));
    this.indexTasks();
    const taskIds = (this.tasksByScope!.get(key) ?? []).map(task => task.id);
    const facts = { recentEvents, deliveries, externalSources, taskIds,
      ...(recentEvents.length >= 100 ? { eventsCompleteAfter: Math.min(...recentEvents.map(value => value.occurredAt)) } : {}) };
    this.factsByScope.set(key, facts);
    return facts;
  }
}
