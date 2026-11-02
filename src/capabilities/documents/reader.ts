import { Worker } from "node:worker_threads";

export type DocumentUnit = { text: string; page?: number; paragraph?: number; offset?: number; needsImage?: boolean };
export type DocumentContent = {
  format: "pdf" | "docx" | "text";
  units: DocumentUnit[];
  totalPages?: number;
  indexedFrom?: number;
  indexedTo?: number;
  truncated: boolean;
  warnings: string[];
  images?: Array<{ image: number; name: string; supported: boolean }>;
  location?: string;
};
type Request = { action: "extract"; from?: number; to?: number } | { action: "render"; pages?: number[]; images?: number[] };
type Rendered = { format: "pdf" | "docx"; totalPages?: number; pictures: Array<{ page?: number; image?: number; data: Uint8Array }> };
export const isDocument = (path: string) => /\.(pdf|docx)$/i.test(path);
export const searchable = (path: string) => /\.(md|txt|json|csv|tsv|html?|xml|ya?ml|pdf|docx)$/i.test(path);

export async function decodeDocument(format: "pdf" | "docx", bytes: Buffer, request: Request, signal?: AbortSignal): Promise<DocumentContent | Rendered> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../../../ops/document-reader/worker.mjs", import.meta.url), {
      workerData: { format, bytes, request }, resourceLimits: { maxOldGenerationSizeMb: 384 }, stdout: true, stderr: true
    });
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const finish = (error?: Error, result?: DocumentContent | Rendered) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new Error("DOCUMENT_CANCELLED"));
    const timer = setTimeout(() => finish(new Error("DOCUMENT_TIMEOUT")), 30000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    worker.once("message", (message: { error?: string; result?: DocumentContent | Rendered }) =>
      finish(message.error ? new Error(message.error) : message.result ? undefined : new Error("DOCUMENT_PARSE_FAILED"), message.result));
    worker.once("error", () => finish(new Error("DOCUMENT_PARSE_FAILED")));
    worker.once("exit", () => { if (!settled) finish(new Error("DOCUMENT_PARSE_FAILED")); });
  });
}

/** Reusable byte-based capability. Callers authorize sources before passing data. */
export class DocumentReader {
  private cache = new Map<string, { value: DocumentContent; size: number }>();
  private size = 0;
  async read(path: string, hash: string, bytes: Buffer, range?: { from: number; to: number }, signal?: AbortSignal): Promise<DocumentContent> {
    const format = /\.pdf$/i.test(path) ? "pdf" : /\.docx$/i.test(path) ? "docx" : "text";
    if (format === "text") {
      if (bytes.length > 2 * 1024 * 1024) throw new Error("DOCUMENT_LIMIT");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) throw new Error("DOCUMENT_UNSUPPORTED");
      return { format, units: [{ text }], truncated: false, warnings: [] };
    }
    const key = JSON.stringify(["documents-v1", format, hash, range]);
    const saved = this.cache.get(key);
    if (saved) { this.cache.delete(key); this.cache.set(key, saved); return saved.value; }
    const value = await decodeDocument(format, bytes, { action: "extract", ...range }, signal) as DocumentContent;
    const size = JSON.stringify(value).length * 2;
    if (size <= 32 * 1024 * 1024) {
      while (this.cache.size >= 32 || this.size + size > 32 * 1024 * 1024) {
        const first = this.cache.keys().next().value;
        if (!first) break;
        this.size -= this.cache.get(first)!.size; this.cache.delete(first);
      }
      this.cache.set(key, { value, size }); this.size += size;
    }
    return value;
  }
  prune(hashes: Set<string>) {
    for (const [key, value] of this.cache) {
      const hash = (JSON.parse(key) as string[])[2]!;
      if (!hashes.has(hash)) { this.size -= value.size; this.cache.delete(key); }
    }
  }
}
