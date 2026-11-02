import { prepareSql, closeSqlite, sqliteTransaction } from "../sqlite.js";
import { distanceMeters } from "../location/coordinates.js";
import { matchesLocationSpeed } from "./location-speed.js";
import type { StoredLocation } from "../location/store.js";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRunSnapshot } from "../agent/transcript.js";
import type {
  ActiveTask,
  TaskRun,
  TaskRunResult,
  TaskScope,
  TaskTrigger,
  LocationTaskEvent,
  ExternalTaskEvent,
  ExternalEventSource,
  AgentExternalEvent,
  ExternalEventReceipt,
} from "./types.js";
import { createNextOccurrenceResolver, localTaskTime, nextOccurrence, validateTrigger } from "./schedule.js";
import { DEFAULT_MAX_LATENESS_SECONDS, taskTimeWindowOpen } from "./time-policy.js";
import { currentHrvEvidence, hrvRunEvidence, hrvSleepGate } from "../health/hrv-policy.js";
import { externalEventDescription, externalEventSchema, externalName } from "./external-events.js";
import { deviceTimeIsUsable } from "../time-policy.js";
import { PhoneNotificationStore } from "./phone-notifications.js";
import { ReusableTriggerStore, type ReusableTriggerSpec, type TriggerFixture, type TriggerRevision, type SharedTrigger } from "./reusable.js";

