import { prepareSql } from "../sqlite.js";
import { ReusableTriggerReads, type RuntimeTrigger, type TriggerEvaluationReads } from "./reusable-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createNextOccurrenceResolver, nextOccurrence, type NextOccurrence } from "./schedule.js";
import type { ActiveTask, TaskRun, TaskScope } from "./types.js";
import { distanceMeters } from "../location/coordinates.js";
import type { StoredLocation } from "../location/store.js";
import { matchesLocationSpeed, validLocationSpeedRange } from "./location-speed.js";
import { deviceTimeIsUsable, timestampIsFresh } from "../time-policy.js";
import { scheduledWindowOpen } from "./time-policy.js";

export const TRIGGER_VALIDATOR_VERSION = "reusable-v1";
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const seconds = z.number().int().min(0).max(86400);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const zone = z.string().max(100).default("Asia/Shanghai").refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Invalid timezone");
const externalSource = z.object({ type: z.literal("external"), event: name, source: name.optional() }).strict();
const locationSource = z.object({ type: z.literal("location"), event: z.enum(["enter", "leave"]),
  minSpeedKph: z.number().min(0).max(2000).optional(), maxSpeedKph: z.number().min(0).max(2000).optional(),
  regionId: z.string().min(1).max(200).optional(), regionName: z.string().min(1).max(200).optional(),
  center: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), system: z.literal("GCJ-02") }).strict().optional(),
  radiusMeters: z.number().min(100).max(50000).optional() }).strict().refine(value => value.center
    ? value.radiusMeters !== undefined && !value.regionId && !value.regionName
    : !value.radiusMeters && Boolean(value.regionId || value.regionName), "Select a region or coordinate fence")
  .refine(validLocationSpeedRange, "Location minimum speed must not exceed maximum speed");
const timeSource = z.union([
  z.object({ type: z.literal("time"), schedule: z.literal("once"), at: z.string().max(100).refine(value => /([Zz]|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))), timezone: zone, maxLatenessSeconds: seconds.refine(v => v > 0).optional() }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("daily"), time: clock, timezone: zone, maxLatenessSeconds: seconds.refine(v => v > 0).optional() }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("weekly"), time: clock, timezone: zone,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7), maxLatenessSeconds: seconds.refine(v => v > 0).optional() }).strict()
]);
export type TriggerCondition =
  | { type: "time_window"; after?: string; before?: string; weekdays?: number[]; timezone?: string }
  | { type: "recent_event"; event: string; source?: string; withinSeconds: number }
  | { type: "task_delivered"; taskId: string; withinSeconds: number }
  | { type: "all"; conditions: TriggerCondition[] }
  | { type: "any"; conditions: TriggerCondition[] }
  | { type: "not"; condition: TriggerCondition };
const conditionSchema: z.ZodType<TriggerCondition> = z.lazy(() => z.union([
  z.object({ type: z.literal("time_window"), after: clock.optional(), before: clock.optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(), timezone: zone }).strict(),
  z.object({ type: z.literal("recent_event"), event: name, source: name.optional(), withinSeconds: seconds.refine(v => v > 0) }).strict(),
  z.object({ type: z.literal("task_delivered"), taskId: z.string().min(1).max(200), withinSeconds: seconds.refine(v => v > 0) }).strict(),
  z.object({ type: z.literal("all"), conditions: z.array(conditionSchema).min(1).max(16) }).strict(),
  z.object({ type: z.literal("any"), conditions: z.array(conditionSchema).min(1).max(16) }).strict(),
  z.object({ type: z.literal("not"), condition: conditionSchema }).strict()
]));
export const triggerEventMatcherSchema = z.union([externalSource,
  z.object({ type: z.literal("location"), event: z.enum(["enter", "leave"]), regionId: z.string().min(1).max(200).optional(), regionName: z.string().min(1).max(200).optional() }).strict()]);
