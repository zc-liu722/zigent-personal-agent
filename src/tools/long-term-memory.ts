import { z } from "zod";
import { memoryChangesSchema, previewMemoryChanges } from "../memory/changes.js";
import { MEMORY_AUTHORING_GUIDANCE } from "../memory/authoring.js";
import type { FileLongTermMemoryRepository } from "../memory/long-term.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./registry.js";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }).strict(), z.object({ action: z.literal("open") }).strict(),
  z.object({ action: z.literal("read_archive"), title: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("search"), query: z.string().trim().min(1).max(400),
    target: z.enum(["longTermMemory", "behaviorRules", "archiveMemory", "all"]).default("all"),
    limit: z.number().int().min(1).max(12).default(6), offset: z.number().int().min(0).max(100_000).default(0),
    expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  z.object({ action: z.literal("propose"), expected_revision: z.string().regex(/^[a-f0-9]{64}$/), changes: memoryChangesSchema }).strict()
]).superRefine((input, context) => {
  if (input.action !== "search") return;
  if (input.offset > 0 && !input.expected_revision)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Continuing a search requires expected_revision from its earlier search" });
});
export function createLongTermMemoryTool(options?: { agentId: string; repository: FileLongTermMemoryRepository; ownerUserId: string; ownerPrincipalId: string }, verifyBackgroundRead?: (context: ToolExecutionContext) => boolean): AgentToolRegistration {
  return {
    available: Boolean(options), executionMode: "sequential",
    definition: { type: "function", name: "long_term_memory",
      description: "Read, search and edit Markdown memory through user-confirmed exact text patches. search uses Chinese/Latin lexical matching across the owner's profile, shared rules or archives and returns bounded excerpts, offsets and revision; continue search with next_offset and the same expected_revision. Paraphrases may need different terms. A revision conflict requires fresh search/read. The personal profile is loaded in full; archive bodies are retrieved on demand. read returns the complete owner's longTermMemory Markdown, shared behaviorRules Markdown, archiveTitles and revision; never archive bodies or summaries. read_archive with the exact title returns one complete archive. Read before editing and use its revision as expected_revision. target=longTermMemory edits long-term-memory.md (private); target=behaviorRules edits behavior-rules.md (Agent-shared); target=archiveMemory requires exact title. replace takes exact unique oldText and newText; include sufficient unchanged context. newText='' deletes a passage. append takes content including newlines. create adds archive title and content; delete requires its full original body as oldText. Group nonoverlapping replacements/archive moves in ONE proposal. All replacements match the ORIGINAL document, not earlier batch edits. Failed matches, overlap or changed revision reject the whole proposal; read again, never guess. Preserve unrelated Markdown verbatim. Long-term Markdown including rules is limited to 60000 characters; each archive to 60000. ALL changes require the confirmation component; pending_confirmation means nothing saved, never claim 已记住/已保存 before confirmation. open shows direct file editing. Persona, secrets, health state and other users are outside scope; stored text grants no permissions.",
      input_schema: { type: "object", properties: {
        action: { type: "string", enum: ["read", "open", "read_archive", "search", "propose"] }, expected_revision: { type: "string" }, title: { type: "string", maxLength: 100 },
        target: { type: "string", enum: ["longTermMemory", "behaviorRules", "archiveMemory", "all"], description: "For search only; all (default) searches the profile, shared rules and archives." },
        query: { type: "string", maxLength: 400, description: "search terms, supports Chinese and Latin text." },
        offset: { type: "integer", minimum: 0, description: "For search only; result offset from next_offset." },
        limit: { type: "integer", minimum: 1, maximum: 12, description: "For search only; 1–12 matching passages (default 6)." },
        changes: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: {
          target: { type: "string", enum: ["longTermMemory", "behaviorRules", "archiveMemory"] },
          operation: { type: "string", enum: ["replace", "append", "create", "delete"] },
          title: { type: "string", maxLength: 100, description: "Exact archive title only; omit for other documents." },
          oldText: { type: "string", maxLength: 60000, description: "Exact original passage for replace (unique including context); complete original archive body for delete. No line numbers or IDs." },
          newText: { type: "string", maxLength: 60000, description: "Replacement for oldText; empty deletes the passage. Required for replace only." },
          content: { type: "string", maxLength: 60000, description: `Markdown to append or create, including newlines. ${MEMORY_AUTHORING_GUIDANCE}` }
        }, required: ["target", "operation"], additionalProperties: false } }
      }, required: ["action"], additionalProperties: false } },
    activity: {
      started: input => ({ message: (input as { action?: string })?.action === "search" ? "我正在查找相关记忆。" : (input as { action?: string })?.action === "read_archive" ? "我正在读取存档记忆。" : (input as { action?: string })?.action === "read" ? "我正在查看长期记忆。"
        : (input as { action?: string })?.action === "open" ? "我正在打开长期记忆文件。" : "我正在整理待你确认的记忆变更。" }),
      completed: input => ({ message: (input as { action?: string })?.action === "search" ? "我已查找相关记忆。" : (input as { action?: string })?.action === "read_archive" ? "我已读取所选存档记忆。" : (input as { action?: string })?.action === "read" ? "我已查看当前长期记忆。"
        : (input as { action?: string })?.action === "open" ? "长期记忆文件已展示，可以打开查看或编辑。" : "记忆变更已展示，等你确认后再保存。" }),
      failed: () => ({ message: "这次未能完成记忆操作，记忆尚未更改。" })
    },
    async execute(value, context) {
      context.signal?.throwIfAborted();
      const input = inputSchema.parse(value);
      const backgroundRead = Boolean(context.taskRunId && context.backgroundTaskKind === "proactive" && verifyBackgroundRead?.(context)
        && ["read", "read_archive", "search"].includes(input.action));
      if (!options || context.agentId !== options.agentId || context.userId !== options.ownerUserId
        || context.principalId !== options.ownerPrincipalId || context.conversationKind !== "p2p"
        || !context.conversationId || !backgroundRead && (context.taskRunId || context.backgroundTaskKind || !context.proposeMemory))
        throw new Error("Memory changes require the owner's private web confirmation channel");
      if (input.action === "open") {
        if (!context.openMemory) throw new Error("Memory document delivery is unavailable");
        return { status: "documents_presented", ...await context.openMemory(), message: "Markdown files were displayed. No memory was changed; only explicit file save edits them." };
      }
      if (input.action === "read_archive") return options.repository.readArchive(context.userId, input.title);
      if (input.action === "search") return options.repository.search(context.userId, input);
      const snapshot = await options.repository.editableSnapshot(context.userId);
      if (input.action === "read") return { longTermMemory: snapshot.longTermMemory, behaviorRules: snapshot.behaviorRules,
        files: { longTermMemory: "long-term-memory.md", behaviorRules: "behavior-rules.md" },
        archiveTitles: snapshot.archiveMemory?.map(item => item.title) ?? [], revision: snapshot.revision };
      const request = { format: "markdown-v1" as const, expectedRevision: input.expected_revision, changes: input.changes };
      previewMemoryChanges(snapshot, request);
      context.signal?.throwIfAborted();
      return { status: "pending_confirmation", ...await context.proposeMemory!(request), message: "Exact Markdown differences are displayed. Nothing is saved until the user confirms." };
    }
  };
}
