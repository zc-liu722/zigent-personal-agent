import { CodePointText, codePointLength } from "../../text/code-points.js";
import type { DocumentContent } from "./reader.js";

/** Project decoded units to a page in the caller's existing coordinate system.
 * Source authorization, freshness, errors and response metadata belong to callers.
 * Attachment sections include their trailing separator; project sections do not. */
export function readDocumentText(document: DocumentContent, input: {
  offset: number; limit: number; heading?: string; sectionSeparators: boolean;
}) {
  let text = document.units.map(unit => unit.text).join("\n\n"), headingOffset = 0, startLine = 1;
  if (input.heading) {
    const lines = text.split("\n"), start = lines.findIndex(line => line.trim() === input.heading!.trim());
    if (start < 0 || !/^#{1,6} /.test(lines[start]!)) return undefined;
    const level = /^#+/.exec(lines[start]!)![0].length;
    const next = lines.findIndex((line, index) => index > start && /^#{1,6} /.test(line) && /^#+/.exec(line)![0].length <= level);
    headingOffset = codePointLength(lines.slice(0, start).join("\n")) + (start ? 1 : 0);
    text = lines.slice(start, next < 0 ? undefined : next).join("\n"); startLine = start + 1;
  }
  const view = new CodePointText(text), end = Math.min(view.length, input.offset + input.limit);
  // Project files resolve section locations after their asynchronous freshness check;
  // attachments resolve them before their synchronous authorization/version check.
  const sections = () => {
    let position = 0;
    return document.units.flatMap(unit => {
      const start = position, end = start + codePointLength(unit.text); position = end + 2;
      if (!((input.sectionSeparators ? position : end) >= headingOffset + input.offset && start < headingOffset + input.offset + input.limit)) return [];
      return [input.sectionSeparators
        ? { page: unit.page, paragraph: unit.paragraph, needsImage: unit.needsImage, offset: start }
        : { page: unit.page, paragraph: unit.paragraph, offset: start, needsImage: unit.needsImage }];
    });
  };
  return { content: view.slice(input.offset, end), total: view.length, startLine, sections,
    next_offset: end < view.length ? end : null, has_more: end < view.length };
}
