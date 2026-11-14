import { el, messageButton } from './dom.js';
import { assetUrl } from './lazy-assets.js';

const views = new Map(), diagrams = new Map(), pending = new Map();
const queue = [];
const cacheLimit = 8 * 1024 * 1024;
const renderTimeout = 12000;
let visibility;
let cacheBytes = 0, renderer, rendererReady, timer, current, nextId = 0;
let watching = false;
const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

function finish(job, result) {
  pending.delete(job.key);
  if (!result) { job.reject(new Error('Mermaid preview unavailable')); return; }
  const bytes = result.blob.size + job.key.length * 2;
  if (bytes <= cacheLimit) {
    diagrams.set(job.key, { ...result, bytes }); cacheBytes += bytes;
    while (cacheBytes > cacheLimit || diagrams.size > 48) {
      const oldest = diagrams.keys().next().value;
      cacheBytes -= diagrams.get(oldest).bytes; diagrams.delete(oldest);
    }
  }
  job.resolve(result);
}

function resetRenderer() {
  clearTimeout(timer);
  renderer?.remove(); renderer = undefined; rendererReady = false;
}

function advance() {
  if (current && queue.length && !current.readers.some(reader => reader.attached())) {
    const abandoned = current; current = undefined; resetRenderer();
    pending.delete(abandoned.key); abandoned.resolve(undefined);
  }
  if (current) return;
  while (queue.length && !queue[0].readers.some(reader => reader.visible())) {
    const skipped = queue.shift();
    pending.delete(skipped.key);
    skipped.resolve(undefined);
  }
  if (!queue.length) return;
  if (!renderer) {
    renderer = el('iframe', 'mermaid-renderer');
    renderer.title = 'Mermaid'; renderer.tabIndex = -1; renderer.setAttribute('aria-hidden', 'true');
    renderer.setAttribute('sandbox', 'allow-scripts'); renderer.referrerPolicy = 'no-referrer';
    renderer.src = assetUrl('./mermaid-frame.html');
    document.body.append(renderer);
    timer = setTimeout(failRenderer, renderTimeout);
  }
  if (!rendererReady) return;
  current = queue.shift();
  const { id, source, mode, palette } = current;
  renderer.contentWindow.postMessage({ type: 'zigent:mermaid:render', id, source, theme: mode, palette }, '*');
  timer = setTimeout(() => {
    resetRenderer(); finish(current); current = undefined; advance();
  }, renderTimeout);
}

function failRenderer() {
  resetRenderer();
  if (current) { finish(current); current = undefined; }
  for (const job of queue.splice(0)) finish(job);
}

export function clearMermaidPreviews() {
  failRenderer(); visibility?.disconnect(); views.clear(); diagrams.clear(); cacheBytes = 0;
}

