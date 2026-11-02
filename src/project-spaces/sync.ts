import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { inventory, relativePath, selected, sha256, spaces, version, type ProjectSpace } from "./policy.js";

export const hostRoot = "F:/zigent-project-spaces";
export const unison = "F:/zigent-claude-workspace-tools/unison-2.54.0-windows-x86_64/bin/unison.exe";
export const ssh = "C:/Program Files/Git/usr/bin/ssh.exe";
export async function command(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
    let output = "", size = 0;
    child.stderr.resume(); child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    const timer = setTimeout(() => { child.kill(); reject(new Error("Host operation timed out")); }, options.timeout ?? 30000);
    child.once("error", e => { clearTimeout(timer); reject(e); });
    child.stdout.on("data", (chunk: string) => { size += Buffer.byteLength(chunk); if (size > 4 * 1024 * 1024) { child.kill(); clearTimeout(timer); reject(new Error("Host output limit")); } else output += chunk; });
    child.once("close", code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout: output }); });
    child.stdin.end(options.input);
  });
}
export async function linuxStatus(space: ProjectSpace) {
  const identity = `/f/zigent-project-spaces/secrets/zt-${space.agent}`;
  const result = await command(ssh, ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ConnectTimeout=8", "-o", "UserKnownHostsFile=/f/zigent-claude-vm/known_hosts",
    "-i", identity, "-p", "22361", `zt-${space.agent}@127.0.0.1`], { input: JSON.stringify({ version: 1, op: "status", project: space.id }) + "\n", timeout: 45000 });
  if (result.code) throw new Error("Linux executor transport unavailable");
  const resultSchema = z.object({ version: z.literal(1), agent: z.literal(space.agent), executor: z.literal("linux-claude"), admission: z.literal("no-account"), available: z.literal(false),
    files: z.array(z.object({ path: relativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().nonnegative() }).strict()).max(10000) });
  return resultSchema.parse(JSON.parse(result.stdout));
}
export type SyncStatus = { project: string; agent: string; state: "synchronized" | "conflict" | "unavailable"; checkedAt: number; inputVersion?: string; reason?: string;
  scopeVersion?: string; reconciledAt?: number; verification?: "reconciled" | "unchanged" };
export async function syncProject(space: ProjectSpace, registry: string): Promise<SyncStatus> {
  if (process.platform !== "win32") throw new Error("Windows is the sync coordinator");
  const state = join(hostRoot, "sync", space.agent, space.id);
  await mkdir(join(state, "backups"), { recursive: true });
  const statusFile = join(state, "status.json");
  let status: SyncStatus;
  try {
    if (sha256(await readFile(unison)) !== "35c50719aba21b57ab6a0110a4038c9d5c019eea24d7f024af59f1e4d6c1059d") throw new Error("Unison executable verification failed");
    const local = await inventory(space, space.windows!), remote = await linuxStatus(space);
    const inputVersion = version(local), scopeVersion = sha256(JSON.stringify(space));
    let prior: Partial<SyncStatus> = {};
    try { prior = JSON.parse(await readFile(statusFile, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    // Both inventories still hash current file contents on every round. Reuse
    // Unison's established baseline only for the same scope and exact content;
    // reconcile again hourly even when idle. A scope change or failure always
    // takes the full path, preserving initial baselines, deletions and conflicts.
    const age = Date.now() - (prior.reconciledAt ?? 0);
    const unchanged = prior.state === "synchronized" && prior.scopeVersion === scopeVersion && prior.inputVersion === inputVersion
      && inputVersion === version(remote.files) && age >= 0 && age < 3600000;
    let previous: string[] = [];
    try { previous = z.array(relativePath).max(30000).parse(JSON.parse(await readFile(join(state, "paths.json"), "utf8"))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const paths = [...new Set([...local, ...remote.files].map(f => f.path).concat(previous))].filter(p => selected(space, p));
    if (paths.length > 30000) throw new Error("Sync path history limit; archive review required");
    if (paths.length !== previous.length || paths.some((path, index) => path !== previous[index]))
      await writeFile(join(state, "paths.json"), JSON.stringify(paths));
    if (!unchanged && paths.length) {
      const root = space.id === "workspace" ? "/shared" : `/shared/${space.id}`;
      const key = `/f/zigent-project-spaces/secrets/zs-${space.agent}`;
      const prefs = [`root = ${space.windows}`, `root = ssh://zs-${space.agent}@127.0.0.1:22361/${root}`, "servercmd = unison", `sshcmd = ${ssh}`,
        `sshargs = -F /dev/null -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ConnectTimeout=8 -o UserKnownHostsFile=/f/zigent-claude-vm/known_hosts -i ${key}`,
        "batch = true", "auto = true", "times = false", "fastcheck = false", "perms = 0", "dontchmod = true", "owner = false", "group = false", "acl = false", "xattrs = false", "links = false",
        // Each path is a validated regular file, never a directory or sync root.
        // Unison's root-empty guard otherwise blocks every single-file deletion.
        "confirmbigdel = false", "backup = Name *", "backuplocation = central", "maxbackups = 10", "log = false", ...paths.map(p => "path = " + p)];
      await writeFile(join(state, "project.prf"), prefs.join("\n") + "\n");
      const result = await command(unison, ["project", "-ui", "text", "-color", "false", "-dumbtty"], { env: { ...process.env, UNISON: state, UNISONBACKUPDIR: join(state, "backups") }, timeout: 190000 });
      if (result.code) throw new Error(result.code === 1 ? "SYNC_CONFLICT" : "Linux file synchronization unavailable");
    }
    const after = unchanged ? local : await inventory(space, space.windows!), check = unchanged ? remote : await linuxStatus(space);
    if (version(after) !== version(check.files)) throw new Error("SYNC_CONFLICT");
    status = { project: space.id, agent: space.agent, state: "synchronized", checkedAt: Date.now(), inputVersion: version(after), scopeVersion,
      reconciledAt: unchanged ? prior.reconciledAt : Date.now(), verification: unchanged ? "unchanged" : "reconciled" };
  } catch (error) { status = { project: space.id, agent: space.agent, state: error instanceof Error && error.message === "SYNC_CONFLICT" ? "conflict" : "unavailable", checkedAt: Date.now(), reason: error instanceof Error ? error.message : "Sync unavailable" }; }
  await writeFile(statusFile + ".next", JSON.stringify(status)); await rename(statusFile + ".next", statusFile);
  return status;
}
export async function syncAll(agent: string, registry: string) {
  const result: SyncStatus[] = [];
  for (const space of (await spaces(agent, registry)).filter(s => s.linux)) result.push(await syncProject(space, registry));
  return result;
}
