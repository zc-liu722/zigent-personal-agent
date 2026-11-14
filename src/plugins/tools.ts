import type { AgentToolSet } from "../tools/tool-contracts.js";
import { withOperationSkillCatalog } from "../tools/confirmed-operation.js";
import type { PluginSnapshot, PluginSource } from "./contracts.js";

/** Non-run callers (including authenticated confirmations) also get a fresh, scoped lease. */
export function livePluginTools(source: PluginSource, create: (snapshot: PluginSnapshot) => AgentToolSet, toolNames?: readonly string[]): AgentToolSet {
  const scoped = (snapshot: PluginSnapshot): AgentToolSet => {
    const tools = create(snapshot);
    return { ...tools, pluginPrompts: snapshot.prompts, pluginServices: snapshot.services,
      execute: (name, input, context) => withOperationSkillCatalog(context,
        snapshot.services.skillCatalog as import("../skills/catalog.js").SkillCatalog | undefined,
        scoped => tools.execute(name, input, scoped)) };
  };
  const lease = () => {
    const snapshot = source.snapshot(toolNames);
    try { return { tools: scoped(snapshot), versions: snapshot.versions, release: snapshot.release }; }
    catch (error) { snapshot.release(); throw error; }
  };
  const read = <T>(action: (tools: AgentToolSet) => T): T => {
    const snapshot = lease(); try { return action(snapshot.tools); } finally { snapshot.release(); }
  };
  return {
    lease,
    leaseVersions: async versions => {
      const snapshot = source.snapshotVersions ? await source.snapshotVersions(versions) : source.snapshot(toolNames);
      if (Object.entries(versions).some(([id, version]) => snapshot.versions[id] !== version)) { snapshot.release(); throw new Error("PLUGIN_VERSION_UNAVAILABLE"); }
      try { return { tools: scoped(snapshot), versions: snapshot.versions, release: snapshot.release }; }
      catch (error) { snapshot.release(); throw error; }
    },
    get names() { return read(tools => tools.names); },
    get localNames() { return read(tools => tools.localNames); },
    get definitions() { return read(tools => tools.definitions); },
    definitionsFor: context => read(tools => tools.definitionsFor?.(context) ?? tools.definitions),
    isAvailable: (name, context) => read(tools => tools.isAvailable?.(name, context) ?? tools.allows(name)),
    allows: name => read(tools => tools.allows(name)),
    isLocal: name => read(tools => tools.isLocal(name)),
    presentActivity: (...args) => read(tools => tools.presentActivity(...args)),
    executionMode: name => read(tools => tools.executionMode?.(name) ?? "parallel"),
    resultFailed: (name, result) => read(tools => tools.resultFailed?.(name, result) ?? false),
    execute: async (name, input, context) => { const snapshot = lease(); try {
      return await snapshot.tools.execute(name, input, context);
    } finally { snapshot.release(); } }
  };
}
