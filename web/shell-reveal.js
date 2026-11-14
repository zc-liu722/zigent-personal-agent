// Unhide the shell as soon as HTML and CSS are ready. Messages still wait for bootstrap.
(() => {
  const shell = document.documentElement.dataset.shell;
  const app = document.getElementById('app');
  const login = document.getElementById('login');
  if (shell === 'app' && app) {
    app.hidden = false;
    const loading = document.getElementById('messages-loading');
    if (loading) loading.hidden = false;
  } else if (login) login.hidden = false;
  const declared = document.querySelector('meta[name="zigent-asset-versions"]')?.content || '';
  if (!window.ZigentAssetVersions) {
    let parsed;
    try { parsed = declared.startsWith('{') ? JSON.parse(declared) : undefined; } catch { parsed = {}; }
    window.ZigentAssetVersions = parsed ? Promise.resolve(parsed)
      : declared ? fetch(new URL(declared, document.baseURI), { credentials: 'same-origin', cache: 'force-cache' }).then(response => response.ok ? response.json() : {}).catch(() => ({}))
      : Promise.resolve({});
  }
  if ('serviceWorker' in navigator) {
    const scope = new URL('./', document.baseURI);
    navigator.serviceWorker.register(new URL('sw.js', scope).href, { scope: scope.pathname }).catch(() => {});
  }
})();
