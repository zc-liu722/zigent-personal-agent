// Start the authenticated read while the main module graph is still downloading.
(() => {
  // The main module may win the race on a slow or failed script download.
  if (window.ZigentStartupConsumed) return;
  const controller = new AbortController(), started = performance.now();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = fetch(new URL('api/bootstrap', location.href), {
    credentials: 'same-origin', cache: 'no-store', priority: 'high', signal: controller.signal
  }).catch(() => undefined).finally(() => clearTimeout(timeout));
  window.ZigentStartup = {
    started,
    takeBootstrap() {
      delete window.ZigentStartup;
      if (performance.now() - started > 15000) { controller.abort(); return; }
      return response;
    }
  };
})();
