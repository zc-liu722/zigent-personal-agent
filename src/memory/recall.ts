import { estimateTextTokens } from "../models/context-projection.js";

export type MemoryPassage = { offset: number; endOffset: number; heading: string; content: string };

/** UTF-16 offsets address the exact stored Markdown. No generated facts enter recall. */
export function memoryPassages(content: string): MemoryPassage[] {
  const result: MemoryPassage[] = [];
  let heading = "", offset = 0, start = 0, fenced = false;
  const headings: string[] = [];
  const add = (end: number) => {
    const raw = content.slice(start, end), leading = raw.length - raw.trimStart().length;
    let cursor = start + leading, text = raw.trim();
    // Bound very long paragraphs at sentence/line boundaries; source offsets remain exact.
    while (text.length) {
      let size = Math.min(text.length, 1600);
      if (size < text.length) {
        const candidate = text.slice(0, size);
        const boundary = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf("。"), candidate.lastIndexOf(". "), candidate.lastIndexOf("；"));
        if (boundary >= 400) size = boundary + 1;
        if (/[\uD800-\uDBFF]/.test(text[size - 1]!)) size--;
      }
      const body = text.slice(0, size);
      result.push({ offset: cursor, endOffset: cursor + size, heading, content: body });
      cursor += size; text = text.slice(size);
      const whitespace = text.length - text.trimStart().length; cursor += whitespace; text = text.trimStart();
    }
    start = end;
  };
  for (const line of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const text = line[0], isHeading = !fenced && /^(#{1,6})\s+(.+)/.exec(text);
    if (isHeading) {
      add(offset); const level = isHeading[1]!.length;
      headings.length = level; headings[level - 1] = isHeading[2]!.trim();
      heading = headings.filter(Boolean).join(" / "); start = offset;
    }
    else if (!fenced && (/^\s*$/.test(text) || /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(text))) add(offset);
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    offset += text.length;
  }
  add(content.length);
  return result;
}

/** Mixed Chinese/Latin lexical recall; exact phrases and rare terms outrank recency. */
export function recallTerms(query: string): string[] {
  const lower = query.normalize("NFKC").toLowerCase();
  const words = lower.match(/[a-z0-9_./:@-]{2,}|[\p{Script=Han}]+/gu) ?? [];
  const terms = words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? word.length < 2 ? [word] : [...(word.length <= 12 ? [word] : []), ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))]
    : [word]);
  return [...new Set(terms)].filter(term => !["这个", "那个", "我们", "什么", "一下", "可以", "请问", "the", "and", "with", "that", "this"].includes(term)).slice(0, 64);
}

export function rankMemoryPassages<T extends MemoryPassage>(passages: readonly T[], query: string): Array<{ passage: T; score: number }> {
  const terms = recallTerms(query), normalized = passages.map(passage => `${passage.heading}\n${passage.content}`.normalize("NFKC").toLowerCase());
  const frequency = terms.map(term => normalized.filter(text => text.includes(term)).length);
  return passages.map((passage, index) => {
    const text = normalized[index]!, heading = passage.heading.normalize("NFKC").toLowerCase();
    const score = terms.reduce((sum, term, termIndex) => {
      if (!text.includes(term)) return sum;
      const rarity = Math.log(1 + (passages.length + 1) / (frequency[termIndex]! + 1));
      return sum + rarity * (heading.includes(term) ? 1.8 : 1) * Math.min(2, Math.sqrt(term.length / 2));
    }, 0) / Math.sqrt(1 + estimateTextTokens(passage.content) / 800);
    return { passage, score };
  }).sort((a, b) => b.score - a.score || a.passage.offset - b.passage.offset);
}
