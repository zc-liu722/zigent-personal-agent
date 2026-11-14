import { el, messageButton, syncChildren } from './dom.js';

const blocks = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th';
const textBoundaries = `${blocks},div,br`;
const excluded = '.activity, [data-selection-control], .conversation-output, button, input, textarea, select, [hidden]';
const normalize = text => text.replace(/\s+/g, ' ').trim();

function indexReplyText(body) {
  const parts = [];
  let text = '';
  // Keep offsets in rendered text independent of markup and viewport wrapping.
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE && node.length) {
      const start = text.length;
      text += node.data;
      parts.push({ node, start, end: text.length });
    } else if (node.nodeType === Node.ELEMENT_NODE && !node.matches(excluded)) {
      const boundary = node.matches(textBoundaries);
      if (boundary) text += '\n';
      node.childNodes.forEach(visit);
      if (boundary) text += '\n';
    }
  }
  body.childNodes.forEach(visit);
  // Preserve the block numbering used by older annotations.
  const candidates = [...body.querySelectorAll(blocks)]
    .filter(node => !node.closest('.activity, [data-selection-control], .conversation-output'));
  return { text, parts, candidates };
}

function locateAnnotation({ text, parts, candidates }, { anchor, block, quote }) {
  const excerpt = normalize(quote);
  if (anchor && anchor.end <= text.length && normalize(text.slice(anchor.start, anchor.end)) === excerpt) return anchor;

  const target = candidates[block];
  const first = target && parts.find(part => target.contains(part.node));
  const last = first && parts.findLast(part => target.contains(part.node));
  const words = excerpt.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(words.join('\\s+'), 'g');
  pattern.lastIndex = first?.start ?? 0;
  let match = pattern.exec(text);
  if (first && (!match || match.index >= last.end)) {
    pattern.lastIndex = 0;
    match = pattern.exec(text);
  }
  if (match) return { start: match.index, end: match.index + match[0].length };
  const fallback = first || parts[0];
  return fallback ? { start: fallback.start, end: last?.end ?? fallback.end } : undefined;
}

function selectionAnchor(parts, span, visible) {
  if (!span) return;
  const range = document.createRange(), rects = [];
  for (const { node, start, end } of parts) {
    if (start >= span.end) break;
    if (end <= span.start) continue;
    range.setStart(node, Math.max(0, span.start - start));
    range.setEnd(node, Math.min(node.length, span.end - start));
    const clip = node.parentElement.closest('.table-scroll, .preserve-layout pre, .math-inline, .math-block')?.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      const left = Math.max(rect.left, clip?.left ?? -Infinity), right = Math.min(rect.right, clip?.right ?? Infinity);
      if (right <= left || !rect.height) continue;
      if (visible && (rect.bottom <= visible.top || rect.top >= visible.bottom || right <= visible.left || left >= visible.right)) continue;
      rects.push({ left, right, top: rect.top, bottom: rect.bottom });
    }
  }
  if (!rects.length) return;
  const first = rects.reduce((top, rect) => rect.top < top.top ? rect : top);
  const middle = (first.top + first.bottom) / 2;
  const line = rects.filter(rect => rect.top <= middle && rect.bottom > middle);
  return { left: Math.min(...line.map(rect => rect.left)), right: Math.max(...line.map(rect => rect.right)),
    top: first.top, bottom: Math.max(...line.map(rect => rect.bottom)) };
}