export const reusableTriggerSpecSchema = z.object({
  source: z.union([externalSource, locationSource, timeSource]), condition: conditionSchema.optional(),
  delaySeconds: seconds.default(0), cancelOn: z.array(triggerEventMatcherSchema).max(8).default([]),
  cooldownSeconds: seconds.default(0), maxAgeSeconds: seconds.refine(v => v > 0).default(3600)
}).strict();
export type ReusableTriggerSpec = z.infer<typeof reusableTriggerSpecSchema>;
export const triggerEventSchema = z.object({ id: z.string().min(1).max(300), type: z.enum(["external", "location", "time"]),
  velocityKph: z.number().min(0).max(2000).optional(),
  occurredAt: z.number().int().nonnegative(), source: name.optional(), event: z.string().max(200).optional(),
  regionId: z.string().max(200).optional(), regionName: z.string().max(200).optional(), scheduledAt: z.number().int().nonnegative().optional() }).strict();
export type TriggerEvent = z.infer<typeof triggerEventSchema>;
export const triggerFixtureSchema = z.object({ name: z.string().min(1).max(100), steps: z.array(z.object({
  at: z.number().int().nonnegative(), event: triggerEventSchema.optional(),
  recentEvents: z.array(triggerEventSchema).max(100).optional(),
  externalSources: z.array(z.object({ source: name, events: z.array(name).max(32) }).strict()).max(32).optional(),
  taskIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  deliveries: z.array(z.object({ taskId: z.string().min(1).max(200), deliveredAt: z.number().int().nonnegative() }).strict()).max(100).optional()
}).strict()).min(1).max(100), expectedFirings: z.number().int().min(0).max(100) }).strict();
export type TriggerFixture = z.infer<typeof triggerFixtureSchema>;
export type TriggerFacts = { recentEvents: TriggerEvent[]; deliveries: Array<{ taskId: string; deliveredAt: number }>;
  externalSources?: Array<{ source: string; events: string[] }>; taskIds?: string[]; eventsCompleteAfter?: number };
export type TriggerState = { pending?: { event: TriggerEvent; dueAt: number }; lastFiredAt?: number; lastEventAt?: number };
export type TriggerValidation = { passed: boolean; validatorVersion: string; hash: string; checkedAt: number;
  results: Array<{ name: string; expectedFirings: number; actualFirings: number; passed: boolean }> };
export type TriggerRevision = { revision: number; spec: ReusableTriggerSpec; fixtures: TriggerFixture[];
  hash: string; validation?: TriggerValidation; createdAt: number };
export type SharedTrigger = { id: string; title: string; status: "draft" | "active" | "paused";
  revision: number; activeRevision?: number; previousRevision?: number; subscriberCount: number;
  revisions: TriggerRevision[]; lastFiredAt?: number; nextAt?: number };

