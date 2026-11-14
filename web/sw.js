// Cache only the public shell. Conversations, API responses, and credentials stay on the network.
const CACHE = "zigent-shell-dev";
const PRECACHE = [];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => PRECACHE.length ? cache.addAll(PRECACHE) : undefined).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

function shellUrl() { return new URL('./', self.location.href).href; }
function isShellNavigation(request) {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  const url = new URL(request.url), shell = new URL(shellUrl());
  return url.origin === shell.origin && (url.pathname === shell.pathname || url.pathname === `${shell.pathname}index.html`);
}
function isShellAsset(url) {
  return ['/style.css', '/app.js', '/shell-runtime.js', '/asset-versions.json'].some(name => url.pathname.endsWith(name));
}
function offline() {
  return new Response('<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>私人对话</title><body><h1>暂时无法连接</h1><p>检查网络后重新打开，之前的对话仍保存在服务器。</p></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function refreshShell(cache, request) {
  try {
    const response = await fetch(request);
    const type = response.headers.get('content-type') || '';
    if (response.ok && response.type === 'basic' && !response.redirected && type.includes('text/html')) await cache.put(shellUrl(), response.clone());
    return response;
  } catch { return undefined; }
}
async function serveAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic' && !response.redirected && (response.headers.get('cache-control') || '').includes('immutable'))
    await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.split('/').includes('api')) return;
  if (isShellNavigation(request)) {
    const cachePromise = caches.open(CACHE);
    const pending = cachePromise.then(cache => refreshShell(cache, request));
    event.waitUntil(pending.then(() => {}, () => {}));
    event.respondWith(cachePromise.then(async cache => {
      const cached = await cache.match(shellUrl());
      if (cached) { pending.then(response => response?.body?.cancel()).catch(() => {}); return cached; }
      return await pending || offline();
    }));
    return;
  }
  if (isShellAsset(url)) event.respondWith(serveAsset(request));
});
