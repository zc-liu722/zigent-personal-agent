import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { forbidden, inventory, safeFile, selected, sha256, spaces, version } from "./policy.js";
import { hostRoot } from "./sync.js";

export async function projectSpace(agent: string, id: string) {
  const space = (await spaces(agent)).find(s => s.id === id);
  if (!space || process.platform !== "win32") throw new Error("Project space is unavailable on this host");
  return space;
}
export async function spaceReadiness(agent: string, id: string) {
  const space = await projectSpace(agent, id);
  const files = await inventory(space, space.windows!, false);
  let status: { state?: string; checkedAt?: number; inputVersion?: string } = {};
  try { status = JSON.parse(await readFile(join(hostRoot, "sync", agent, id, "status.json"), "utf8")); } catch { /* Unprepared is never ready. */ }
  let macReady = !space.mac;
  if (space.mac) {
    try {
      const xml = await readFile(join(hostRoot, "syncthing/state/config.xml"), "utf8");
      const key = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
      if (!key) throw new Error("Missing sync control identity");
      const api = async (path: string) => {
        const r = await fetch("http://127.0.0.1:18385/rest/" + path, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error("Mac sync control unavailable"); return r.json() as Promise<Record<string, unknown>>;
      };
      const [state, connections] = await Promise.all([api("db/status?folder=" + encodeURIComponent(`zigent-${space.agent}-${space.id}`)), api("system/connections")]);
      const peer = Object.entries((connections.connections ?? {}) as Record<string, { connected?: boolean }>).find(([, c]) => c.connected)?.[0];
      const completion = peer ? await api("db/completion?folder=" + encodeURIComponent(`zigent-${space.agent}-${space.id}`) + "&device=" + encodeURIComponent(peer)) : {};
      macReady = state.state === "idle" && Number(state.needTotalItems ?? 1) === 0 && Number(state.pullErrors ?? 0) === 0
        && Number(completion.completion ?? 0) === 100 && Object.values((connections.connections ?? {}) as Record<string, { connected?: boolean }>).some(c => c.connected);
      // Conflict files must be resolved explicitly, even when transfer is idle.
      if (files.some(f => /\.sync-conflict-/.test(f.path))) macReady = false;
    } catch { macReady = false; }
  }
  const complete = await inventory(space, space.windows!);
  if (!space.linux) status = { state: "synchronized", checkedAt: Date.now(), inputVersion: version(complete) };
  async function hasConflict(root: string, prefix = ""): Promise<boolean> {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (/\.sync-conflict-/.test(item.name) && selected(space, path.replace(/\.sync-conflict-[^.]+(?=\.|$)/, ""))) return true;
      if (item.isDirectory() && !forbidden(path, space) && await hasConflict(join(root, item.name), path + "/")) return true;
    }
    return false;
  }
  const conflict = status.state === "conflict" || await hasConflict(space.windows!);
  if (conflict) macReady = false;
  const ready = macReady && status.state === "synchronized" && Date.now() - (status.checkedAt ?? 0) < 180000 && status.inputVersion === version(complete);
  return { project: space.id,
    sync: { direction: "bidirectional", macWindows: space.mac ? { transport: "syncthing", scheduling: "continuous", watcherDelaySeconds: 2, fallbackScanSeconds: 600 } : undefined,
      windowsLinux: space.linux ? { transport: "unison", intervalSeconds: 60 } : undefined, offline: "catch_up_on_reconnect", conflicts: "preserve_both", dailySnapshot: false },
    machines: { mac: space.mac, windows: space.windows, linux: space.linux },
    resultRoot: ".", executionMode: "project", state: conflict ? "conflict" : ready ? "ready" : "syncing", inputVersion: version(files), macReady: space.mac ? macReady : undefined,
    linuxSync: space.linux ? status.state ?? "unprepared" : undefined, checkedAt: status.checkedAt, execution: { "windows-codex": ready, "linux-claude": false }, claudeAdmission: "no-account" };
}
export async function spaceFiles(agent: string, id: string, offset: number, limit: number, path?: string) {
  const space = await projectSpace(agent, id), files = await inventory(space, space.windows!);
  if (path !== undefined) {
    if (!selected(space, path)) throw new Error("File outside the registered project scope");
    const found = files.find(f => f.path === path);
    if (!found || found.size > 1024 * 1024) throw new Error("File missing or too large for text reading");
    const data = await readFile(await safeFile(space.windows!, path));
    if (data.length !== found.size || sha256(data) !== found.sha256) throw new Error("Project snapshot changed; read the file list again");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw new Error("Use an executor for binary project files");
    const characters = Array.from(text);
    return { project: id, path, snapshot: version(files), sha256: found.sha256, text: characters.slice(offset, offset + limit).join(""), nextOffset: offset + limit < characters.length ? offset + limit : undefined };
  }
  return { project: id, snapshot: version(files), files: files.slice(offset, offset + Math.min(limit, 100)), nextOffset: offset + Math.min(limit, 100) < files.length ? offset + Math.min(limit, 100) : undefined };
}