/** Reject excessive nesting before the recursive parser, not after it could exhaust the stack. */
export function parseReusableTriggerSpec(input: unknown): ReusableTriggerSpec {
  const inspect = (value: unknown, depth: number, count: { n: number }) => {
    if (depth > 8 || ++count.n > 256) throw new Error("Trigger rule exceeds complexity limits");
    if (value && typeof value === "object") for (const child of Object.values(value)) {
      if (child && typeof child === "object") inspect(child, depth + 1, count);
    }
  };
  inspect(input, 0, { n: 0 });
  if (JSON.stringify(input).length > 24000) throw new Error("Trigger rule exceeds size limit");
  const spec = reusableTriggerSpecSchema.parse(input);
  // A location wait tracks absence of an opposite event; it is not proof of continuous physical presence.
  if (spec.source.type === "location" && spec.delaySeconds) {
    const opposite = { type: "location" as const, event: spec.source.event === "enter" ? "leave" as const : "enter" as const,
      ...(spec.source.regionId ? { regionId: spec.source.regionId } : {}), ...(spec.source.regionName ? { regionName: spec.source.regionName } : {}) };
    if (!spec.cancelOn.some(value => JSON.stringify(value) === JSON.stringify(opposite))) spec.cancelOn.push(opposite);
  }
  return spec;
}
export function triggerRevisionHash(spec: ReusableTriggerSpec, fixtures: TriggerFixture[]): string {
  return createHash("sha256").update(JSON.stringify({ spec, fixtures })).digest("hex");
}
function eventMatches(match: ReusableTriggerSpec["source"] | z.infer<typeof triggerEventMatcherSchema>, event: TriggerEvent): boolean {
  if (match.type !== event.type) return false;
  if (match.type === "time") {
    if (event.scheduledAt !== event.occurredAt) return false;
    if (match.schedule === "once") return event.scheduledAt === Date.parse(match.at);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: match.timezone, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(event.occurredAt).map(value => [value.type, value.value]));
    return `${parts.hour}:${parts.minute}` === match.time && (match.schedule !== "weekly" || match.weekdays.includes(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)));
  }
  if (match.type === "external") return match.event === event.event && (!match.source || match.source === event.source);
  return match.event === event.event && (!match.regionId || match.regionId === event.regionId) && (!match.regionName || match.regionName === event.regionName);
}
export function evaluateTriggerCondition(condition: TriggerCondition | undefined, now: number, facts: TriggerFacts): boolean | undefined {
  if (!condition) return true;
  if (condition.type === "all" || condition.type === "any") {
    const values = condition.conditions.map(value => evaluateTriggerCondition(value, now, facts));
    if (condition.type === "all") return values.includes(false) ? false : values.includes(undefined) ? undefined : true;
    return values.includes(true) ? true : values.includes(undefined) ? undefined : false;
  }
  if (condition.type === "not") { const value = evaluateTriggerCondition(condition.condition, now, facts); return value === undefined ? undefined : !value; }
  if (condition.type === "recent_event") {
    if (!facts.externalSources?.some(source => (!condition.source || source.source === condition.source) && source.events.includes(condition.event))) return undefined;
    const found = facts.recentEvents.some(value => value.type === "external" && value.event === condition.event
    && (!condition.source || value.source === condition.source) && deviceTimeIsUsable(value.occurredAt, now, condition.withinSeconds * 1000));
    if (found) return true;
    return facts.eventsCompleteAfter !== undefined && now - condition.withinSeconds * 1000 < facts.eventsCompleteAfter ? undefined : false;
  }
  if (condition.type === "task_delivered") {
    if (!facts.taskIds?.includes(condition.taskId)) return undefined;
    return facts.deliveries.some(value => value.taskId === condition.taskId
      && timestampIsFresh(value.deliveredAt, now, condition.withinSeconds * 1000));
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: condition.timezone ?? "Asia/Shanghai", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
  const time = `${parts.hour}:${parts.minute}`;
  const window = condition.after && condition.before && condition.after > condition.before
    ? time >= condition.after || time < condition.before : (!condition.after || time >= condition.after) && (!condition.before || time < condition.before);
  return window && (!condition.weekdays || condition.weekdays.includes(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday)));
}
/** The same pure transition function validates fixtures and processes persisted production events/timers. */
export function stepReusableTrigger(spec: ReusableTriggerSpec, previous: TriggerState, at: number, event: TriggerEvent | undefined, facts: TriggerFacts): { state: TriggerState; fired?: TriggerEvent } {
  const state: TriggerState = structuredClone(previous);
  if (event && (event.type === "time" ? timestampIsFresh : deviceTimeIsUsable)(event.occurredAt, at, spec.maxAgeSeconds * 1000)
    && (state.lastEventAt === undefined || event.occurredAt >= state.lastEventAt)) {
    if (eventMatches(spec.source, event) || spec.cancelOn.some(match => eventMatches(match, event))) state.lastEventAt = event.occurredAt;
    if (spec.cancelOn.some(match => eventMatches(match, event))) delete state.pending;
    if (eventMatches(spec.source, event) && (spec.source.type !== "time" || scheduledWindowOpen(spec.source, event.scheduledAt, at))
      && evaluateTriggerCondition(spec.condition, at, facts) === true
      && (spec.source.type !== "location" || matchesLocationSpeed(spec.source, event.velocityKph))
      && (state.lastFiredAt === undefined || at - state.lastFiredAt >= spec.cooldownSeconds * 1000)) {
      // A burst does not postpone an existing wait forever; explicit cancel and re-entry starts a new wait.
      state.pending ??= { event, dueAt: at + spec.delaySeconds * 1000 };
    }
  }
  if (state.pending && state.pending.dueAt <= at) {
    const pending = state.pending;
    delete state.pending;
    // Input freshness, timer lateness and emitted occurrence freshness are separate boundaries.
    if (timestampIsFresh(pending.dueAt, at, spec.maxAgeSeconds * 1000)
      && (spec.source.type !== "time" || scheduledWindowOpen(spec.source, pending.event.scheduledAt, at))
      && evaluateTriggerCondition(spec.condition, at, facts) === true
      && (state.lastFiredAt === undefined || at - state.lastFiredAt >= spec.cooldownSeconds * 1000)) {
      state.lastFiredAt = at;
      return { state, fired: pending.event };
    }
  }
  return { state };
}

