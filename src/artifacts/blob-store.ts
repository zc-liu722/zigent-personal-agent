import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ordinaryPath, snapshotFile } from "../workspaces/paths.js";

export const contentHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Immutable bytes only. Ownership is checked by WorkspaceService before access. */
export class ArtifactBlobStore {
  constructor(private readonly directory: string, private readonly maxBytes: number) {}
  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("文件摘要无效。");
    return `${hash.slice(0, 2)}/${hash}`;
  }
  async put(bytes: Buffer): Promise<string> {
    if (bytes.length > this.maxBytes) throw new Error("文件超过存储大小限制。");
    const hash = contentHash(bytes), path = this.path(hash);
    const target = await ordinaryPath(this.directory, path, true);
    try {
      const previous = await this.read(hash);
      if (!previous.equals(bytes)) throw new Error("文件存储摘要冲突。");
      return hash;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(join(this.directory, hash.slice(0, 2)), { recursive: true });
    await ordinaryPath(this.directory, `${hash.slice(0, 2)}`);
    const temporary = join(this.directory, hash.slice(0, 2), `.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes); await handle.sync();
    } catch (error) { await handle.close(); await rm(temporary, { force: true }); throw error; }
    await handle.close();
    try {
      await ordinaryPath(this.directory, path, true);
      // All writers for this name have exactly these bytes. Rename exposes a
      // complete object atomically; an existing Windows destination is verified.
      await rename(temporary, target);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      const current = await this.read(hash);
      if (!current.equals(bytes)) throw new Error("文件存储校验失败。");
    } finally { await rm(temporary, { force: true }); }
    return hash;
  }
  async read(hash: string): Promise<Buffer> {
    const { bytes } = await snapshotFile(this.directory, this.path(hash), this.maxBytes);
    if (contentHash(bytes) !== hash) throw new Error("保存的文件校验失败，请恢复备份。");
    return bytes;
  }
}
