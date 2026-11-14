import entries from "#skill-assets";
import type { PluginInstance, PluginManifest } from "../contracts.js";
import type { SkillCatalog } from "../../skills/catalog.js";

export async function create(resources: Readonly<Record<string, unknown>>): Promise<PluginInstance> {
  const identity = resources.pluginIdentity as PluginManifest;
  const catalog: SkillCatalog = Object.freeze({ version: identity.version,
    entries: Object.freeze(entries.map(skill => Object.freeze({ ...skill, files: Object.freeze(skill.files) }))) });
  return { pinForTurn: true, services: { skillCatalog: catalog }, async ready() {}, async dispose() {} };
}
