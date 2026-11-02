// Share concurrent loads, but let a failed download be retried on the next action.
const downloads = new Map();
const root = new URL('.', import.meta.url);
const versions = (() => {
  try { return new Map(Object.entries(JSON.parse(document.querySelector('meta[name="zigent-asset-versions"]')?.content || '{}'))); }
  catch { return new Map(); }
})();
export function assetUrl(path) {
  const url = new URL(path, import.meta.url);
  const key = url.origin === root.origin && url.pathname.startsWith(root.pathname) ? url.pathname.slice(root.pathname.length) : undefined;
  const version = versions.get(key) || new URL(import.meta.url).searchParams.get('v');
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
