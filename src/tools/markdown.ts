import { z } from "zod";
import { memoryChangesSchema, previewMemoryChanges, type MemoryChange, type MemorySnapshot } from "../memory/changes.js";
import type { FileLongTermMemoryRepository } from "../memory/long-term.js";
import { memoryPassages, rankMemoryPassages } from "../memory/recall.js";
import { editMarkdown, type MarkdownEdit } from "../text/markdown-edits.js";
import { skillDescriptionRequired, skillFrontmatterDescription } from "../skills/frontmatter.js";
import { parseAgentSkillMutation } from "../skills/mutations.js";
import { operationDigest } from "./confirmed-operation.js";
import { operationReads, operationSnapshots, type OperationDraft } from "./operation-policy.js";
import { activitySubject, type ToolActivityPresentation } from "./activity-presentation.js";
import type { SkillDocuments } from "./skills.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";

export type MemoryDocumentAccess = { agentId: string; repository: FileLongTermMemoryRepository; ownerUserId: string; ownerPrincipalId: string };
type SkillRef = { kind: "skill"; name: string; field: "body" | "rules" } | { kind: "resource"; name: string; path: string };
type MemoryRef = { kind: "memory"; target: MemoryChange["target"]; title?: string };
const documentId = z.string().min(1).max(1200);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(100_000).refine(value => !value.includes("\0"));
const documentVersion = { document_id: documentId, revision };
const patch = z.discriminatedUnion("operation", [
  z.object({ ...documentVersion, operation: z.literal("replace"), oldText: text.refine(value => value.length > 0), newText: text }).strict(),
  z.object({ ...documentVersion, operation: z.literal("append"), content: text }).strict(),
  z.object({ ...documentVersion, operation: z.literal("create"), content: text }).strict(),
  z.object({ ...documentVersion, operation: z.literal("delete"), oldText: text }).strict()
]);
const scope = z.enum(["memory", "skills", "all"]).default("all");
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), scope }).strict(),
  z.object({ action: z.literal("read"), document_id: documentId }).strict(),
  z.object({ action: z.literal("search"), scope, document_id: documentId.optional(), query: z.string().trim().min(1).max(400),
    offset: z.number().int().min(0).max(100_000).default(0), limit: z.number().int().min(1).max(20).default(8),
    revision: revision.optional() }).strict(),
  z.object({ action: z.literal("edit"), changes: z.array(patch).min(1).max(20) }).strict(),
  z.object({ action: z.literal("open") }).strict()
]);
type Patch = z.infer<typeof patch>;
type DocumentInfo = { document_id: string; title: string; scope: "private_memory" | "shared_rules" | "skill" | "skill_resource"; editable: boolean };
type Document = DocumentInfo & { content?: string; exists: boolean; revision: string };

const archiveId = (title: string) => `memory:archive:${title}`;
const profileId = "memory:profile", rulesId = "memory:rules";
const memoryId = (target: MemoryChange["target"], title?: string) => target === "archiveMemory" ? archiveId(title!) : target === "behaviorRules" ? rulesId : profileId;

function parseId(id: string): MemoryRef | SkillRef {
  if (id === profileId) return { kind: "memory", target: "longTermMemory" };
  if (id === rulesId) return { kind: "memory", target: "behaviorRules" };
  const archive = /^memory:archive:([^\x00-\x1f]{1,100})$/.exec(id);
  if (archive) return { kind: "memory", target: "archiveMemory", title: archive[1]! };
  const skill = /^skill:([a-z][a-z0-9_-]{0,63}):(body|rules)$/.exec(id);
  if (skill) return { kind: "skill", name: skill[1]!, field: skill[2] === "rules" ? "rules" : "body" };
  const resource = /^skill:([a-z][a-z0-9_-]{0,63}):resource:([^\x00-\x1f]{1,1024}\.(?:md|mdown|markdown))$/i.exec(id);
  if (resource) return { kind: "resource", name: resource[1]!, path: resource[2]! };
  throw new Error("未知 Markdown 文档标识。");
}

function memoryInfo(ref: MemoryRef): DocumentInfo {
  return { document_id: memoryId(ref.target, ref.title), title: ref.title ?? (ref.target === "behaviorRules" ? "共享行为规则" : "长期记忆"),
    scope: ref.target === "behaviorRules" ? "shared_rules" : "private_memory", editable: true };
}
function skillInfo(ref: SkillRef): DocumentInfo {
  return ref.kind === "resource" ? { document_id: `skill:${ref.name}:resource:${ref.path}`, title: ref.path, scope: "skill_resource", editable: false }
    : { document_id: `skill:${ref.name}:${ref.field}`, title: `${ref.name} · ${ref.field === "body" ? "正文" : "规则"}`, scope: "skill", editable: true };
}

