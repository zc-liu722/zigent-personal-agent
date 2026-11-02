import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { projectSpace } from "./service.js";
import { relativePath, safeFile, selected, sha256 } from "./policy.js";

const table = Array.from({ length: 256 }, (_, i) => { let c = i; for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255]! ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function drain(res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => { res.off("drain", ready); res.off("error", failed); res.off("close", closed); };
    const ready = () => { clean(); resolve(); };
    const failed = (error: Error) => { clean(); reject(error); };
    const closed = () => failed(new Error("Download disconnected"));
    res.once("drain", ready); res.once("error", failed); res.once("close", closed);
  });
}
/** ZIP stored entries; only the published manifest's hash-verified regular files. */
export async function resultArchive(agent: string, projectId: string, taskId: string, inputVersion: string, res: ServerResponse) {
  z.string().uuid().parse(taskId);
  const space = await projectSpace(agent, projectId), root = join(space.windows!, "results", taskId);
  const manifestBytes = await readFile(await safeFile(root, "manifest.json"));
  const manifest = z.object({ taskId: z.literal(taskId), inputVersion: z.literal(inputVersion), files: z.array(z.object({
    path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(64 * 1024 * 1024) })).max(10000) }).parse(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.files.reduce((n, f) => n + f.size, 0) > 512 * 1024 * 1024 || new Set(manifest.files.map(f => f.path.toLowerCase())).size !== manifest.files.length
    || manifest.files.some(f => !selected(space, "results/" + taskId + "/files/" + f.path))) throw new Error("Result archive limit or excluded path");
  const entries = [{ path: "manifest.json", size: manifestBytes.length, sha256: sha256(manifestBytes) }, ...manifest.files.map(f => ({ ...f, path: "files/" + f.path }))];
  let offset = 0; const directory: Buffer[] = [];
  res.writeHead(200, { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${projectId}-${taskId}.zip"`, "Cache-Control": "no-store" });
  try {
    for (const entry of entries) {
      const data = entry.path === "manifest.json" ? manifestBytes : await readFile(await safeFile(root, entry.path));
      if (data.length !== entry.size || sha256(data) !== entry.sha256) throw new Error("Published result checksum changed");
      const name = Buffer.from(entry.path), crc = crc32(data), local = Buffer.alloc(30), central = Buffer.alloc(46);
      local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(33, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
      central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(33, 14);
      central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      directory.push(central, name);
      for (const chunk of [local, name, data]) {
        if (res.destroyed) return;
        if (!res.write(chunk)) await drain(res);
      }
      offset += local.length + name.length + data.length;
    }
    const centralSize = directory.reduce((n, b) => n + b.length, 0), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    res.end(Buffer.concat([...directory, end]));
  } catch (error) { res.destroy(error instanceof Error ? error : new Error("Archive unavailable")); }
}
