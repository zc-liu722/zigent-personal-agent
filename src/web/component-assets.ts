/** Conversation components are shared verbatim by the web channel and Dashboard preview. */
export const componentFiles = [
  'mochi.js', 'image-generation.js',
  'subagent-view.js', 'subagent.css', 'activity-renderer.js', 'activity.css',
  'index.js', 'interaction-model.js', 'interaction-renderer.js', 'interaction.css',
  'operation-preview.js', 'operation-preview.css',
  'operation-calendar.js', 'operation-calendar.css', 'schedule-link.js',
  'operation-todo.js', 'operation-todo.css',
  'operation-mindmap.js', 'operation-mindmap.css',
  'operation-content.js', 'operation-content.css',
  'output-components.js', 'output-components.css', 'document-cards.css',
  'interactive-output.js', 'interactive-tokens.css',
  'trigger-context.js', 'trigger-diagram.js', 'trigger-visual.js', 'trigger.css', 'paper-grain.svg'
] as const;
export const componentAssets: Record<string, [string, string]> = Object.fromEntries(componentFiles.map(file =>
  [`components/${file}`, [`components/${file}`, file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8']]));
// Existing asset URLs remain valid for older shells and persisted links.
export const legacyComponentAssets: Record<string, [string, string]> = Object.fromEntries(componentFiles.map(file =>
  [file, componentAssets[`components/${file}`]!]));
