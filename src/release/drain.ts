import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Host release procedure only. Never exports conversation text or credentials.
type Target = { id: string; url: string; storage: string; protocol: boolean };
type DeploymentState = {
  protocol?: number; ready?: boolean; draining?: boolean; idle?: boolean;
  activeRequests?: number; activeConversations?: number; activeBackgroundTasks?: number; queuedMessages?: number;
};
async function healthState(target: Target): Promise<DeploymentState | undefined> {
  const response = await fetch(`${target.url}/healthz`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("health");
  return (await response.json() as { deployment?: DeploymentState }).deployment;
}
function idle(state: DeploymentState): boolean {
  const counts = [state.activeRequests, state.activeConversations, state.activeBackgroundTasks, state.queuedMessages ?? 0];
  if (counts.some(count => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new Error("activity");
  return counts.every(count => count === 0) && state.idle !== false;
}
const [manifestPath, mode, ...agents] = process.argv.slice(2);
const targets: Target[] = [];
async function release(strict = false): Promise<void> {
  const results = await Promise.allSettled(targets.filter(target => target.protocol).map(async target => {
    const response = await fetch(`${target.url}/_deployment/drain`, { method: "DELETE", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("release");
  }));
  if (strict && results.some(result => result.status === "rejected")) throw new Error("release");
}
function legacyActive(target: Target): number {
  const db = new DatabaseSync(target.storage, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const deleted = db.prepare("PRAGMA table_info(web_messages)").all().some(column => column.name === "deleted_at");
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM web_messages
      WHERE json_extract(payload,'$.snapshot.status')='running'${deleted ? " AND deleted_at IS NULL" : ""}`).get()!.n);
  } finally { db.close(); }
}
try {
  if (!manifestPath || !["wait", "release"].includes(mode ?? "")) throw new Error("arguments");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // The recovery gateway retains the incoming Host header. Host-maintenance
  // requests must reach its configured backend directly, never weaken the
  // server's loopback Host/Origin checks to accommodate a proxy.
  let gateway: { listenPort: number; backendPort: number; basePath: string } | undefined;
  try { gateway = JSON.parse(await readFile(join(dirname(manifestPath), "recovery/control/config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const id of agents) {
    const profile = manifest.agents.find((value: { id: string }) => value.id === id);
    if (!profile?.web || !Number.isInteger(profile.web.listenPort)) throw new Error("profile");
    const port = gateway?.listenPort === profile.web.listenPort && gateway?.basePath === new URL(profile.web.publicUrl).pathname
      ? gateway.backendPort : profile.web.listenPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port");
    targets.push({ id, url: `http://127.0.0.1:${port}`, storage: profile.web.storage, protocol: mode === "release" });
  }
  if (mode === "release") await release(true);
  else {
    for (const target of targets) {
      const state = await healthState(target);
      target.protocol = state?.protocol === 1;
      console.info(`DEPLOY_DRAIN agent=${target.id} protocol=${target.protocol ? "lease" : "legacy-readonly"}`);
    }
    // The owning release/maintenance workflow bounds this passive wait. Busy
    // conversations remain available instead of failing promotion after 15 min.
    let previous = "";
    for (;;) {
      const states = await Promise.all(targets.map(async target => {
        if (!target.protocol) return { agent: target.id, ready: legacyActive(target) === 0 };
        // Observe every Agent before sealing any of them. An idle Agent must
        // keep serving new conversations while another Agent remains busy.
        const state = await healthState(target);
        if (state?.protocol !== 1) throw new Error("protocol");
        return { agent: target.id, ready: idle(state) };
      }));
      const summary = JSON.stringify(states);
      if (summary !== previous) { console.info(`DEPLOY_DRAIN_STATE ${summary}`); previous = summary; }
      if (states.every(state => state.ready)) {
        const sealed = await Promise.allSettled(targets.map(async target => {
          if (!target.protocol) return legacyActive(target) === 0;
          const response = await fetch(`${target.url}/_deployment/drain`, { method: "POST", signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error("drain");
          const state = await response.json() as DeploymentState;
          if (state.protocol !== 1 || typeof state.ready !== "boolean" || typeof state.draining !== "boolean") throw new Error("protocol");
          return state.draining && state.ready;
        }));
        if (sealed.every(result => result.status === "fulfilled" && result.value)) break;
        // A request can arrive between observation and sealing. Reopen all
        // Agents immediately and let that work finish before trying again.
        await release(true);
        if (sealed.some(result => result.status === "rejected")) throw new Error("seal");
      }
      await delay(2_000);
    }
  }
} catch {
  await release();
  console.error("DEPLOY_DRAIN_FAILED: existing conversations were not stopped; retry the release after they finish.");
  process.exitCode = 1;
}
