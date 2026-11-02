import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";

export const agentId = z.enum(["deepmind", "xiaochang"]);
export const executorId = z.enum(["windows-codex", "linux-claude"]);
export const relativePath = z.string().min(1).max(600).refine(p => !/[\\\x00-\x1f<>:"|?*]/.test(p)
  && p.split("/").every(s => s && !s.startsWith(".") && !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)));
const absolutePath = z.string().max(1024).refine(p => isAbsolute(p) || win32.isAbsolute(p));
export const spaceSchema = z.object({ agent: agentId, id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().min(1).max(80),
  introduction: z.string().trim().min(1).max(1600).optional(),
  mac: absolutePath.optional(), windows: absolutePath.optional(), linux: absolutePath.optional(),
  include: z.array(z.string().min(1).max(600)).min(1).max(100), executors: z.array(executorId).max(2) }).strict();
export type ProjectSpace = z.infer<typeof spaceSchema>;
export const registrySchema = z.object({ version: z.literal(1), spaces: z.array(spaceSchema).max(100) }).strict().superRefine((registry, ctx) => {
  const keys = registry.spaces.map(s => `${s.agent}/${s.id}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate project identity" });
  for (const s of registry.spaces) {
    const windows = s.windows ? win32.normalize(s.windows).replaceAll("\\", "/").toLowerCase() : "";
    if (!s.windows || s.mac && s.agent !== "deepmind" || windows === "d:/zigent" || windows.startsWith("d:/zigent/") || s.executors.includes("linux-claude") && !s.linux)
      ctx.addIssue({ code: "custom", message: "Project must be separate from production; Mac is Deepmind-only" });
    for (const other of registry.spaces.filter(o => o.agent !== s.agent)) for (const host of ["mac", "windows", "linux"] as const) {
      const a = s[host]?.replaceAll("\\", "/").toLowerCase().replace(/\/$/, ""), b = other[host]?.replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
      if (a && b && (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))) ctx.addIssue({ code: "custom", message: "Agent spaces overlap" });
    }
  }
});
export const registryPath = () => resolve("ops/project-spaces/projects.json");
export async function spaces(agent: string, path = registryPath()): Promise<ProjectSpace[]> {
  agentId.parse(agent);
  return registrySchema.parse(JSON.parse(await readFile(path, "utf8"))).spaces.filter(s => s.agent === agent);
}
export function glob(pattern: string): RegExp {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") { expression += ".*"; i++; }
    else if (c === "*") expression += "[^/]*";
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + expression + "$");
}
export function forbidden(path: string, space?: Pick<ProjectSpace, "agent" | "id">): boolean {
  return path.split("/").some(part => { const s = part.replace(/\.sync-conflict-[^.]+(?=\.|$)/, ""); return s.startsWith(".") || /^(node_modules|vendor|venv|__pycache__|dist|build|target|tmp|temp|cache)$/i.test(s)
    || /^(history|material|output|_source)$/i.test(s) || s.startsWith("~$")
    || /^(auth|credentials?|tokens?|secrets?|config)\.(json|toml|ya?ml)$/i.test(s)
    || /^(credentials?|tokens?|secrets?|authorized_keys|known_hosts|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$/i.test(s)
    || /\.(sqlite(?:-.*)?|db(?:-.*)?|pem|key|pfx|p12|log|tmp|part|swp)$/i.test(s); });
}
export function selected(space: ProjectSpace, path: string, includeResults = true): boolean {
  if (!relativePath.safeParse(path).success || forbidden(path, space) || !includeResults && path.split("/").includes("results")) return false;
  const original = path.replace(/\.sync-conflict-[^.]+(?=\.|$)/, "");
  return space.include.some(p => glob(p).test(path) || original !== path && !forbidden(original, space) && glob(p).test(original));
}
export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export type Inventory = Array<{ path: string; sha256: string; size: number }>;
export const version = (files: Inventory) => sha256(JSON.stringify(files));
export async function safeRoot(path: string): Promise<string> {
  const absolute = resolve(path), actual = await realpath(absolute);
  if (actual.toLowerCase() !== absolute.toLowerCase() || !(await lstat(actual)).isDirectory()) throw new Error("Workspace links are forbidden");
  return actual;
}
export async function safeFile(root: string, path: string): Promise<string> {
  relativePath.parse(path);
  const file = join(await safeRoot(root), ...path.split("/"));
  const rel = relative(root, file);
  if (rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("Path outside project");
  let at = root;
  for (const part of path.split("/")) {
    at = join(at, part);
    const info = await lstat(at);
    if (info.isSymbolicLink() || info.nlink > 1 && info.isFile()) throw new Error("Linked project files are forbidden");
  }
  return file;
}
export async function inventory(space: ProjectSpace, root: string, includeResults = true): Promise<Inventory> {
  root = await safeRoot(root);
  const files: Inventory = [], names = new Set<string>(); let bytes = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (forbidden(path, space) || !includeResults && path.split("/").includes("results")) continue;
      if (entry.isSymbolicLink()) throw new Error("Remove project links before syncing or executing");
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + "/");
      else if (entry.isFile() && selected(space, path, includeResults)) {
        const file = await safeFile(root, path), before = await lstat(file), data = await readFile(file), after = await lstat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || data.length !== before.size) throw new Error("Project changed during inventory");
        bytes += data.length;
        if (files.length >= 10000 || bytes > 512 * 1024 * 1024 || data.length > 64 * 1024 * 1024 || names.has(path.toLowerCase())) throw new Error("Project inventory limit or case collision");
        names.add(path.toLowerCase()); files.push({ path, sha256: sha256(data), size: data.length });
      }
    }
  }
  await walk(root, ""); return files.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}
