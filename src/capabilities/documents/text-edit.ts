import { z } from "zod";
import { relativePath } from "../../project-spaces/policy.js";

export const documentSourceSchema = z.object({ id: z.string().uuid().optional(), project: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(), path: z.string().min(1).max(1024).optional() }).strict()
  .refine(value => value.id ? !value.path && !value.project : Boolean(value.path || value.project), "Choose one uploaded reference or a file path/project source");
const destination = z.object({ project: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), path: relativePath }).strict();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const content = z.string().max(2 * 1024 * 1024);
export const documentMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create_text"), destination, content }).strict(),
  z.object({ action: z.literal("edit_text"), source: documentSourceSchema, expected_sha256: hash, content: content.optional(),
    edits: z.array(z.object({ old_text: z.string().min(1).max(2 * 1024 * 1024), new_text: content }).strict()).min(1).max(40).optional() }).strict(),
  z.object({ action: z.literal("move_file"), source: documentSourceSchema, expected_sha256: hash, destination }).strict()
]).superRefine((value, ctx) => {
  if (value.action === "edit_text" && (value.content === undefined) === (value.edits === undefined))
    ctx.addIssue({ code: "custom", message: "Provide complete content OR exact edits, never both" });
});
export type DocumentMutation = z.infer<typeof documentMutationSchema>;
export const isDocumentMutation = (value: { action: string }): value is DocumentMutation => ["create_text", "edit_text", "move_file"].includes(value.action);

export function textBytes(content: string): Buffer {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > 2 * 1024 * 1024 || content.includes("\0")) throw new Error("文字文件必须是无空字符、最多 2 MiB 的 UTF-8 文本。");
  return bytes;
}
/** All matches refer to the original version, so edits cannot cascade or overlap. */
export function editText(text: string, input: Extract<DocumentMutation, { action: "edit_text" }>): Buffer {
  if (input.content !== undefined) return textBytes(input.content);
  const ranges = input.edits!.map(edit => {
    const start = text.indexOf(edit.old_text);
    if (start < 0 || text.indexOf(edit.old_text, start + 1) >= 0) throw new Error("原文字段必须恰好匹配一处；请读取当前文件并提供更完整的上下文。");
    return { start, end: start + edit.old_text.length, text: edit.new_text };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) if (ranges[i]!.start < ranges[i - 1]!.end) throw new Error("修改范围不能重叠。");
  for (const range of ranges.reverse()) text = text.slice(0, range.start) + range.text + text.slice(range.end);
  return textBytes(text);
}
