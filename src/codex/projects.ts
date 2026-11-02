import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { CodexRpc } from "./rpc.js";
import { identifier, PROJECT_LIMIT, projectSchema } from "./types.js";

export type WorkerProject = z.infer<typeof projectSchema> & { path: string };
const pageSchema = z.object({ data: z.array(z.object({ id: identifier, name: z.string().min(1), roots: z.array(z.object({ path: z.string().refine(isAbsolute) })).max(16) })), nextCursor: z.string().nullable() });
/** Native project identities and roots only. No scanning user files or inferring projects from chats. */
export async function codexProjects(rpc: Pick<CodexRpc, "call">): Promise<WorkerProject[]> {
  const projects: WorkerProject[] = [], seen = new Set<string>(), cursors = new Set<string>(); let cursor: string | null = null;
  do {
    const page = pageSchema.parse(await rpc.call("project/list", { cursor, limit: 100 }));
    for (const project of page.data) {
      if (seen.has(project.id)) throw new Error("Duplicate Codex project identity"); seen.add(project.id);
      let available = project.roots.length > 0;
      const roots: string[] = [];
      for (const root of project.roots) {
        try { const path = await realpath(root.path); if (!(await stat(path)).isDirectory()) available = false; roots.push(path); }
        catch { available = false; roots.push(root.path); }
      }
      projects.push({ id: project.id, codexProjectId: project.id, name: project.name.slice(0, 80), path: roots[0] ?? "", ...(roots[0] ? { directory: roots[0] } : {}), roots, available });
      if (projects.length > PROJECT_LIMIT) throw new Error("Codex project catalog exceeds transport limit");
    }
    if (page.nextCursor && cursors.has(page.nextCursor)) throw new Error("Codex project cursor did not advance");
    if (page.nextCursor) cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return projects;
}