function documentSubject(id: unknown): string {
  if (typeof id !== "string") return "";
  try {
    const ref = parseId(id);
    if (ref.kind === "memory") {
      const title = activitySubject(memoryInfo(ref).title);
      return ref.target === "archiveMemory" ? `记忆档案《${title}》` : title;
    }
    const title = activitySubject(ref.kind === "resource" ? ref.path.split(/[\\/]/).at(-1) : skillInfo(ref).title);
    return `技能《${title}》`;
  } catch {
    return "";
  }
}

function markdownActivity(raw: unknown): Required<Pick<ToolActivityPresentation, "title">> & Pick<ToolActivityPresentation, "actionKind"> {
  const input = raw as { action?: unknown; scope?: unknown; document_id?: unknown; query?: unknown;
    changes?: Array<{ document_id?: unknown; operation?: unknown } | null> } | null;
  const scope = input?.scope === "memory" ? "记忆文档" : input?.scope === "skills" ? "技能文档" : "文档";
  switch (input?.action) {
    case "list": return { title: `查看${scope}目录`, actionKind: "read" };
    case "open": return { title: "打开记忆文档", actionKind: "read" };
    case "read": return { title: `阅读${documentSubject(input.document_id) || "文档"}`, actionKind: "read" };
    case "search": {
      const query = activitySubject(input.query);
      const subject = documentSubject(input.document_id);
      return { title: `搜索${subject || scope}${query ? ` · ${query}` : ""}`, actionKind: "search" };
    }
    case "edit": {
      const changes = Array.isArray(input.changes) ? input.changes.slice(0, 20) : [];
      const subjects = [...new Set(changes.map(change => documentSubject(change?.document_id)).filter(Boolean))];
      const action = changes.length && changes.every(change => change?.operation === "create") ? "新建"
        : changes.length && changes.every(change => change?.operation === "delete") ? "删除"
        : changes.length && changes.every(change => change?.operation === "append") ? "追加内容到" : "编辑";
      const subject = subjects.length > 1 ? `${subjects[0]}等 ${subjects.length} 份文档` : subjects[0] || "文档";
      return { title: `拟${action}${subject}`, actionKind: "edit" };
    }
    default: return { title: "查询文档信息" };
  }
}

function skillRevision(skill: Awaited<ReturnType<SkillDocuments["current"]>>) {
  return operationDigest([skill.name, skill.revision, skill.exists, skill.exists ? [skill.body, skill.rules, skill.description] : null]);
}

