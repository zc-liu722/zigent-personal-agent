// Share concurrent loads, but let a failed download be retried on the next action.
const downloads = new Map();
const versions = new Map();
const root = new URL('.', import.meta.url);
const declared = document.querySelector('meta[name="zigent-asset-versions"]')?.content || '';
function remember(data) {
  const map = data && typeof data === 'object' ? data : {};
  window.ZigentAssetVersionMap = map;
  for (const [key, value] of Object.entries(map)) if (typeof value === 'string') versions.set(key, value);
  return versions;
}
if (!window.ZigentAssetVersions) {
  let parsed;
  try { parsed = declared.startsWith('{') ? JSON.parse(declared) : undefined; } catch { parsed = {}; }
  window.ZigentAssetVersions = parsed ? Promise.resolve(parsed)
    : declared ? fetch(new URL(declared, document.baseURI), { credentials: 'same-origin', cache: 'force-cache' }).then(response => response.ok ? response.json() : {}).catch(() => ({}))
    : Promise.resolve({});
}
// Pin this page's map. A later navigation fetches its own file; this document must not mix generations.
export const versionsReady = window.ZigentAssetVersions.then(remember).catch(() => versions);
function versionFor(key) { return versions.get(key) || window.ZigentAssetVersionMap?.[key]; }
export const assetVersion = key => versionFor(key);
export function assetUrl(path) {
  const url = new URL(path, import.meta.url);
  const key = url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url.pathname.slice(root.pathname.length) : undefined;
  const version = versionFor(key) || new URL(import.meta.url).searchParams.get('v');
  if (version) url.searchParams.set('v', version);
  return url.href;
}
function load(path, style) {
  if (style && [...document.querySelectorAll('link[rel=stylesheet]')].some(node => node.href === assetUrl(path) && node.sheet)) return Promise.resolve();
  if (downloads.has(path)) return downloads.get(path);
  const pending = new Promise((resolve, reject) => {
    const node = document.createElement(style ? 'link' : 'script');
    if (style) { node.rel = 'stylesheet'; node.href = assetUrl(path); }
    else { node.src = assetUrl(path); node.async = true; }
    node.onload = () => resolve();
    node.onerror = () => { node.remove(); downloads.delete(path); reject(new Error('组件加载失败，请重试。')); };
    document.head.append(node);
  });
  downloads.set(path, pending); return pending;
}
export const loadScript = path => load(path, false);
export const loadStyle = path => load(path, true);
