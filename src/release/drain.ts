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
class DrainFailure extends Error {
  constructor(readonly agent: string, readonly reason: string, readonly retryable = false) { super(reason); }
}
const recoveryBudgetMs = 120_000;
async function healthState(target: Target): Promise<DeploymentState | undefined> {
  const started = performance.now();
  let attempts = 0;
  for (;;) {
    try {
      const response = await fetch(`${target.url}/healthz`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
      if (!response.ok) throw new DrainFailure(target.id, `health-status-${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new DrainFailure(target.id, "health-invalid-body");
      if (attempts) console.info(`DEPLOY_DRAIN_RECOVERED agent=${target.id} attempts=${attempts} elapsedMs=${Math.round(performance.now() - started)}`);
      return (body as { deployment?: DeploymentState }).deployment;
    } catch (error) {
      const failure = error instanceof DrainFailure ? error
        : new DrainFailure(target.id, error instanceof SyntaxError ? "health-invalid-json"
          : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "health-timeout" : "health-unreachable", !(error instanceof SyntaxError));
      if (!failure.retryable || performance.now() - started >= recoveryBudgetMs) throw failure;
      attempts++;
      console.info(`DEPLOY_DRAIN_PROBE agent=${target.id} reason=${failure.reason} attempt=${attempts} retrying=true`);
      await delay(2_000);
    }
  }
}
function idle(state: DeploymentState): boolean {
  const counts = [state.activeRequests, state.activeConversations, state.activeBackgroundTasks, state.queuedMessages ?? 0];
  if (counts.some(count => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new Error("activity-invalid");
  return counts.every(count => count === 0) && state.idle !== false;
}
const [manifestPath, mode, ...agents] = process.argv.slice(2);
const targets: Target[] = [];
let stage = "configuration";
async function release(strict = false): Promise<void> {
  const results = await Promise.allSettled(targets.filter(target => target.protocol).map(async target => {
    try {
      const response = await fetch(`${target.url}/_deployment/drain`, { method: "DELETE", signal: AbortSignal.timeout(5_000), redirect: "error" });
      if (!response.ok) throw new DrainFailure(target.id, `release-status-${response.status}`);
    } catch (error) { throw error instanceof DrainFailure ? error : new DrainFailure(target.id, "release-unreachable"); }
  }));
  const failure = results.find(result => result.status === "rejected");
  if (strict && failure?.status === "rejected") throw failure.reason;
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
  // First deployment of direct routing still drains the pre-migration release
  // on its backend port. After migration, the manifest itself is authoritative;
  // retained gateway metadata no longer matches its public-facing port.
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
  if (mode === "release") { stage = "release"; await release(true); }
  else {
    stage = "health";
    for (const target of targets) {
      const state = await healthState(target);
      target.protocol = state?.protocol === 1;
      // A legacy idle observation cannot protect work arriving during promotion.
      if (!target.protocol) throw new DrainFailure(target.id, "protocol-required");
      console.info(`DEPLOY_DRAIN agent=${target.id} protocol=${target.protocol ? "lease" : "legacy-readonly"}`);
    }
    // The owning release/maintenance workflow bounds this passive wait. Busy
    // conversations remain available instead of failing promotion after 15 min.
    let previous = "";
    let sealFailureStarted: number | undefined;
    for (;;) {
      stage = "observe";
      const states = await Promise.all(targets.map(async target => {
        if (!target.protocol) return { agent: target.id, ready: legacyActive(target) === 0 };
        // Observe every Agent before sealing any of them. An idle Agent must
        // keep serving new conversations while another Agent remains busy.
        const state = await healthState(target);
        if (state?.protocol !== 1) throw new DrainFailure(target.id, "protocol-changed");
        let ready: boolean;
        try { ready = idle(state); } catch { throw new DrainFailure(target.id, "activity-invalid"); }
        return { agent: target.id, ready, activeRequests: state.activeRequests, activeConversations: state.activeConversations,
          activeBackgroundTasks: state.activeBackgroundTasks, queuedMessages: state.queuedMessages ?? 0 };
      }));
      const summary = JSON.stringify(states);
      if (summary !== previous) { console.info(`DEPLOY_DRAIN_STATE ${summary}`); previous = summary; }
      if (states.every(state => state.ready)) {
        stage = "seal";
        const sealed = await Promise.allSettled(targets.map(async target => {
          if (!target.protocol) return legacyActive(target) === 0;
          try {
            const response = await fetch(`${target.url}/_deployment/drain`, { method: "POST", signal: AbortSignal.timeout(5_000), redirect: "error" });
            if (!response.ok) throw new DrainFailure(target.id, `seal-status-${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500);
            const state = await response.json() as DeploymentState | null;
            if (!state || state.protocol !== 1 || typeof state.ready !== "boolean" || typeof state.draining !== "boolean") throw new DrainFailure(target.id, "seal-invalid");
            return state.draining && state.ready;
          } catch (error) { throw error instanceof DrainFailure ? error : new DrainFailure(target.id, error instanceof SyntaxError ? "seal-invalid-json" : "seal-unreachable", !(error instanceof SyntaxError)); }
        }));
        if (sealed.every(result => result.status === "fulfilled" && result.value)) break;
        // A request can arrive between observation and sealing. Reopen all
        // Agents immediately and let that work finish before trying again.
        stage = "reopen";
        await release(true);
        const failures = sealed.filter(result => result.status === "rejected").map(result => result.reason as unknown);
        if (failures.length) {
          stage = "seal";
          sealFailureStarted ??= performance.now();
          const fatal = failures.find(error => !(error instanceof DrainFailure) || !error.retryable);
          if (fatal || performance.now() - sealFailureStarted >= recoveryBudgetMs) throw fatal ?? failures[0];
          // Reopen every Agent before another observation or POST attempt.
          for (const error of failures) if (error instanceof DrainFailure)
            console.info(`DEPLOY_DRAIN_SEAL_RETRY agent=${error.agent} reason=${error.reason} reopened=true`);
        } else { sealFailureStarted = undefined; }
      } else { sealFailureStarted = undefined; }
      await delay(2_000);
    }
  }
} catch (error) {
  await release();
  // The denial code is fixed-vocabulary only; never a response body or content.
  const reason = error instanceof DrainFailure ? error.reason : "drain-operation";
  console.error(`DEPLOY_DRAIN_FAILED stage=${stage} agent=${error instanceof DrainFailure ? error.agent : "unknown"} reason=${reason}: existing conversations were not stopped; current release retained.`);
  process.exitCode = 1;
}
