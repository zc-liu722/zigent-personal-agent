import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const reserved = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;
export function workspacePath(value = ".", allowRoot = true): string {
  if (typeof value !== "string" || value.length > 2048 || isAbsolute(value) || /^[\\/]|^[a-z]:/i.test(value)) throw new Error("只支持工作区内的相对路径。");
  const path = value.replaceAll("\\", "/");
  if (allowRoot && (path === "." || path === "")) return ".";
  const parts = path.split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === ".." || part.length > 240 || /[\x00-\x1f\x7f<>:"|?*]/.test(part) || /[. ]$/.test(part) || reserved.test(part))) throw new Error("文件路径无效，不能包含上级目录、设备名或特殊路径。");
  return parts.join("/");
}
export function workspaceName(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  workspacePath(name, false); return name;
}
function equalPath(a: string, b: string) { return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b; }
function inside(root: string, path: string) { const rel = relative(root, path); return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); }

/** Validate every existing ancestor, including Windows junctions, before touching a task path. */
export async function ordinaryPath(root: string, child = ".", allowMissing = false): Promise<string> {
  root = resolve(root);
  const normalized = workspacePath(child);
  const target = normalized === "." ? root : resolve(root, normalized);
  if (!inside(root, target)) throw new Error("文件位于工作区之外。");
  const anchor = parse(root).root;
  let current = anchor;
  const pieces = relative(anchor, target).split(sep).filter(Boolean);
  let missing = false;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]!);
    if (missing) continue;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1) throw new Error("工作区不支持符号链接、硬链接或特殊文件。");
      if (i < pieces.length - 1 && !info.isDirectory()) throw new Error("路径中的父级不是目录。");
      if (!equalPath(await realpath(current), current)) throw new Error("文件路径已重定向，请使用普通文件。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) missing = true;
      else throw error;
    }
  }
  return target;
}

export async function snapshotFile(root: string, path: string, maxBytes: number): Promise<{ bytes: Buffer; modifiedAt: number }> {
  const target = await ordinaryPath(root, path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error(`请选择不超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 的普通文件。`);
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) throw new Error("文件读取期间发生变化，请重试。");
      position += read.bytesRead;
    }
    const after = await handle.stat();
    await ordinaryPath(root, path);
    const current = await lstat(target);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1 || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs) throw new Error("文件读取期间发生变化，请重试。");
    return { bytes, modifiedAt: after.mtimeMs };
  } finally { await handle.close(); }
}
