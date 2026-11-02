import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { documentMime } from "../capabilities/documents/files.js";
import { inventory, safeFile, safeRoot, selected, sha256, type ProjectSpace } from "./policy.js";
import { projectSpace } from "./service.js";
import { textFileDiff, withFileDiff } from '../file-diff.js';

export type ProjectFile = { project: string; path: string; sha256: string; size: number };
const locks = new Map<string, Promise<void>>();
export async function serializeFileMutation<T>(agent: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(agent) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(agent, current);
  await previous;
  try { return await operation(); }
  finally { release(); if (locks.get(agent) === current) locks.delete(agent); }
}

/** The authority is the same registered project selection used by reads and sync. */
export class ProjectFileWriter {
  constructor(private readonly agent: string, private readonly assertAccess: () => void) {}
  private async space(project: string, path: string) {
    this.assertAccess();
    const space = await projectSpace(this.agent, project);
    if (!selected(space, path) || /\.sync-conflict-/i.test(path)) throw new Error("文件不在已授权项目范围内。");
    return space;
  }
  private async unchanged(space: ProjectSpace) {
    this.assertAccess();
    if (JSON.stringify(await projectSpace(this.agent, space.id)) !== JSON.stringify(space)) throw new Error("项目授权范围已变化，请重新读取。");
    this.assertAccess();
  }
  private async contents(space: ProjectSpace, path: string) {
    const file = await safeFile(space.windows!, path), before = await lstat(file);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error("请选择不超过 64 MiB 的普通项目文件。");
    const bytes = await readFile(file), after = await lstat(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size)
      throw new Error("文件正在变化，请重新读取。");
    return { file, bytes, metadata: { project: space.id, path, size: bytes.length, sha256: sha256(bytes) } };
  }
  async read(project: string, path: string, expected: string) {
    const space = await this.space(project, path), result = await this.contents(space, path);
    if (result.metadata.sha256 !== expected) throw new Error("文件版本已变化，请重新读取后修改。");
    await this.unchanged(space);
    return result;
  }
  private async target(space: ProjectSpace, path: string) {
    let at = await safeRoot(space.windows!);
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      const names = await readdir(at);
      if (names.some(name => name.toLowerCase() === part.toLowerCase() && name !== part)) throw new Error("项目中已有仅大小写不同的路径，请使用实际文件名。");
      const next = join(at, part);
      if (index === parts.length - 1) return next;
      await this.unchanged(space);
      try { await mkdir(next); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = await lstat(next);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("项目路径不能包含链接或普通文件。");
      // Recheck the complete path, including previously traversed directories.
      await safeFile(space.windows!, parts.slice(0, index + 1).join("/"));
      at = next;
    }
    throw new Error("请选择文件路径。");
  }
  private async budget(space: ProjectSpace, path: string, bytes: Buffer) {
    if (bytes.length > 64 * 1024 * 1024) throw new Error("项目文件不能超过 64 MiB。");
    const files = await inventory(space, space.windows!);
    if (files.some(file => /\.sync-conflict-/i.test(file.path))) throw new Error("项目存在同步冲突，请处理冲突后再整理文件。");
    const old = files.find(file => file.path === path);
    if (files.length + (old ? 0 : 1) > 10000 || files.reduce((total, file) => total + file.size, 0) - (old?.size ?? 0) + bytes.length > 512 * 1024 * 1024)
      throw new Error("项目文件数或容量超过同步范围上限。");
  }
  private async stage(space: ProjectSpace, path: string, bytes: Buffer) {
    const target = await this.target(space, path), parent = dirname(path);
    if (parent !== ".") await safeFile(space.windows!, parent);
    const temp = join(dirname(target), `.zigent-write-${randomUUID()}.tmp`);
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temp).catch(() => {}); throw error; }
    await handle.close();
    return { target, temp };
  }
  async create(project: string, path: string, bytes: Buffer, captureDiff = false): Promise<ProjectFile> {
    const space = await this.space(project, path);
    await this.budget(space, path, bytes);
    const staged = await this.stage(space, path, bytes);
    let existed = false;
    try {
      await this.unchanged(space);
      if (dirname(path) !== ".") await safeFile(space.windows!, dirname(path));
      // A hard-link publishes complete bytes atomically and never overwrites an existing destination.
      try { await link(staged.temp, staged.target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.contents(space, path);
        if (!existing.bytes.equals(bytes)) throw new Error("目标文件已存在；请读取后编辑，或选择其他位置。");
        existed = true;
      }
    } finally { await unlink(staged.temp); }
    const saved = await this.contents(space, path);
    if (!saved.bytes.equals(bytes)) throw new Error("保存后文件已变化，请重新读取。");
    return captureDiff && documentMime(path)?.startsWith('text/') ? withFileDiff(saved.metadata, textFileDiff(path, existed ? bytes.toString('utf8') : '', bytes.toString('utf8'))) : saved.metadata;
  }
  async replace(project: string, path: string, expected: string, bytes: Buffer, captureDiff = false): Promise<ProjectFile> {
    const space = await this.space(project, path);
    if (!documentMime(path)?.startsWith("text/")) throw new Error("仅支持编辑 UTF-8 文字文件。");
    const before = await this.read(project, path, expected);
    await this.budget(space, path, bytes);
    const staged = await this.stage(space, path, bytes);
    try {
      await this.unchanged(space);
      await this.read(project, path, expected);
      this.assertAccess();
      await rename(staged.temp, staged.target);
    } finally { await unlink(staged.temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    const saved = await this.contents(space, path);
    if (!saved.bytes.equals(bytes)) throw new Error("保存后文件已变化，请重新读取。");
    return captureDiff ? withFileDiff(saved.metadata, textFileDiff(path, before.bytes.toString('utf8'), bytes.toString('utf8'))) : saved.metadata;
  }
  async move(project: string, path: string, expected: string, destination: { project: string; path: string }) {
    const source = await this.read(project, path, expected);
    if (project === destination.project && path === destination.path) return { status: "unchanged", source: source.metadata };
    // Reject nesting workspace -> child project aliases and case-only self moves.
    const targetSpace = await this.space(destination.project, destination.path);
    if (join(targetSpace.windows!, destination.path).toLowerCase() === source.file.toLowerCase()) throw new Error("目标与原文件相同，请使用实际路径。");
    await this.budget(await this.space(project, path), path, source.bytes);
    const saved = await this.create(destination.project, destination.path, source.bytes);
    try {
      const current = await this.read(project, path, expected);
      await this.read(destination.project, destination.path, saved.sha256);
      this.assertAccess();
      await unlink(current.file);
    } catch {
      return { status: "move_incomplete", destination: saved, source: source.metadata, message: "目标已保存，原文件因版本变化或取消未移除；请重新核对两处文件。" };
    }
    return { status: "moved", source: source.metadata, destination: saved, sync: "pending" };
  }
}
