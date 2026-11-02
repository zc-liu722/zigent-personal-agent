'use strict';
// A touch context menu for user prompts. Text selection lives in its own native
// textarea so long-press recognition never competes with selection handles.
window.ZigentMessageActions = class {
  constructor({ getMessage, canEdit, onCopy, onEdit }) {
    this.getMessage = getMessage; this.canEdit = canEdit; this.onCopy = onCopy; this.onEdit = onEdit;
    const node = (tag, className, text) => {
      const element = document.createElement(tag); element.className = className || '';
      if (text !== undefined) element.textContent = text; return element;
    };
    this.dialog = node('dialog', 'message-context-dialog'); this.dialog.setAttribute('aria-label', '消息操作');
    this.preview = node('div', 'message-context-preview'); this.preview.setAttribute('aria-hidden', 'true');
    this.menu = node('div', 'message-context-menu'); this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', '消息操作');
    const icons = {
      copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
      edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15Z"/>',
      select: '<path d="M7 3H4v18h3M17 3h3v18h-3M9 7h6M12 7v10M9 17h6"/>'
    };
    this.buttons = ['copy', 'edit', 'select'].map((action, index) => {
      const button = node('button', 'message-context-item'); button.type = 'button'; button.setAttribute('role', 'menuitem');
      button.dataset.action = action; button.append(node('span', '', ['复制', '编辑', '选择文本'][index]));
      const icon = node('span', 'message-context-icon');
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg>`; button.append(icon);
      button.onclick = () => {
        const message = this.message;
        if (!message) return;
        this.dismiss({ immediate: true, restore: false });
        if (action === 'copy') this.onCopy(message.text);
        else if (action === 'edit') this.onEdit(message);
        else this.selectText(message);
      };
      this.menu.append(button); return button;
    });
    this.dialog.append(this.preview, this.menu); document.body.append(this.dialog);
    this.dialog.addEventListener('click', event => { if (event.target === this.dialog) this.dismiss(); });
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.dismiss(); });
    this.dialog.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = this.buttons.filter(button => !button.disabled), index = buttons.indexOf(document.activeElement);
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length].focus({ preventScroll: true });
    });
    this.selection = node('dialog', 'message-selection-dialog'); this.selection.setAttribute('aria-label', '选择文本');
    const header = node('header', 'message-selection-header'), title = node('h2', '', '选择文本'), done = node('button', '', '完成');
    done.type = 'button'; done.onclick = () => this.closeSelection(); header.append(title, done);
    this.selectionText = node('textarea', 'message-selection-text'); this.selectionText.readOnly = true; this.selectionText.spellcheck = false;
    this.selectionText.dataset.nativeSelection = 'true'; this.selectionText.setAttribute('aria-label', '消息文本');
    const footer = node('div', 'message-selection-footer'), all = node('button', '', '全选'); this.copySelection = node('button', '', '复制所选');
    all.type = this.copySelection.type = 'button';
    all.onclick = () => { this.selectionText.focus({ preventScroll: true }); this.selectionText.select(); updateSelection(); };
    this.copySelection.onclick = () => this.onCopy(this.selectionText.value.slice(this.selectionText.selectionStart, this.selectionText.selectionEnd));
    const updateSelection = () => { this.copySelection.disabled = this.selectionText.selectionStart === this.selectionText.selectionEnd; };
    for (const event of ['select', 'keyup', 'pointerup']) this.selectionText.addEventListener(event, updateSelection);
    document.addEventListener('selectionchange', () => { if (this.selection.open) updateSelection(); });
    footer.append(all, this.copySelection); this.selection.append(header, this.selectionText, footer); document.body.append(this.selection);
    this.selection.addEventListener('cancel', event => { event.preventDefault(); this.closeSelection(); });
    const target = event => event.target.closest?.('button, a, input, textarea, select') ? null : event.target.closest?.('.message.user .message-text');
    document.addEventListener('pointerdown', event => {
      if (!event.isPrimary) { this.cancelPress(); this.dismiss({ immediate: true }); return; }
      if (!['touch', 'pen'].includes(event.pointerType) || this.dialog.open || this.selection.open) return;
      const bubble = target(event); if (!bubble) return;
      this.cancelPress();
      this.press = { bubble, id: event.pointerId, x: event.clientX, y: event.clientY };
      bubble.classList.add('message-pressing');
      this.timer = setTimeout(() => { this.cancelPress(); this.open(bubble); }, 450);
    }, { passive: true });
    document.addEventListener('pointermove', event => {
      if (this.press && (event.pointerId !== this.press.id || Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 10)) this.cancelPress();
    }, { passive: true });
    for (const event of ['pointerup', 'pointercancel']) document.addEventListener(event, () => this.cancelPress(), { passive: true });
    document.addEventListener('contextmenu', event => {
      const bubble = target(event); if (!bubble || window.getSelection()?.toString()) return;
      event.preventDefault(); this.cancelPress(); if (!this.dialog.open) this.open(bubble);
    });
    document.addEventListener('keydown', event => {
      const bubble = target(event);
      if (bubble && (['ContextMenu', 'Enter', ' '].includes(event.key) || event.key === 'F10' && event.shiftKey)) {
        event.preventDefault(); this.open(bubble);
      }
    });
    // Pointer movement/cancellation handles touch scrolling. A layout scroll or
    // visual-viewport resize can also come from dismissing the keyboard, and
    // must not cancel a finger that is still holding the same prompt.
    document.addEventListener('wheel', () => this.cancelPress(), { passive: true, capture: true });
    const resize = () => {
      cancelAnimationFrame(this.layoutFrame);
      // The app updates its visual-viewport rectangle in the first frame. Wait
      // for that layout before avoiding the keyboard or Safari's browser bars.
      this.layoutFrame = requestAnimationFrame(() => { this.layoutFrame = requestAnimationFrame(() => this.position()); });
    };
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.close(); });
  }
  cancelPress() { clearTimeout(this.timer); this.press?.bubble.classList.remove('message-pressing'); this.press = undefined; }
  open(bubble) {
    const message = this.getMessage(bubble.dataset.messageId);
    if (!message?.text || !bubble.isConnected) return;
    this.dismiss({ immediate: true, restore: false }); this.message = message; this.anchor = bubble;
    const style = getComputedStyle(bubble);
    this.preview.textContent = message.text;
    for (const property of ['font', 'padding', 'borderRadius', 'letterSpacing', 'wordSpacing', 'textAlign']) this.preview.style[property] = style[property];
    this.buttons[1].disabled = !this.canEdit(message);
    this.dialog.showModal(); document.body.classList.add('message-context-open');
    this.position(); bubble.classList.add('message-context-source'); this.buttons[0].focus({ preventScroll: true });
  }
  position() {
    if (!this.dialog.open || !this.anchor?.isConnected) return;
    const bubble = this.anchor, rect = bubble.getBoundingClientRect(), width = parseFloat(getComputedStyle(bubble).width);
    // The pressed source is slightly scaled; its layout width keeps the preview's line breaks unchanged.
    this.preview.style.width = `${Math.min(width || bubble.offsetWidth, (window.visualViewport?.width || innerWidth) - 32)}px`;
    const bounds = this.dialog.getBoundingClientRect(), margin = 16, gap = 10, menuHeight = this.menu.offsetHeight;
    this.preview.hidden = bounds.height < menuHeight + gap + margin * 2 + 48;
    if (this.preview.hidden) {
      this.menu.style.left = `${Math.max(margin, bounds.width - this.menu.offsetWidth - margin)}px`;
      this.menu.style.top = `${Math.max(margin, (bounds.height - menuHeight) / 2)}px`; return;
    }
    this.preview.style.maxHeight = `${Math.max(48, bounds.height - menuHeight - gap - margin * 2)}px`;
    const height = this.preview.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left - bounds.left, bounds.width - this.preview.offsetWidth - margin));
    let top = Math.max(margin, Math.min(rect.top - bounds.top, bounds.height - height - margin)), menuTop;
    if (top + height + gap + menuHeight <= bounds.height - margin) menuTop = top + height + gap;
    else if (top - gap - menuHeight >= margin) menuTop = top - gap - menuHeight;
    else { top = Math.max(margin, bounds.height - height - gap - menuHeight - margin); menuTop = top + height + gap; }
    this.preview.style.left = `${left}px`; this.preview.style.top = `${top}px`;
    this.menu.style.left = `${Math.max(margin, Math.min(left + this.preview.offsetWidth - this.menu.offsetWidth, bounds.width - this.menu.offsetWidth - margin))}px`;
    this.menu.style.top = `${menuTop}px`; this.menu.style.transformOrigin = menuTop < top ? 'bottom right' : 'top right';
  }
  dismiss({ immediate = false, restore = true } = {}) {
    clearTimeout(this.dismissTimer);
    cancelAnimationFrame(this.layoutFrame);
    if (!this.dialog.open) return;
    document.body.classList.remove('message-context-open');
    const finish = () => {
      this.dialog.close(); this.dialog.classList.remove('is-closing'); this.anchor?.classList.remove('message-context-source');
      if (restore && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
      this.message = undefined;
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else { this.dialog.classList.add('is-closing'); this.dismissTimer = setTimeout(finish, 140); }
  }
  selectText(message) {
    this.selectionText.value = message.text; this.copySelection.disabled = true;
    this.selection.showModal(); this.selectionText.focus({ preventScroll: true }); this.selectionText.setSelectionRange(0, 0);
  }
  closeSelection() { this.selection.close(); this.selectionText.value = ''; if (this.anchor?.isConnected) this.anchor.focus({ preventScroll: true }); }
  close() { this.cancelPress(); this.dismiss({ immediate: true, restore: false }); if (this.selection.open) this.closeSelection(); }
};

// Mouse/keyboard use native selection. Touch owns a Range without installing it
// in window.getSelection(), so iOS never adds a second set of handles or menus.
window.ZigentReplySelection = class {
  constructor({ onAdd, onCopy, onNew, onBranch, createButton, readingScroller, readingTopEdge }) {
    this.readingScroller = readingScroller; this.readingTopEdge = readingTopEdge;
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'reply-selection-toolbar'; this.toolbar.hidden = true;
    this.toolbar.setAttribute('role', 'toolbar'); this.toolbar.setAttribute('aria-label', '所选回复操作');
    for (const [icon, label, action] of [
      ['copy', '复制', onCopy], ['reply-add', '添加到本会话', onAdd],
      ['reply-new', '添加到新会话', onNew], ['branch', '添加到分支会话', onBranch]
    ]) {
      const button = createButton(icon, label);
      button.onclick = async () => {
        if (this.pendingAction) return;
        const selected = this.read();
        if (!selected) { this.close(); return; }
        this.pendingAction = true;
        const buttons = [...this.toolbar.children];
        buttons.forEach(control => { control.disabled = true; });
        try {
          // Capture the source reply before navigation replaces the transcript.
          // Invoke clipboard/focus synchronously in the user's activation event.
          if (await action(selected.text, selected) !== false) this.close();
        } finally {
          this.pendingAction = false;
          buttons.forEach(control => { control.disabled = false; });
        }
      };
      this.toolbar.append(button);
    }
    // Focusing a toolbar button on pointerdown would collapse the source range
    // before click, especially in Safari. Keyboard focus remains available.
    this.toolbar.addEventListener('pointerdown', event => event.preventDefault());
    document.body.append(this.toolbar);
    this.highlight = document.createElement('div'); this.highlight.className = 'reply-selection-highlights';
    this.highlight.setAttribute('aria-hidden', 'true'); document.body.append(this.highlight);
    this.handles = ['start', 'end'].map(side => {
      const handle = document.createElement('span'); handle.className = `reply-selection-handle ${side}`;
      handle.hidden = true; handle.dataset.nativeSelection = 'true'; handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', event => {
        if (!event.isPrimary || !this.read()) return;
        event.preventDefault(); event.stopPropagation(); this.cancelPress();
        // Expanded line hit areas can overlap for a short selection. Resolve the
        // closest boundary instead of letting DOM order always choose the end.
        const candidates = ['start', 'end'].filter(name => !this.handles[name === 'start' ? 0 : 1].hidden);
        const hitSide = candidates.reduce((closest, name) => {
          const point = this.handlePoints[name], best = this.handlePoints[closest];
          return Math.hypot(event.clientX - point.x, event.clientY - point.y) <
            Math.hypot(event.clientX - best.x, event.clientY - best.y) ? name : closest;
        }, side);
        const point = this.handlePoints[hitSide];
        this.drag = { side: hitSide, id: event.pointerId, dx: event.clientX - point.x, dy: event.clientY - point.y };
        handle.setPointerCapture(event.pointerId); this.toolbar.hidden = true;
      });
      document.body.append(handle); return handle;
    });
    document.addEventListener('selectionchange', () => this.schedule());
    document.addEventListener('pointerdown', event => {
      if (this.toolbar.contains(event.target) || this.handles.includes(event.target)) return;
      this.cancelPress();
      this.selectionTap = undefined;
      // A right click (including macOS Control-click) must retain the range
      // until contextmenu can present its actions.
      if (event.pointerType === 'mouse' && (event.button !== 0 || event.ctrlKey)) {
        if (!this.read()) this.clearTouchRange();
        return;
      }
      if (!event.isPrimary) { this.drag = undefined; return; }
      // A touch down can become a scroll. Keep the selection until a completed
      // tap, including when the gesture starts in another reply or empty space.
      if (this.touchRange && ['touch', 'pen'].includes(event.pointerType)
        && !event.target.closest('a, button, input, textarea, select')) {
        this.selectionTap = { id: event.pointerId, x: event.clientX, y: event.clientY };
        return;
      }
      if (this.selected && !this.selected.body.contains(event.target)) this.close();
      if (event.pointerType === 'mouse') this.clearTouchRange();
      if (!['touch', 'pen'].includes(event.pointerType) || event.target.closest('a, button, input, textarea, select, .activity')) return;
      const body = event.target.closest('.message.assistant > .message-text');
      if (!body) return;
      if (this.touchRange) this.close();
      if (this.read()) window.getSelection()?.removeAllRanges();
      // Disable native touch selection before Safari recognises the hold. Keep
      // touchstart available for normal scrolling and pinch zoom.
      if (this.touchBody !== body) this.clearTouchRange();
      this.touchBody = body; body.dataset.replyTouchSelection = 'true';
      this.press = { body, x: event.clientX, y: event.clientY, id: event.pointerId, point: this.caret(event.clientX, event.clientY, body) };
      this.pressTimer = setTimeout(() => {
        const press = this.press;
        if (!press || !body.isConnected || this.read()) return;
        // Remember the touched text before dismissing a keyboard can move it.
        const point = press.point || this.caret(press.x, press.y, body);
        const range = this.wordRange(point);
        if (!range) return;
        this.touchRange = range; this.holdBody = body;
        window.getSelection()?.removeAllRanges(); this.sync();
      }, 450);
    });
    document.addEventListener('pointermove', event => {
      const tap = this.selectionTap;
      if (tap && (event.pointerId !== tap.id || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10)) this.selectionTap = undefined;
      if (this.press && (event.pointerId !== this.press.id || Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 10)) this.cancelPress();
      if (!this.drag || this.drag.id !== event.pointerId) return;
      event.preventDefault(); this.drag.x = event.clientX - this.drag.dx; this.drag.y = event.clientY - this.drag.dy;
      this.moveHandle();
    }, { passive: false });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) document.addEventListener(type, event => {
      if (type === 'pointerup' && this.selectionTap?.id === event.pointerId) this.close();
      this.selectionTap = undefined;
      this.cancelPress(); this.drag = undefined; cancelAnimationFrame(this.dragFrame); this.schedule();
    });
    document.addEventListener('touchend', event => {
      if (this.holdBody && event.cancelable) event.preventDefault();
      this.holdBody = undefined;
    }, { passive: false });
    document.addEventListener('touchcancel', () => { this.holdBody = undefined; });
    document.addEventListener('wheel', () => this.cancelPress(), { passive: true, capture: true });
    document.addEventListener('contextmenu', event => {
      const target = event.target;
      if (this.toolbar.contains(target) || this.handles.includes(target)) { event.preventDefault(); return; }
      const body = target.closest('.message.assistant > .message-text');
      if (!body || target.closest('input, textarea, select, [contenteditable="true"], .activity, [data-selection-control]')) return;
      // Cancel in capture phase even before a selection exists, and on the
      // toolbar itself, so browser menus cannot cover the reply actions.
      event.preventDefault();
      // Touch long-press recognition and selection handles keep their own
      // Range; do not replace it with a native selection on mobile browsers.
      if (body.hasAttribute('data-reply-touch-selection')) { this.schedule(); return; }
      this.cancelPress(); this.selectionTap = undefined;
      if (this.read()?.body !== body) this.close();
      if (!this.read()) {
        const range = this.wordRange(this.caret(event.clientX, event.clientY, body));
        if (range) {
          this.clearTouchRange();
          const selection = window.getSelection();
          selection.removeAllRanges(); selection.addRange(range);
        }
      }
      this.sync();
    }, { capture: true });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.selected) {
        const body = this.selected.body, restoreFocus = this.toolbar.contains(document.activeElement);
        this.close(); if (restoreFocus) { body.tabIndex = -1; body.focus({ preventScroll: true }); }
      }
    });
    document.addEventListener('scroll', () => { this.cancelPress(); this.selectionTap = undefined; this.schedule(); }, { passive: true, capture: true });
    window.addEventListener('resize', () => this.schedule());
    window.visualViewport?.addEventListener('resize', () => this.schedule());
    window.visualViewport?.addEventListener('scroll', () => this.schedule());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.close(); });
  }
  clearTouchRange() {
    if (this.touchBody) delete this.touchBody.dataset.replyTouchSelection;
    this.touchBody = undefined; this.touchRange = undefined; this.holdBody = undefined;
    this.highlight.replaceChildren();
  }
  cancelPress() { clearTimeout(this.pressTimer); this.press = undefined; }
  caret(x, y, body) {
    const position = document.caretPositionFromPoint?.(x, y), range = position ? undefined : document.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode || range?.startContainer, offset = position?.offset ?? range?.startOffset;
    if (node?.nodeType !== Node.TEXT_NODE || !body.contains(node) || node.parentElement.closest('button, input, textarea, select, .activity, [data-selection-control]')) return;
    return { node, offset };
  }
  wordRange(point) {
    if (!point) return;
    const text = point.node.textContent, offset = Math.min(point.offset, text.length - 1);
    const segments = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text) : [];
    const word = [...segments].find(part => part.index <= offset && part.index + part.segment.length > offset);
    const start = word?.index ?? offset, end = start + (word?.segment.length || 1);
    if (start < 0 || !text.slice(start, end).trim()) return;
    const range = document.createRange(); range.setStart(point.node, start); range.setEnd(point.node, end);
    return range;
  }
  moveHandle() {
    cancelAnimationFrame(this.dragFrame);
    const selected = this.read(), drag = this.drag;
    if (!selected || !drag || drag.x === undefined) return;
    const timeline = this.readingScroller(), bounds = this.readingBounds();
    const y = Math.max(bounds.top + 2, Math.min(drag.y, bounds.bottom - 2));
    const point = this.caret(drag.x, y, selected.body);
    if (point) {
      const range = selected.range.cloneRange(), comparison = range.comparePoint(point.node, point.offset);
      if (drag.side === 'start' && comparison <= 0) range.setStart(point.node, point.offset);
      else if (drag.side === 'end' && comparison >= 0) range.setEnd(point.node, point.offset);
      if (!range.collapsed) this.touchRange = range;
    }
    this.sync();
    // Continue expanding a long selection when a handle reaches the reading edge.
    const scroll = drag.y < bounds.top + 28 ? -8 : drag.y > bounds.bottom - 28 ? 8 : 0;
    const before = timeline.scrollTop;
    if (scroll) timeline.scrollTop += scroll;
    if (timeline.scrollTop !== before) this.dragFrame = requestAnimationFrame(() => this.moveHandle());
  }
  read() {
    const selection = window.getSelection();
    const range = this.touchRange || (selection?.rangeCount === 1 && !selection.isCollapsed ? selection.getRangeAt(0) : undefined);
    if (!range || range.collapsed) return;
    const element = node => node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const start = element(range.startContainer), end = element(range.endContainer);
    const body = start?.closest('.message.assistant > .message-text');
    if (!body?.isConnected || !body.contains(range.endContainer) || body.closest('[hidden], [inert]')) return;
    // Selecting code is supported; embedded copy buttons are not reply text.
    const controls = 'button, input, textarea, select';
    const fragment = range.cloneContents();
    if (start.closest('.activity, [data-selection-control]') || end?.closest('.activity, [data-selection-control]')) return;
    const processes = [...fragment.querySelectorAll('.activity, [data-selection-control]')];
    for (const process of processes) process.remove();
    if (start.closest(controls) || end?.closest(controls) || fragment.querySelector(controls)) return;
    // Native Selection includes rendered paragraph breaks; Range.toString()
    // does not. Retain those boundaries when copying an app-owned touch range.
    let text;
    if (this.touchRange || processes.length) {
      for (const br of fragment.querySelectorAll('br')) br.replaceWith('\n');
      for (const block of fragment.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, pre, blockquote, li, tr')) {
        block.prepend('\n'); block.append('\n');
      }
      for (const cell of fragment.querySelectorAll('td, th')) cell.append('\t');
      text = fragment.textContent.replace(/^\n+|\n+$/g, '');
    } else text = selection.toString();
    if (!text.trim()) return;
    return { body, range, text };
  }
  isSelecting(target) { const selected = this.read(); return Boolean(selected && selected.body.contains(target)); }
  schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.sync());
  }
  textRects({ body, range }) {
    // Element rectangles include complete paragraphs as well as their inline
    // descendants. Measure only selected text to avoid painting either twice.
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), rects = [];
    for (let node; (node = walker.nextNode());) {
      if (!range.intersectsNode(node) || node.parentElement.closest('.activity, [data-selection-control], button, input, textarea, select')) continue;
      const part = document.createRange(); part.selectNodeContents(node);
      if (node === range.startContainer) part.setStart(node, range.startOffset);
      if (node === range.endContainer) part.setEnd(node, range.endOffset);
      if (!part.collapsed) rects.push(...part.getClientRects());
    }
    return rects.filter(rect => rect.width && rect.height);
  }
  readingBounds() {
    const bounds = document.getElementById('timeline').getBoundingClientRect();
    // Floating controls cover part of the full-height scrollport. Keep selection
    // handles and their toolbar in the unobscured reading area.
    return { top: Math.max(bounds.top, this.readingTopEdge()),
      bottom: Math.min(bounds.bottom, document.querySelector('.composer-area').getBoundingClientRect().top) };
  }
  sync() {
    this.selected = this.read();
    const scrollingElement = document.scrollingElement || document.documentElement;
    const documentFlow = this.readingScroller() === scrollingElement;
    const offsetX = documentFlow ? window.scrollX : 0, offsetY = documentFlow ? window.scrollY : 0;
    // Document scrolling moves the transcript on Safari's compositor. Put every
    // selection visual in that same coordinate system instead of repainting a
    // fixed overlay after each scroll event; nested desktop scrolling stays fixed.
    for (const element of [this.highlight, this.toolbar, ...this.handles]) element.classList.toggle('document-flow', documentFlow);
    this.toolbar.hidden = true;
    this.highlight.replaceChildren();
    this.handles.forEach(handle => { handle.hidden = true; });
    if (!this.selected || document.querySelector('dialog:modal, .conversation-sidebar.open')) return;
    const viewport = window.visualViewport, timeline = this.readingBounds();
    const left = (viewport?.offsetLeft || 0) + 8, right = left + (viewport?.width || innerWidth) - 16;
    const top = Math.max((viewport?.offsetTop || 0) + 8, timeline.top + 8);
    const bottom = Math.min((viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - 8, timeline.bottom - 8);
    const allRects = this.textRects(this.selected);
    const rects = allRects.filter(rect =>
      rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right);
    if (!rects.length) return;
    if (this.touchRange) {
      // Range rectangles also support older Safari versions without CSS
      // Highlights. They are clipped to the reading area and ignore all input.
      const seen = new Set();
      for (const rect of rects) {
        const x = Math.max(left, rect.left), y = Math.max(top, rect.top);
        const width = Math.min(right, rect.right) - x, height = Math.min(bottom, rect.bottom) - y;
        const key = [x, y, width, height].join(','); if (seen.has(key)) continue;
        seen.add(key);
        const mark = document.createElement('span');
        Object.assign(mark.style, { left: `${x + offsetX}px`, top: `${y + offsetY}px`, width: `${width}px`, height: `${height}px` });
        this.highlight.append(mark);
      }
      this.handlePoints = {};
      [allRects[0], allRects.at(-1)].forEach((rect, index) => {
        const handle = this.handles[index], side = index ? 'end' : 'start', x = index ? rect.right : rect.left;
        this.handlePoints[side] = { x, y: rect.top + rect.height / 2 };
        if (rect.bottom <= top || rect.top >= bottom || x < left || x > right) return;
        handle.style.left = `${x - 28 + offsetX}px`;
        handle.style.top = `${(index ? rect.top : rect.top - 44) + offsetY}px`;
        handle.style.setProperty('--selection-line-height', `${rect.height}px`); handle.hidden = false;
      });
    }
    if (this.drag) return;
    this.toolbar.hidden = false;
    const width = this.toolbar.offsetWidth, height = this.toolbar.offsetHeight, first = rects[0], last = rects.at(-1);
    if (bottom - top < height) { this.toolbar.hidden = true; return; }
    const y = first.top - height - 12 >= top ? first.top - height - 12 : last.bottom + 12;
    this.toolbar.style.left = `${Math.max(left, Math.min((first.left + first.right - width) / 2, right - width)) + offsetX}px`;
    this.toolbar.style.top = `${Math.max(top, Math.min(y, bottom - height)) + offsetY}px`;
  }
  close() {
    this.selectionTap = undefined;
    cancelAnimationFrame(this.frame);
    this.cancelPress(); cancelAnimationFrame(this.dragFrame); this.drag = undefined;
    if (!this.touchRange && this.read()) window.getSelection().removeAllRanges();
    this.clearTouchRange();
    this.selected = undefined; this.toolbar.hidden = true;
    this.handles.forEach(handle => { handle.hidden = true; });
  }
};
