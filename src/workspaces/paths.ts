import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
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

const readChanged = () => new Error("文件读取期间发生变化，请重试。");
function unstable(before: Stats, after: Stats, current: Stats): boolean {
  return before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1
    || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.mtimeMs !== after.mtimeMs;
}
async function assertStable(root: string, path: string, target: string, handle: FileHandle, before: Stats): Promise<Stats> {
  const after = await handle.stat();
  await ordinaryPath(root, path);
  if (unstable(before, after, await lstat(target))) throw readChanged();
  return after;
}
export type FileIdentity = { dev: bigint; ino: bigint; size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint };
function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
const wholeSecond = 1_000_000_000n;
/** FAT stores both stamps in 2-second units. exFAT mtime is 10 ms, so those files still reuse the digest. A copied file often keeps a whole-second mtime and a fine ctime. */
export function coarseFileIdentity(identity: FileIdentity): boolean {
  return identity.mtimeNs % wholeSecond === 0n && identity.ctimeNs % wholeSecond === 0n;
}
function fileIdentity(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}
async function readExact(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let written = 0;
  while (written < length) {
    const read = await handle.read(bytes, written, length - written, position + written);
    if (!read.bytesRead) throw readChanged();
    written += read.bytesRead;
  }
  return bytes;
}

export async function snapshotFile(root: string, path: string, maxBytes: number): Promise<{ bytes: Buffer; modifiedAt: number }> {
  const target = await ordinaryPath(root, path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error(`请选择不超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 的普通文件。`);
    const bytes = await readExact(handle, 0, before.size);
    const after = await assertStable(root, path, target, handle, before);
    return { bytes, modifiedAt: after.mtimeMs };
  } finally { await handle.close(); }
}

/** Read one byte range. A cached digest is reused only while the file identity is unchanged; otherwise the whole file is hashed once. */
export async function snapshotFileRange(root: string, path: string, maxBytes: number, offset: number, length: number, cached?: { identity: FileIdentity; sha256: string }): Promise<{ bytes: Buffer; size: number; sha256: string; identity: FileIdentity; examined: number }> {
  const target = await ordinaryPath(root, path);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error(`请选择不超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 的普通文件。`);
    // Number stats omit mtimeNs, so a same-size rewrite would look unchanged. Nanosecond identity comes from the bigint stat.
    const identity = fileIdentity(await handle.stat({ bigint: true }));
    if (identity.size !== BigInt(before.size) || identity.nlink !== 1n) throw readChanged();
    const start = Number.isSafeInteger(offset) && offset >= 0 ? Math.min(offset, before.size) : 0;
    const span = Number.isSafeInteger(length) && length > 0 ? length : 0;
    const end = Math.min(before.size, start + span);
    if (cached && sameFileIdentity(cached.identity, identity) && !coarseFileIdentity(identity)) {
      const bytes = await readExact(handle, start, end - start);
      await assertStable(root, path, target, handle, before);
      return { bytes, size: before.size, sha256: cached.sha256, identity, examined: end - start };
    }
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(end - start);
    const chunk = Buffer.alloc(before.size === 0 ? 0 : Math.min(64 * 1024, before.size));
    let position = 0;
    while (position < before.size) {
      const read = await handle.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
      if (!read.bytesRead) throw readChanged();
      hash.update(chunk.subarray(0, read.bytesRead));
      const from = Math.max(position, start);
      const to = Math.min(position + read.bytesRead, end);
      if (to > from) chunk.copy(bytes, from - start, from - position, to - position);
      position += read.bytesRead;
    }
    await assertStable(root, path, target, handle, before);
    return { bytes, size: before.size, sha256: hash.digest("hex"), identity, examined: position };
  } finally { await handle.close(); }
}