type Row = Record<string, unknown>;
export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly changeListeners = new Set<() => void>();
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }
  private changed(): void { for (const listener of this.changeListeners) listener(); }
  private changedTx<T>(fn: () => T): T {
    const result = this.tx(fn);
    this.changed();
    return result;
  }
  private readonly reusable: ReusableTriggerStore;
  private readonly phoneNotifications: PhoneNotificationStore;
  constructor(
    readonly options: {
      databasePath: string;
      agentId: string;
      ownerUserId?: string;
      deliveryDatabasePath?: string;
      defaultModel?(): string;
      legacyDefaultModel?: string;
    },
  ) {
    if (options.ownerUserId === "") throw new Error("Task owner must be configured");
    mkdirSync(dirname(options.databasePath), { recursive: true });
    this.db = new DatabaseSync(options.databasePath);
    if (options.deliveryDatabasePath) prepareSql(this.db, "ATTACH DATABASE ? AS delivery_state").run(options.deliveryDatabasePath);
    const ownership = prepareSql(this.db,
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_metadata'",
      )
      .get();
    if (ownership) {
      const row = prepareSql(this.db,
        "SELECT agent_id FROM agent_metadata WHERE singleton=1")
        .get() as Row | undefined;
      if (row && row.agent_id !== options.agentId) {
        closeSqlite(this.db);
        throw new Error("Task database belongs to a different agent");
      }
    }
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS agent_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),agent_id TEXT NOT NULL)",
    );
    prepareSql(this.db,
        "INSERT OR IGNORE INTO agent_metadata(singleton,agent_id) VALUES(1,?)",
      )
      .run(options.agentId);
    const claimed = prepareSql(this.db,
      "SELECT agent_id FROM agent_metadata WHERE singleton=1")
      .get() as { agent_id: string };
    if (claimed.agent_id !== options.agentId) {
      closeSqlite(this.db);
      throw new Error("Task database belongs to a different agent");
    }
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,title TEXT NOT NULL,instruction TEXT NOT NULL,trigger_json TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT 0,next_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,creation_key TEXT,principal_id TEXT,skill_name TEXT);
      CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),occurrence TEXT NOT NULL,task_revision INTEGER NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,triggered_at INTEGER NOT NULL,started_at INTEGER,ended_at INTEGER,lease_token TEXT,lease_until INTEGER,result_json TEXT,error TEXT,notification_status TEXT NOT NULL DEFAULT 'none',notification_id TEXT NOT NULL,session_id TEXT,message_id TEXT,parent_run_id TEXT,refresh_count INTEGER NOT NULL DEFAULT 0,UNIQUE(task_id,occurrence));
      CREATE INDEX IF NOT EXISTS task_runs_queue ON task_runs(state,available_at);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(agent_id,status,next_at);
      CREATE TABLE IF NOT EXISTS task_run_activity(run_id TEXT NOT NULL REFERENCES task_runs(id),attempt INTEGER NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(run_id,attempt));
      CREATE TABLE IF NOT EXISTS task_health_pending(task_id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,payload_json TEXT NOT NULL,due_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS task_health_pending_due ON task_health_pending(due_at,task_id);
      CREATE TABLE IF NOT EXISTS task_location_events(event_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_source_cursors(name TEXT PRIMARY KEY,cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_location_state(task_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,observed_at INTEGER NOT NULL,inside INTEGER,last_triggered_at INTEGER);
      CREATE TABLE IF NOT EXISTS task_mutations(task_id TEXT NOT NULL,mutation_key TEXT NOT NULL,PRIMARY KEY(task_id,mutation_key));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_external_events(task_id TEXT NOT NULL REFERENCES tasks(id),event_id TEXT NOT NULL,received_at INTEGER NOT NULL,status TEXT NOT NULL,PRIMARY KEY(task_id,event_id));
      CREATE INDEX IF NOT EXISTS task_external_cooldown ON task_external_events(task_id,status,received_at);
      CREATE TABLE IF NOT EXISTS agent_external_sources(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,principal_id TEXT NOT NULL,source TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,allowed_events_json TEXT NOT NULL,max_age_seconds INTEGER NOT NULL,status TEXT NOT NULL,UNIQUE(user_id,principal_id,source));
      CREATE TABLE IF NOT EXISTS agent_external_events(source_id TEXT NOT NULL REFERENCES agent_external_sources(id),event_id TEXT NOT NULL,occurred_at INTEGER NOT NULL,received_at INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(source_id,event_id));`);
    const runColumns = prepareSql(this.db,
      "PRAGMA table_info(task_runs)")
      .all() as Array<{ name: string }>;
    if (!runColumns.some((c) => c.name === "parent_run_id"))
      this.db.exec("ALTER TABLE task_runs ADD COLUMN parent_run_id TEXT");
    if (!runColumns.some((c) => c.name === "delivered_at"))
      this.db.exec("ALTER TABLE task_runs ADD COLUMN delivered_at INTEGER");
    if (!runColumns.some((c) => c.name === "refresh_count"))
      this.db.exec(
        "ALTER TABLE task_runs ADD COLUMN refresh_count INTEGER NOT NULL DEFAULT 0",
      );
    const columns = prepareSql(this.db, "PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === "model")) this.db.exec("ALTER TABLE tasks ADD COLUMN model TEXT");
    // Freeze legacy inherited models once. Later default changes and restarts must not reroute them.
    const legacyModel = options.legacyDefaultModel ?? options.defaultModel?.();
    if (legacyModel) prepareSql(this.db, "UPDATE tasks SET model=? WHERE agent_id=? AND model IS NULL").run(legacyModel, options.agentId);
    if (!columns.some((c) => c.name === "skill_name")) this.db.exec("ALTER TABLE tasks ADD COLUMN skill_name TEXT");
    if (!columns.some((c) => c.name === "principal_id"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN principal_id TEXT");
    if (!columns.some((c) => c.name === "delivery_policy"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT 'conditional'");
    if (!columns.some((c) => c.name === "creation_key"))
      this.db.exec("ALTER TABLE tasks ADD COLUMN creation_key TEXT");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_creation_key ON tasks(agent_id,user_id,creation_key) WHERE creation_key IS NOT NULL",
    );
    // Preserve the existing iPhone credential during the move from one task to a source of Agent events.
    // Only the known owner-provisioned alarm integration is eligible; cancelled bindings are not revived.
    if (prepareSql(this.db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_external_tokens'").get()) {
      const legacy = prepareSql(this.db, `SELECT t.user_id,t.principal_id,t.trigger_json,k.token_hash FROM task_external_tokens k JOIN tasks t ON t.id=k.task_id
        WHERE t.agent_id=? AND t.creation_key='outing-weather:v1' AND t.status IN ('active','paused')`).all(options.agentId) as Row[];
      for (const row of legacy) {
        const trigger = JSON.parse(String(row.trigger_json));
        if (trigger.type !== "external" || trigger.event !== "alarm_stopped") continue;
        prepareSql(this.db, `INSERT OR IGNORE INTO agent_external_sources(id,user_id,principal_id,source,token_hash,allowed_events_json,max_age_seconds,status)
          VALUES(?,?,?,'iphone',?,'["alarm_stopped"]',1800,'active')`)
          .run(randomUUID(), String(row.user_id), row.principal_id == null ? "" : String(row.principal_id), String(row.token_hash));
      }
    }
    this.phoneNotifications = new PhoneNotificationStore(this.db);
    this.reusable = new ReusableTriggerStore(this.db, options.agentId, {
      tasks: () => this.all(), enqueue: (task, occurrence, payload, now) => this.enqueue(task, occurrence, payload, now),
      invalidate: (id, now) => this.invalidateSharedTrigger(id, now),
    });
  }
  listTriggers(scope: TaskScope): SharedTrigger[] { this.assertScope(scope); return this.reusable.list(scope); }
  getTrigger(scope: TaskScope, id: string): SharedTrigger | undefined { this.assertScope(scope); return this.reusable.get(scope, id); }
  getTriggerSource(scope: TaskScope, id: string): ReusableTriggerSpec["source"] | undefined {
    this.assertScope(scope); return this.reusable.activeSource(scope, id);
  }
  stageTrigger(scope: TaskScope, input: { id?: string; title: string; spec: ReusableTriggerSpec; fixtures: TriggerFixture[] }, creationKey?: string): SharedTrigger {
    this.assertScope(scope); return this.tx(() => this.reusable.stage(scope, input, creationKey));
  }
  validateTriggerRevision(scope: TaskScope, id: string, revision: number): TriggerRevision {
    this.assertScope(scope); return this.tx(() => this.reusable.validate(scope, id, revision));
  }
  activateTriggerRevision(scope: TaskScope, id: string, revision: number): SharedTrigger {
    this.assertScope(scope); return this.changedTx(() => this.reusable.activate(scope, id, revision));
  }
  rollbackTrigger(scope: TaskScope, id: string): SharedTrigger { this.assertScope(scope); return this.changedTx(() => this.reusable.rollback(scope, id)); }
  pauseTrigger(scope: TaskScope, id: string): SharedTrigger { this.assertScope(scope); return this.changedTx(() => this.reusable.status(scope, id, "paused")); }
  resumeTrigger(scope: TaskScope, id: string): SharedTrigger { this.assertScope(scope); return this.changedTx(() => this.reusable.status(scope, id, "active")); }
  createWithTriggerRevision(scope: TaskScope, input: { title: string; instruction: string; trigger: TaskTrigger; skill?: "health"; deliveryPolicy?: "always" | "conditional" }, revision: number,
    now = Date.now(), creationKey?: string, initialHealthCursor = 0): ActiveTask {
    this.assertScope(scope);
    return this.changedTx(() => {
      if (input.trigger.type !== "reference") throw new Error("A shared trigger reference is required");
      if (creationKey) {
        const prior = prepareSql(this.db, `SELECT id FROM tasks
          WHERE agent_id=? AND user_id=? AND principal_id IS ? AND creation_key=? LIMIT 1`)
          .get(scope.agentId, scope.userId, scope.principalId ?? null, creationKey) as { id: string } | undefined;
        if (prior) return this.get(prior.id)!;
      }
      this.reusable.activate(scope, input.trigger.triggerId, revision, now);
      return this.create(scope, input, now, creationKey, initialHealthCursor);
    });
  }
  sharedLocationScopes(): Array<Pick<TaskScope, "agentId" | "userId" | "principalId">> { return this.reusable.activeLocationScopes(); }
  /** Maintenance update: install a validated rule and change its task binding in one transaction. */
  updateWithTriggerRevision(scope: TaskScope, id: string, patch: { instruction: string; trigger: { type: "reference"; triggerId: string } },
    triggerRevision: number, expectedTaskRevision: number, now = Date.now()): ActiveTask {
    this.assertScope(scope);
    return this.changedTx(() => {
      const task = this.get(id);
      if (!task || task.userId !== scope.userId || task.principalId !== scope.principalId || task.revision !== expectedTaskRevision
        || task.status === "cancelled") throw new Error("Task changed before trigger update");
      this.reusable.activate(scope, patch.trigger.triggerId, triggerRevision, now);
      return this.update(scope, id, patch, now);
    });
  }
  /** Apply a reviewed owner maintenance batch only if every saved revision still matches. */
  updateTimingBatch(scope: TaskScope, changes: Array<{ id: string; expectedRevision: number; instruction: string; trigger: TaskTrigger }>): ActiveTask[] {
    this.assertScope(scope);
    return this.changedTx(() => {
      for (const change of changes) {
        const task = this.get(change.id);
        if (!task || task.userId !== scope.userId || task.principalId !== scope.principalId || task.status === "cancelled"
          || task.revision !== change.expectedRevision) throw new Error("Task changed before timing update");
      }
      return changes.map(change => this.update(scope, change.id, { instruction: change.instruction, trigger: change.trigger }));
    });
  }
  observeSharedLocation(scope: Pick<TaskScope, "userId" | "principalId">, point: StoredLocation & { id: number }, now = Date.now()): void {
    this.tx(() => this.reusable.observeLocation(scope, point, now));
  }
  isRunTriggerCurrent(task: ActiveTask, run: TaskRun, now = Date.now()): boolean {
    if (task.trigger.type === "health_change" && task.trigger.condition === "hrv_realtime_v2") {
      if (!hrvSleepGate(this, task, now).open) return false;
      const evidence = hrvRunEvidence(run);
      if (evidence && currentHrvEvidence(this, task, evidence, now, run.id).anomalies.length !== evidence.anomalies.length) return false;
    }
    return taskTimeWindowOpen(task, run, now) && this.reusable.isCurrent(task, run, now);
  }
  private invalidateSharedTrigger(id: string, now: number): void {
    const ids = this.all().filter(task => task.trigger.type === "reference" && task.trigger.triggerId === id).map(task => task.id);
    const deliverySchema = this.options.deliveryDatabasePath ? "delivery_state" : "main";
    const hasDeliveries = prepareSql(this.db, `SELECT 1 FROM ${deliverySchema}.sqlite_master WHERE type='table' AND name='background_deliveries'`).get();
    const unsentOnly = hasDeliveries ? ` AND NOT EXISTS(SELECT 1 FROM ${deliverySchema}.background_deliveries d WHERE d.delivery_id=task_runs.notification_id AND d.status IN ('attempted','delivered','uncertain'))` : "";
    for (const taskId of ids) {
      prepareSql(this.db, "UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=?").run(now, taskId);
      prepareSql(this.db, "UPDATE task_runs SET state='cancelled',ended_at=?,lease_token=NULL,lease_until=NULL WHERE task_id=? AND state IN ('pending','running')").run(now, taskId);
      prepareSql(this.db, "UPDATE task_runs SET notification_status='stale' WHERE task_id=? AND notification_status='pending'" + unsentOnly).run(taskId);
    }
  }
  close(): void {
    closeSqlite(this.db);
  }
  private assertExternalOwner(scope: Pick<TaskScope, "agentId" | "userId" | "principalId">): void {
    if (scope.agentId !== this.options.agentId || !scope.userId || this.options.ownerUserId !== undefined && scope.userId !== this.options.ownerUserId)
      throw new Error("External sources require the configured Agent and owner");
  }
  /** A source credential reports facts to this Agent/owner. It never names a task or conversation. */
  bindExternalSource(scope: Pick<TaskScope, "agentId" | "userId" | "principalId">, source: string, token: string,
    allowedEvents: readonly string[], maxAgeSeconds = 1800): ExternalEventSource {
    this.assertExternalOwner(scope);
    externalName.parse(source);
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token) || !allowedEvents.length || allowedEvents.length > 32
      || new Set(allowedEvents).size !== allowedEvents.length || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 86400)
      throw new Error("External source configuration is invalid");
    allowedEvents.forEach(event => externalName.parse(event));
    prepareSql(this.db, `INSERT INTO agent_external_sources(id,user_id,principal_id,source,token_hash,allowed_events_json,max_age_seconds,status)
      VALUES(?,?,?,?,?,?,?,'active') ON CONFLICT(user_id,principal_id,source) DO UPDATE SET
      token_hash=excluded.token_hash,allowed_events_json=excluded.allowed_events_json,max_age_seconds=excluded.max_age_seconds`)
      .run(randomUUID(), scope.userId, scope.principalId ?? "", source, createHash("sha256").update(token).digest("hex"), JSON.stringify(allowedEvents), maxAgeSeconds);
    return this.externalSources(scope).find(item => item.source === source)!;
  }
  externalSources(scope: Pick<TaskScope, "agentId" | "userId" | "principalId">): ExternalEventSource[] {
    this.assertExternalOwner(scope);
    return (prepareSql(this.db, "SELECT * FROM agent_external_sources WHERE user_id=? AND principal_id=? ORDER BY source")
      .all(scope.userId, scope.principalId ?? "") as Row[]).map(row => ({ id: String(row.id), agentId: this.options.agentId,
        userId: String(row.user_id), principalId: row.principal_id ? String(row.principal_id) : undefined,
        source: String(row.source), allowedEvents: JSON.parse(String(row.allowed_events_json)), maxAgeSeconds: Number(row.max_age_seconds),
        status: row.status as ExternalEventSource["status"] }));
  }
  setExternalSourceStatus(scope: Pick<TaskScope, "agentId" | "userId" | "principalId">, source: string, status: "active" | "disabled"): void {
    this.assertExternalOwner(scope);
    if (!["active", "disabled"].includes(status)) throw new Error("Invalid external source status");
    if (!prepareSql(this.db, "UPDATE agent_external_sources SET status=? WHERE user_id=? AND principal_id=? AND source=?")
      .run(status, scope.userId, scope.principalId ?? "", source).changes) throw new Error("External source not found");
    this.changed();
  }
  externalSource(token: string): ExternalEventSource | undefined {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return undefined;
    const row = prepareSql(this.db, "SELECT user_id,principal_id,source FROM agent_external_sources WHERE token_hash=? AND status='active'")
      .get(createHash("sha256").update(token).digest("hex")) as Row | undefined;
    if (!row) return undefined;
    return this.externalSources({ agentId: this.options.agentId, userId: String(row.user_id), principalId: row.principal_id ? String(row.principal_id) : undefined })
      .find(source => source.source === row.source);
  }
  /** Device receipt and all matching task occurrences commit together. Duplicate facts never replay into later subscriptions. */
  acceptExternalEvent(token: string, input: ExternalTaskEvent, now = Date.now(), validateOnly = false): ExternalEventReceipt {
    return this.changedTx(() => {
      const source = this.externalSource(token);
      if (!source) throw new Error("EXTERNAL_UNAUTHORIZED");
      const event = externalEventSchema.parse(input), occurredAt = Date.parse(event.occurredAt);
      if (!source.allowedEvents.includes(event.event)) throw new Error("EXTERNAL_EVENT_INVALID");
      const receipt: ExternalEventReceipt = { status: "received", matchedTasks: 0, queuedTasks: 0, coalescedTasks: 0, expiredTasks: 0 };
      if (!validateOnly && prepareSql(this.db, "SELECT 1 FROM agent_external_events WHERE source_id=? AND event_id=?").get(source.id, event.eventId)) {
        const notificationId = this.phoneNotifications.eventId(source.id, event.eventId);
        return { ...receipt, status: "duplicate", ...(notificationId === undefined ? {} : { notificationId }) };
      }
      const fresh = deviceTimeIsUsable(occurredAt, now, source.maxAgeSeconds * 1000);
      // Late app notifications remain useful history. Other device facts retain their source expiry.
      if (!deviceTimeIsUsable(occurredAt, now) || !fresh && event.event !== "notification_received") throw new Error("EXTERNAL_EVENT_INVALID");
      if (validateOnly) return { ...receipt, status: "validated", ...(event.event === "notification_received" ? { historical: !fresh } : {}) };
      const notification: AgentExternalEvent = { ...event, source: source.source, receivedAt: new Date(now).toISOString(), description: externalEventDescription(event.event, source.source),
        ...(!fresh ? { historyOnly: true } : {}) };
      prepareSql(this.db, "INSERT INTO agent_external_events(source_id,event_id,occurred_at,received_at,payload_json) VALUES(?,?,?,?,?)")
        .run(source.id, event.eventId, occurredAt, now, JSON.stringify(notification));
      const notificationId = this.phoneNotifications.save(source.id, event, now);
      if (notificationId !== undefined) { receipt.notificationId = notificationId; receipt.historical = !fresh; }
      // Never publish historical imports into shared recent-event conditions or subscriptions.
      if (!fresh) return receipt;
      const sharedQueued = this.reusable.accept(source, { id: `external:${source.id}:${event.eventId}`, type: "external", occurredAt, event: event.event, source: source.source }, now);
      receipt.queuedTasks += sharedQueued;
      receipt.matchedTasks += sharedQueued;
      for (const task of this.all()) {
        if (task.status !== "active" || task.userId !== source.userId || task.principalId !== source.principalId
          || task.trigger.type !== "external" || task.trigger.event !== event.event || task.trigger.source && task.trigger.source !== source.source) continue;
        receipt.matchedTasks++;
        const key = `${source.id}:${event.eventId}`;
        // A retry of a pre-migration alarm must not rerun the original subscription.
        if (source.source === "iphone" && prepareSql(this.db, "SELECT 1 FROM task_external_events WHERE task_id=? AND event_id=?").get(task.id, event.eventId)) continue;
        const prior = prepareSql(this.db, "SELECT MAX(received_at) AS at FROM task_external_events WHERE task_id=? AND status='queued'")
          .get(task.id) as { at: number | null };
        const status = !deviceTimeIsUsable(occurredAt, now, (task.trigger.maxAgeSeconds ?? 600) * 1000) ? "expired"
          : prior.at !== null && now - prior.at < (task.trigger.cooldownSeconds ?? 0) * 1000 ? "coalesced" : "queued";
        prepareSql(this.db, "INSERT INTO task_external_events(task_id,event_id,received_at,status) VALUES(?,?,?,?)").run(task.id, key, now, status);
        if (status === "queued") { this.enqueue(task, `external:${key}`, notification, now); receipt.queuedTasks++; }
        else if (status === "coalesced") receipt.coalescedTasks++;
        else receipt.expiredTasks++;
      }
      return receipt;
    });
  }
  readPhoneNotifications(scope: TaskScope, input: unknown) {
    this.assertScope(scope);
    this.assertExternalOwner(scope);
    return this.phoneNotifications.read(scope, input);
  }
  /** Privacy-safe facts for the Agent to inspect on an owner turn, including events with no subscriptions. */
  externalEvents(scope: TaskScope, limit = 30) {
    this.assertScope(scope);
    return (prepareSql(this.db, `SELECT s.source,e.payload_json FROM agent_external_events e JOIN agent_external_sources s ON s.id=e.source_id
      WHERE s.user_id=? AND s.principal_id=? ORDER BY e.received_at DESC,e.rowid DESC LIMIT ?`)
      .all(scope.userId, scope.principalId ?? "", Math.max(1, Math.min(100, limit))) as Row[]).map(row => {
        const event = JSON.parse(String(row.payload_json)) as AgentExternalEvent;
        return { source: String(row.source), event: event.event, occurredAt: event.occurredAt, receivedAt: event.receivedAt, description: event.description,
          ...(event.historyOnly ? { historical: true } : {}),
          ...(event.notification ? { notification: event.notification } : {}) };
      });
  }
  sourceCursor(name: string): number | undefined {
    const row = prepareSql(this.db,
      "SELECT cursor FROM task_source_cursors WHERE name=?")
      .get(name) as { cursor: number } | undefined;
    return row?.cursor;
  }
  setSourceCursor(name: string, cursor: number): void {
    if (
      !name ||
      name.length > 100 ||
      !Number.isSafeInteger(cursor) ||
      cursor < 0
    )
      throw new Error("Invalid source cursor");
    const previous = this.sourceCursor(name);
    prepareSql(this.db,
        "INSERT INTO task_source_cursors(name,cursor) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)",
      )
      .run(name, cursor);
    if (previous === undefined || cursor > previous) this.changed();
  }
  assertScope(scope: TaskScope): void {
    if (
      scope.agentId !== this.options.agentId ||
      (this.options.ownerUserId !== undefined && scope.userId !== this.options.ownerUserId) ||
      !scope.userId ||
      scope.conversationKind !== "p2p" ||
      !scope.conversationId
    )
      throw new Error(
        this.options.ownerUserId ? "Tasks are available only to the configured owner in a private conversation" : "Tasks are available only in a private conversation",
      );
  }
  create(
    scope: TaskScope,
    input: { title: string; instruction: string; trigger: TaskTrigger; skill?: "health"; deliveryPolicy?: "always" | "conditional" },
    now = Date.now(),
    creationKey?: string,
    initialHealthCursor = 0,
  ): ActiveTask {
    this.assertScope(scope);
    return this.changedTx(() => {
      if (creationKey) {
        const prior = prepareSql(this.db,
            "SELECT id FROM tasks WHERE agent_id=? AND user_id=COALESCE(?,user_id) AND creation_key=?",
          )
          .get(scope.agentId, scope.userId, creationKey) as
          { id: string } | undefined;
        if (prior) return this.get(prior.id)!;
      }
      const trigger = validateTrigger(input.trigger);
      if (trigger.type === "reference" && !this.reusable.get(scope, trigger.triggerId)?.activeRevision) throw new Error("Activate an authorized shared trigger revision first");
      const deliveryPolicy = input.deliveryPolicy ?? "conditional";
      if (!["always", "conditional"].includes(deliveryPolicy)) throw new Error("Invalid delivery policy");
      if (
        !input.title?.trim() ||
        input.title.length > 200 ||
        !input.instruction?.trim() ||
        input.instruction.length > 12000
      )
        throw new Error(
          "Task title and instruction are required (maximum 200 and 12000 characters)",
        );
      if (
        trigger.type === "time" &&
        trigger.schedule === "once" &&
        Date.parse(trigger.at) <= now
      )
        throw new Error("Once schedule must be in the future");
      const id = randomUUID();
      prepareSql(this.db,
          `INSERT INTO tasks(id,agent_id,user_id,conversation_id,title,instruction,trigger_json,status,cursor,next_at,created_at,updated_at,creation_key,principal_id,skill_name,delivery_policy,model) VALUES(?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          scope.agentId,
          scope.userId,
          scope.conversationId!,
          input.title.trim(),
          input.instruction.trim(),
          JSON.stringify(trigger),
          trigger.type === "health_change" ? initialHealthCursor : 0,
          nextOccurrence(trigger, now) ?? null,
          now,
          now,
          creationKey ?? null,
          scope.principalId ?? null,
          input.skill ?? null,
          deliveryPolicy,
          this.options.defaultModel?.() ?? null,
        );
      return this.get(id)!;
    });
  }

  list(scope: TaskScope): ActiveTask[] {
    this.assertScope(scope);
    return this.all().filter((t) => t.userId === scope.userId && (t.trigger.type !== "reference" || t.principalId === scope.principalId));
  }
  /** Presentation only: keep task/run history and delivery reconciliation intact. */
  isHistorical(task: ActiveTask, now = Date.now()): boolean {
    if (task.status === "cancelled") return true;
    let source = task.trigger;
    if (source.type === "reference") {
      const activeSource = this.reusable.activeSource({ ...task, conversationKind: "p2p" }, source.triggerId);
      if (!activeSource) return false;
      // Shared event/location rules can fire again; only their once time sources end.
      if (activeSource.type !== "time") return false;
      source = activeSource;
    }
    if (source.type === "time" && source.schedule === "once") {
      const at = Date.parse(source.at);
      if (now < at) return false;
      if (now - at > (source.maxLatenessSeconds ?? DEFAULT_MAX_LATENESS_SECONDS) * 1000) return true;
    } else if (!(source.type === "location" && source.repeat === false
      && (source.center || source.regionId || source.regionName))) return false;

    // Ignore prior revisions and manual runs. A refresh or pending delivery still needs attention.
    const state = prepareSql(this.db, `SELECT
      MAX(CASE WHEN state IN ('pending','running') OR notification_status IN ('pending','uncertain') THEN 1 ELSE 0 END) AS pending,
      MAX(CASE WHEN state='succeeded' AND notification_status IN ('none','delivered','stale') THEN 1 ELSE 0 END) AS settled
      FROM task_runs WHERE task_id=? AND task_revision=? AND COALESCE(json_extract(payload_json,'$.manual'),0)<>1`)
      .get(task.id, task.revision) as { pending: number | null; settled: number | null };
    return state.settled === 1 && state.pending !== 1;
  }
  all(): ActiveTask[] {
    return (
      prepareSql(this.db,
          "SELECT * FROM tasks WHERE agent_id=? AND user_id=COALESCE(?,user_id) ORDER BY created_at",
        )
        .all(this.options.agentId, this.options.ownerUserId ?? null) as Row[]
    ).map((r) => this.task(r));
  }
  active(): ActiveTask[] {
    return (
      prepareSql(this.db,
          "SELECT * FROM tasks WHERE agent_id=? AND user_id=COALESCE(?,user_id) AND status='active' ORDER BY created_at",
        )
        .all(this.options.agentId, this.options.ownerUserId ?? null) as Row[]
    ).map((r) => this.task(r));
  }
  get(id: string): ActiveTask | undefined {
    const r = prepareSql(this.db,
      "SELECT * FROM tasks WHERE id=? AND agent_id=? AND user_id=COALESCE(?,user_id)")
      .get(id, this.options.agentId, this.options.ownerUserId ?? null) as
      Row | undefined;
    return r ? this.task(r) : undefined;
  }
  update(
    scope: TaskScope,
    id: string,
    patch: {
      model?: string | null;
      title?: string;
      skill?: "health";
      deliveryPolicy?: "always" | "conditional";
      instruction?: string;
      trigger?: TaskTrigger;
      status?: "active" | "paused" | "cancelled";
    },
    now = Date.now(),
    mutationKey?: string,
  ): ActiveTask {
    this.assertScope(scope);
    return this.changedTx(() => {
      const task = this.get(id);
      if (!task || task.userId !== scope.userId) throw new Error("Task not found");
      if (
        mutationKey &&
        prepareSql(this.db,
            "SELECT 1 FROM task_mutations WHERE task_id=? AND mutation_key=?",
          )
          .get(id, mutationKey)
      )
        return task;
      const title = (patch.title ?? task.title).trim();
      const instruction = (patch.instruction ?? task.instruction).trim();
      const trigger = validateTrigger(patch.trigger ?? task.trigger);
      if (trigger.type === "reference" && !this.reusable.get(scope, trigger.triggerId)?.activeRevision) throw new Error("Activate an authorized shared trigger revision first");
      const status = patch.status ?? task.status;
      const skill = patch.skill ?? task.skill;
      const deliveryPolicy = patch.deliveryPolicy ?? task.deliveryPolicy ?? "conditional";
      if (!["always", "conditional"].includes(deliveryPolicy)) throw new Error("Invalid delivery policy");
      if (status === "active" && (patch.trigger || task.status !== "active") && trigger.type === "time"
        && trigger.schedule === "once" && Date.parse(trigger.at) <= now)
        throw new Error("Once schedule must be in the future");
      if (
        !title ||
        title.length > 200 ||
        !instruction ||
        instruction.length > 12000
      )
        throw new Error("Invalid title or instruction");
      const model = patch.model === null ? this.options.defaultModel?.() ?? task.model : patch.model ?? task.model;
      const unchanged =
        model === task.model &&
        deliveryPolicy === task.deliveryPolicy &&
        skill === task.skill &&
        title === task.title &&
        instruction === task.instruction &&
        JSON.stringify(trigger) === JSON.stringify(task.trigger) &&
        status === task.status;
      if (task.status === "cancelled" && !unchanged)
        throw new Error("Cancelled task cannot be updated");
      if (!unchanged) {
        prepareSql(this.db,
            "UPDATE tasks SET model=?,title=?,instruction=?,trigger_json=?,status=?,skill_name=?,delivery_policy=?,revision=revision+1,next_at=?,updated_at=? WHERE id=?",
          )
          .run(
            model ?? null,
            title,
            instruction,
            JSON.stringify(trigger),
            status,
            skill ?? null,
            deliveryPolicy,
            status === "active" ? (nextOccurrence(trigger, now) ?? null) : null,
            now,
            id,
          );
        prepareSql(this.db,
            "UPDATE task_runs SET state='cancelled',ended_at=?,lease_token=NULL,lease_until=NULL WHERE task_id=? AND state IN ('pending','running')",
          )
          .run(now, id);
        const deliverySchema = this.options.deliveryDatabasePath ? "delivery_state" : "main";
        const hasDeliveries = prepareSql(this.db,
            `SELECT 1 FROM ${deliverySchema}.sqlite_master WHERE type='table' AND name='background_deliveries'`,
          )
          .get();
        // Once transport was attempted it may already be visible externally.
        // Preserve reconciliation even when the task is paused or edited later.
        const unsentOnly = hasDeliveries
          ? ` AND NOT EXISTS(SELECT 1 FROM ${deliverySchema}.background_deliveries d WHERE d.delivery_id=task_runs.notification_id AND d.status IN ('attempted','delivered','uncertain'))`
          : "";
        prepareSql(this.db,
            "UPDATE task_runs SET notification_status='stale' WHERE task_id=? AND notification_status='pending'" +
              unsentOnly,
          )
          .run(id);
        prepareSql(this.db,
          "DELETE FROM task_health_pending WHERE task_id=?")
          .run(id);
      }
      if (mutationKey)
        prepareSql(this.db,
            "INSERT INTO task_mutations(task_id,mutation_key) VALUES(?,?)",
          )
          .run(id, mutationKey);
      return this.get(id)!;
    });
  }
  runs(scope: TaskScope, id?: string, limit = 30): TaskRun[] {
    this.assertScope(scope);
    if (id && this.get(id)?.userId !== scope.userId) throw new Error("Task not found");
    const selected = id ? this.get(id) : undefined;
    if (selected?.trigger.type === "reference" && selected.principalId !== scope.principalId) throw new Error("Task not found");
    return this.runRows(
      `SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id)
      AND (json_extract(t.trigger_json,'$.type')<>'reference' OR COALESCE(t.principal_id,'')=?) ${id ? "AND t.id=?" : ""} ORDER BY r.triggered_at DESC LIMIT ?`,
      ...[
        this.options.agentId,
        scope.userId,
        scope.principalId ?? "",
        ...(id ? [id] : []),
        Math.max(1, Math.min(100, limit)),
      ],
    );
  }
  getRun(id: string): TaskRun | undefined {
    return this.runRows(
      "SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE r.id=? AND t.agent_id=? AND t.user_id=COALESCE(?,t.user_id)",
      id,
      this.options.agentId,
      this.options.ownerUserId ?? null,
    )[0];
  }
  /** Revision cursor is arrival sequence, never observed timestamp: late health data still triggers. */
  enqueueHealthChange(
    taskId: string,
    cursor: number,
    payload: unknown,
    now = Date.now(),
  ): void {
    const task = this.get(taskId);
    if (
      !task ||
      task.status !== "active" ||
      task.trigger.type !== "health_change" ||
      cursor <= task.cursor
    )
      return;
    const pending = prepareSql(this.db,
      "SELECT cursor,due_at,payload_json FROM task_health_pending WHERE task_id=?")
      .get(taskId) as { cursor: number; due_at: number; payload_json: string } | undefined;
    if (pending && cursor <= pending.cursor) return;
    // Merge a bounded upload window; repeated uploads cannot postpone it forever.
    const debounce = (task.trigger.debounceSeconds ?? 30) * 1000;
    const due = pending ? pending.due_at : now + debounce;
    if (pending) {
      const previous = JSON.parse(pending.payload_json) as Record<string, unknown>;
      const next = payload as Record<string, unknown>;
      if (next && Array.isArray(next.changes) && Array.isArray(previous.changes)) {
        const changes = new Map<string, unknown>();
        for (const change of [...previous.changes, ...next.changes] as Array<{ id: string }>) changes.set(change.id, change);
        payload = { ...previous, ...next, fromCursor: previous.fromCursor, changes: [...changes.values()].slice(-500),
          noMatchingChanges: changes.size === 0, changesTruncated: changes.size > 500 };
      }
    }
    prepareSql(this.db,
        "INSERT INTO task_health_pending VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET cursor=excluded.cursor,payload_json=excluded.payload_json,due_at=excluded.due_at",
      )
      .run(taskId, cursor, JSON.stringify(payload), due);
    this.changed();
  }
  enqueueLocationEvent(event: LocationTaskEvent, now = Date.now()): void {
    if (this.options.ownerUserId !== undefined && event.userId !== this.options.ownerUserId) return;
    this.tx(() => {
      const inserted = prepareSql(this.db,
        "INSERT OR IGNORE INTO task_location_events VALUES(?,?,?)")
        .run(this.options.ownerUserId === undefined ? `${event.userId}:${event.id}` : event.id, JSON.stringify(event), now);
      if (!inserted.changes) return;
      // Region events carry an owner identity; principal scope is resolved from authorized subscriptions.
      for (const scope of this.reusable.activeLocationScopes()) if (scope.userId === event.userId)
        this.reusable.accept(scope, { id: `location:${event.id}`, type: "location", occurredAt: event.occurredAt, event: event.event, regionId: event.regionId, regionName: event.regionName,
          ...(event.velocityKph === undefined ? {} : { velocityKph: event.velocityKph }) }, now);
      for (const task of this.all())
        if (
          task.userId === event.userId &&
          task.status === "active" &&
          event.occurredAt >= task.createdAt &&
          task.trigger.type === "location" &&
          !task.trigger.center &&
          (!task.trigger.regionId || task.trigger.regionId === event.regionId) &&
          (!task.trigger.regionName || task.trigger.regionName === event.regionName)
        ) {
          if (!task.trigger.regionId && !task.trigger.regionName) {
            // Preserve legacy health tasks that subscribe to every region event.
            if (task.trigger.event === event.event && matchesLocationSpeed(task.trigger, event.velocityKph)) this.enqueue(task, `location:${event.id}`, event, now);
          } else this.locationTransition(task, event, event.event === "enter", now, true);
        }
    });
  }
  /** Establish a fresh baseline once per task revision; never treat existing presence as an arrival. */
  seedLocation(taskId: string, point: StoredLocation & { id: number }, now = Date.now()): void {
    const task = this.get(taskId);
    if (!task || task.status !== "active" || task.trigger.type !== "location" || !task.trigger.center) return;
    const prior = prepareSql(this.db, "SELECT revision FROM task_location_state WHERE task_id=?").get(taskId) as { revision: number } | undefined;
    if (prior?.revision === task.revision) return;
    const t = task.trigger, accuracy = point.accuracyMeters;
    if (!deviceTimeIsUsable(point.observedAt, now, (t.maxAgeSeconds ?? 600) * 1000) || accuracy === undefined || accuracy < 0 || accuracy > t.radiusMeters!) return;
    const distance = distanceMeters(t.center!, { latitude: point.gcj02Latitude, longitude: point.gcj02Longitude });
    const margin = Math.max(25, accuracy);
    const inside = distance + margin < t.radiusMeters! ? true : distance - margin > t.radiusMeters! ? false : undefined;
    if (inside === undefined) return;
    prepareSql(this.db, `INSERT INTO task_location_state VALUES(?,?,?,?,NULL) ON CONFLICT(task_id) DO UPDATE SET
      revision=excluded.revision,observed_at=excluded.observed_at,inside=excluded.inside,last_triggered_at=NULL`)
      .run(taskId, task.revision, point.observedAt, Number(inside));
  }
  /** Evaluate only fresh, ordered fixes; uncertainty near the boundary preserves the prior state. */
  observeLocation(taskId: string, point: StoredLocation & { id: number }, now = Date.now()): void {
    this.tx(() => {
      const task = this.get(taskId);
      if (!task || task.status !== "active" || task.trigger.type !== "location" || !task.trigger.center) return;
      const trigger = task.trigger;
      if (point.observedAt < task.updatedAt || !deviceTimeIsUsable(point.observedAt, now, (trigger.maxAgeSeconds ?? 600) * 1000)) return;
      const accuracy = point.accuracyMeters;
      if (accuracy === undefined || accuracy < 0 || accuracy > trigger.radiusMeters!) return;
      const distance = distanceMeters(trigger.center!, { latitude: point.gcj02Latitude, longitude: point.gcj02Longitude });
      const margin = Math.max(25, accuracy);
      const inside = distance + margin < trigger.radiusMeters! ? true
        : distance - margin > trigger.radiusMeters! ? false : undefined;
      if (inside === undefined) return;
      this.locationTransition(task, { id: `fix:${point.id}`, userId: task.userId,
        event: inside ? "enter" : "leave", occurredAt: point.observedAt,
        ...(point.velocityKph === undefined ? {} : { velocityKph: point.velocityKph }) }, inside, now);
    });
  }
  private locationTransition(task: ActiveTask, event: LocationTaskEvent, inside: boolean | undefined, now: number, authoritative = false): void {
    if (task.trigger.type !== "location") return;
    const trigger = task.trigger;
    if (event.occurredAt < task.updatedAt || !deviceTimeIsUsable(event.occurredAt, now, (trigger.maxAgeSeconds ?? 600) * 1000)) return;
    const stored = prepareSql(this.db, "SELECT * FROM task_location_state WHERE task_id=?").get(task.id) as
      { revision: number; observed_at: number; inside: number | null; last_triggered_at: number | null } | undefined;
    const prior = stored?.revision === task.revision ? stored : undefined;
    if (prior && event.occurredAt <= prior.observed_at) return;
    const changed = prior?.inside != null ? Boolean(prior.inside) !== inside : authoritative;
    const alreadyTriggered = trigger.repeat === false && prepareSql(this.db,
      "SELECT 1 FROM task_runs WHERE task_id=? AND task_revision=? LIMIT 1").get(task.id, task.revision);
    const fire = !alreadyTriggered && changed && event.event === trigger.event
      && matchesLocationSpeed(trigger, event.velocityKph)
      && (prior?.last_triggered_at == null || event.occurredAt - prior.last_triggered_at >= (trigger.cooldownSeconds ?? 300) * 1000);
    prepareSql(this.db, `INSERT INTO task_location_state VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
      revision=excluded.revision,observed_at=excluded.observed_at,inside=excluded.inside,last_triggered_at=excluded.last_triggered_at`)
      .run(task.id, task.revision, event.occurredAt, inside === undefined ? null : Number(inside),
        fire ? event.occurredAt : prior?.last_triggered_at ?? null);
    if (fire) this.enqueue(task, `location:r${task.revision}:${event.id}`, event, now);
  }
  dailyNotificationState(taskId: string, day: string): "pending" | "sent" | undefined {
    const rows = prepareSql(this.db, `SELECT notification_status FROM task_runs WHERE task_id=?
      AND json_extract(payload_json,'$.dayKey')=? AND notification_status IN ('pending','delivered','uncertain')`)
      .all(taskId, day) as Array<{ notification_status: string }>;
    return rows.some(r => r.notification_status !== "pending") ? "sent" : rows.length ? "pending" : undefined;
  }
  /** A once-per-day task holds new evidence while its earlier execution or delivery settles. */
  private dailyWorkState(taskId: string, day: string): "pending" | "sent" | undefined {
    const notification = this.dailyNotificationState(taskId, day);
    if (notification) return notification;
    return prepareSql(this.db, `SELECT 1 FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE r.task_id=? AND r.task_revision=t.revision AND r.state IN ('pending','running')
      AND json_extract(r.payload_json,'$.dayKey')=? LIMIT 1`).get(taskId, day) ? "pending" : undefined;
  }
  deliveredHealthReviewAt(taskId: string, day: string, timezone = "Asia/Shanghai"): number | undefined {
    if (!this.get(taskId)) return;
    const rows = prepareSql(this.db, `SELECT COALESCE(delivered_at,ended_at) AS at,triggered_at AS triggeredAt FROM task_runs
      WHERE task_id=? AND state='succeeded' AND notification_status='delivered'
      AND (json_extract(payload_json,'$.dayKey')=? OR json_extract(payload_json,'$.manual')=1)`)
      .all(taskId, day) as Array<{ at: number | null; triggeredAt: number }>;
    const completed = rows.filter(row => row.at !== null && localTaskTime(row.at, timezone).day === day
      && localTaskTime(row.at, timezone).time >= "04:00" && localTaskTime(row.triggeredAt, timezone).day === day);
    // Later manual rereads must not move the day's already-open sampling boundary.
    return completed.length ? Math.min(...completed.map(row => row.at!)) : undefined;
  }
  recentNotifications(taskId: string, since: number, excludeRunId = ""): TaskRun[] {
    if (!this.get(taskId)) return [];
    return this.runRows(`SELECT * FROM task_runs WHERE task_id=? AND id<>? AND notification_status IN ('pending','delivered','uncertain')
      AND (notification_status='pending' OR COALESCE(delivered_at,ended_at,triggered_at)>=?)`, taskId, excludeRunId, since);
  }
  collectDue(now = Date.now()): void {
    this.tx(() => {
      const next = createNextOccurrenceResolver(now);
      this.reusable.collect(now, next);
      const dueRows = prepareSql(this.db, `SELECT DISTINCT t.* FROM tasks t
        LEFT JOIN task_health_pending p ON p.task_id=t.id
        WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id) AND t.status='active'
          AND (t.next_at<=? OR p.due_at<=?) ORDER BY t.created_at`)
        .all(this.options.agentId, this.options.ownerUserId ?? null, now, now) as Row[];
      for (const task of dueRows.map(row => this.task(row))) {
        if (task.nextAt !== undefined && task.nextAt <= now) {
          const at = task.nextAt;
          const occurrence =
            task.trigger.type === "time" && task.trigger.schedule !== "once"
              ? new Intl.DateTimeFormat("sv-SE", {
                  timeZone: task.trigger.timezone,
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  hourCycle: "h23",
                }).format(at)
              : String(at);
          this.enqueue(task, `time:${occurrence}`, { scheduledAt: at }, now);
          // Coalesce missed intervals after downtime into one occurrence.
          prepareSql(this.db,
            "UPDATE tasks SET next_at=? WHERE id=?")
            .run(next(task.trigger) ?? null, task.id);
        }
        const pending = prepareSql(this.db,
            "SELECT * FROM task_health_pending WHERE task_id=? AND due_at<=?",
          )
          .get(task.id, now) as Row | undefined;
        if (pending) {
          const data = JSON.parse(String(pending.payload_json));
          const dayKey = typeof data.dayKey === "string" ? data.dayKey : undefined;
          const dailyState = dayKey && task.trigger.type === "health_change" && task.trigger.oncePerDay
            ? this.dailyWorkState(task.id, dayKey) : undefined;
          // Keep newer evidence while an earlier execution or delivery is still pending.
          if (dailyState === "pending") continue;
          if (dailyState !== "sent" && Number(pending.cursor) > task.cursor)
            this.enqueue(
              task,
              `health:${pending.cursor}`,
              {
                cursor: pending.cursor,
                data,
                ...(dayKey ? { dayKey } : {}),
              },
              now,
            );
          prepareSql(this.db,
            "DELETE FROM task_health_pending WHERE task_id=?")
            .run(task.id);
        }
      }
    });
  }
  claim(
    leaseMs: number,
    now = Date.now(),
    maxAttempts = 3,
    busyTaskIds: string[] = [],
  ): TaskRun | undefined {
    return this.tx(() => {
      prepareSql(this.db,
          "UPDATE task_runs SET state='failed',ended_at=?,error='Worker lease expired; retry budget exhausted',lease_token=NULL,lease_until=NULL WHERE state='running' AND lease_until<=? AND attempts>=?",
        )
        .run(now, now, maxAttempts);
      const row = prepareSql(this.db,
          `SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id) AND t.status='active' AND t.revision=r.task_revision AND r.attempts<? AND t.id NOT IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM task_runs other WHERE other.task_id=r.task_id AND other.id<>r.id AND other.state='running' AND other.lease_until>?) AND ((r.state='pending' AND r.available_at<=?) OR (r.state='running' AND r.lease_until<=?)) ORDER BY r.triggered_at LIMIT 1`,
        )
        .get(
          this.options.agentId,
          this.options.ownerUserId ?? null,
          maxAttempts,
          JSON.stringify(busyTaskIds),
          now,
          now,
          now,
        ) as Row | undefined;
      if (!row) return;
      const candidate = this.getRun(String(row.id))!, candidateTask = this.get(candidate.taskId)!;
      if (!this.isRunTriggerCurrent(candidateTask, candidate, now)) {
        prepareSql(this.db, "UPDATE task_runs SET state='cancelled',ended_at=? WHERE id=?").run(now, candidate.id);
        return;
      }
      const token = randomUUID();
      prepareSql(this.db,
          "UPDATE task_runs SET state='running',attempts=attempts+1,started_at=COALESCE(started_at,?),lease_token=?,lease_until=? WHERE id=?",
        )
        .run(now, token, now + leaseMs, String(row.id));
      return this.getRun(String(row.id));
    });
  }
  /** Freeze skill and input data on first attempt; retries use exactly the same decision inputs. */
  saveActivity(id: string, token: string, attempt: number, snapshot: AgentRunSnapshot): void {
    prepareSql(this.db, `INSERT INTO task_run_activity(run_id,attempt,snapshot_json)
      SELECT id,?,? FROM task_runs WHERE id=? AND state='running' AND lease_token=? AND attempts=?
      ON CONFLICT(run_id,attempt) DO UPDATE SET snapshot_json=excluded.snapshot_json`)
      .run(attempt, JSON.stringify(snapshot), id, token, attempt);
  }
  activity(id: string): Array<{ attempt: number; snapshot: AgentRunSnapshot }> {
    return (prepareSql(this.db, "SELECT attempt,snapshot_json FROM task_run_activity WHERE run_id=? ORDER BY attempt").all(id) as Array<{ attempt: number; snapshot_json: string }>)
      .map(row => ({ attempt: row.attempt, snapshot: JSON.parse(row.snapshot_json) as AgentRunSnapshot }));
  }
  pinSession(id: string, token: string, sessionId: string, now = Date.now()): void {
    const updated = prepareSql(this.db, `UPDATE task_runs SET session_id=? WHERE id=? AND state='running'
      AND lease_token=? AND lease_until>? AND (session_id IS NULL OR session_id=?)`).run(sessionId, id, token, now, sessionId);
    if (!updated.changes) throw new Error("Task execution session lease lost");
  }

  pinSnapshot(id: string, token: string, snapshot: unknown): unknown {
    return this.tx(() => {
      const run = this.getRun(id);
      if (!run || run.state !== "running" || run.leaseToken !== token)
        throw new Error("Task execution lease lost");
      const payload = run.payload as Record<string, unknown>;
      if (payload.snapshot !== undefined) return payload.snapshot;
      prepareSql(this.db,
          "UPDATE task_runs SET payload_json=? WHERE id=? AND lease_token=?",
        )
        .run(JSON.stringify({ ...payload, snapshot }), id, token);
      return snapshot;
    });
  }

  heartbeat(
    id: string,
    token: string,
    leaseMs: number,
    now = Date.now(),
  ): boolean {
    const run = this.getRun(id), task = run && this.get(run.taskId);
    if (!run || !task || !this.isRunTriggerCurrent(task, run, now)) return false;
    return !!prepareSql(this.db,
        "UPDATE task_runs SET lease_until=? WHERE id=? AND state='running' AND lease_token=? AND EXISTS(SELECT 1 FROM tasks WHERE tasks.id=task_runs.task_id AND tasks.status='active' AND tasks.revision=task_runs.task_revision)",
      )
      .run(now + leaseMs, id, token).changes;
  }
  complete(
    id: string,
    token: string,
    result: TaskRunResult,
    now = Date.now(),
  ): boolean {
    return this.tx(() => {
      const run = this.getRun(id);
      if (!run || run.state !== "running" || run.leaseToken !== token) return false;
      const task = this.get(run.taskId)!;
      if (!task || task.status !== "active" || task.revision !== run.taskRevision) return false;
      if (!this.isRunTriggerCurrent(task, run, now)) {
        // The provider may already have returned usage. Preserve it even when the result expired before commit.
        prepareSql(this.db, "UPDATE task_runs SET state='cancelled',ended_at=?,result_json=?,notification_status='stale',lease_token=NULL,lease_until=NULL WHERE id=?")
          .run(now, JSON.stringify({ ...result, text: undefined }), id);
        return true;
      }
      if (!this.heartbeat(id, token, 1, now)) return false;
      const day = (run.payload as { dayKey?: string }).dayKey;
      if (result.text?.trim() && task.trigger.type === "health_change" && task.trigger.oncePerDay && day
        && this.dailyNotificationState(task.id, day)) result = { ...result, text: undefined };
      prepareSql(this.db,
          "UPDATE task_runs SET state='succeeded',ended_at=?,result_json=?,notification_status=?,lease_token=NULL,lease_until=NULL WHERE id=?",
        )
        .run(
          now,
          JSON.stringify(result),
          result.text?.trim() ? "pending" : "none",
          id,
        );
      // Advance only the exact revision cursor included in the successful snapshot.
      const cursor =
        result.cursor ?? (run.payload as { cursor?: number })?.cursor;
      if (cursor !== undefined)
        prepareSql(this.db,
          "UPDATE tasks SET cursor=MAX(cursor,?) WHERE id=?")
          .run(cursor, run.taskId);
      return true;
    });
  }
  fail(
    id: string,
    token: string,
    error: string,
    maxAttempts = 3,
    now = Date.now(),
  ): void {
    const run = this.getRun(id);
    if (!run || run.state !== "running" || run.leaseToken !== token) return;
    prepareSql(this.db,
        "UPDATE task_runs SET state=?,available_at=?,ended_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
      )
      .run(
        run.attempts < maxAttempts ? "pending" : "failed",
        now + Math.min(60000, 1000 * 2 ** run.attempts),
        run.attempts < maxAttempts ? null : now,
        error.slice(0, 1000),
        id,
        token,
      );
  }
  pendingNotifications(now = Date.now()): TaskRun[] {
    return this.runRows(
      "SELECT r.* FROM task_runs r JOIN tasks t ON t.id=r.task_id WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id) AND r.notification_status='pending' AND r.available_at<=? ORDER BY r.triggered_at",
      this.options.agentId,
      this.options.ownerUserId ?? null,
      now,
    );
  }
  deferNotification(id: string, at: number): void {
    prepareSql(this.db, "UPDATE task_runs SET available_at=? WHERE id=? AND notification_status='pending'").run(at, id);
  }

  /** All persisted deadlines, including debounce, shared delays, retries and abandoned leases. */
  nextWakeAt(busyTaskIds: string[] = [], includeWork = true, maxAttempts = 3): number | undefined {
    const scope = [this.options.agentId, this.options.ownerUserId ?? null];
    const scheduled = prepareSql(this.db, `SELECT MIN(next_at) AS at FROM tasks
      WHERE agent_id=? AND user_id=COALESCE(?,user_id) AND status='active'`).get(...scope) as { at: number | null };
    let at = Math.min(scheduled.at ?? Infinity, this.reusable.nextWakeAt() ?? Infinity);
    const health = prepareSql(this.db, `SELECT t.id,p.due_at AS at,json_extract(t.trigger_json,'$.oncePerDay') AS daily,
      json_extract(p.payload_json,'$.dayKey') AS day FROM task_health_pending p JOIN tasks t ON t.id=p.task_id
      WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id) AND t.status='active'`).all(...scope) as
      Array<{ id: string; at: number; daily: number | null; day: string | null }>;
    for (const pending of health) {
      // collectDue deliberately holds newer daily evidence until the previous execution/delivery settles.
      // That held deadline must not create a zero-delay scheduling loop.
      if (pending.daily && pending.day && this.dailyWorkState(pending.id, pending.day) === "pending") continue;
      at = Math.min(at, pending.at);
    }
    if (includeWork) {
      const queued = prepareSql(this.db, `SELECT MIN(CASE WHEN r.notification_status='pending' THEN r.available_at
        WHEN r.state='running' THEN r.lease_until
        ELSE MAX(r.available_at, COALESCE((SELECT MAX(other.lease_until) FROM task_runs other
          WHERE other.task_id=r.task_id AND other.state='running'),0)) END) AS at
        FROM task_runs r JOIN tasks t ON t.id=r.task_id
        WHERE t.agent_id=? AND t.user_id=COALESCE(?,t.user_id) AND t.id NOT IN (SELECT value FROM json_each(?))
        AND (r.notification_status='pending' OR (t.status='active' AND t.revision=r.task_revision
          AND ((r.state='pending' AND r.attempts<?) OR r.state='running')))`)
        .get(...scope, JSON.stringify(busyTaskIds), maxAttempts) as { at: number | null };
      at = Math.min(at, queued.at ?? Infinity);
    }
    return Number.isFinite(at) ? at : undefined;
  }
  /** Only title metadata for a previously delivered phone/chat identity; never read task or reply bodies. */
  titleForNotification(userId: string, notificationId: string): string | undefined {
    if (this.options.ownerUserId !== undefined && userId !== this.options.ownerUserId) return undefined;
    return (prepareSql(this.db, `SELECT t.title FROM task_runs r JOIN tasks t ON t.id=r.task_id
      WHERE t.agent_id=? AND t.user_id=? AND r.notification_id=?`)
      .get(this.options.agentId, userId, notificationId) as { title: string } | undefined)?.title;
  }
  markDelivered(
    id: string,
    link: { sessionId: string; messageId: string },
    now = Date.now(),
  ): void {
    prepareSql(this.db,
        "UPDATE task_runs SET notification_status='delivered',session_id=?,message_id=?,delivered_at=? WHERE id=? AND notification_status='pending'",
      )
      .run(link.sessionId, link.messageId, now, id);
    this.changed();
  }
  /** A stale scheduled/location suggestion gets at most two fresh decisions, never an old-text resend. */
  refreshStale(id: string, maxRefreshes = 2, now = Date.now()): void {
    this.tx(() => {
      const run = this.getRun(id);
      if (!run || run.notificationStatus !== "pending") return;
      this.markStale(id);
      const task = this.get(run.taskId);
      if (
        !task ||
        task.status !== "active" ||
        task.revision !== run.taskRevision ||
        (task.trigger.type === "health_change" && !task.trigger.oncePerDay && !task.trigger.condition) ||
        run.refreshCount >= maxRefreshes
      )
        return;
      const payload = { ...(run.payload as Record<string, unknown>) };
      delete payload.snapshot;
      this.enqueue(
        task,
        `${run.occurrence}:refresh`,
        payload,
        now,
        run.id,
        run.refreshCount + 1,
      );
    });
  }

  markNotificationUncertain(id: string): void {
    prepareSql(this.db,
        "UPDATE task_runs SET notification_status='uncertain',error='Delivery acknowledgement remained uncertain; manual review required' WHERE id=? AND notification_status='pending'",
      )
      .run(id);
  }
  markStale(id: string): void {
    prepareSql(this.db,
        "UPDATE task_runs SET notification_status='stale' WHERE id=? AND notification_status='pending'",
      )
      .run(id);
  }
  private enqueue(
    task: ActiveTask,
    occurrence: string,
    payload: unknown,
    now: number,
    parentRunId?: string,
    refreshCount = 0,
  ): void {
    prepareSql(this.db,
        "INSERT OR IGNORE INTO task_runs(id,task_id,occurrence,task_revision,state,payload_json,available_at,triggered_at,notification_id,parent_run_id,refresh_count) VALUES(?,?,?,?,'pending',?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        task.id,
        occurrence,
        task.revision,
        JSON.stringify(payload),
        now,
        now,
        randomUUID(),
        parentRunId ?? null,
        refreshCount,
      );
  }
  private tx<T>(fn: () => T): T {
    return sqliteTransaction(this.db, fn);
  }
  private runRows(sql: string, ...args: (string | number | null)[]): TaskRun[] {
    return (prepareSql(this.db, sql).all(...args) as Row[]).map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      parentRunId:
        r.parent_run_id == null ? undefined : String(r.parent_run_id),
      refreshCount: Number(r.refresh_count ?? 0),
      occurrence: String(r.occurrence),
      taskRevision: Number(r.task_revision),
      state: r.state as TaskRun["state"],
      payload: JSON.parse(String(r.payload_json)),
      attempts: Number(r.attempts),
      availableAt: Number(r.available_at),
      triggeredAt: Number(r.triggered_at),
      startedAt: r.started_at == null ? undefined : Number(r.started_at),
      endedAt: r.ended_at == null ? undefined : Number(r.ended_at),
      deliveredAt: r.delivered_at == null ? undefined : Number(r.delivered_at),
      leaseToken: r.lease_token == null ? undefined : String(r.lease_token),
      leaseUntil: r.lease_until == null ? undefined : Number(r.lease_until),
      result: r.result_json ? JSON.parse(String(r.result_json)) : undefined,
      error: r.error == null ? undefined : String(r.error),
      notificationStatus:
        r.notification_status as TaskRun["notificationStatus"],
      notificationId: String(r.notification_id),
      sessionId: r.session_id == null ? undefined : String(r.session_id),
      messageId: r.message_id == null ? undefined : String(r.message_id),
    }));
  }
  private task(r: Row): ActiveTask {
    return {
      model: r.model == null ? undefined : String(r.model),
      id: String(r.id),
      agentId: String(r.agent_id),
      userId: String(r.user_id),
      principalId: r.principal_id == null ? undefined : String(r.principal_id),
      conversationId: String(r.conversation_id),
      title: String(r.title),
      skill: r.skill_name === "health" ? "health" : undefined,
      deliveryPolicy: r.delivery_policy === "always" ? "always" : "conditional",
      instruction: String(r.instruction),
      trigger: JSON.parse(String(r.trigger_json)),
      status: r.status as ActiveTask["status"],
      revision: Number(r.revision),
      cursor: Number(r.cursor),
      nextAt: r.next_at == null ? undefined : Number(r.next_at),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
