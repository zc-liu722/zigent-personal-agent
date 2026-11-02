import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./http.js";

/** Validators skip BLOB reads; only the requested bytes cross from SQLite into Node. */
export function sendAsset(req: IncomingMessage, res: ServerResponse,
  asset: { mime: string; size: number; etag: string; immutable: boolean; name?: string },
  read: (start: number, length: number) => Uint8Array | undefined): void {
  res.setHeader("Cache-Control", asset.immutable ? "private, max-age=86400, immutable, no-transform" : "private, max-age=0, must-revalidate, no-transform");
  res.setHeader("ETag", asset.etag); res.setHeader("Vary", "Cookie");
  res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Content-Type", asset.mime);
  if (asset.name) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
  if (req.headers["if-none-match"]?.split(",").some(value => value.trim().replace(/^W\//, "") === asset.etag || value.trim() === "*")) {
    res.writeHead(304); res.end(); return;
  }
  let start = 0, end = asset.size - 1, status = 200;
  // Only the current strong content version can validate a partial response.
  if (req.method === "GET" && req.headers.range && (!req.headers["if-range"] || req.headers["if-range"] === asset.etag)) {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const invalid = () => { res.setHeader("Cache-Control", "no-store"); res.writeHead(416, { "Content-Range": `bytes */${asset.size}` }); res.end(); };
    if (!range || !range[1] && !range[2]) { invalid(); return; }
    const first = range[1] ? Number(range[1]) : undefined, last = range[2] ? Number(range[2]) : undefined;
    if (first !== undefined && !Number.isSafeInteger(first) || last !== undefined && !Number.isSafeInteger(last)) { invalid(); return; }
    if (first === undefined) {
      if (!last) { invalid(); return; }
      start = Math.max(0, asset.size - last);
    } else { start = first; if (last !== undefined) end = Math.min(end, last); }
    if (start > end || start >= asset.size) { invalid(); return; }
    status = 206; res.setHeader("Content-Range", `bytes ${start}-${end}/${asset.size}`);
  }
  const length = Math.max(0, end - start + 1);
  const bytes = req.method === "HEAD" ? undefined : read(start, length);
  if (req.method !== "HEAD" && (!bytes || bytes.length !== length)) {
    res.setHeader("Cache-Control", "no-store"); res.removeHeader("Content-Range"); json(res, 404, { error: "附件不存在。" }); return;
  }
  res.setHeader("Content-Length", length); res.writeHead(status); res.end(bytes);
}
