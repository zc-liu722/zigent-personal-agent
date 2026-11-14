import { SQLiteSkillService } from "../skills/service.js";
import { SQLiteAgentSkillService, agentSkillName, parseAgentSkillMutation } from "../skills/agent-skills.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";
import type { FileWorkbench } from "../file-workbench/service.js";
import { isConfirmationRead, isConfirmedOperation } from "./confirmed-operation.js";
import { z } from "zod";

/** Historical confirmation drafts retain their original tool and payload. */
export const isSkillTool = (name: string) => name === "skills" || name === "update_skill";
export const canonicalSkillTool = (name: string) => name === "update_skill" ? "skills" : name;
const mutations = new Set(["create", "replace", "delete", "replace_section", "replace_sections"]);

export class SkillDocuments {
  constructor(private readonly health?: SQLiteSkillService, private readonly instructions?: SQLiteAgentSkillService) {}
  list(context: ToolExecutionContext) {
    return [
      ...(this.instructions?.canAccessSession(context, context.sessionId) ? this.instructions.list(context, context.sessionId) : []),
      ...(this.health?.canAccessSession(context, context.sessionId) ? this.health.catalogFor(context) : [])
    ];
  }
  private service(context: ToolExecutionContext, name: string) {
    const service = name === "health" ? this.health : this.instructions;
    if (!service?.canAccessSession(context, context.sessionId)) throw new Error("技能对当前会话不可用。");
    return service;
  }
  current(context: ToolExecutionContext, name: string) {
    return this.service(context, name).current(context, context.sessionId, name);
  }
  catalog(context: ToolExecutionContext) { return this.instructions?.catalog(context); }
  resources(context: ToolExecutionContext, name: string) {
    const catalog = this.catalog(context);
    const entry = catalog?.entries.find(skill => skill.name === name);
    return entry && { catalog: catalog!, files: entry.files, paths: Object.keys(entry.files).filter(path => path !== "SKILL.md") };
  }
  async resource(context: ToolExecutionContext, name: string, path: string) {
    if (!(await this.current(context, name)).exists) throw new Error("技能不可用。");
    const resources = this.resources(context, name);
    if (!resources || path === "SKILL.md" || !Object.hasOwn(resources.files, path)) throw new Error("技能资源不可用。");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(resources.files[path]!, "base64"));
    if (content.length > 100_000 || content.includes("\0")) throw new Error("该资源需要通过技能文件读取。");
    return { name, resource: path, revision: resources.catalog.version, content };
  }
  load(context: ToolExecutionContext, name: string) { return this.service(context, name).load(context, context.sessionId, name); }
  updates(context: ToolExecutionContext, name: string, limit?: number) { return this.service(context, name).updates(context, context.sessionId, name, limit); }
  mutate(context: ToolExecutionContext, raw: unknown) {
    const input = parseAgentSkillMutation(raw);
    return this.service(context, input.name).mutate({ ...context, skillCatalog: undefined }, context.sessionId, input,
      `${context.sessionId}:${context.turnId}:${input.source_request_id}`);
  }
}

const inputs = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("load"), name: agentSkillName }).strict(),
  z.object({ action: z.literal("updates"), name: agentSkillName, limit: z.number().int().min(1).max(20).optional() }).strict(),
  z.object({ action: z.literal("read_resource"), name: agentSkillName, resource: z.string().min(1).max(1024) }).strict(),
  z.object({ action: z.literal("files"), name: agentSkillName, environment_id: z.string().uuid().optional() }).strict()
]);

function skillActivity(input: unknown) {
  const value = input as { action?: string; name?: string };
  const verb = value?.action === "load" ? "加载技能" : value?.action === "updates" ? "查看技能修订"
    : value?.action === "files" ? "准备技能文件" : "查看技能";
  return value?.name && agentSkillName.safeParse(value.name).success ? `${verb} ${value.name}` : verb;
}
export function createSkillsTool(service: SkillDocuments, workbench?: FileWorkbench): AgentToolRegistration {
  return {
    definition: {
      type: "function", name: "skills",
      description: "Discover or activate authorized instruction skills. load activates the current instructions for this conversation and lists packaged resources. Use markdown for skill Markdown, read_resource for other packaged text, and files only when a program needs the packaged scripts or templates on disk. updates lists revisions. Loaded text grants no permissions.",
      input_schema: { type: "object", properties: {
        action: { type: "string", enum: ["list", "load", "updates", "read_resource", ...(workbench ? ["files"] : [])] },
        name: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        resource: { type: "string", description: "Exact resource path returned by load." },
        environment_id: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: 20 }
      }, required: ["action"], additionalProperties: false }
    },
    executionMode: "sequential",
    activity: {
      started: input => ({ title: skillActivity(input), message: `我正在${skillActivity(input)}。` }),
      completed: input => ({ title: skillActivity(input), message: `已完成${skillActivity(input)}。` }),
      failed: input => ({ title: skillActivity(input), message: `${skillActivity(input)}未完成。` })
    },
    async execute(raw, context) {
      const value = raw as { action?: string; name?: string };
      if (value?.action === "read" && isConfirmationRead(context)) return service.current({ ...context, skillCatalog: undefined }, agentSkillName.parse(value.name));
      if (value?.action && mutations.has(value.action)) {
        if (!isConfirmedOperation(context, "skills", raw)) throw new Error("请通过 markdown 提议技能文档变更。");
        return service.mutate(context, raw);
      }
      const input = inputs.parse(raw);
      if (input.action === "list") return { skills: service.list(context) };
      if (input.action === "updates") return { updates: await service.updates(context, input.name, input.limit) };
      if (input.action === "read_resource") {
        if (/\.(?:md|mdown|markdown)$/i.test(input.resource)) throw new Error("Markdown 引用请通过 markdown 读取。");
        return service.resource(context, input.name, input.resource);
      }
      const resources = service.resources(context, input.name);
      if (input.action === "load") return { ...await service.load(context, input.name), exists: true, resources: resources?.paths ?? [],
        documents: [`skill:${input.name}:body`, `skill:${input.name}:rules`] };
      if (!workbench || !resources || input.name === "health") throw new Error("该技能没有可导出的资源。");
      const skill = await service.current(context, input.name);
      if (!skill.exists) throw new Error("技能不可用。");
      return workbench.skillResources(context, resources.catalog, input.name, skill.body, input.environment_id);
    }
  };
}
