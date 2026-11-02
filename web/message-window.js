/** Keep lightweight row anchors, but release offscreen message bodies and their resources. */
export function createMessageWindow({ readingScroller, capturePosition, restorePosition, render, dispose }) {
  let root = readingScroller();
  const rows = new Map();
  const supported = typeof IntersectionObserver !== 'undefined' && typeof ResizeObserver !== 'undefined';
  let enabled = false, selectionVersion, frame, position, width = root.clientWidth;
  let initialEnd = false, count = 0;
  const pending = new Set();
  function schedule(id) {
    if (id) pending.add(id);
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const dirty = new Set(pending); pending.clear();
      render(dirty);
    });
  }
  function remember() { position = capturePosition(); }
  function restore(saved) {
    if (!saved) return;
    restorePosition(saved, false, true);
    remember();
  }
  const intersectionsChanged = entries => {
    for (const entry of entries) {
      const row = rows.get(entry.target.dataset.id);
      if (!row || row.node !== entry.target) continue;
      row.near = entry.isIntersecting;
      if (enabled && row.near === row.suspended) schedule(entry.target.dataset.id);
    }
  };
  let intersection;
  const resize = supported ? new ResizeObserver(entries => {
    const saved = position;
    let changed = false;
    for (const entry of entries) {
      if (entry.target === root) continue;
      const row = rows.get(entry.target.dataset.id);
      if (!row || row.suspended || !row.node.isConnected) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? row.node.getBoundingClientRect().height;
      if (Math.abs(height - row.height) > .5) { row.height = height; changed = true; }
    }
    if (root.clientWidth > 0 && width !== root.clientWidth) {
      const ratio = width > 0 ? width / root.clientWidth : 1;
      width = root.clientWidth;
      // Offscreen heights are provisional until the body is measured at its new width.
      for (const row of rows.values()) if (row.suspended && row.height) {
        row.height *= ratio; row.node.style.height = `${row.height}px`;
      }
      changed = true;
      if (enabled) schedule();
    }
    if (changed) restore(saved);
  }) : undefined;
  resize?.observe(root);
  function syncRoot() {
    const next = readingScroller();
    if (root === next && intersection) return;
    if (root !== next) { resize?.unobserve(root); root = next; resize?.observe(root); }
    intersection?.disconnect();
    intersection = supported ? new IntersectionObserver(intersectionsChanged, {
      root: root === document.scrollingElement ? null : root, rootMargin: '1200px 0px'
    }) : undefined;
    for (const row of rows.values()) { intersection?.observe(row.node); row.observingIntersection = Boolean(intersection); }
  }
  syncRoot();
  window.addEventListener('resize', syncRoot, { passive: true });
  document.addEventListener('scroll', event => {
    if (event.target === root || root === document.scrollingElement && event.target === document) remember();
  }, { passive: true, capture: true });
  document.addEventListener('selectionchange', () => { if (enabled) schedule(); });
  document.addEventListener('focusout', () => { if (enabled) schedule(); });
  document.addEventListener('toggle', () => { if (enabled) schedule(); }, true);
  function forget(row) {
    intersection?.unobserve(row.node); resize?.unobserve(row.node);
  }
  function reset() {
    for (const row of rows.values()) forget(row);
    rows.clear(); pending.clear(); enabled = false; position = undefined;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  }
  function prepare(messages, existing, version, atEnd) {
    syncRoot();
    if (selectionVersion !== version) { reset(); selectionVersion = version; }
    const ids = new Set(messages.map(message => message.id));
    for (const [id, row] of rows) if (!ids.has(id)) { forget(row); rows.delete(id); }
    count = messages.length;
    const wasEnabled = enabled;
    enabled = supported && count >= 160;
    initialEnd = atEnd;
    // Seed the observer window synchronously when a previously short list becomes long.
    if (enabled && !wasEnabled) {
      const bounds = root === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : root.getBoundingClientRect();
      for (const [id, node] of existing) {
        const rect = node.getBoundingClientRect();
        const row = rows.get(id);
        if (row) row.near = rect.bottom >= bounds.top - 1200 && rect.top <= bounds.bottom + 1200;
      }
    }
  }
  function keepMounted(node) {
    // Expanded processes and active forms keep their DOM state until the user closes them.
    if (node.contains(document.activeElement) || node.querySelector('details[open],dialog[open][role="dialog"]')) return true;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
    return selection.getRangeAt(0).intersectsNode(node);
  }
  function shouldMount(message, node, index, pinned) {
    let row = rows.get(message.id);
    if (!row) {
      row = { node, near: !enabled, suspended: false, height: 0 };
      rows.set(message.id, row);
    }
    return !enabled || pinned || row.near || initialEnd && index >= count - 16 || node.isConnected && keepMounted(node);
  }
  function suspend(message, node) {
    const row = rows.get(message.id);
    if (!row.suspended) {
      if (node.isConnected) {
        row.height = node.getBoundingClientRect().height;
        const style = getComputedStyle(node);
        row.marginTop = style.marginTop; row.marginBottom = style.marginBottom;
      } else {
        const columns = Math.max(20, Math.min(75, Math.floor(root.clientWidth / 9)));
        const lines = (message.text || '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
        const textHeight = message.role === 'user' ? Math.min(lines, 12) * 28 + (lines > 12 ? 36 : 0) + 24 : lines * 28;
        row.height = Math.max(28, textHeight) + (message.assets?.length ? 240 : 0) + (message.snapshot ? 44 : 0);
      }
      dispose(node); node.replaceChildren();
      row.suspended = true; resize?.unobserve(node); row.observingSize = false;
      node.classList.add('virtual-message'); node.setAttribute('aria-hidden', 'true');
      node.style.marginTop = row.marginTop || ''; node.style.marginBottom = row.marginBottom || '';
    }
    node.style.height = `${row.height}px`;
  }
  function resume(node) {
    const row = rows.get(node.dataset.id), suspended = row.suspended;
    if (suspended) {
      row.suspended = false;
      node.classList.remove('virtual-message'); node.removeAttribute('aria-hidden');
      node.style.height = ''; node.style.marginTop = ''; node.style.marginBottom = '';
    }
    return suspended;
  }
  function observe(articles) {
    for (const node of articles) {
      const row = rows.get(node.dataset.id);
      if (!row) continue;
      if (!row.observingIntersection) { intersection?.observe(node); row.observingIntersection = true; }
      // ResizeObserver keeps mounted heights current. Unchanged rows need no
      // synchronous measurement on every streamed token or status update.
      if (!row.suspended && !row.observingSize && resize) {
        resize.observe(node, { box: 'border-box' }); row.observingSize = true;
      }
    }
  }
  return { prepare, shouldMount, suspend, resume, observe, remember, reset, syncRoot };
}
