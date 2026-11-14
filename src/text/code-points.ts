import { Buffer } from "node:buffer";

const STRIDE = 256;

function width(text: string, at: number): number {
  const first = text.charCodeAt(at);
  if (first < 0xd800 || first > 0xdbff) return 1;
  const second = text.charCodeAt(at + 1);
  return second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
}

export function codePointLength(text: string): number {
  if (!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) return text.length;
  let length = 0;
  for (let at = 0; at < text.length; at += width(text, at)) length++;
  return length;
}

// Match Array.prototype.slice's numeric boundaries, including negative/NaN/infinite inputs.
function sliceBoundary(value: number, length: number): number {
  const integer = Math.trunc(value) || 0;
  return integer < 0 ? Math.max(length + integer, 0) : Math.min(integer, length);
}

/** A read-local Unicode code-point view, not a grapheme or UTF-16 offset API.
 * Index one UTF-16 boundary per 256 code points instead of allocating a string
 * for every character. Repeated/overlapping pages reuse the same sparse index.
 * Strings are immutable; nothing is cached across source/version reads. */
export class CodePointText {
  readonly length: number;
  private readonly checkpoints: number[] = [];
  constructor(private readonly text: string) {
    if (!/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) { this.length = text.length; return; }
    let length = 0;
    for (let at = 0; at < text.length; at += width(text, at)) {
      if (length % STRIDE === 0) this.checkpoints.push(at);
      length++;
    }
    this.length = length;
  }
  private boundary(offset: number): number {
    if (!this.checkpoints.length) return offset;
    if (offset === this.length) return this.text.length;
    const checkpoint = Math.floor(offset / STRIDE);
    let at = this.checkpoints[checkpoint] ?? 0;
    for (let i = checkpoint * STRIDE; i < offset; i++) at += width(this.text, at);
    return at;
  }
  slice(start = 0, end = this.length): string {
    start = sliceBoundary(start, this.length); end = sliceBoundary(end, this.length);
    if (end <= start) return "";
    // V8 slices can keep a multi-megabyte source alive in a tiny returned page.
    // Copy only this page through UTF-16 (not UTF-8, which replaces lone surrogates).
    // This avoids both retaining the source and rebuilding a per-character array.
    return Buffer.from(this.text.slice(this.boundary(start), this.boundary(end)), "utf16le").toString("utf16le");
  }
}
