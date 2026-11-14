import { CodePointText } from "../text/code-points.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { forbidden, inventory, safeFile, selected, sha256, spaces, version, type ProjectSpace } from "./policy.js";
import { hostRoot } from "./paths.js";

export async function projectSpace(agent: string, id: string) {
  const space = (await spaces(agent)).find(s => s.id === id);
  if (!space || process.platform !== "win32") throw new Error("Project space is unavailable on this host");
  return space;
}
export function syncDescription(space: Pick<ProjectSpace, "mac" | "sync">) {
  const manual = space.sync?.mode === "manual";
  return {
    direction: manual ? "on_request" : "bidirectional",
    macWindows: space.mac ? manual
      ? { transport: "ssh", scheduling: "manual" }
      : { transport: "syncthing", scheduling: "continuous", watcherDelaySeconds: 2, fallbackScanSeconds: 600 } : undefined,
    offline: manual ? "next_manual_sync" : "catch_up_on_reconnect", conflicts: "preserve_both", dailySnapshot: false
  };
}
export async function spaceReadiness(agent: string, id: string) {
  const space = await projectSpace(agent, id);
  const files = await inventory(space, space.windows!, false);
  const continuous = Boolean(space.mac && space.sync?.mode !== "manual");
  let macReady = !continuous;
  if (continuous) {
    try {
      const control = space.sync?.mode === "continuous" ? space.sync : undefined;
      const folder = `zigent-${space.agent}-${space.id}`;
      const query = "folder=" + encodeURIComponent(folder);
      const xml = await readFile(join(hostRoot, control ? `sync/${control.instance}/state/config.xml` : "syncthing/state/config.xml"), "utf8");
      const key = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
      if (!key) throw new Error("Missing sync control identity");
      const api = async (path: string) => {
        const r = await fetch(`http://127.0.0.1:${control?.port ?? 18385}/rest/` + path, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error("Mac sync control unavailable"); return r.json() as Promise<Record<string, unknown>>;
      };
      const [state, connections, configured, system] = await Promise.all([api("db/status?" + query), api("system/connections"),
        api("config/folders/" + encodeURIComponent(folder)), api("system/status")]);
      const peers = ((configured.devices ?? []) as Array<{ deviceID: string }>).filter(d => d.deviceID !== system.myID);
      const peer = peers.length === 1 ? peers[0]!.deviceID : undefined;
      const completion = peer ? await api("db/completion?" + query + "&device=" + encodeURIComponent(peer)) : {};
      macReady = String(configured.path).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase() === space.windows!.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()
        && configured.type === "sendreceive" && configured.paused === false && state.state === "idle"
        && Number(state.needTotalItems ?? 1) === 0 && Number(state.pullErrors ?? 0) === 0 && Number(completion.completion ?? 0) === 100
        && Boolean(peer && ((connections.connections ?? {}) as Record<string, { connected?: boolean }>)[peer]?.connected);
      // Conflict files must be resolved explicitly, even when transfer is idle.
      if (files.some(f => /\.sync-conflict-/.test(f.path))) macReady = false;
    } catch { macReady = false; }
  }
  const current = await inventory(space, space.windows!, false);
  async function hasConflict(root: string, prefix = ""): Promise<boolean> {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (/\.sync-conflict-/.test(item.name) && selected(space, path.replace(/\.sync-conflict-[^.]+(?=\.|$)/, ""))) return true;
      if (item.isDirectory() && !forbidden(path) && await hasConflict(join(root, item.name), path + "/")) return true;
    }
    return false;
  }
  const conflict = await hasConflict(space.windows!);
  if (conflict) macReady = false;
  // Execution uses the live Windows directory and its Mac synchronization only.
  // Preserve conflicts, transfer gates, and the exact local baseline.
  const unchanged = version(files) === version(current);
  const blockingReason = conflict ? "sync_conflict" : !macReady ? "mac_sync_pending" : !unchanged ? "project_changed" : undefined;
  const ready = !blockingReason;
  return { project: space.id,
    sync: syncDescription(space),
    machines: { mac: space.mac, windows: space.windows },
    resultRoot: ".", executionMode: "project", state: conflict ? "conflict" : ready ? "ready" : "syncing", inputVersion: version(files), macReady: continuous ? macReady : undefined,
    blockingReason,
    checkedAt: Date.now(), execution: { "windows-codex": ready } };
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
    const characters = new CodePointText(text);
    return { project: id, path, snapshot: version(files), sha256: found.sha256, text: characters.slice(offset, offset + limit), nextOffset: offset + limit < characters.length ? offset + limit : undefined };
  }
  return { project: id, snapshot: version(files), files: files.slice(offset, offset + Math.min(limit, 100)), nextOffset: offset + Math.min(limit, 100) < files.length ? offset + Math.min(limit, 100) : undefined };
}
