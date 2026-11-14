import { createHash } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PluginManifest, PluginDefinition, PluginSnapshot } from "./contracts.js";
import { PluginHost, type SwitchResult } from "./host.js";
import type { WebAssetRecord, WebAssetReleases } from "../web/asset-releases.js";

export type ComponentRecord = PluginManifest & { sha256: string; entry: "index.mjs" };
export type ComponentRelease = { protocol: 1; sourceCommit: string; hostFingerprint: string; components: ComponentRecord[]; web?: WebAssetRecord };
export const componentOwners = { schedule: ["schedule"], browser: ["browser"], documents: ["documents"],
  health: ["health_data", "health_tasks"], location: ["user_location"], "model-http": [], "model-codex": [], "model-cursor": [], "model-antigravity": [], "model-catalog": [], recordings: [], "skill-resources": [] } as const;
export const componentResources = { schedule: ["scheduleStore", "notifications", "scheduler", "scheduleConnection"],
  browser: ["browser"], documents: ["documents", "confirmedOperation"], health: ["health", "healthTasks", "location"], location: ["location"], "model-http": [], "model-codex": [], "model-cursor": [], "model-antigravity": [], "model-catalog": ["modelCatalogBinding", "bootstrapModelCatalog"], recordings: ["recordingConnection"], "skill-resources": [] };
export const componentRoutes = { schedule: ["api/schedule"] };

