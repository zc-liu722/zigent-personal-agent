import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";
import type { CodexDevice } from "./types.js";

export const directorySchema = z.string().trim().min(1).max(1024).refine(value => win32.isAbsolute(value) && !/[\x00-\x1f]/.test(value), "请选择 Windows 上的绝对工作目录");
/** A location, never an admission list or a writable-root policy. */
export function directoryProject(value: unknown): CodexDevice["projects"][number] {
  const path = win32.normalize(directorySchema.parse(value));
  const directory = (path.length > win32.parse(path).root.length ? path.replace(/[\\/]$/, "") : path).replaceAll("\\", "/");
  const id = "dir_" + createHash("sha256").update(directory.toLowerCase()).digest("hex");
  return { id, name: win32.basename(directory).slice(0, 80) || directory, directory, executor: "windows-codex", host: "windows", available: true };
}
export function dispatchProject(device: CodexDevice, target: { directory?: unknown; projectId?: unknown }) {
  if (target.directory !== undefined) return directoryProject(target.directory);
  const project = device.projects.find(project => project.id === target.projectId && project.available !== false);
  if (!project?.directory) throw new Error("请提供任务的绝对工作目录");
  return directoryProject(project.directory);
}
