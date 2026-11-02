/** Model-facing contracts mirror the restricted runtime schemas; no executable fields. */
type JsonSchema = Record<string, unknown>;
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const name = { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" };
const seconds = { type: "integer", minimum: 1, maximum: 86400 };
const weekdays = { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } };
const clockTime = { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" };
const event = object({ id: { type: "string" }, type: { type: "string", enum: ["external", "location", "time"] },
  occurredAt: { type: "number" }, source: name, event: { type: "string" }, regionId: { type: "string" },
  regionName: { type: "string" }, velocityKph: { type: "number", minimum: 0, maximum: 2000 }, scheduledAt: { type: "number" } }, ["id", "type", "occurredAt"]);

export const triggerFixtureJsonSchema = object({ name: { type: "string" }, expectedFirings: { type: "integer", minimum: 0 },
  steps: { type: "array", minItems: 1, items: object({ at: { type: "number" }, event,
    recentEvents: { type: "array", maxItems: 100, items: event },
    externalSources: { type: "array", maxItems: 32, items: object({ source: name, events: { type: "array", maxItems: 32, items: name } }, ["source", "events"]) },
    taskIds: { type: "array", maxItems: 100, items: { type: "string" } },
    deliveries: { type: "array", maxItems: 100, items: object({ taskId: { type: "string" }, deliveredAt: { type: "number" } }, ["taskId", "deliveredAt"]) }
  }, ["at"]) } }, ["name", "steps", "expectedFirings"]);

function condition(depth: number): JsonSchema {
  // Flatten the shared fields instead of serializing five overlapping unions
  // at every level. All fields, nesting depth and types remain model-visible;
  // parseReusableTriggerSpec enforces the exact discriminated union at runtime.
  const properties: Record<string, unknown> = {
    type: { type: "string", enum: depth > 0
      ? ["time_window", "recent_event", "task_delivered", "all", "any", "not"]
      : ["time_window", "recent_event", "task_delivered"] },
    // These constraints are shared by every recursive node and validated by
    // parseReusableTriggerSpec; avoid repeating their long regex/bounds 15 times.
    after: { type: "string" }, before: { type: "string" },
    weekdays: { type: "array", items: { type: "integer" } }, timezone: { type: "string" },
    event: { type: "string" }, source: { type: "string" }, taskId: { type: "string" }, withinSeconds: { type: "integer" }
  };
  if (depth > 0) {
    properties.conditions = { type: "array", minItems: 1, maxItems: 16, items: condition(depth - 1) };
    properties.condition = condition(depth - 1);
  }
  return object(properties, ["type"]);
}

export const reusableTriggerSpecJsonSchema = object({
  source: { type: "object", description: "An existing time, external or location trigger. Health and reference sources are unavailable; no execution instruction or preparation. Use actual authorized location coordinates.",
    properties: { type: { type: "string", enum: ["time", "external", "location"] }, schedule: { type: "string", enum: ["once", "daily", "weekly"] },
      at: { type: "string" }, time: clockTime, timezone: { type: "string" }, weekdays, maxLatenessSeconds: seconds,
      event: { type: "string" }, source: name, regionId: { type: "string" }, regionName: { type: "string" },
      center: object({ system: { type: "string", enum: ["GCJ-02"] }, latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } }, ["system", "latitude", "longitude"]),
      radiusMeters: { type: "number", minimum: 100, maximum: 50000 },
      minSpeedKph: { type: "number", minimum: 0, maximum: 2000, description: "Location only: inclusive lower bound on the crossing observation's reported speed in km/h." },
      maxSpeedKph: { type: "number", minimum: 0, maximum: 2000, description: "Location only: inclusive upper bound in km/h, >= minSpeedKph. Either bound may be omitted; missing speed does not match configured bounds." } }, required: ["type"], additionalProperties: false },
  condition: { ...condition(3), description: "time_window: after/before HH:mm, weekdays 0–6, timezone; recent_event: event/withinSeconds, optional source; task_delivered: taskId/withinSeconds; all/any: conditions; not: condition. Use only fields for the selected type. Event/source names are lowercase identifiers; withinSeconds is 1–86400." },
  delaySeconds: { type: "integer", minimum: 0, maximum: 86400 },
  cancelOn: { type: "array", maxItems: 8, items: object({ type: { type: "string", enum: ["external", "location"] },
    event: { type: "string" }, source: name, regionId: { type: "string" }, regionName: { type: "string" } }, ["type", "event"]) },
  cooldownSeconds: { type: "integer", minimum: 0, maximum: 86400 }, maxAgeSeconds: seconds
}, ["source"]);

export const triggerActions = ["trigger_list", "trigger_stage", "trigger_validate", "trigger_activate", "trigger_rollback", "trigger_pause", "trigger_resume"] as const;
const messages: Record<string, readonly [string, string, string]> = {
  trigger_list: ["我正在查看可复用的触发规则。", "我已读取可复用的触发规则。", "这次没能读取触发规则。"],
  trigger_stage: ["我正在准备触发规则草稿。", "触发规则草稿已保存，还未启用。", "这次没能保存触发规则草稿。"],
  trigger_validate: ["我正在验证触发规则的正反例。", "触发规则的正反例已验证通过，还未启用新修订。", "这次没能完成触发规则验证。"],
  trigger_activate: ["我正在启用已验证的触发规则。", "已验证的触发规则已经启用。", "这次没能启用触发规则。"],
  trigger_rollback: ["我正在恢复之前的触发规则。", "触发规则已经恢复到之前的修订。", "这次没能恢复之前的触发规则。"],
  trigger_pause: ["我正在暂停触发规则。", "触发规则已暂停。", "这次没能暂停触发规则。"],
  trigger_resume: ["我正在恢复触发规则。", "触发规则已恢复。", "这次没能恢复触发规则。"]
};
export function triggerActivity(action: string, phase: "started" | "completed" | "failed", result?: unknown): { message: string } | undefined {
  const entries = Object.hasOwn(messages, action) ? messages[action] : undefined;
  if (!entries) return undefined;
  if (action === "trigger_validate" && phase === "completed") {
    const revision = result && typeof result === "object" ? (result as { revision?: { validation?: { passed?: boolean } } }).revision : undefined;
    if (revision?.validation?.passed !== true) return { message: "触发规则验证未通过，需要调整后再验证。" };
  }
  return { message: entries[phase === "started" ? 0 : phase === "completed" ? 1 : 2]! };
}
