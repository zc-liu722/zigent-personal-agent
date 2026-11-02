import { createHash } from "node:crypto";
import { z } from "zod";

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
    let after: string | undefined;
    if (edits.some(edit => edit.operation === "create" || edit.operation === "delete")) {
      if (edits.length !== 1 || !archive) throw new Error("File create/delete must be a single archive operation; use replace/append for long-term Markdown");
      if (first.operation === "create") {
        if (existing !== undefined || first.content === undefined || first.oldText !== undefined || first.newText !== undefined)
          throw new Error("Create requires a new archive title and content only");
        after = first.content;
      } else {
        if (existing === undefined || first.oldText !== existing || first.newText !== undefined || first.content !== undefined)
          throw new MemoryConflictError("Deleting an archive requires its complete exact oldText from read_archive");
      }
    } else {
      if (existing === undefined) throw new MemoryConflictError("Archive file is missing; read current files again");
      const ranges: { start: number; end: number; text: string }[] = [];
      let append = "";
      for (const edit of edits) {
        if (edit.operation === "append") {
          if (!edit.content?.trim() || edit.oldText !== undefined || edit.newText !== undefined) throw new Error("Append requires nonempty content only; include desired newlines");
          append += edit.content;
        } else {
          if (!edit.oldText || edit.newText === undefined || edit.content !== undefined) throw new Error("Replace requires nonempty oldText and newText; newText may be empty for deletion");
          const start = existing.indexOf(edit.oldText);
          if (start < 0 || existing.indexOf(edit.oldText, start + 1) >= 0)
            throw new MemoryConflictError("oldText must match exactly once. Read the Markdown again and include enough surrounding context; never guess a line number or ID.");
          const end = start + edit.oldText.length;
          if (ranges.some(range => start < range.end && end > range.start)) throw new MemoryConflictError("Replacements overlap; combine them into one exact original passage");
          ranges.push({ start, end, text: edit.newText });
        }
      }
      after = existing;
      for (const range of ranges.sort((a, b) => b.start - a.start)) after = after.slice(0, range.start) + range.text + after.slice(range.end);
      after += append;
    }
    if (after === existing) throw new Error("No Markdown changes for this file");
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