/** Notes belong to their source reply; only explicit composer actions quote them. */
export function createReplyAnnotations({ api, getConversation, getMessages, onChange, onAdd, onNew, onBranch, toast, readingScroller, readingTopEdge }) {
  let current, pending = false, returnFocus;
  const markerViews = new WeakMap();
  const dialog = el('dialog', 'reply-annotation-dialog');
  dialog.setAttribute('aria-label', '批注');
  const cancel = messageButton('close', '取消批注'), done = messageButton('check', '保存批注');
  const input = el('textarea'); input.maxLength = 4000; input.rows = 1; input.placeholder = '写批注…';
  input.setAttribute('aria-label', '批注内容');
  const status = el('p', 'reply-annotation-status'); status.setAttribute('role', 'status');
  const footer = el('footer'), actions = [];
  for (const [icon, label, action] of [
    ['reply-add', '添加到本会话', onAdd], ['reply-new', '添加到新会话', onNew], ['branch', '添加到分支会话', onBranch]
  ]) {
    const button = messageButton(icon, label);
    button.onclick = () => run(async () => {
      if (current.conversationId !== getConversation()) { status.textContent = '请回到批注所在会话后再添加。'; return; }
      if (!await save()) return;
      const source = current;
      const selected = { messageId: current.messageId, conversationId: current.conversationId };
      const text = `${current.annotation.quote}\n\n批注：${current.annotation.text}`;
      dialog.close();
      const result = await action(text, selected);
      if (current !== source) return;
      if (result === false) { dialog.show(); position(); }
      else current = undefined;
    });
    actions.push(button); footer.append(button);
  }
  const remove = messageButton('delete', '删除批注'); footer.append(done, remove, cancel);
  const controls = [cancel, done, ...actions, remove];
  const field = el('div', 'reply-annotation-field');
  field.append(input, footer); dialog.append(field, status); document.body.append(dialog);
  const messages = document.getElementById('messages');
  let markerFrame;
  function scheduleMarkers() {
    if (markerFrame !== undefined) return;
    markerFrame = requestAnimationFrame(() => {
      markerFrame = undefined;
      const placements = [];
      for (const article of messages.querySelectorAll('.reply-annotation-source')) {
        const view = markerViews.get(article);
        if (!view?.layer.isConnected) continue;
        const index = indexReplyText(view.body), origin = view.layer.getBoundingClientRect();
        const positions = new Map();
        for (const { annotation, button } of view.entries) {
          const anchor = selectionAnchor(index.parts, locateAnnotation(index, annotation));
          if (!anchor) { placements.push({ button }); continue; }
          const left = anchor.right - origin.left, top = anchor.top - origin.top;
          const corner = `${Math.round(left)}:${Math.round(top)}`;
          const offset = positions.get(corner) ?? 0;
          placements.push({ button, left: left - offset, top });
          positions.set(corner, offset + button.offsetWidth + 3);
        }
      }
      for (const { button, left, top } of placements) {
        button.style.visibility = left === undefined ? '' : 'visible';
        if (left === undefined) continue;
        button.style.left = `${left}px`;
        button.style.top = `${top}px`;
      }
    });
  }
  let positionFrame;
  function schedulePosition() {
    if (!dialog.open) return;
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(position);
  }
  function position() {
    if (!dialog.open || !current) return;
    const source = [...messages.children]
      .find(article => article.dataset.id === current.messageId);
    const body = source?.querySelector(':scope > .message-text');
    if (!body) { dialog.style.visibility = 'hidden'; return; }
    const viewport = window.visualViewport, margin = 8;
    const left = (viewport?.offsetLeft || 0) + margin;
    const right = left + (viewport?.width || innerWidth) - margin * 2;
    const top = Math.max((viewport?.offsetTop || 0) + margin, (readingTopEdge?.() || 0) + margin);
    const bottom = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - margin;
    const index = indexReplyText(body);
    const span = locateAnnotation(index, current.annotation);
    const anchor = selectionAnchor(index.parts, span, { left, right, top, bottom });
    if (!anchor) { dialog.style.visibility = 'hidden'; return; }
    const documentFlow = readingScroller?.() === (document.scrollingElement || document.documentElement);
    dialog.classList.toggle('document-flow', documentFlow);
    const leftSpace = anchor.right - left, rightSpace = right - anchor.right;
    const alignRight = leftSpace >= 280 || leftSpace >= rightSpace;
    dialog.style.width = `${Math.min(380, right - left, Math.max(280, alignRight ? leftSpace : rightSpace))}px`;
    const width = dialog.offsetWidth, height = dialog.offsetHeight;
    const y = anchor.top - height - margin >= top ? anchor.top - height - margin : anchor.bottom + margin;
    const x = alignRight ? anchor.right - width : anchor.right;
    dialog.style.left = `${Math.max(left, Math.min(x, right - width)) + (documentFlow ? scrollX : 0)}px`;
    dialog.style.top = `${Math.max(top, Math.min(y, bottom - height)) + (documentFlow ? scrollY : 0)}px`;
    dialog.style.visibility = '';
  }
  document.addEventListener('scroll', event => {
    schedulePosition();
    if (event.target.closest?.('.reply-annotation-source')) scheduleMarkers();
  }, { passive: true, capture: true });
  function relayout() { scheduleMarkers(); schedulePosition(); }
  window.addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('resize', schedulePosition);
  window.visualViewport?.addEventListener('scroll', schedulePosition);
  document.fonts?.addEventListener('loadingdone', relayout);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedulePosition).observe(dialog);
    new ResizeObserver(relayout).observe(messages);
  }
  async function run(action) {
    if (pending || !current) return;
    const source = current;
    pending = true; controls.forEach(button => { button.disabled = true; }); input.readOnly = true; status.textContent = '';
    try { await action(); }
    catch (error) {
      if (current === source) { status.textContent = error.message || '保存失败，请重试。'; if (!dialog.open) dialog.show(); schedulePosition(); }
    }
    finally { pending = false; controls.forEach(button => { button.disabled = false; }); input.readOnly = false; }
  }
  function update(annotations) {
    if (current.conversationId === getConversation()) {
      const message = getMessages().find(item => item.id === current.messageId);
      if (message) { message.annotations = annotations; onChange(); }
    }
  }
  async function save() {
    const text = input.value.trim();
    if (!text) { status.textContent = '请填写批注。'; input.focus(); return false; }
    const source = current, annotation = source.annotation;
    if (annotation.version && annotation.text === text) return true;
    const result = await api('messages/annotations', 'POST', {
      conversationId: current.conversationId, messageId: current.messageId,
      id: annotation.id, version: annotation.version, quote: annotation.quote, text, block: annotation.block, anchor: annotation.anchor
    });
    if (current !== source) return false;
    current.annotation = result.annotation; input.value = result.annotation.text;
    dialog.setAttribute('aria-label', `批注 ${result.annotation.number}`); remove.hidden = false; update(result.annotations);
    return true;
  }
  function finish({ restoreFocus = true } = {}) {
    return run(async () => {
      if (input.value.trim() && !await save()) return;
      dialog.close(); current = undefined;
      if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  }
  done.onclick = finish;
  cancel.onclick = () => {
    dialog.close(); current = undefined;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); void finish(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void finish(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && dialog.open && !document.querySelector('dialog:modal')) {
      event.preventDefault(); void finish();
    }
  });
  document.addEventListener('click', event => {
    if (!dialog.open || dialog.contains(event.target) ||
      event.target.closest?.('.reply-selection-toolbar, .reply-annotation-marker')) return;
    void finish({ restoreFocus: false });
  });
  remove.onclick = () => run(async () => {
    const source = current;
    const result = await api('messages/annotations', 'DELETE', {
      conversationId: current.conversationId, messageId: current.messageId,
      id: current.annotation.id, version: current.annotation.version
    });
    if (current !== source) return;
    update(result.annotations); dialog.close(); current = undefined;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  function open(messageId, annotation, focus) {
    if (pending || dialog.open) return false;
    current = { conversationId: getConversation(), messageId, annotation: { ...annotation } }; returnFocus = focus;
    dialog.setAttribute('aria-label', annotation.number ? `批注 ${annotation.number}` : '写批注');
    input.title = annotation.quote; input.value = annotation.text; status.textContent = ''; remove.hidden = !annotation.version;
    dialog.show(); position(); input.focus({ preventScroll: true }); schedulePosition();
  }
  function annotate(text, selected) {
    if (text.length > 16000) { toast('所选内容过长，请缩短后批注。'); return false; }
    const { body, range } = selected;
    const messageId = body.closest('.message')?.dataset.id;
    if (!getMessages().some(message => message.id === messageId)) return false;
    const { parts, candidates } = indexReplyText(body);
    const selectedParts = parts.filter(({ node }) => range.intersectsNode(node)
      && !(node === range.startContainer && range.startOffset === node.length)
      && !(node === range.endContainer && range.endOffset === 0));
    if (!selectedParts.length) return false;
    const first = selectedParts[0], last = selectedParts.at(-1);
    const anchor = {
      start: first.start + (first.node === range.startContainer ? range.startOffset : 0),
      end: last.start + (last.node === range.endContainer ? range.endOffset : last.node.length)
    };
    const block = candidates.indexOf(first.node.parentElement.closest(blocks));
    const annotation = { id: crypto.randomUUID(), quote: text, text: '', block, anchor, version: 0 };
    return open(messageId, annotation, body);
  }
  function render(message, article, body) {
    if (current?.messageId === message.id) schedulePosition();
    const hasAnnotations = Boolean(body && message.annotations?.length);
    article.classList.toggle('reply-annotation-source', hasAnnotations);
    if (!hasAnnotations) { markerViews.delete(article); return; }
    let view = markerViews.get(article);
    if (!view) {
      const layer = el('div', 'reply-annotation-markers');
      layer.dataset.selectionControl = 'true';
      view = { layer, entries: [] };
      markerViews.set(article, view);
    }
    view.body = body;
    const buttons = new Map(view.entries.map(({ annotation, button }) => [annotation.id, button]));
    view.entries = message.annotations.map(annotation => {
      const button = buttons.get(annotation.id) || el('button', 'reply-annotation-marker', String(annotation.number));
      button.type = 'button';
      button.title = annotation.text; button.setAttribute('aria-label', `查看批注 ${annotation.number}`);
      button.onclick = () => open(message.id, annotation, button);
      return { annotation, button };
    });
    syncChildren(view.layer, view.entries.map(({ button }) => button));
    scheduleMarkers();
    return view.layer;
  }
  return { annotate, render, close: finish, reset: () => { dialog.close(); current = undefined; input.value = ''; input.title = ''; } };
}
