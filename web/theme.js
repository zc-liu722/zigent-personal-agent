'use strict';
(() => {
  const root = document.documentElement;
  const fileInput = document.getElementById('theme-wallpaper-file');
  const choose = document.getElementById('theme-wallpaper-choose');
  const clear = document.getElementById('theme-wallpaper-clear');
  const status = document.getElementById('theme-wallpaper-status');
  const databaseName = `zigent-appearance:${new URL('.', location.href).pathname}`;
  let wallpaperUrl;

  async function accessWallpaper(mode, operation) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('appearance');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction('appearance', mode);
        const request = operation(transaction.objectStore('appearance'), 'wallpaper');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  async function preparePhoto(file) {
    const source = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob?.size ? resolve(blob) : reject(new Error('Empty image')), 'image/webp', .88);
      });
    } finally {
      URL.revokeObjectURL(source);
    }
  }

  function displayWallpaper(photo) {
    const nextUrl = photo && URL.createObjectURL(photo);
    if (nextUrl) root.style.setProperty('--wallpaper-image', `url("${nextUrl}")`);
    else root.style.removeProperty('--wallpaper-image');
    root.toggleAttribute('data-wallpaper', Boolean(nextUrl));
    clear.hidden = !nextUrl;
    choose.querySelector('span').textContent = nextUrl ? '更换照片' : '上传照片';
    if (wallpaperUrl) URL.revokeObjectURL(wallpaperUrl);
    wallpaperUrl = nextUrl;
  }

  async function updateWallpaper(progress, failure, operation) {
    const focused = document.activeElement;
    choose.disabled = clear.disabled = true;
    status.textContent = progress;
    try { await operation(); }
    catch { status.textContent = failure; }
    finally {
      choose.disabled = clear.disabled = false;
      if ((focused === choose || focused === clear) && document.activeElement === document.body
        && choose.closest('dialog').open) (focused.hidden ? choose : focused).focus();
    }
  }

  choose.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file || choose.disabled) return;
    if (file.size > 40 * 1024 * 1024) {
      status.textContent = '请选择不超过 40 MB 的照片。';
      return;
    }
    void updateWallpaper('正在处理照片…', '无法保存背景，请重试。', async () => {
      let photo;
      try { photo = await preparePhoto(file); }
      catch { status.textContent = '无法读取照片，请试试 JPG、PNG 或 WebP。'; return; }
      await accessWallpaper('readwrite', (store, key) => store.put(photo, key));
      displayWallpaper(photo);
      status.textContent = '背景已更新。';
    });
  });
  clear.addEventListener('click', () => {
    void updateWallpaper('', '无法移除背景，请重试。', async () => {
      await accessWallpaper('readwrite', (store, key) => store.delete(key));
      displayWallpaper();
      status.textContent = '已恢复默认背景。';
    });
  });
  void updateWallpaper('', '无法读取已保存的背景。', async () => {
    const photo = await accessWallpaper('readonly', (store, key) => store.get(key));
    if (photo) displayWallpaper(photo);
  });
})();

// The server selects light or dark from Beijing sunrise and sunset.
(() => {
  const root = document.documentElement;
  const themeColor = document.querySelector('meta[name="theme-color"]');
  const picker = document.getElementById('theme-palette-picker');
  for (const option of picker?.querySelectorAll('input') ?? []) option.checked = option.value === root.dataset.palette;
  function updatePaletteLabel() {
    const option = picker?.querySelector('input:checked');
    if (!option) return;
    document.getElementById('open-theme')?.setAttribute('aria-label', `主题色，当前${option.nextElementSibling.textContent}`);
  }
  updatePaletteLabel();
  function updateChrome(fallback) {
    const color = getComputedStyle(root).getPropertyValue('--palette-page').trim() || fallback;
    if (color) themeColor?.setAttribute('content', color);
  }
  picker?.addEventListener('change', event => {
    const option = event.target;
    if (!option.matches('input[type="radio"]:checked')) return;
    const palette = option.value;
    root.dataset.palette = palette;
    updatePaletteLabel();
    const path = new URL('.', location.href).pathname;
    document.cookie = `zigent_palette=${palette}; Path=${path}; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
    updateChrome();
  });
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
      if (root.dataset.theme !== theme.mode) root.dataset.theme = theme.mode;
      document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.mode);
      updateChrome(theme.color);
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
