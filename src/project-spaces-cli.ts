import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncAll, hostRoot } from "./project-spaces/sync.js";
import { agentId, inventory, spaces, version } from "./project-spaces/policy.js";

const [action, agent, registry = "ops/project-spaces/projects.json"] = process.argv.slice(2);
agentId.parse(agent);
if (action === "inventory") {
  for (const space of await spaces(agent!, registry)) {
    const files = await inventory(space, space.windows!);
    console.info(JSON.stringify({ project: space.id, count: files.length, version: version(files) }));
  }
} else if (action === "sync") {
  const lock = join(hostRoot, "sync", agent!, "coordinator.lock");
  await mkdir(resolve(lock, ".."), { recursive: true });
  // Host scheduler has a bounded lifetime and IgnoreNew. A live lock never
  // gets stolen; crashes leave a PID for explicit liveness reconciliation.
  try { await mkdir(lock); } catch {
    const pid = Number(await readFile(join(lock, "pid"), "utf8"));
    try { process.kill(pid, 0); throw new Error("Sync already running"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(lock, "pid"), String(process.pid));
  try { console.info(JSON.stringify(await syncAll(agent!, registry))); }
  finally { await rm(lock, { recursive: true }); }
} else throw new Error("Use inventory or sync with an exact agent");
