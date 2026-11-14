'use strict';
// Host-owned lifecycle. Generated code is fetched only into an opaque-origin sandbox.
(() => {
  const prefix = 'zigent:interactive:';
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const documents = new Map(), downloads = new Map();
  const documentLimit = 3 * 1024 * 1024;
  let documentBytes = 0, frameUrl;
  function previewFrameUrl() {
    if (frameUrl) return frameUrl;
    const url = new URL('./interactive-frame.html', location.href);
    const version = window.ZigentAssetVersionMap?.['interactive-frame.html'];
    if (!version && document.querySelector('meta[name="zigent-asset-versions"]')?.content) return url.href;
    if (version) url.searchParams.set('v', version);
    return frameUrl = url.href;
  }
  function loadDocument(url, block) {
    const key = JSON.stringify([url, block.type, block.duration, block.html]);
    const cached = documents.get(key);
    if (cached) {
      documents.delete(key); documents.set(key, cached);
      return { promise: Promise.resolve(cached.html) };
    }
    let download = downloads.get(key);
    if (!download) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      download = { controller, readers: 0 };
      download.promise = fetch(url, { credentials: 'same-origin', redirect: 'error', signal: controller.signal }).then(async response => {
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('text/html')) throw new Error('Preview unavailable');
        const html = await response.text();
        if (controller.signal.aborted || html.length > 128 * 1024) throw new Error('Preview unavailable');
        const bytes = (html.length + key.length) * 2;
        documents.set(key, { html, bytes }); documentBytes += bytes;
        while (documentBytes > documentLimit || documents.size > 24) {
          const oldest = documents.keys().next().value;
          documentBytes -= documents.get(oldest).bytes; documents.delete(oldest);
        }
        return html;
      }).finally(() => {
        clearTimeout(timeout);
        if (downloads.get(key) === download) downloads.delete(key);
      });
      downloads.set(key, download);
    }
    download.readers++;
    return { promise: download.promise, release() {
      if (--download.readers === 0 && downloads.get(key) === download) {
        downloads.delete(key);
        download.controller.abort();
      }
    } };
  }
  const validControls = value => Array.isArray(value) && value.length <= 32 && JSON.stringify(value).length <= 24000 && value.every(item => item &&
    typeof item.id === 'string' && item.id.length <= 80 && typeof item.value === 'string' && item.value.length <= 500 && typeof item.checked === 'boolean');
  const fingerprint = value => { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(36); };
  function create(block, source, options = {}) {
    const animated = block.type === 'animation', motion = matchMedia('(prefers-reduced-motion: reduce)');
    const root = node('div', 'interactive-output'), toolbar = node('div', 'interactive-toolbar'), status = node('span', 'interactive-status'),
      retry = node('button', 'output-text-button', '重试'), content = node('div', 'interactive-stage'),
      summary = node('p', 'interactive-summary', block.summary);
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    retry.type = 'button'; retry.hidden = toolbar.hidden = true;
    toolbar.append(status, retry);
    root.append(toolbar, content, summary);
    const layout = update => options.resize ? options.resize(update) : update();
    const key = prefix + (typeof source === 'string' ? source : source?.key || 'local') + ':' + fingerprint(animated ? JSON.stringify(block) : block.html);
    let frame, timer, observer, visibility, controls = [], mounted = false, active = false, ready = false, failed = false, height = block.height || 400, inView = false;
    let animationTime = 0, lastSaved = 0, frameTheme, framePalette, frameOpened, releaseDocument, activationScheduled = false;
    if (animated) try { const saved = JSON.parse(sessionStorage.getItem(key + ':timeline') || 'null'); if (Number.isFinite(saved) && saved >= 0 && saved < block.duration) animationTime = saved; } catch {}
    const saveAnimation = () => { lastSaved = performance.now(); try { sessionStorage.setItem(key + ':timeline', JSON.stringify(animationTime)); } catch {} };
    const animationVisible = () => inView && !document.hidden && !motion.matches;
    const command = (action, extra = {}) => { if (animated && ready && !failed) frame?.contentWindow.postMessage({type:'zigent:animation', action, ...extra}, '*'); };
    const syncVisibility = () => command('visibility', {visible:animationVisible()});
    content.style.minHeight = `${height}px`;
    const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const currentPalette = () => document.documentElement.dataset.palette || 'brown';
    const appearanceChanged = () => frameTheme !== currentTheme() || framePalette !== currentPalette();
    // Recreate cached paints and static Canvas drawings too, restoring controls and playback time.
    const syncTheme = () => { if (ready && appearanceChanged()) layout(start); };
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (validControls(saved)) controls = saved; } catch { /* Optional tab-local state. */ }
    const clearFrame = () => {
      releaseDocument?.(); releaseDocument = undefined;
      frame?.remove(); frame = frameOpened = undefined;
    };
    const fail = () => layout(() => {
      command('visibility', {visible:false}); failed = true; ready = false; clearTimeout(timer);
      root.setAttribute('data-state', 'failed'); status.textContent = '预览暂不可用';
      toolbar.hidden = retry.hidden = summary.hidden = false;
      clearFrame();
    });
    const receive = event => {
      if (!active || event.source !== frame?.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (data?.type === 'zigent:interactive:document-ready') {
        frameOpened?.(); frameOpened = undefined;
        return;
      }
      if (data?.type !== 'zigent:interactive') return;
      if (data.kind === 'error') { fail(); return; }
      if (data.kind === 'ready') {
        ready = true; clearTimeout(timer);
        layout(() => { root.setAttribute('data-state', 'ready'); toolbar.hidden = summary.hidden = true; });
        if (appearanceChanged()) { syncTheme(); return; }
        frame.contentWindow.postMessage({type:'zigent:theme', theme:frameTheme}, '*');
        frame.contentWindow.postMessage({ type: 'zigent:restore', controls }, '*');
        if (animated && !failed) {
          command('init', {time:animationTime, visible:animationVisible()});
        }
      }
      if (data.kind === 'animation' && animated && ready && !failed && Number.isFinite(data.time) && data.time >= 0 && data.time < block.duration) {
        animationTime = data.time;
        if (performance.now() - lastSaved >= 1000) saveAnimation();
      }
      if (data.kind === 'size' && ready && Number.isFinite(data.height)) {
        const next = Math.round(Math.max(240, Math.min(960, data.height)));
        if (next !== height) layout(() => { height = next; frame.style.height = content.style.minHeight = `${height}px`; });
      }
      if (data.kind === 'state' && ready && validControls(data.controls)) {
        // Clone only allowlisted primitive fields; never store executable content or messages.
        controls = data.controls.map(({ id, value, checked }) => ({ id, value, checked }));
        try { sessionStorage.setItem(key, JSON.stringify(controls)); } catch { /* Keep in memory when storage is full or unavailable. */ }
      }
    };
    const start = () => {
      if (!source) { fail(); return; }
      clearTimeout(timer); clearFrame();
      root.setAttribute('data-state', 'loading'); ready = failed = false; retry.hidden = true; summary.hidden = toolbar.hidden = false; status.textContent = '正在加载…';
      frame = node('iframe', 'interactive-frame'); frame.title = block.title || (animated ? '动态画面' : '交互可视化');
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.style.height = `${height}px`;
      frameTheme = currentTheme(); framePalette = currentPalette(); frameOpened = undefined;
      if (typeof source === 'object' && typeof source.html === 'string') {
        // Local previews arrive as a prebuilt document; apply the host theme before its first drawing.
        const palette = JSON.stringify(framePalette).replaceAll('<', '\\u003c');
        const themeScript = `<script>document.documentElement.dataset.theme=${JSON.stringify(frameTheme)};document.documentElement.dataset.palette=${palette};document.documentElement.style.colorScheme=${JSON.stringify(frameTheme)};</script>`;
        frame.srcdoc = source.html.replace('<head>', '<head>' + themeScript);
      }
      else {
        const url = new URL(source, location.href); url.searchParams.set('theme', frameTheme);
        url.searchParams.set('paletteId', framePalette);
        // Fetch the authorized document and open the versioned sandbox in parallel.
        const target = frame;
        const opened = new Promise(resolve => { frameOpened = resolve; });
        const download = loadDocument(url.href, block); releaseDocument = download.release;
        Promise.all([download.promise, opened]).then(([html]) => {
          if (active && frame === target) target.contentWindow.postMessage({ type: 'zigent:interactive:document', html }, '*');
        }, () => { if (active && frame === target) fail(); });
        frame.src = previewFrameUrl();
      } content.replaceChildren(frame); timer = setTimeout(fail, 12000);
    };
    retry.onclick = () => layout(start);
    const activate = () => {
      if (active) return; active = true; window.addEventListener('message', receive);
      if (!animated) visibility?.disconnect();
      observer = new MutationObserver(syncTheme); observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-palette']}); layout(start);
    };
    const scheduleActivation = () => {
      if (active || activationScheduled) return;
      activationScheduled = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        activationScheduled = false;
        if (mounted && inView && root.isConnected) activate();
      }));
    };
    const deactivate = () => {
      if (animated) saveAnimation();
      active = ready = false; clearTimeout(timer); observer?.disconnect(); window.removeEventListener('message', receive);
      clearFrame();
    };
    return {
      node: root,
      mount() {
        if (mounted) return; mounted = true;
        if (animated) { document.addEventListener('visibilitychange', syncVisibility); motion.addEventListener('change', syncVisibility); }
        if (typeof IntersectionObserver === 'undefined') { inView = true; scheduleActivation(); return; }
        visibility = new IntersectionObserver(entries => { if (!mounted) return; for (const entry of entries) {
          inView = entry.isIntersecting;
          if (inView) scheduleActivation();
          if (animated) syncVisibility();
        } }, { rootMargin: animated ? '0px' : '480px' });
        visibility.observe(root);
      },
      unmount() { mounted = inView = false; visibility?.disconnect(); document.removeEventListener('visibilitychange', syncVisibility); motion.removeEventListener('change', syncVisibility); deactivate(); }
    };
  }

  function clearDocuments() {
    for (const { controller } of downloads.values()) controller.abort();
    downloads.clear(); documents.clear(); documentBytes = 0;
  }
  function clearState() { try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch {} }
  window.ZigentInteractiveOutput = Object.freeze({ create, clearState, clearDocuments });
})();
