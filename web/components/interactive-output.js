'use strict';
// Host-owned lifecycle. Generated code is fetched only into an opaque-origin sandbox.
(() => {
  const prefix = 'zigent:interactive:';
  const node = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const validControls = value => Array.isArray(value) && value.length <= 32 && JSON.stringify(value).length <= 24000 && value.every(item => item &&
    typeof item.id === 'string' && item.id.length <= 80 && typeof item.value === 'string' && item.value.length <= 500 && typeof item.checked === 'boolean');
  const fingerprint = value => { let hash = 2166136261; for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619); return (hash >>> 0).toString(36); };
  function create(block, source, options = {}) {
    const animated = block.type === 'animation', motion = matchMedia('(prefers-reduced-motion: reduce)');
    const root = node('div', 'interactive-output'), toolbar = node('div', 'interactive-toolbar'), status = node('span', 'interactive-status'),
      retry = node('button', 'output-text-button', '重试'), content = node('div', 'interactive-stage'),
      summary = node('p', 'interactive-summary', block.summary);
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    retry.type = 'button'; retry.hidden = summary.hidden = true;
    toolbar.append(status, retry);
    root.append(toolbar, content, summary);
    const layout = update => options.resize ? options.resize(update) : update();
    const key = prefix + (typeof source === 'string' ? source : source?.key || 'local') + ':' + fingerprint(animated ? JSON.stringify(block) : block.html);
    let frame, timer, observer, visibility, controls = [], mounted = false, active = false, ready = false, failed = false, height = block.height || 400, inView = false;
    let animationTime = 0, lastSaved = 0, frameTheme;
    if (animated) try { const saved = JSON.parse(sessionStorage.getItem(key + ':timeline') || 'null'); if (Number.isFinite(saved) && saved >= 0 && saved < block.duration) animationTime = saved; } catch {}
    const saveAnimation = () => { lastSaved = performance.now(); try { sessionStorage.setItem(key + ':timeline', JSON.stringify(animationTime)); } catch {} };
    const animationVisible = () => inView && !document.hidden && !motion.matches;
    const command = (action, extra = {}) => { if (animated && ready && !failed) frame?.contentWindow.postMessage({type:'zigent:animation', action, ...extra}, '*'); };
    const syncVisibility = () => command('visibility', {visible:animationVisible()});
    content.style.minHeight = `${height}px`;
    const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    // Recreate cached paints and static Canvas drawings too, restoring controls and playback time.
    const syncTheme = () => { if (ready && frameTheme !== currentTheme()) layout(start); };
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (validControls(saved)) controls = saved; } catch { /* Optional tab-local state. */ }
    const fail = () => layout(() => { command('visibility', {visible:false}); failed = true; root.setAttribute('data-state', 'failed'); clearTimeout(timer); status.textContent = '预览暂不可用'; toolbar.hidden = false; content.hidden = true; retry.hidden = false; summary.hidden = false; frame?.remove(); frame = undefined; });
    const receive = event => {
      if (!active || event.source !== frame?.contentWindow || event.origin !== 'null' || event.data?.type !== 'zigent:interactive') return;
      const data = event.data;
      if (data.kind === 'error') { fail(); return; }
      if (data.kind === 'ready') {
        ready = true; root.setAttribute('data-state', 'ready'); clearTimeout(timer); layout(() => { if (!failed) { toolbar.hidden = true; content.hidden = false; } });
        if (frameTheme !== currentTheme()) { syncTheme(); return; }
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
      clearTimeout(timer); root.setAttribute('data-state', 'loading'); ready = failed = false; retry.hidden = summary.hidden = true; content.hidden = false; toolbar.hidden = false; status.textContent = '正在加载…';
      frame?.remove(); frame = node('iframe', 'interactive-frame'); frame.title = block.title || (animated ? '动态画面' : '交互可视化');
      frame.setAttribute('sandbox', 'allow-scripts'); frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.style.height = `${height}px`;
      frameTheme = currentTheme();
      if (typeof source === 'object' && typeof source.html === 'string') {
        // Local previews arrive as a prebuilt document; apply the host theme before its first drawing.
        const themeScript = `<script>document.documentElement.dataset.theme=${JSON.stringify(frameTheme)};document.documentElement.style.colorScheme=${JSON.stringify(frameTheme)};</script>`;
        frame.srcdoc = source.html.replace('<head>', '<head>' + themeScript);
      }
      else {
        const url = new URL(source, location.href); url.searchParams.set('theme', frameTheme);
        frame.src = url.href;
      } content.replaceChildren(frame); timer = setTimeout(fail, 12000);
    };
    retry.onclick = () => layout(start);
    const activate = () => {
      if (active) return; active = true; window.addEventListener('message', receive);
      observer = new MutationObserver(syncTheme); observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']}); start();
    };
    const deactivate = () => {
      if (animated) saveAnimation();
      active = ready = false; clearTimeout(timer); observer?.disconnect(); window.removeEventListener('message', receive); frame?.remove(); frame = undefined;
    };
    return {
      node: root,
      mount() {
        if (mounted) return; mounted = true;
        if (animated) { document.addEventListener('visibilitychange', syncVisibility); motion.addEventListener('change', syncVisibility); }
        if (typeof IntersectionObserver === 'undefined') { inView = true; activate(); return; }
        visibility = new IntersectionObserver(entries => { if (!mounted) return; for (const entry of entries) {
          inView = entry.isIntersecting;
          if (inView) { if (!animated) visibility.disconnect(); activate(); }
          if (animated) syncVisibility();
        } }, { rootMargin: animated ? '0px' : '240px' });
        visibility.observe(root);
      },
      unmount() { mounted = false; visibility?.disconnect(); document.removeEventListener('visibilitychange', syncVisibility); motion.removeEventListener('change', syncVisibility); deactivate(); }
    };
  }

  function clearState() { try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(prefix)) sessionStorage.removeItem(key); } catch {} }
  window.ZigentInteractiveOutput = Object.freeze({ create, clearState });
})();
