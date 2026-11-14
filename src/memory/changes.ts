import { createHash } from "node:crypto";
import { z } from "zod";
import { editMarkdown, MarkdownConflictError, type MarkdownEdit } from "../text/markdown-edits.js";

export type ArchiveMemory = { title: string; content: string };
/** Markdown bodies are authoritative; scopes remain separate on disk and in prompts. */
export type EditableMemory = { behaviorRules: string; longTermMemory: string; archiveMemory?: ArchiveMemory[] };
const text = z.string().max(60_000).refine(value => !value.includes("\0"));
export const memoryChangesSchema = z.array(z.object({
  target: z.enum(["longTermMemory", "archiveMemory", "behaviorRules"]),
  operation: z.enum(["replace", "append", "create", "delete"]),
  title: z.string().min(1).max(100).regex(/^[^\r\n\x00-\x1f]+$/).optional(),
  oldText: text.optional(), newText: text.optional(), content: text.optional()
}).strict()).min(1).max(20);
export type MemoryChange = z.infer<typeof memoryChangesSchema>[number];
export type MemoryChangeRequest = { format: "markdown-v1"; expectedRevision: string; changes: MemoryChange[] };
export type MemoryChangePreview = { target: MemoryChange["target"]; operation: "add" | "update" | "delete"; title?: string; before?: string; after?: string };
export type MemorySnapshot = EditableMemory & { revision: string };
export class MemoryConflictError extends Error {
  constructor(message = "Memory changed; read again and propose a new confirmation") { super(message); }
}
export function memoryRevision(memory: EditableMemory): string {
  return createHash("sha256").update(JSON.stringify(["markdown-v1", memory.behaviorRules, memory.longTermMemory,
    [...memory.archiveMemory ?? []].sort((a, b) => a.title.localeCompare(b.title))])).digest("hex");
}
export function memorySnapshot(memory: EditableMemory): MemorySnapshot {
  return { ...memory, archiveMemory: memory.archiveMemory ?? [], revision: memoryRevision(memory) };
}
export function validateMarkdown(content: string, allowEmpty = true) {
  if (content.includes("\0") || content.length > 60_000 || !allowEmpty && !content.trim())
    throw new Error("Markdown 正文不能为空或过长，最多 60,000 字。");
}
/** Resolve all exact matches against the same original document, never against an earlier edit. */
export function previewMemoryChanges(snapshot: MemorySnapshot, request: MemoryChangeRequest): { next: EditableMemory; preview: MemoryChangePreview[] } {
  if (request.format !== "markdown-v1") throw new MemoryConflictError("Unsupported memory proposal format. Read Markdown again and propose exact oldText/newText edits.");
  if (request.expectedRevision !== snapshot.revision) throw new MemoryConflictError();
  const changes = memoryChangesSchema.parse(request.changes);
  const groups = new Map<string, MemoryChange[]>();
  for (const change of changes) {
    if (change.target === "archiveMemory" ? !change.title : change.title !== undefined) throw new Error("Only archive files require an exact title");
    const key = change.target === "archiveMemory" ? `archive:${change.title}` : change.target === "behaviorRules" ? "behaviorRules" : "longTermMemory";
    groups.set(key, [...groups.get(key) ?? [], change]);
  }
  const next: EditableMemory = { behaviorRules: snapshot.behaviorRules, longTermMemory: snapshot.longTermMemory, archiveMemory: structuredClone(snapshot.archiveMemory ?? []) };
  const preview: MemoryChangePreview[] = [];
  for (const edits of groups.values()) {
    const first = edits[0]!, archive = first.target === "archiveMemory";
    const existing = archive ? snapshot.archiveMemory?.find(item => item.title === first.title)?.content
      : first.target === "behaviorRules" ? snapshot.behaviorRules : snapshot.longTermMemory;
    const patches: MarkdownEdit[] = edits.map(edit => {
      if (edit.operation === "replace") {
        if (!edit.oldText || edit.newText === undefined || edit.content !== undefined)
          throw new Error("Replace requires nonempty oldText and newText");
        return { operation: "replace", oldText: edit.oldText, newText: edit.newText };
      }
      if (edit.operation === "delete") {
        if (edit.oldText === undefined || edit.newText !== undefined || edit.content !== undefined)
          throw new MemoryConflictError("Deleting an archive requires its complete exact oldText");
        return { operation: "delete", oldText: edit.oldText };
      }
      if (edit.content === undefined || edit.oldText !== undefined || edit.newText !== undefined)
        throw new Error("Create or append requires content only");
      return { operation: edit.operation, content: edit.content };
    });
    let after: string | undefined;
    try { after = editMarkdown(existing, patches, archive); }
    catch (error) {
      if (error instanceof MarkdownConflictError) throw new MemoryConflictError(error.message);
      throw error;
    }
    if (after !== undefined) validateMarkdown(after, !archive);
    if (archive) {
      next.archiveMemory = next.archiveMemory!.filter(item => item.title !== first.title);
      if (after !== undefined) next.archiveMemory.push({ title: first.title!, content: after });
    } else if (first.target === "behaviorRules") next.behaviorRules = after!;
    else next.longTermMemory = after!;
    preview.push({ target: first.target, title: first.title, operation: after === undefined ? "delete" : existing === undefined ? "add" : "update",
      before: existing, after });
  }
  if (next.behaviorRules.length + next.longTermMemory.length > 60_000 || next.archiveMemory!.length > 200
    || next.archiveMemory!.reduce((sum, item) => sum + item.content.length, 0) > 2_000_000) throw new Error("Memory capacity exceeded");
  return { next, preview };
}