export function createMarkdownTool(memory: MemoryDocumentAccess | undefined, skills?: SkillDocuments,
  verifyBackgroundRead?: (context: ToolExecutionContext) => boolean): AgentToolRegistration {
  const canReadMemory = (context: ToolExecutionContext) => Boolean(memory && context.agentId === memory.agentId
    && context.userId === memory.ownerUserId && context.principalId === memory.ownerPrincipalId
    && context.conversationKind === "p2p" && context.conversationId
    && (!(context.taskRunId || context.backgroundTaskKind) || context.taskRunId && context.backgroundTaskKind === "proactive" && verifyBackgroundRead?.(context)));

  async function read(context: ToolExecutionContext, ref: ReturnType<typeof parseId>, memorySnapshot?: MemorySnapshot): Promise<Document> {
    if (ref.kind === "memory") {
      if (!canReadMemory(context)) throw new Error("记忆文档对当前会话不可用。");
      const snapshot = memorySnapshot ?? await memory!.repository.editableSnapshot(context.userId);
      const content = ref.target === "archiveMemory" ? snapshot.archiveMemory?.find(item => item.title === ref.title)?.content : snapshot[ref.target];
      return { ...memoryInfo(ref), exists: content !== undefined, content, revision: snapshot.revision };
    }
    if (!skills) throw new Error("技能文档不可用。");
    if (ref.kind === "resource") {
      const resource = await skills.resource(context, ref.name, ref.path);
      return { ...skillInfo(ref), exists: true, content: resource.content, revision: operationDigest(resource.revision) };
    }
    const skill = await skills.current(context, ref.name);
    return { ...skillInfo(ref), exists: skill.exists, content: skill.exists ? skill[ref.field] : undefined, revision: skillRevision(skill) };
  }

  async function catalog(context: ToolExecutionContext, scope: "all" | "skills" | "memory", memorySnapshot?: MemorySnapshot): Promise<DocumentInfo[]> {
    const documents: DocumentInfo[] = [];
    if (scope !== "skills" && canReadMemory(context)) {
      const snapshot = memorySnapshot ?? await memory!.repository.editableSnapshot(context.userId);
      documents.push(memoryInfo({ kind: "memory", target: "longTermMemory" }), memoryInfo({ kind: "memory", target: "behaviorRules" }),
        ...(snapshot.archiveMemory ?? []).map(item => memoryInfo({ kind: "memory", target: "archiveMemory", title: item.title })));
    }
    if (scope !== "memory" && skills) {
      for (const { name } of skills.list(context)) {
        documents.push(skillInfo({ kind: "skill", name, field: "body" }), skillInfo({ kind: "skill", name, field: "rules" }));
        for (const path of skills.resources(context, name)?.paths ?? []) {
          if (/\.(?:md|mdown|markdown)$/i.test(path)) documents.push(skillInfo({ kind: "resource", name, path }));
        }
      }
    }
    return documents;
  }

  async function offerSkill(context: ToolExecutionContext, ref: Extract<SkillRef, {kind: "skill"}>, changes: Patch[]) {
    if (!skills || !context.proposeOperation) throw new Error("当前会话无法确认技能文档变更。");
    if (changes.some(change => change.document_id !== changes[0]!.document_id))
      throw new Error("一份技能提议只修改一份文档。");
    const skill = await skills.current(context, ref.name);
    if (changes.some(change => change.revision !== skillRevision(skill))) throw new Error("技能文档版本已变化，请重新读取。");
    const original = skill.exists ? skill[ref.field] : undefined;
    const next = editMarkdown(original, changes, ref.field === "body");
    const first = changes[0]!;
    const describesSkill = ref.name !== "health" && (first.operation === "create" || ref.field === "body" && first.operation !== "delete");
    const description = describesSkill ? skillFrontmatterDescription(next ?? "") : undefined;
    if (describesSkill && !description) throw new Error(skillDescriptionRequired);
    if (description && description.length > 500) throw new Error("frontmatter description 需要控制在 500 字以内，并用一两句话说明技能做什么、何时使用，然后重试。");
    const base = { name: ref.name, expected_revision: skill.revision, source_request_id: `markdown:${operationDigest(changes)}` };
    const mutation = parseAgentSkillMutation(first.operation === "create"
      ? { ...base, action: "create", body: next, description }
      : first.operation === "delete" ? { ...base, action: "delete" }
      : { ...base, action: "replace", target: ref.field, content: next, ...(description ? { description } : {}) });
    const reads = operationReads("skills", mutation), title = skillInfo(ref).title;
    const draft: OperationDraft = {
      tool: "skills", input: mutation, reads, baseline: operationDigest(operationSnapshots(reads, [skill], mutation)),
      pluginVersions: context.pluginVersions, operationRecovery: "managed-skill-v1",
      title: first.operation === "create" ? "创建技能" : first.operation === "delete" ? "删除技能" : "修改技能文档",
      description: title,
      changes: changes.map(change => ({
        title, ...(change.operation === "replace" ? { before: change.oldText.slice(0, 3000), after: change.newText.slice(0, 3000),
          ...(Math.max(change.oldText.length, change.newText.length) > 3000 ? { note: "可打开完整文档核对。" } : {}) }
          : change.operation === "delete" ? { note: "删除技能正文和规则，并从会话卸载。" }
          : { after: change.content.slice(0, 3000), ...(change.content.length > 3000 ? { note: "可打开完整文档核对。" } : {}) })
      })),
      changeDocuments: [
        ...(original === undefined ? [] : [{ id: "skill-before", title: `${title}（原文）`, filename: `${ref.name}-before.md`, content: original }]),
        ...(next === undefined ? [] : [{ id: "skill-after", title: `${title}（提议）`, filename: `${ref.name}-after.md`, content: next }]),
        ...(first.operation === "delete" && skill.exists ? [{ id: "skill-rules", title: `${ref.name} · 规则`, filename: `${ref.name}-rules.md`, content: skill.rules }] : [])
      ]
    };
    context.signal?.throwIfAborted();
    return { status: "pending_confirmation", ...await context.proposeOperation(draft) };
  }

  return {
    available: Boolean(memory || skills), executionMode: "sequential",
    definition: { type: "function", name: "markdown",
      description: "Discover, read, search and edit Zigent-managed Markdown by logical document_id. list and search support scope=memory|skills|all. read returns content and revision, including the current version for an absent document. edit takes changes with document_id, revision and operation. replace needs unique exact oldText and newText, append and create need content, delete needs the complete oldText. Batch matches refer to the original document. A proposal may edit several memory documents together or one skill document. Archives and skill bodies support create/delete. Creating or replacing a skill body requires frontmatter description: one or two sentences on what the skill does and when to use it. Deleting a skill body removes the skill and its rules. Packaged references are read-only. Changes require confirmation. open displays memory documents for direct user editing.",
      input_schema: { type: "object", additionalProperties: false, required: ["action"], properties: {
        action: { type: "string", enum: ["list", "read", "search", "edit", "open"] }, scope: { type: "string", enum: ["memory", "skills", "all"] },
        document_id: { type: "string", description: "e.g. memory:profile, memory:rules, memory:archive:<title>, skill:<name>:body" },
        query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 }, offset: { type: "integer", minimum: 0 },
        revision: { type: "string", description: "Search revision required for continuation pages." },
        changes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", additionalProperties: false,
          required: ["document_id", "revision", "operation"], properties: {
            document_id: { type: "string" }, revision: { type: "string" }, operation: { type: "string", enum: ["replace", "append", "create", "delete"] },
            oldText: { type: "string" }, newText: { type: "string" }, content: { type: "string" }
          } } }
      } }
    },
    activity: {
      started: input => {
        const heading = markdownActivity(input);
        return { ...heading, message: heading.actionKind === "edit" ? "我正在准备这项文档变更。" : `我正在${heading.title}。` };
      },
      completed: input => ({ ...markdownActivity(input), message: (input as { action?: string })?.action === "edit"
        ? "文档变更已展示，等待确认。" : "文档信息已就绪。" }),
      failed: input => ({ ...markdownActivity(input), message: "这次文档操作未完成。" })
    },
    async execute(raw, context) {
      context.signal?.throwIfAborted();
      const input = schema.parse(raw);
      if (input.action === "read") return read(context, parseId(input.document_id));
      if (input.action === "list") return { documents: await catalog(context, input.scope) };
      if (input.action === "search") {
        if (input.offset > 0 && !input.revision) throw new Error("继续搜索需要上一页的 revision。");
        const snapshot = !input.document_id && input.scope !== "skills" && canReadMemory(context)
          ? await memory!.repository.editableSnapshot(context.userId) : undefined;
        const documents = input.document_id ? [await read(context, parseId(input.document_id))] : await Promise.all(
          (await catalog(context, input.scope, snapshot)).map(document => read(context, parseId(document.document_id), snapshot)));
        const current = operationDigest(documents.map(document => [document.document_id, document.revision]));
        if (input.revision && input.revision !== current) throw new Error("搜索文档已变化，请从第一页重新搜索。");
        const matches = rankMemoryPassages(documents.flatMap(document => memoryPassages(document.content ?? "")
          .map(passage => ({ ...passage, document_id: document.document_id, revision: document.revision, heading: `${document.title} ${passage.heading}` }))), input.query)
          .filter(item => item.score > 0);
        return { revision: current, items: matches.slice(input.offset, input.offset + input.limit).map(({ passage }) => ({
          document_id: passage.document_id, revision: passage.revision, excerpt: passage.content.slice(0, 800)
        })), ...(matches.length > input.offset + input.limit ? { next_offset: input.offset + input.limit } : {}) };
      }
      if (context.subagent || context.taskRunId || context.backgroundTaskKind) throw new Error("需要由本人私聊中的主 Agent 发起。");
      if (input.action === "open") {
        if (!canReadMemory(context) || !context.openMemory) throw new Error("当前会话无法打开记忆文档。");
        return { status: "documents_presented", ...await context.openMemory() };
      }
      const refs = input.changes.map(change => parseId(change.document_id)), first = refs[0]!;
      if (first.kind === "skill") return offerSkill(context, first, input.changes);
      if (refs.some(ref => ref.kind !== "memory")) throw new Error("请分别提交记忆和技能文档变更。");
      if (!canReadMemory(context) || !context.proposeMemory) throw new Error("当前会话无法确认记忆文档变更。");
      const expectedRevision = input.changes[0]!.revision;
      const changes = input.changes.map(({ document_id: _id, revision, ...edit }, index) => {
        if (revision !== expectedRevision) throw new Error("记忆批量修改需要同一原始版本。");
        const { target, title } = refs[index] as MemoryRef;
        return { target, ...(title === undefined ? {} : { title }), ...edit } satisfies MemoryChange & MarkdownEdit;
      });
      const request = { format: "markdown-v1" as const, expectedRevision, changes: memoryChangesSchema.parse(changes) };
      previewMemoryChanges(await memory!.repository.editableSnapshot(context.userId), request);
      context.signal?.throwIfAborted();
      return { status: "pending_confirmation", ...await context.proposeMemory(request) };
    }
  };
}
