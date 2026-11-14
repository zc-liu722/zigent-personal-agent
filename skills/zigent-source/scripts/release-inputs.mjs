// Shared by the release planner and source-equivalence verification. No build
// dependencies: planning runs before npm dependencies are materialized.
export const inputPolicy = 3;
export const componentIds = ['schedule', 'browser', 'documents', 'health', 'location', 'model-http', 'model-codex', 'model-cursor', 'model-antigravity', 'model-catalog', 'recordings', 'skill-resources'];

export function inputOwner(path) {
  // These files are not runtime inputs of the maintained package. Keep this allowlist
  // narrow: unknown paths still require a controlled host upgrade.
  if (/^(docs|experiments|test)\//.test(path)
    || path === 'AGENTS.md' || path === 'README.md'
    || /^(src|ops)\/(?:.*\/)?(?:AGENTS|README)\.md$/.test(path)) return 'development';
  const component = componentIds.find(id => path.startsWith(`src/plugins/${id}/`));
  if (component) return component;
  // Dashboard and the audit exporter read this resource from the host release.
  if (path === 'web/plugins/palette/colors.css') return 'host';
  if (path.startsWith('web/')) return 'web';
  // These are maintained release executables, not instruction prose. The host
  // calls their installed copies; updating them still requires its controlled upgrade.
  if (path.startsWith('skills/zigent-source/scripts/')) return 'host';
  if (path.startsWith('skills/')) return 'skill-resources';
  return 'host';
}

export function inputReason(path) {
  const owner = inputOwner(path);
  if (owner === 'development') return 'not_in_runtime_package';
  if (owner !== 'host') return owner === 'web' ? 'versioned_web_resources' : owner === 'skill-resources' ? 'versioned_skill_resources' : 'plugin_implementation';
  if (path === 'web/plugins/palette/colors.css') return 'palette_shared_with_host_services';
  if (path.startsWith('src/')) return 'host_or_shared_source';
  if (path.startsWith('skills/')) return 'maintained_release_executable';
  if (path.startsWith('config/')) return 'configuration_requires_controlled_upgrade';
  if (path.startsWith('ops/') || path.startsWith('.github/')) return 'release_or_runtime_service_input';
  if (/^(package(?:-lock)?\.json|tsconfig(?:\.build)?\.json)$/.test(path)) return 'build_toolchain';
  return 'unclassified_conservative_upgrade';
}

// Only the global text catalogue and its per-Agent order can move independently.
export const modelManifestPaths = ['config/agents.json'];
const textFields = new Set(['name', 'brand', 'supplier', 'apiModel', 'protocol',
  'reasoningEffort', 'reasoning', 'capabilities', 'context', 'maxTokens', 'webSearch']);
export function splitModelManifest(manifest) {
  const models = manifest?.catalog?.models;
  if (!Array.isArray(models) || !models.length || !Array.isArray(manifest.agents)
    || models.some(model => !model || typeof model !== 'object'
      || Object.keys(model).some(key => !textFields.has(key)))
    || manifest.agents.some(agent => !agent || agent.models || agent.suppliers || agent.providerOrder
      || !Array.isArray(agent.modelOrder))) return;
  const host = { ...manifest, catalog: { ...manifest.catalog },
    agents: manifest.agents.map(({ modelOrder, ...agent }) => agent) };
  delete host.catalog.models;
  return { host, catalog: { models, orders: Object.fromEntries(manifest.agents.map(agent => [agent.id, agent.modelOrder])) } };
}

export function inputParts(path, bytes) {
  const owner = inputOwner(path);
  if (modelManifestPaths.includes(path)) {
    const split = splitModelManifest(JSON.parse(bytes.toString()));
    if (split) return [['host', JSON.stringify(split.host)], ['model-catalog', JSON.stringify(split.catalog)]];
  }
  return [[owner, bytes]];
}
