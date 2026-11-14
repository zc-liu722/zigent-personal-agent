export type MarkdownEdit =
  | { operation: "replace"; oldText: string; newText: string }
  | { operation: "append"; content: string }
  | { operation: "create"; content: string }
  | { operation: "delete"; oldText: string };

export class MarkdownConflictError extends Error {}

/** Plan one document against its original bytes. No edit sees the output of another edit. */
export function editMarkdown(original: string | undefined, edits: readonly MarkdownEdit[], allowLifecycle: boolean): string | undefined {
  const first = edits[0]!;
  if (edits.some(edit => edit.operation === "create" || edit.operation === "delete")) {
    if (!allowLifecycle || edits.length !== 1) throw new Error("创建或删除需要此文档允许该操作，且不能与其他修改混用。");
    if (first.operation === "create") {
      if (original !== undefined) throw new MarkdownConflictError("文档已存在。");
      return first.content;
    }
    if (first.operation === "delete") {
      if (original === undefined || first.oldText !== original) throw new MarkdownConflictError("删除需要完整的原文。");
      return undefined;
    }
  }
  if (original === undefined) throw new MarkdownConflictError("文档不存在，请重新读取。");
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let suffix = "";
  for (const edit of edits) {
    if (edit.operation === "append") {
      if (!edit.content.trim()) throw new Error("追加内容不能为空。");
      suffix += edit.content;
    }
    if (edit.operation === "replace") {
      const start = original.indexOf(edit.oldText);
      if (!edit.oldText || start < 0 || original.indexOf(edit.oldText, start + 1) >= 0)
        throw new MarkdownConflictError("oldText 必须在原文中精确匹配一次。");
      const end = start + edit.oldText.length;
      if (ranges.some(range => start < range.end && end > range.start)) throw new MarkdownConflictError("修改范围重叠。");
      ranges.push({ start, end, text: edit.newText });
    }
  }
  let result = original;
  for (const { start, end, text } of ranges.sort((a, b) => b.start - a.start))
    result = result.slice(0, start) + text + result.slice(end);
  result += suffix;
  if (result === original) throw new Error("文档内容没有变化。");
  return result;
}
