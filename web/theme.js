'use strict';
// The server owns both the theme and the remaining time until sunrise/sunset.
// Do not use the device clock, local timezone, OS preference, or saved overrides.
(() => {
  let timer, pending = false, refreshAgain = false;
  async function sync() {
    clearTimeout(timer);
    if (document.hidden) return;
    // A resumed page must recheck even if a pre-suspension request is pending.
    if (pending) { refreshAgain = true; return; }
    pending = true;
    let delay = 60_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch('api/theme', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Theme unavailable');
      const theme = await response.json();
      if (!['light', 'dark'].includes(theme.mode) || !Number.isFinite(theme.refreshAfterMs)) throw new Error('Invalid theme');
      document.documentElement.dataset.theme = theme.mode;
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.mode);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
      delay = Math.max(1000, Math.min(theme.refreshAfterMs, 86_400_000));
    } catch { /* Keep the last server theme during an outage, then retry. */ }
    finally {
      clearTimeout(timeout);
      pending = false;
      if (!document.hidden) {
        if (refreshAgain) { refreshAgain = false; void sync(); }
        else timer = setTimeout(sync, delay);
      }
    }
  }
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pageshow', sync);
  window.addEventListener('online', sync);
  void sync();
})();