/** The release program installs directories; the Agent can activate only verified installed code. */
export class PluginInstallation {
  readonly root?: string;
  readonly bundled: string;
  readonly hostFingerprint: string;
  private candidate?: ComponentRecord[];
  private active: ComponentRecord[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private maintenance?: Promise<void>;
  private closed = false;
  private pointerPending = false;
  private last?: SwitchResult;
  private assets?: WebAssetReleases;
  private web?: WebAssetRecord;
  private candidateWeb?: WebAssetRecord;
  private preparation?: { totalMs: number; readyMs: number; preparedAt: string };
  private readonly definitions = new Map<string, PluginDefinition>();
  private constructor(readonly host: PluginHost, readonly agentId: string, readonly release: ComponentRelease, bundled: string, root?: string) {
    this.bundled = bundled; this.root = root; this.hostFingerprint = release.hostFingerprint; this.web = release.web;
  }
  static async open(host: PluginHost, agentId: string, enabled: readonly string[], options: { bundled?: string; root?: string } = {}): Promise<PluginInstallation> {
    const bundled = options.bundled ?? fileURLToPath(new URL("../../components/", import.meta.url));
    const release = JSON.parse(await readFile(join(bundled, "release.json"), "utf8")) as ComponentRelease;
    if (release.protocol !== 1 || !/^[a-f0-9]{64}$/.test(release.hostFingerprint)) throw new Error("COMPONENT_RELEASE_INVALID");
    const root = options.root ?? (process.env.AGENTS_CONFIG_PATH ? join(dirname(resolve(process.env.AGENTS_CONFIG_PATH)), "components") : undefined);
    const installation = new PluginInstallation(host, agentId, release, bundled, root);
    let selected = release.components.filter(record => enabled.includes(record.id));
    if (root) {
      try {
        const saved = JSON.parse(await readFile(installation.pointerPath(), "utf8"));
        if (saved.hostFingerprint === release.hostFingerprint) { selected = saved.components.filter((r: ComponentRecord) => enabled.includes(r.id)); installation.web = saved.web ?? release.web; }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (selected.length) { await installation.prepare(selected); await installation.activate(); }
    installation.maintenanceTimer = setInterval(() => { void installation.maintain().catch(() => {
      console.warn("Component retirement maintenance needs retry");
    }); }, 30000);
    installation.maintenanceTimer.unref();
    return installation;
  }
  private pointerPath(): string { return join(this.root!, "active", this.hostFingerprint, `${this.agentId}.json`); }
  private async definition(record: ComponentRecord): Promise<PluginDefinition> {
    if (!Object.hasOwn(componentOwners, record.id) || !/^[a-f0-9]{16,64}$/.test(record.version)
      || record.entry !== "index.mjs" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("COMPONENT_NOT_AUTHORIZED");
    let directory = join(this.bundled, record.id, record.version);
    if (!this.release.components.some(b => b.id === record.id && b.version === record.version)) {
      if (!this.root) throw new Error("COMPONENT_INSTALLATION_UNAVAILABLE");
      directory = join(this.root, "installed", record.id, record.version);
    }
    const path = join(directory, record.entry), bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== record.sha256 || record.version !== record.sha256) throw new Error("COMPONENT_INTEGRITY_FAILED");
    const metadata = JSON.parse(await readFile(join(directory, "component.json"), "utf8"));
    if (JSON.stringify(metadata) !== JSON.stringify(record)) throw new Error("COMPONENT_METADATA_MISMATCH");
    const key = `${record.id}:${record.version}`;
    let definition = this.definitions.get(key);
    if (!definition) {
      const module = await import(pathToFileURL(path).href);
      if (typeof module.create !== "function") throw new Error("COMPONENT_ENTRY_INVALID");
      definition = { manifest: record, create: module.create }; this.definitions.set(key, definition);
    }
    return definition;
  }
  async attachAssets(assets: WebAssetReleases): Promise<void> {
    if (!this.web) throw new Error("WEB_ASSET_RELEASE_MISSING");
    await assets.initialize(this.web); this.assets = assets;
  }
  snapshot(toolNames?: readonly string[]): PluginSnapshot { return this.host.snapshot(toolNames); }
  async snapshotVersions(versions: Readonly<Record<string, string>>): Promise<PluginSnapshot> {
    if (Object.entries(versions).every(([id, version]) => this.active.some(record => record.id === id && record.version === version))) return this.host.snapshot(undefined, Object.keys(versions));
    const definitions: PluginDefinition[] = [];
    for (const [id, version] of Object.entries(versions)) {
      if (!Object.hasOwn(componentOwners, id) || !/^[a-f0-9]{64}$/.test(version)) throw new Error("COMPONENT_RESTORE_INVALID");
      const bundled = this.release.components.find(record => record.id === id && record.version === version);
      if (bundled) definitions.push(await this.definition(bundled));
      else {
        if (!this.root) throw new Error("COMPONENT_RESTORE_UNAVAILABLE");
        const record = JSON.parse(await readFile(join(this.root, "installed", id, version, "component.json"), "utf8")) as ComponentRecord;
        definitions.push(await this.definition(record));
      }
    }
    const restored = await this.host.passiveSnapshot(definitions);
    const placeholders = this.host.snapshot([], []);
    const tools = new Map(placeholders.tools.map(tool => [tool.definition.name, tool]));
    for (const tool of restored.tools) tools.set(tool.definition.name, tool);
    return { ...restored, tools: [...tools.values()], release: () => { restored.release(); placeholders.release(); } };
  }
  async prepare(records: ComponentRecord[], web?: WebAssetRecord): Promise<SwitchResult> {
    if (this.candidate) throw new Error("COMPONENT_UPDATE_BUSY");
    if (!Array.isArray(records) || !records.length && !web) throw new Error("COMPONENT_UPDATE_EMPTY");
    const started = performance.now();
    const definitions = [];
    for (const record of records) definitions.push(await this.definition(record));
    if (web) {
      if (!this.assets) throw new Error("WEB_ASSET_HOST_UNAVAILABLE");
      await this.assets.prepare(web);
    }
    try { this.last = definitions.length ? await this.host.prepare(definitions)
      : { state: "prepared", versions: {}, preparedMs: performance.now() - started }; }
    catch (error) { this.assets?.discard(); throw error; }
    this.preparation = { totalMs: performance.now() - started, readyMs: definitions.length ? this.last.preparedMs : 0, preparedAt: new Date().toISOString() };
    this.last = { ...this.last, preparedMs: this.preparation.totalMs, lifecycleReadyMs: this.preparation.readyMs, preparedAt: this.preparation.preparedAt };
    this.candidate = records; this.candidateWeb = web;
    return this.last;
  }
  async activate(): Promise<SwitchResult> {
    if (!this.candidate) throw new Error("COMPONENT_NO_CANDIDATE");
    this.last = this.candidate.length ? await this.host.activate()
      : { ...this.last!, state: "active", pauseMs: 0, effectiveAt: new Date().toISOString() };
    if (this.preparation) this.last = { ...this.last, preparedMs: this.preparation.totalMs, lifecycleReadyMs: this.preparation.readyMs, preparedAt: this.preparation.preparedAt };
    if (this.last.state === "deferred") {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.activate().catch(() => { console.warn("Component activation needs retry"); }); }, 1000);
      this.timer.unref(); return this.last;
    }
    this.pointerPending = true;
    const selected = new Map(this.active.map(record => [record.id, record]));
    if (this.candidateWeb) {
      const switching = performance.now();
      this.assets!.activate(); this.web = this.candidateWeb; this.candidateWeb = undefined;
      this.last.pauseMs = (this.last.pauseMs ?? 0) + performance.now() - switching;
      this.last.effectiveAt = new Date().toISOString();
    }
    for (const record of this.candidate) selected.set(record.id, record);
    this.active = [...selected.values()]; this.candidate = undefined; this.preparation = undefined;
    try {
      if (this.root) {
        const target = this.pointerPath(); await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ hostFingerprint: this.hostFingerprint, components: this.active, web: this.web }) + "\n", { mode: 0o600 });
        await rename(temporary, target);
      }
    } catch (error) {
      this.last = { ...this.last, state: "failed", reason: "active_pointer_failed" };
      throw error;
    } finally { this.pointerPending = false; }
    // Reclamation and its durable ledger continue after the release lock is freed.
    void this.maintain().catch(() => { console.warn("Component retirement ledger needs retry"); });
    return this.last;
  }
  private maintain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.maintenance ??= this.writeMaintenance().finally(() => { this.maintenance = undefined; });
  }
  private async writeMaintenance(): Promise<void> {
    this.host.maintainRetired();
    if (!this.root) return;
    const target = join(this.root, "maintenance", `${this.agentId}.json`);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    const plugins = this.host.status().plugins.filter(plugin => ["retiring", "cleaning", "cleanup_failed"].includes(plugin.state));
    await writeFile(temporary, JSON.stringify({ protocol: 1, agent: this.agentId, hostFingerprint: this.hostFingerprint,
      checkedAt: new Date().toISOString(), state: plugins.length ? "pending" : "complete", plugins }) + "\n", { mode: 0o600 });
    await rename(temporary, target);
  }
  status() { return { ...this.host.status(), hostSourceCommit: this.release.sourceCommit, hostFingerprint: this.hostFingerprint, active: this.active, candidate: this.candidate, activation: this.last, persistence: this.pointerPending ? "pending" : "committed", web: this.web }; }
  async discard(): Promise<void> { clearTimeout(this.timer); await this.host.discard(); this.assets?.discard(); this.candidate = undefined; this.candidateWeb = undefined; this.preparation = undefined; }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); clearInterval(this.maintenanceTimer);
    await this.maintenance; await this.host.close();
  }
}
