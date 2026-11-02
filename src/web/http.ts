import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
/** Bound bootstrap transfer size before the edge; compression never blocks the JS thread. */
export async function bootstrapJson(req: IncomingMessage, res: ServerResponse, value: unknown): Promise<void> {
  const body = JSON.stringify(value);
  const encodings = (req.headers['accept-encoding'] ?? '').toLowerCase().split(',').map(part => {
    const [name, ...parameters] = part.trim().split(';');
    const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
    return { name, quality: quality === undefined ? 1 : Number(quality.slice(2)) };
  });
  const accepted = (encodings.find(value => value.name === 'gzip') ?? encodings.find(value => value.name === '*'))?.quality ?? 0;
  const bytes = Buffer.from(body);
  res.setHeader('Vary', 'Accept-Encoding');
  const compressed = bytes.length >= 8192 && accepted > 0 ? await compress(bytes, { level: 4 }) : undefined;
  const output = compressed && compressed.length < bytes.length ? compressed : bytes;
  if (output === compressed) res.setHeader('Content-Encoding', 'gzip');
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': output.length });
  res.end(output);
}
const bodyEtag = (body: string) => `"${createHash("sha256").update(body).digest("hex")}"`;
export const jsonEtag = (value: unknown): string => bodyEtag(JSON.stringify(value));
/** Conditional private reads; validators never bypass the authenticated route. */
export function conditionalJson(req: IncomingMessage, res: ServerResponse, value: unknown): void {
  const body = JSON.stringify(value);
  const etag = bodyEtag(body);
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"]?.split(",").some(value => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")) {
    res.writeHead(304); res.end(); return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
export async function body(req: IncomingMessage, limit = 128_000): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw new Error("请求内容过大。");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
export async function data(req: IncomingMessage, limit?: number): Promise<unknown> {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new Error("请求格式不正确。");
  return JSON.parse((await body(req, limit)).toString("utf8"));
}
export type WebRequest = { req: IncomingMessage; res: ServerResponse; url: URL; route: string; credential: string };
export type WebRoute = (request: WebRequest) => Promise<boolean>;