function watchRenderer() {
  if (watching) return;
  watching = true;
  addEventListener('message', event => {
    if (!renderer || event.source !== renderer.contentWindow || event.origin !== 'null' || event.data?.type !== 'zigent:mermaid') return;
    const { state, id, image, width, height, title, description } = event.data;
    if (!rendererReady) {
      if (state === 'error') failRenderer();
      if (state === 'ready') { clearTimeout(timer); rendererReady = true; advance(); }
      return;
    }
    if (!current || id !== current.id || !['error', 'rendered'].includes(state)) return;
    clearTimeout(timer);
    const valid = state === 'rendered' && typeof image === 'string'
      && [width, height, width / height].every(value => Number.isFinite(value) && value > 0);
    finish(current, valid ? {
      blob: new Blob([image], { type: 'image/svg+xml' }), width, height,
      title: typeof title === 'string' ? title.slice(0, 500) : '',
      description: typeof description === 'string' ? description.slice(0, 1000) : ''
    } : undefined);
    current = undefined; advance();
  });
  if (typeof IntersectionObserver !== 'undefined') visibility = new IntersectionObserver(entries => {
    for (const entry of entries) views.get(entry.target)?.setVisible(entry.isIntersecting);
  });
  new MutationObserver(() => {
    let removed = false;
    for (const [block] of views) if (!block.isConnected) {
      visibility?.unobserve(block); views.delete(block); removed = true;
    }
    if (removed && !current) advance();
  }).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(() => {
    for (const view of views.values()) view.schedule();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
}

function getDiagram(key, source, mode, palette, reader) {
  const cached = diagrams.get(key);
  if (cached) { diagrams.delete(key); diagrams.set(key, cached); return cached; }
  let job = pending.get(key);
  if (!job) {
    job = { key, source, mode, palette, readers: [], id: ++nextId };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    pending.set(key, job); queue.push(job);
  }
  job.readers.push(reader);
  advance();
  return job.promise;
}

function forgetDiagram(key, blob) {
  const cached = diagrams.get(key);
  if (cached?.blob !== blob) return;
  diagrams.delete(key); cacheBytes -= cached.bytes;
}

function mermaidViewer() {
  const preview = el('div', 'mermaid-preview'), dialog = el('dialog', 'mermaid-viewer');
  const viewport = el('div', 'mermaid-viewport'), stage = el('div', 'mermaid-stage');
  const toolbar = el('div', 'mermaid-toolbar'), controls = el('div', 'mermaid-actions');
  const expand = messageButton('expand', '全屏查看 Mermaid 图表'); expand.className = 'content-icon';
  const close = messageButton('close', '关闭全屏'); close.className = 'content-icon';
  const minus = el('button', 'mermaid-toggle', '−'), fit = el('button', 'mermaid-toggle', '适应窗口'), plus = el('button', 'mermaid-toggle', '＋');
  for (const button of [minus, fit, plus]) button.type = 'button';
  minus.setAttribute('aria-label', '缩小图表'); plus.setAttribute('aria-label', '放大图表');
  expand.setAttribute('aria-haspopup', 'dialog'); expand.hidden = true;
  preview.dataset.selectionControl = 'true';
  dialog.open = true; dialog.setAttribute('role', 'none');
  const image = el('img', 'mermaid-diagram');
  image.alt = 'Mermaid 图表'; image.draggable = false;
  controls.append(minus, fit, plus, close); toolbar.append(el('span', '', 'Mermaid'), controls);
  stage.append(image); viewport.append(stage); dialog.append(toolbar, viewport); preview.append(dialog);

  let zoom = 1, drag;
  const maxZoom = 16;
  function setZoom(value) {
    const before = image.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    const centerX = before.width ? (bounds.left + viewport.clientWidth / 2 - before.left) / before.width : .5;
    const centerY = before.height ? (bounds.top + viewport.clientHeight / 2 - before.top) / before.height : .5;
    zoom = Math.max(1, Math.min(maxZoom, value));
    viewport.style.setProperty('--mermaid-zoom', zoom);
    viewport.toggleAttribute('data-zoomed', zoom > 1);
    minus.disabled = fit.disabled = zoom === 1; plus.disabled = zoom === maxZoom;
    const after = image.getBoundingClientRect();
    viewport.scrollBy(after.left + centerX * after.width - bounds.left - viewport.clientWidth / 2,
      after.top + centerY * after.height - bounds.top - viewport.clientHeight / 2);
  }
  expand.onclick = () => {
    if (expand.hidden || !dialog.open || dialog.matches(':modal')) return;
    dialog.open = false; dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-label', 'Mermaid 图表');
    viewport.tabIndex = 0; dialog.showModal(); setZoom(1); close.focus({ preventScroll: true });
  };
  viewport.onclick = () => { if (!dialog.matches(':modal')) expand.click(); };
  minus.onclick = () => setZoom(zoom / 1.5);
  fit.onclick = () => setZoom(1);
  plus.onclick = () => setZoom(zoom * 1.5);
  close.onclick = () => dialog.close();
  dialog.onclose = () => {
    if (dialog.open || !preview.isConnected) return;
    dialog.setAttribute('role', 'none'); dialog.removeAttribute('aria-label');
    viewport.removeAttribute('tabindex'); dialog.open = true;
    if (!expand.hidden) expand.focus({ preventScroll: true });
  };
  stage.onpointerdown = event => {
    if (zoom === 1 || !dialog.matches(':modal') || event.pointerType !== 'mouse' || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.setAttribute('data-dragging', '');
  };
  viewport.onpointermove = event => {
    if (drag) viewport.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY);
  };
  viewport.onlostpointercapture = () => { drag = undefined; viewport.removeAttribute('data-dragging'); };
  return { preview, expand, image, close: () => { if (dialog.matches(':modal')) dialog.close(); } };
}

export function mermaidBlock(source, { copyText, resize = update => update() }) {
  const block = el('section', 'code-block mermaid-block'), heading = el('div', 'code-heading');
  const actions = el('div', 'mermaid-actions'), toggle = el('button', 'mermaid-toggle', '源码');
  const copy = messageButton('copy', '复制 Mermaid 源码'); copy.className = 'content-icon code-copy';
  const status = el('div', 'mermaid-status'), pre = el('pre'), code = el('code', '', source);
  heading.dataset.selectionControl = 'true'; toggle.type = 'button'; toggle.setAttribute('aria-pressed', 'false');
  status.setAttribute('role', 'status'); status.hidden = true; pre.append(code); pre.hidden = true;
  actions.append(toggle, copy); heading.append(el('span', '', 'Mermaid'), actions); block.append(heading, status, pre);
  let failed = false, showingSource = false, inView = false, scheduled = false, revision = 0, renderedTheme, requestedTheme, releaseImage;
  let viewer;
  const show = () => {
    pre.hidden = !showingSource;
    if (viewer) {
      viewer.preview.hidden = showingSource || failed || !viewer.preview.hasAttribute('data-ready');
      viewer.expand.hidden = viewer.preview.hidden;
    }
    toggle.textContent = showingSource ? (failed ? '重试' : '图表') : '源码';
    toggle.setAttribute('aria-pressed', String(showingSource));
  };
  const fail = () => resize(() => {
    revision++; renderedTheme = requestedTheme = undefined;
    failed = showingSource = true;
    viewer?.close();
    releaseImage?.(); viewer?.image.removeAttribute('src'); viewer?.preview.removeAttribute('data-ready');
    status.hidden = false; status.textContent = '图表未能绘制，已显示源码'; show();
  });
  const render = () => {
    const mode = theme(), palette = document.documentElement.dataset.palette || 'brown';
    const appearance = `${mode}:${palette}`, key = `${appearance}:${source}`;
    if (!block.isConnected || !inView || showingSource || requestedTheme === appearance || renderedTheme === appearance && !requestedTheme) return;
    failed = false; show(); requestedTheme = appearance;
    const attempt = ++revision;
    const isCurrent = () => revision === attempt && block.isConnected;
    const paint = ({ blob, width, height, title, description }) => {
      if (!isCurrent()) return;
      if (!viewer) {
        viewer = mermaidViewer();
        viewer.preview.hidden = true;
        actions.prepend(viewer.expand); block.insertBefore(viewer.preview, pre);
      }
      const { image, preview } = viewer;
      releaseImage?.();
      // SVG stays in image mode, where scripts and external resources cannot run.
      const url = URL.createObjectURL(blob);
      releaseImage = () => {
        image.onload = image.onerror = null; URL.revokeObjectURL(url); releaseImage = undefined;
      };
      image.onload = () => {
        releaseImage?.();
        if (!isCurrent()) return;
        resize(() => {
          preview.style.setProperty('--mermaid-ratio', width / height);
          preview.style.setProperty('--mermaid-height', `${height}px`);
          preview.setAttribute('data-ready', '');
          status.hidden = true; renderedTheme = appearance; requestedTheme = undefined; show();
        });
      };
      image.onerror = () => {
        releaseImage?.(); forgetDiagram(key, blob);
        if (isCurrent()) fail();
      };
      image.alt = title || 'Mermaid 图表';
      if (description) image.setAttribute('aria-description', description);
      else image.removeAttribute('aria-description');
      image.src = url;
    };
    const diagram = getDiagram(key, source, mode, palette, {
      attached: isCurrent, visible: () => isCurrent() && inView && !showingSource
    });
    if (diagram.blob) paint(diagram);
    else {
      status.hidden = false; status.textContent = '正在绘制图表…';
      diagram.then(result => {
        if (!isCurrent()) return;
        if (result) paint(result);
        else { requestedTheme = undefined; status.hidden = true; schedule(); }
      }, () => { if (isCurrent()) fail(); });
    }
  };
  const schedule = () => {
    if (scheduled || !inView || !block.isConnected || showingSource) return;
    scheduled = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { scheduled = false; render(); }));
  };
  toggle.onclick = () => resize(() => {
    showingSource = !showingSource;
    if (showingSource) {
      revision++; requestedTheme = undefined; status.hidden = !failed; advance();
    }
    show();
    if (!showingSource) {
      if (failed && !current && !queue.length) resetRenderer();
      schedule();
    }
  });
  copy.onclick = () => copyText(source, copy, '复制 Mermaid 源码');
  if (source.length > 50000) { fail(); toggle.disabled = true; }
  else {
    show();
    queueMicrotask(() => {
      if (!block.isConnected) return;
      watchRenderer();
      views.set(block, { schedule, setVisible(value) { inView = value; if (value) schedule(); } });
      if (visibility) visibility.observe(block);
      else { inView = true; schedule(); }
    });
  }
  return block;
}
