import { z } from "zod";
import { validateTrigger } from "../tasks/schedule.js";
import { parseReusableTriggerSpec, triggerFixtureSchema } from "../tasks/reusable.js";
import { triggerActions } from "./trigger-maintenance.js";

export const proactiveTaskCreationGuidance = "create/propose: top-level title, instruction, trigger; spec/fixtures belong only to trigger_stage. For location/external weekday or time-window gates: trigger_stage(title,spec,fixtures) → trigger_validate(id,revision) → create(title,instruction,trigger={type:reference,triggerId},activate_revision=validated revision). Activation and creation share one confirmation; reuse active rules without activate_revision. Put deterministic schedules, windows, cooldowns and expiry in trigger configuration, not instruction.";

const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("reference"), triggerId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("external"), event: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), source: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
    cooldownSeconds: z.number().optional(), maxAgeSeconds: z.number().optional(), preparation: z.literal("outing_weather").optional() }).strict(),
  z.object({ type: z.literal("time"), schedule: z.literal("once"), at: z.string(), timezone: z.string().optional(), maxLatenessSeconds: z.number().optional() }).strict(),
  z.object({ type: z.literal("health_change"), debounceSeconds: z.number().optional(), metrics: z.array(z.string()).optional(),
    afterTime: z.string().optional(), timezone: z.string().default("Asia/Shanghai"), oncePerDay: z.boolean().optional(),
    condition: z.enum(["hrv_anomaly_v1", "hrv_realtime_v2"]).optional() }).strict(),
  z.object({ type: z.literal("location"), event: z.enum(["enter", "leave"]), regionId: z.string().optional(), regionName: z.string().optional(),
    minSpeedKph: z.number().min(0).max(2000).optional(), maxSpeedKph: z.number().min(0).max(2000).optional(),
    center: z.object({ latitude: z.number(), longitude: z.number(), system: z.literal("GCJ-02") }).strict().optional(),
    radiusMeters: z.number().optional(), cooldownSeconds: z.number().optional(), maxAgeSeconds: z.number().optional(), repeat: z.boolean().default(false) }).strict()
]);
const recurringSchema = z.object({ type: z.literal("time"), schedule: z.enum(["daily", "weekly"]), time: z.string(),
  timezone: z.string().default("Asia/Shanghai"), weekdays: z.array(z.number()).optional(), maxLatenessSeconds: z.number().optional() }).strict();
export const proactiveTaskActions = ["propose", "create", "update", "delete", "pause", "resume", "list", "runs", "events", ...triggerActions] as const;
const inputSchema = z.object({ action: z.enum(proactiveTaskActions),
  delivery_policy: z.enum(["always", "conditional"]).optional(),
  skill: z.literal("health").optional(), id: z.string().min(1).optional(), title: z.string().min(1).max(200).optional(), instruction: z.string().min(1).max(12000).optional(),
  trigger: z.union([triggerSchema, recurringSchema]).optional(),
  spec: z.unknown().optional(), fixtures: z.array(triggerFixtureSchema).min(2).max(32).optional(),
  revision: z.number().int().positive().optional(), activate_revision: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).default(30) }).strict();

/** Pure validation shared by confirmation previews and execution; never creates or activates anything. */
export function parseProactiveTaskInput(value: unknown) {
  const input = inputSchema.parse(value);
  if ((input.spec !== undefined || input.fixtures !== undefined) && input.action !== "trigger_stage")
    throw new Error(proactiveTaskCreationGuidance);
  if (["create", "propose"].includes(input.action) && (!input.title?.trim() || !input.instruction?.trim() || !input.trigger))
    throw new Error(`title, instruction and trigger are required. ${proactiveTaskCreationGuidance}`);
  if (input.activate_revision !== undefined && (input.action !== "create" || input.trigger?.type !== "reference"))
    throw new Error("activate_revision requires create with a reference trigger");
  if (["update", "delete", "pause", "resume", "trigger_validate", "trigger_activate", "trigger_rollback", "trigger_pause", "trigger_resume"].includes(input.action) && !input.id)
    throw new Error("Task or trigger id is required");
  if (["trigger_validate", "trigger_activate"].includes(input.action) && !input.revision)
    throw new Error("Exact trigger revision is required");
  if (input.action === "trigger_stage") {
    if (!input.title?.trim() || !input.spec || !input.fixtures) throw new Error("title, spec and fixtures are required");
    parseReusableTriggerSpec(input.spec);
  }
  if (input.trigger) {
    validateTrigger(input.trigger);
    if (input.trigger.type === "location" && !input.trigger.center && !input.trigger.regionId && !input.trigger.regionName)
      throw new Error("Select a region or a coordinate geofence");
  }
  return input;
}