type DbRow = Record<string, unknown>;
type TriggerRecord = SharedTrigger & { userId: string; principalId?: string };
export class ReusableTriggerStore {
  private readonly reads: ReusableTriggerReads;
  constructor(private readonly db: DatabaseSync, private readonly agentId: string, private readonly callbacks: {
    tasks(): ActiveTask[]; enqueue(task: ActiveTask, occurrence: string, payload: unknown, now: number): void;
    invalidate(triggerId: string, now: number): void;
  }) {
    this.reads = new ReusableTriggerReads(db, agentId, callbacks.tasks);
    db.exec(`CREATE TABLE IF NOT EXISTS shared_triggers(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,user_id TEXT NOT NULL,principal_id TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,active_revision INTEGER,previous_revision INTEGER,creation_key TEXT,state_json TEXT NOT NULL DEFAULT '{}',next_at INTEGER,updated_at INTEGER NOT NULL,UNIQUE(agent_id,user_id,principal_id,creation_key));
      CREATE TABLE IF NOT EXISTS shared_trigger_revisions(trigger_id TEXT NOT NULL REFERENCES shared_triggers(id),revision INTEGER NOT NULL,spec_json TEXT NOT NULL,fixtures_json TEXT NOT NULL,hash TEXT NOT NULL,validation_json TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(trigger_id,revision));
      CREATE TABLE IF NOT EXISTS shared_trigger_events(trigger_id TEXT NOT NULL,revision INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(trigger_id,revision,event_id));
      CREATE TABLE IF NOT EXISTS shared_trigger_occurrences(id TEXT PRIMARY KEY,trigger_id TEXT NOT NULL,revision INTEGER NOT NULL,event_id TEXT NOT NULL,fired_at INTEGER NOT NULL,UNIQUE(trigger_id,revision,event_id));
      CREATE TABLE IF NOT EXISTS shared_trigger_location_state(trigger_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,observed_at INTEGER NOT NULL,inside INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shared_trigger_due ON shared_triggers(status,next_at);`);
    if (!(db.prepare("PRAGMA table_info(shared_triggers)").all() as Array<{ name: string }>).some(column => column.name === "activated_at"))
      db.exec("ALTER TABLE shared_triggers ADD COLUMN activated_at INTEGER");
  }
  private owned(scope: TaskScope, id: string): DbRow | undefined {
    return prepareSql(this.db, "SELECT * FROM shared_triggers WHERE id=? AND agent_id=? AND user_id=? AND principal_id=?")
      .get(id, scope.agentId, scope.userId, scope.principalId ?? "") as DbRow | undefined;
  }
  private decode(row: DbRow): TriggerRecord {
    const revisions = (prepareSql(this.db, "SELECT * FROM shared_trigger_revisions WHERE trigger_id=? ORDER BY revision").all(String(row.id)) as DbRow[]).map(value => ({
      revision: Number(value.revision), spec: JSON.parse(String(value.spec_json)) as ReusableTriggerSpec,
      fixtures: JSON.parse(String(value.fixtures_json)) as TriggerFixture[], hash: String(value.hash), createdAt: Number(value.created_at),
      ...(value.validation_json ? { validation: JSON.parse(String(value.validation_json)) as TriggerValidation } : {}) }));
    const state = JSON.parse(String(row.state_json)) as TriggerState;
    return { id: String(row.id), title: String(row.title), status: row.status as SharedTrigger["status"], revision: Number(row.revision),
      userId: String(row.user_id), ...(row.principal_id ? { principalId: String(row.principal_id) } : {}),
      ...(row.active_revision == null ? {} : { activeRevision: Number(row.active_revision) }),
      ...(row.previous_revision == null ? {} : { previousRevision: Number(row.previous_revision) }),
      subscriberCount: this.callbacks.tasks().filter(task => task.userId === row.user_id && (task.principalId ?? "") === row.principal_id
        && task.status !== "cancelled" && task.trigger.type === "reference" && task.trigger.triggerId === row.id).length,
      revisions, ...(state.lastFiredAt === undefined ? {} : { lastFiredAt: state.lastFiredAt }), ...(row.next_at == null ? {} : { nextAt: Number(row.next_at) }) };
  }
  get(scope: TaskScope, id: string): SharedTrigger | undefined {
    const row = this.owned(scope, id); if (!row) return;
    const { userId: _user, principalId: _principal, ...safe } = this.decode(row); return safe;
  }
  list(scope: TaskScope): SharedTrigger[] {
    return (prepareSql(this.db, "SELECT id FROM shared_triggers WHERE agent_id=? AND user_id=? AND principal_id=? ORDER BY updated_at DESC")
      .all(scope.agentId, scope.userId, scope.principalId ?? "") as Array<{ id: string }>).map(row => this.get(scope, row.id)!);
  }
  /** Selected revision even while paused; execution/delivery still require isCurrent. */
  activeSource(scope: TaskScope, id: string): ReusableTriggerSpec["source"] | undefined {
    return this.reads.owned(scope, id)?.spec?.source;
  }
  activeLocationScopes(): Array<Pick<TaskScope, "agentId" | "userId" | "principalId">> {
    return this.reads.active().filter(record => record.spec?.source.type === "location")
      .map(record => ({ agentId: this.agentId, userId: record.userId, principalId: record.principalId }));
  }
  stage(scope: TaskScope, input: { id?: string; title: string; spec: ReusableTriggerSpec; fixtures: TriggerFixture[] }, key?: string, now = Date.now()): SharedTrigger {
    const spec = parseReusableTriggerSpec(input.spec);
    const fixtures = z.array(triggerFixtureSchema).min(2).max(32).parse(input.fixtures);
    if (JSON.stringify(fixtures).length > 160000) throw new Error("Trigger fixtures exceed size limit");
    const title = input.title?.trim(); if (!title || [...title].length > 4) throw new Error("Trigger title must contain 1..4 characters");
    if (key) {
      const prior = prepareSql(this.db, "SELECT id FROM shared_triggers WHERE agent_id=? AND user_id=? AND principal_id=? AND creation_key=?")
        .get(scope.agentId, scope.userId, scope.principalId ?? "", key) as { id: string } | undefined;
      if (prior && !input.id) return this.get(scope, prior.id)!;
    }
    const existing = input.id ? this.owned(scope, input.id) : undefined;
    if (input.id && !existing) throw new Error("Trigger not found");
    if (existing) {
      if (existing.active_revision !== null && existing.title !== title) throw new Error("A live trigger title cannot change through draft staging");
      const current = this.get(scope, input.id!)!;
      if (current.title === title && current.revisions.at(-1)?.hash === triggerRevisionHash(spec, fixtures)) return current;
    }
    const id = input.id ?? randomUUID(), revision = existing ? Number(existing.revision) + 1 : 1;
    if (existing) prepareSql(this.db, "UPDATE shared_triggers SET title=?,revision=?,updated_at=? WHERE id=?").run(title, revision, now, id);
    else prepareSql(this.db, "INSERT INTO shared_triggers(id,agent_id,user_id,principal_id,title,status,revision,creation_key,updated_at) VALUES(?,?,?,?,?,'draft',?,?,?)")
      .run(id, scope.agentId, scope.userId, scope.principalId ?? "", title, revision, key ?? null, now);
    prepareSql(this.db, "INSERT INTO shared_trigger_revisions VALUES(?,?,?,?,?,NULL,?)").run(id, revision, JSON.stringify(spec), JSON.stringify(fixtures), triggerRevisionHash(spec, fixtures), now);
    return this.get(scope, id)!;
  }
  validate(scope: TaskScope, id: string, revision: number, now = Date.now()): TriggerRevision {
    const definition = this.get(scope, id), version = definition?.revisions.find(value => value.revision === revision);
    if (!version) throw new Error("Trigger revision not found");
    const results = version.fixtures.map(fixture => {
      let state: TriggerState = {}, actualFirings = 0, lastAt = -1;
      const seen = new Set<string>();
      for (const step of fixture.steps) {
        if (step.at < lastAt) throw new Error("Fixture steps must be time ordered"); lastAt = step.at;
        const event = step.event && !seen.has(step.event.id) ? step.event : undefined;
        if (event) seen.add(event.id);
        const result = stepReusableTrigger(version.spec, state, step.at, event, { recentEvents: step.recentEvents ?? [], deliveries: step.deliveries ?? [],
          externalSources: step.externalSources, taskIds: step.taskIds });
        state = result.state; if (result.fired) actualFirings++;
      }
      return { name: fixture.name, expectedFirings: fixture.expectedFirings, actualFirings, passed: actualFirings === fixture.expectedFirings };
    });
    const passed = results.every(result => result.passed) && results.some(result => result.expectedFirings > 0) && results.some(result => result.expectedFirings === 0);
    const validation: TriggerValidation = { passed, validatorVersion: TRIGGER_VALIDATOR_VERSION, hash: version.hash, checkedAt: now, results };
    prepareSql(this.db, "UPDATE shared_trigger_revisions SET validation_json=? WHERE trigger_id=? AND revision=?")
      .run(JSON.stringify(validation), id, revision);
    return { ...version, validation };
  }
  activate(scope: TaskScope, id: string, revision: number, now = Date.now()): SharedTrigger {
    const definition = this.get(scope, id), version = definition?.revisions.find(value => value.revision === revision);
    if (!definition || !version) throw new Error("Trigger revision not found");
    if (!version.validation?.passed || version.validation.hash !== triggerRevisionHash(version.spec, version.fixtures)
      || version.validation.validatorVersion !== TRIGGER_VALIDATOR_VERSION) throw new Error("Validate this exact trigger revision before activation");
    if (definition.activeRevision === revision && definition.status === "active") return definition;
    if (version.spec.source.type === "time" && version.spec.source.schedule === "once" && Date.parse(version.spec.source.at) <= now) throw new Error("Once trigger must still be in the future when activated");
    this.callbacks.invalidate(id, now);
    prepareSql(this.db, "DELETE FROM shared_trigger_location_state WHERE trigger_id=?").run(id);
    const previous = definition.activeRevision === revision ? definition.previousRevision : definition.activeRevision;
    prepareSql(this.db, "UPDATE shared_triggers SET status='active',active_revision=?,previous_revision=?,state_json='{}',next_at=?,updated_at=?,activated_at=? WHERE id=?")
      .run(revision, previous ?? null, nextOccurrence(version.spec.source, now) ?? null, now, now, id);
    return this.get(scope, id)!;
  }
  rollback(scope: TaskScope, id: string, now = Date.now()): SharedTrigger {
    const definition = this.get(scope, id); if (!definition?.previousRevision) throw new Error("No previous active revision");
    return this.activate(scope, id, definition.previousRevision, now);
  }
  status(scope: TaskScope, id: string, status: "active" | "paused", now = Date.now()): SharedTrigger {
    const definition = this.get(scope, id); if (!definition) throw new Error("Trigger not found");
    if (definition.status === status) return definition;
    if (status === "active") {
      if (definition.activeRevision === undefined) throw new Error("Activate a validated revision first");
      return this.activate(scope, id, definition.activeRevision, now);
    }
    this.callbacks.invalidate(id, now);
    prepareSql(this.db, "UPDATE shared_triggers SET status='paused',state_json='{}',next_at=NULL,updated_at=? WHERE id=?").run(now, id);
    return this.get(scope, id)!;
  }
  activeSpec(record: SharedTrigger): ReusableTriggerSpec | undefined { return record.revisions.find(value => value.revision === record.activeRevision)?.spec; }
  private process(record: RuntimeTrigger, event: TriggerEvent | undefined, now: number, reads: TriggerEvaluationReads): number {
    const spec = record.spec; if (!spec || record.activeRevision === undefined) return 0;
    if (event && record.activatedAt !== undefined && event.occurredAt < record.activatedAt) return 0;
    if (spec.source.type === "external") {
      const source = spec.source;
      if (!reads.facts(record).externalSources!.some(value => (!source.source || value.source === source.source) && value.events.includes(source.event))) {
        prepareSql(this.db, "UPDATE shared_triggers SET state_json='{}' WHERE id=?").run(record.id);
        return 0;
      }
    }
    if (event) {
      const inserted = prepareSql(this.db, "INSERT OR IGNORE INTO shared_trigger_events VALUES(?,?,?)").run(record.id, record.activeRevision, event.id);
      if (!inserted.changes) return 0;
    }
    const row = prepareSql(this.db, "SELECT state_json FROM shared_triggers WHERE id=?").get(record.id) as { state_json: string };
    const previous = JSON.parse(row.state_json) as TriggerState, facts = reads.facts(record);
    if (spec.source.type === "external" && previous.pending) {
      const origin = previous.pending.event;
      if (!facts.externalSources!.some(value => value.source === origin.source && value.events.includes(origin.event ?? ""))) delete previous.pending;
    }
    const result = stepReusableTrigger(spec, previous, now, event, facts);
    prepareSql(this.db, "UPDATE shared_triggers SET state_json=? WHERE id=?").run(JSON.stringify(result.state), record.id);
    if (!result.fired) return 0;
    const occurrence = `${record.id}:r${record.activeRevision}:${result.fired.id}`;
    if (!prepareSql(this.db, "INSERT OR IGNORE INTO shared_trigger_occurrences VALUES(?,?,?,?,?)").run(occurrence, record.id, record.activeRevision, result.fired.id, now).changes) return 0;
    let count = 0;
    for (const task of reads.subscribers(record)) {
      this.callbacks.enqueue(task, `shared:${occurrence}`, { sharedTrigger: { id: record.id, revision: record.activeRevision, hash: record.hash!,
        occurrence, firedAt: now, evidence: result.fired, interpretation: spec.delaySeconds ? "A reported source event was followed by the configured waiting period without a received cancellation; this is not proof of current physical presence." : "A reported source event matched this rule." } }, now);
      count++;
    }
    return count;
  }
  accept(scope: Pick<TaskScope, "userId" | "principalId">, event: TriggerEvent, now: number): number {
    let count = 0;
    const reads = this.reads.evaluation();
    for (const record of this.reads.active()) if (record.userId === scope.userId && record.principalId === scope.principalId) {
      const source = record.spec?.source;
      // Coordinate fences only consume fixes calculated for that fence, never unrelated named-region events.
      if (event.type === "location" && source?.type === "location" && source.center) continue;
      count += this.process(record, event, now, reads);
    }
    return count;
  }
  observeLocation(scope: Pick<TaskScope, "userId" | "principalId">, point: StoredLocation & { id: number }, now: number): void {
    const reads = this.reads.evaluation();
    for (const record of this.reads.active()) {
      if (record.userId !== scope.userId || record.principalId !== scope.principalId) continue;
      const spec = record.spec!, source = spec.source;
      if (source.type !== "location" || !source.center) continue;
      if (record.activatedAt !== undefined && point.observedAt < record.activatedAt) continue;
      const accuracy = point.accuracyMeters;
      if (accuracy === undefined || accuracy < 0 || accuracy > source.radiusMeters! || !deviceTimeIsUsable(point.observedAt, now, spec.maxAgeSeconds * 1000)) continue;
      const prior = prepareSql(this.db, "SELECT * FROM shared_trigger_location_state WHERE trigger_id=?").get(record.id) as { revision: number; observed_at: number; inside: number } | undefined;
      if (prior && prior.revision === record.activeRevision && point.observedAt <= prior.observed_at) continue;
      const distance = distanceMeters(source.center, { latitude: point.gcj02Latitude, longitude: point.gcj02Longitude }), margin = Math.max(25, accuracy);
      const inside = distance + margin < source.radiusMeters! ? true : distance - margin > source.radiusMeters! ? false : undefined;
      if (inside === undefined) continue;
      prepareSql(this.db, "INSERT INTO shared_trigger_location_state VALUES(?,?,?,?) ON CONFLICT(trigger_id) DO UPDATE SET revision=excluded.revision,observed_at=excluded.observed_at,inside=excluded.inside")
        .run(record.id, record.activeRevision!, point.observedAt, Number(inside));
      if (prior && prior.revision === record.activeRevision && Boolean(prior.inside) !== inside)
        this.process(record, { id: `fix:${record.id}:${point.id}`, type: "location", event: inside ? "enter" : "leave", occurredAt: point.observedAt,
          ...(point.velocityKph === undefined ? {} : { velocityKph: point.velocityKph }) }, now, reads);
    }
  }
  nextWakeAt(): number | undefined {
    const row = prepareSql(this.db, `SELECT MIN(at) AS at FROM (
      SELECT next_at AS at FROM shared_triggers WHERE agent_id=? AND status='active'
      UNION ALL SELECT json_extract(state_json,'$.pending.dueAt') FROM shared_triggers WHERE agent_id=? AND status='active'
    )`).get(this.agentId, this.agentId) as { at: number | null };
    return row.at ?? undefined;
  }
  collect(now: number, next: NextOccurrence = createNextOccurrenceResolver(now)): void {
    const reads = this.reads.evaluation();
    for (const record of this.reads.active()) {
      const spec = record.spec!;
      if (record.nextAt !== undefined && record.nextAt <= now && spec.source.type === "time") {
        this.process(record, { id: `time:${record.nextAt}`, type: "time", occurredAt: record.nextAt, scheduledAt: record.nextAt }, now, reads);
        prepareSql(this.db, "UPDATE shared_triggers SET next_at=? WHERE id=?").run(next(spec.source) ?? null, record.id);
      }
      this.process(record, undefined, now, reads);
    }
  }
  isCurrent(task: ActiveTask, run: TaskRun, now = Date.now()): boolean {
    if (task.trigger.type !== "reference") return true;
    const definition = this.reads.owned({ ...task, conversationKind: "p2p" }, task.trigger.triggerId);
    const evidence = (run.payload as { sharedTrigger?: { revision?: number; hash?: string; firedAt?: number; evidence?: TriggerEvent } })?.sharedTrigger;
    const spec = definition?.spec;
    if (!definition || !spec || !evidence || definition.activeRevision === undefined || definition.status !== "active" || evidence.revision !== definition.activeRevision || evidence.hash !== definition.hash
      || !evidence.evidence || !timestampIsFresh(evidence.firedAt, now, spec.maxAgeSeconds * 1000)) return false;
    const source = spec.source;
    if (source.type === "time" && !scheduledWindowOpen(source, evidence.evidence.scheduledAt, now)) return false;
    const facts = this.reads.evaluation().facts(task);
    if (evaluateTriggerCondition(spec.condition, now, facts) !== true) return false;
    return source.type !== "external" || facts.externalSources!
      .some(value => value.source === evidence.evidence!.source && (!source.source || value.source === source.source)
        && evidence.evidence!.event === source.event && value.events.includes(source.event));
  }
}
