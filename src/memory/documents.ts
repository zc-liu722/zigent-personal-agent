import { createHash } from "node:crypto";
import { validateMarkdown, type EditableMemory } from "./changes.js";

export type MemoryDocumentTarget = "longTermMemory" | "behaviorRules" | `archive-${string}`;
export const MEMORY_DOCUMENTS = {
  longTermMemory: { id: "longTermMemory", title: "长期记忆", filename: "long-term-memory.md" },
  behaviorRules: { id: "behaviorRules", title: "共享规则", filename: "behavior-rules.md" }
} as const;
export const archiveDocumentId = (title: string) => `archive-${createHash("sha256").update(title).digest("hex").slice(0, 24)}` as const;
export function memoryDocuments(memory: EditableMemory) {
  return [MEMORY_DOCUMENTS.longTermMemory, MEMORY_DOCUMENTS.behaviorRules,
    ...(memory.archiveMemory ?? []).map(item => ({ id: archiveDocumentId(item.title), title: item.title, filename: `${item.title.replace(/[<>:"/\\|?*]/g, "_")}.md` }))];
}
export function documentDefinition(memory: EditableMemory, id: string) {
  return memoryDocuments(memory).find(item => item.id === id);
}
export function documentContent(memory: EditableMemory, id: MemoryDocumentTarget): string {
  if (id.startsWith("archive-")) return memory.archiveMemory?.find(item => archiveDocumentId(item.title) === id)?.content ?? "";
  return id === "behaviorRules" ? memory.behaviorRules : memory.longTermMemory;
}
export function validateMemoryDocument(id: string, content: string) { validateMarkdown(content, !id.startsWith("archive-")); }
