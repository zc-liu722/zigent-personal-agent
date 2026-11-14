import { Context, type Fiber } from "cordis";
import type { AgentToolRegistration, ToolExecutionContext } from "../tools/tool-contracts.js";
import type { PluginDefinition, PluginInstance, PluginManifest, PluginSnapshot } from "./contracts.js";

type Generation = {
  manifest: PluginManifest; instance: PluginInstance; fiber: Fiber;
  context: Context; dispose: () => Promise<void>; disposed: () => boolean;
  leases: number; calls: number; state: "prepared" | "active" | "retiring" | "cleaning" | "retired" | "cleanup_failed";
  cleanupAttempts?: number; cleanupRetryAt?: number;
  preparedMs: number; activatedAt?: string; retiredAt?: string;
};
export type SwitchResult = { state: "prepared" | "deferred" | "active" | "failed"; versions: Record<string, string>;
  preparedMs: number; lifecycleReadyMs?: number; preparedAt?: string; pauseMs?: number; effectiveAt?: string; reason?: string };

/** Cordis owns dependency/effect lifetimes. Zigent owns business safe points and routing. */
export class PluginHost {
  private readonly active = new Map<string, Generation>();
  private readonly history: Generation[] = [];
  private pending?: { context: Context; generations: Generation[]; result: SwitchResult };
  private mutation: Promise<unknown> = Promise.resolve();
  private closing = false;
  private last?: SwitchResult;
  constructor(private readonly borrowed: Readonly<Record<string, unknown>> = {},
    private readonly toolOwners: Readonly<Record<string, readonly string[]>> = {},
    private readonly resourceOwners?: Readonly<Record<string, readonly string[]>>,
    private readonly routeOwners: Readonly<Record<string, readonly string[]>> = {}) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.mutation.then(work);
    this.mutation = task.catch(() => {});
    return task;
  }
  status() {
    return { protocol: 1, last: this.last, pending: this.pending?.result,
      plugins: [...this.history].map(g => ({ ...g.manifest, state: g.state, leases: g.leases,
        activeCalls: g.calls, activeBackgroundWork: g.instance.activeWork?.() ?? 0, preparedMs: g.preparedMs,
        activatedAt: g.activatedAt, retiredAt: g.retiredAt, cleanupAttempts: g.cleanupAttempts, cleanupRetryAt: g.cleanupRetryAt })) };
  }
  private ordered(definitions: readonly PluginDefinition[]): PluginDefinition[] {
    const byId = new Map(definitions.map(d => [d.manifest.id, d]));
    if (byId.size !== definitions.length || !definitions.length) throw new Error("PLUGIN_GROUP_INVALID");
    const providers = new Map<string, { id: string; api: number }>();
    const manifests = [...this.active.values()].filter(g => !byId.has(g.manifest.id)).map(g => g.manifest)
      .concat(definitions.map(d => d.manifest));
    for (const m of manifests) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(m.id) || !/^[a-f0-9]{16,64}$/.test(m.version)
        || !/^[a-f0-9]{40}$/.test(m.sourceCommit) || m.hostApi !== 1) throw new Error("PLUGIN_MANIFEST_INVALID");
      for (const [name, api] of Object.entries(m.provides)) {
        if (providers.has(name) || !Number.isSafeInteger(api) || api < 1) throw new Error("PLUGIN_SERVICE_INVALID");
        providers.set(name, { id: m.id, api });
      }
    }
    const visiting = new Set<string>(), done = new Set<string>(), result: PluginDefinition[] = [];
    const visit = (m: PluginManifest) => {
      if (done.has(m.id)) return;
      if (visiting.has(m.id)) throw new Error("PLUGIN_DEPENDENCY_CYCLE");
      visiting.add(m.id);
      for (const [name, range] of Object.entries(m.requires)) {
        const provider = providers.get(name);
        if (!provider || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max)
          || range.min > range.max || provider.api < range.min || provider.api > range.max) throw new Error("PLUGIN_DEPENDENCY_INCOMPATIBLE");
        // Consumers carry exact dependency generations; replace them as one group.
        if (!byId.has(m.id) && byId.has(provider.id)) throw new Error("PLUGIN_DEPENDENT_MISSING_FROM_GROUP");
        const dependency = byId.get(provider.id);
        if (dependency) visit(dependency.manifest);
      }
      visiting.delete(m.id); done.add(m.id);
      const definition = byId.get(m.id); if (definition) result.push(definition);
    };
    for (const m of manifests) visit(m);
    return result;
  }
  prepare(definitions: readonly PluginDefinition[]): Promise<SwitchResult> {
    return this.serialize(async () => {
      if (this.closing || this.pending) throw new Error("PLUGIN_UPDATE_BUSY");
      const ordered = this.ordered(definitions), context = new Context();
      // Each candidate graph has its own Cordis service namespace. Old fibers remain alive.
      let scope = context;
      const names = new Set([...this.active.values()].flatMap(g => Object.keys(g.manifest.provides))
        .concat(ordered.flatMap(d => Object.keys(d.manifest.provides))));
      for (const name of names) scope = scope.isolate(name);
      const generations: Generation[] = [], exports: Record<string, unknown> = {};
      for (const g of this.active.values()) if (!ordered.some(d => d.manifest.id === g.manifest.id)) {
        Object.assign(exports, g.instance.services);
        for (const name of Object.keys(g.manifest.provides)) scope.provide(name, g.instance.services?.[name]);
      }
      const started = performance.now();
      try {
        for (const definition of ordered) {
          const before = performance.now();
          let instance: PluginInstance | undefined;
          let disposal: Promise<void> | undefined;
          let disposed = false;
          const dispose = (): Promise<void> => disposal ??= Promise.resolve().then(async () => {
            await instance!.dispose(); disposed = true;
          }).catch(error => {
            disposal = undefined; throw error;
          });
          const fiber = scope.plugin({ name: `${definition.manifest.id}:${definition.manifest.version}`,
            inject: Object.keys(definition.manifest.requires),
            apply: async ctx => {
              const borrowed = this.resourceOwners ? Object.fromEntries((this.resourceOwners[definition.manifest.id] ?? []).map(name => [name, this.borrowed[name]])) : this.borrowed;
              const dependencies = Object.fromEntries(Object.keys(definition.manifest.requires).map(name => [name, exports[name]]));
              instance = await definition.create(Object.freeze({ ...borrowed, ...dependencies, pluginIdentity: Object.freeze({ ...definition.manifest }) }));
              // Register before readiness so partially initialized instances are cleaned on failure.
              ctx.effect(() => dispose);
              await instance.ready();
              for (const name of Object.keys(definition.manifest.provides)) {
                if (!instance.services || !(name in instance.services)) throw new Error("PLUGIN_SERVICE_MISSING");
                ctx.provide(name, instance.services[name]);
              }
            }
          });
          try { await fiber; } catch (error) { await fiber.dispose(); throw error; }
          if (!instance) { await fiber.dispose(); throw new Error("PLUGIN_NOT_READY"); }
          const g: Generation = { manifest: definition.manifest, instance, fiber, context, dispose, disposed: () => disposed, leases: 0, calls: 0, state: "prepared", preparedMs: performance.now() - before };
          generations.push(g);
          Object.assign(exports, instance.services);
        }
        const toolNames = new Set<string>();
        for (const g of generations) for (const route of Object.keys(g.instance.routes ?? {}))
          if (!this.routeOwners[g.manifest.id]?.includes(route)) throw new Error("PLUGIN_ROUTE_NOT_AUTHORIZED");
        for (const g of [...this.active.values()].filter(g => !generations.some(n => n.manifest.id === g.manifest.id)).concat(generations))
          for (const tool of g.instance.tools ?? []) {
            const name = tool.definition.name;
            if (!this.toolOwners[g.manifest.id]?.includes(name) || toolNames.has(name)) throw new Error("PLUGIN_TOOL_NOT_AUTHORIZED");
            toolNames.add(name);
          }
        const result: SwitchResult = { state: "prepared", versions: Object.fromEntries(generations.map(g => [g.manifest.id, g.manifest.version])), preparedMs: performance.now() - started };
        this.pending = { context: scope, generations, result };
        this.history.push(...generations); this.last = result;
        return result;
      } catch (error) {
        await context.fiber.dispose();
        this.last = { state: "failed", versions: {}, preparedMs: performance.now() - started, reason: "preparation_failed" };
        throw error;
      }
    });
  }
  activate(): Promise<SwitchResult> {
    return this.serialize(async () => {
      const pending = this.pending;
      if (!pending) throw new Error("PLUGIN_NO_CANDIDATE");
      const previous = pending.generations.flatMap(g => this.active.get(g.manifest.id) ?? []);
      // Do not pause a busy scheduler or cancel a model request to hurry promotion.
      if (previous.some(g => (g.instance.activeWork?.() ?? 0) > 0)) {
        return this.last = pending.result = { ...pending.result, state: "deferred", reason: "active_background_work" };
      }
      const started = performance.now();
      try {
        for (const g of previous) g.instance.pause?.();
        for (const g of pending.generations) g.instance.start?.();
      } catch (error) {
        for (const g of pending.generations) g.instance.pause?.();
        for (const g of previous) g.instance.resume?.();
        await this.discardPending();
        this.last = { ...pending.result, state: "failed", reason: "activation_failed", pauseMs: performance.now() - started };
        throw error;
      }
      // No await inside the routing transaction: all consumers observe one generation group.
      const effectiveAt = new Date().toISOString();
      for (const g of previous) g.state = "retiring";
      for (const g of pending.generations) { g.state = "active"; g.activatedAt = effectiveAt; this.active.set(g.manifest.id, g); }
      this.pending = undefined;
      this.last = { ...pending.result, state: "active", effectiveAt, pauseMs: performance.now() - started, reason: undefined };
      for (const g of previous.reverse()) void this.retire(g);
      return this.last;
    });
  }
  private async retire(g: Generation): Promise<void> {
    if (g.state !== "retiring" || g.leases || g.calls || (g.instance.activeWork?.() ?? 0)) return;
    // Serialize duplicate final lease releases without hiding cleanup failure.
    g.state = "cleaning";
    g.cleanupAttempts = (g.cleanupAttempts ?? 0) + 1;
    g.cleanupRetryAt = undefined;
    try {
      // Cordis owns dependency teardown order, but logs effect failures internally.
      // Retry our failed disposer explicitly only after its original fiber teardown.
      if (g.cleanupAttempts > 1) await g.dispose();
      await g.fiber.dispose();
      if (!g.disposed()) throw new Error("PLUGIN_DISPOSAL_FAILED");
      g.state = "retired"; g.retiredAt = new Date().toISOString();
      if (this.history.filter(other => other.context === g.context).every(other => other.state === "retired")) await g.context.fiber.dispose();
    }
    catch { g.state = "cleanup_failed"; g.cleanupRetryAt = Date.now() + 60000; console.warn("Plugin cleanup requires attention", g.manifest.id, g.manifest.version); }
  }
  /** Independent reclamation never changes which generation owns new work. */
  maintainRetired(): void {
    if (this.closing) return;
    for (const g of [...this.history].reverse()) {
      if (g.state === "cleanup_failed" && (g.cleanupRetryAt ?? 0) <= Date.now()) g.state = "retiring";
      if (g.state === "retiring") void this.retire(g);
    }
  }
  snapshot(toolNames?: readonly string[], ids?: readonly string[]): PluginSnapshot {
    const all = [...this.active.values()];
    const selected = new Set(all.filter(g => ids ? ids.includes(g.manifest.id) : !toolNames || g.instance.pinForTurn
      || g.instance.tools?.some(tool => tool.available !== false && toolNames.includes(tool.definition.name))));
    const includeDependencies = (g: Generation) => {
      for (const name of Object.keys(g.manifest.requires)) {
        const dependency = all.find(candidate => name in candidate.manifest.provides);
        if (dependency && !selected.has(dependency)) { selected.add(dependency); includeDependencies(dependency); }
      }
    };
    for (const g of selected) includeDependencies(g);
    const generations = [...selected];
    for (const g of generations) g.leases++;
    let released = false;
    return { tools: all.flatMap<AgentToolRegistration>(g => selected.has(g) ? (g.instance.tools ?? []).map(tool => ({ ...tool,
        prepare: tool.prepare ? (input: unknown, context: ToolExecutionContext) => this.trackCall(g, () => tool.prepare!(input, context)) : undefined,
        execute: (input: unknown, context: ToolExecutionContext) => this.trackCall(g, () => tool.execute(input, context))
      })) : (g.instance.tools ?? [])
      .map(tool => ({ definition: tool.definition, available: false, requiredSkill: tool.requiredSkill,
        activity: { started: () => ({message:"这项能力暂不可用。"}), completed: () => ({message:"这项能力暂不可用。"}), failed: () => ({message:"这项能力暂不可用。"}) },
        execute: async () => { throw new Error("PLUGIN_TOOL_UNAVAILABLE"); } }))),
      services: Object.assign({}, ...generations.map(g => g.instance.services)),
      prompts: Object.assign({}, ...generations.map(g => g.instance.prompts)),
      versions: Object.freeze(Object.fromEntries(generations.map(g => [g.manifest.id, g.manifest.version]))),
      release: () => {
        if (released) return; released = true;
        for (const g of generations.reverse()) { g.leases--; void this.retire(g); }
      } };
  }
  private async trackCall<T>(generation: Generation, call: () => Promise<T>): Promise<T> {
    generation.calls++;
    try { return await call(); } finally { generation.calls--; }
  }
  async passiveSnapshot(definitions: readonly PluginDefinition[]): Promise<PluginSnapshot> {
    const retained = new PluginHost(this.borrowed, this.toolOwners, this.resourceOwners, this.routeOwners);
    // Restoring old tools never grants that version scheduler/subscription ownership.
    await retained.prepare(definitions.map(definition => ({ ...definition, create: async services => {
      const instance = await definition.create(services);
      return { ...instance, start: undefined, resume: undefined };
    } })));
    await retained.activate();
    const snapshot = retained.snapshot();
    return { ...snapshot, release: () => { snapshot.release(); void retained.close(); } };
  }
  /** Resolve service at each host call; callers must not retain an implementation. */
  service<T>(name: string): T {
    const generation = [...this.active.values()].find(g => name in g.manifest.provides);
    if (!generation) throw new Error("PLUGIN_SERVICE_UNAVAILABLE");
    return generation.instance.services![name] as T;
  }
  route(path: string) {
    const generation = [...this.active.values()].find(g => g.instance.routes?.[path]);
    if (!generation) return undefined;
    generation.leases++;
    let released = false;
    const route = generation.instance.routes![path];
    return { route: { ...route, handle: (method: string, input: unknown) => this.trackCall(generation, async () => route.handle(method, input)) }, release: () => {
      if (released) return; released = true; generation.leases--; void this.retire(generation);
    } };
  }
  private async discardPending(): Promise<void> {
    const pending = this.pending; this.pending = undefined;
    if (pending) {
      await pending.context.fiber.dispose();
      for (const g of pending.generations) { g.state = "retired"; g.retiredAt = new Date().toISOString(); }
    }
  }
  discard(): Promise<void> { return this.serialize(() => this.discardPending()); }
  close(): Promise<void> {
    return this.serialize(async () => {
      this.closing = true; await this.discardPending();
      for (const g of [...this.active.values()].reverse()) { g.instance.pause?.(); g.state = "retiring"; await this.retire(g); }
      this.active.clear();
    });
  }
}
