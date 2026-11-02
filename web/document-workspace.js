/* One rendered Markdown surface; drafts stay private until explicitly saved. */
(() => {
  const drafts = new Map();
  let active = null, counter = 0, background = null;
  const mobile = window.matchMedia?.('(max-width: 900px), (max-width: 1024px) and (pointer: coarse)');

  function syncBackground() {
    const shell = document.querySelector('.app-shell');
    if (active?.view) {
      active.view.panel.setAttribute('role', mobile?.matches ? 'dialog' : 'complementary');
      active.view.panel.setAttribute('aria-modal', String(!!mobile?.matches));
    }
    if (active && mobile?.matches && shell) {
      if (!background) background = { shell, inert: shell.inert };
      shell.inert = true;
    } else if (background) {
      background.shell.inert = background.inert; background = null;
    }
  }
  mobile?.addEventListener('change', syncBackground);
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function iconButton(label, className, path, action) {
    const node = element('button', className);
    node.type = 'button'; node.setAttribute('aria-label', label); node.title = label;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path'); shape.setAttribute('d', path);
    svg.append(shape); node.append(svg); node.addEventListener('click', action);
    return node;
  }
  const savePath = 'M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7 3v6h9V3M7 21v-8h10v8';
  const dirty = state => state.content !== state.savedContent;
  const needsSave = state => dirty(state) || state.saveRequired;
  const snapshot = state => state ? ({ key: state.key, content: state.content, revision: state.revision,
    dirty: dirty(state), saveRequired: state.saveRequired, saving: state.saving, conflict: !!state.remote, error: state.error }) : null;

  function update(state) {
    if (active !== state || !state.view) return;
    const v = state.view;
    v.title.textContent = state.options.title || '文档';
    const label = state.saving ? '正在保存' : state.options.saveLabel || '保存修改';
    v.save.setAttribute('aria-label', label); v.save.title = label;
    v.save.hidden = state.options.editable === false;
    v.save.disabled = state.saving || state.reloading || !state.options.onSave || !needsSave(state);
    v.save.dataset.state = state.saving ? 'saving' : needsSave(state) ? 'dirty' : state.didSave ? 'saved' : 'idle';
    v.save.setAttribute('aria-busy', String(state.saving));
    v.save.querySelector('path').setAttribute('d', state.didSave && !needsSave(state) ? 'm5 12 4 4L19 6' : savePath);
    v.editor.setEditable(!state.reloading && !!state.options.onSave);
    v.feedback.textContent = state.error || '';
    v.feedback.hidden = !state.error;
    v.conflict.hidden = !state.remote && !(state.error && state.options.onReload);
    v.conflictText.textContent = state.reloadArmed ? '载入新版会替换这里尚未保存的修改。' : state.remote ? '文档已有新版本，你的修改仍保留在这里。' : '你的修改已保留，也可以重新载入最新文档。';
    v.conflictText.hidden = !!state.error && !state.remote && !state.reloadArmed;
    v.notice.hidden = v.feedback.hidden && v.conflict.hidden;
    v.reload.textContent = state.reloading ? '正在载入…' : state.reloadArmed ? '放弃草稿并载入' : '重新载入';
    v.reload.disabled = state.saving || state.reloading;
  }

  async function save(state) {
    if (state.saving || state.reloading || !needsSave(state) || !state.options.onSave) return;
    state.saving = true; state.error = '';
    const content = state.content, revision = state.revision;
    update(state);
    try {
      const result = await state.options.onSave({ content, revision });
      if (!result || typeof result.content !== 'string' || result.revision === undefined) throw new Error('保存未完成，请重试。');
      state.savedContent = result.content; state.saveRequired = false; state.didSave = true;
      if (state.content === content) {
        state.content = result.content;
        if (active === state) state.view.editor.setContent(state.content);
      }
      state.revision = result.revision;
      if (!state.remote || state.remote.revision === result.revision || state.remote.revision === revision) state.remote = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : '暂时无法保存，修改已保留，请重试。';
    } finally { state.saving = false; update(state); }
  }

  async function reload(state) {
    if (state.saving || state.reloading) return;
    if (dirty(state) && !state.reloadArmed) { state.reloadArmed = true; update(state); return; }
    state.reloading = true; state.reloadArmed = false; update(state);
    try {
      const latest = state.options.onReload ? await state.options.onReload() : state.remote;
      if (!latest || typeof latest.content !== 'string' || latest.revision === undefined) throw new Error('暂时无法载入新版，请重试。');
      state.content = state.savedContent = latest.content;
      state.revision = latest.revision; state.remote = null; state.error = ''; state.didSave = false;
      if (typeof latest.pending === 'boolean') state.saveRequired = latest.pending;
      if (active === state) state.view.editor.setContent(state.content);
    } catch (error) { state.error = error instanceof Error ? error.message : '暂时无法载入新版，修改已保留。'; }
    finally { state.reloading = false; update(state); }
  }

  function close() {
    if (!active) return;
    const state = active; active = null;
    state.view.editor.destroy(); state.view.panel.remove(); state.view = null;
    document.body.classList.remove('document-workspace-open'); syncBackground();
    state.options.onClose?.();
    if (state.opener?.isConnected) state.opener.focus({ preventScroll: true });
  }

  function mount(state) {
    const id = `document-workspace-${++counter}`;
    const panel = element('section', 'document-workspace');
    panel.setAttribute('aria-labelledby', `${id}-title`);
    const header = element('header', 'document-workspace-header');
    const title = element('h2', 'document-workspace-title'); title.id = `${id}-title`;
    const actions = element('div', 'document-workspace-actions');
    const saveButton = iconButton('保存修改', 'document-workspace-save', savePath, () => save(state));
    const back = iconButton('返回对话', 'document-workspace-back', 'M19 12H5m6-6-6 6 6 6', close);
    actions.append(saveButton, back); header.append(title, actions);
    const feedback = element('p', 'document-workspace-feedback'); feedback.setAttribute('role', 'alert');
    const conflict = element('div', 'document-workspace-conflict'); conflict.setAttribute('role', 'status');
    const conflictText = element('p');
    const reloadButton = element('button', '', '重新载入'); reloadButton.type = 'button'; reloadButton.addEventListener('click', () => reload(state));
    conflict.append(conflictText, reloadButton);
    const notice = element('div', 'document-workspace-notice'); notice.append(feedback, conflict);
    const body = element('div', 'document-workspace-body');
    const surface = element('div', 'document-workspace-surface'); body.append(surface);
    panel.append(header, notice, body);
    panel.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(state); }
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab' && mobile?.matches) {
        const focusable = [...panel.querySelectorAll('button, [contenteditable="true"], [tabindex="0"]')].filter(node => node.tabIndex !== -1 && !node.disabled && !node.hidden && node.getClientRects().length);
        const index = focusable.indexOf(document.activeElement);
        const next = index < 0 ? (event.shiftKey ? focusable.length - 1 : 0)
          : (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
        event.preventDefault(); focusable[next]?.focus();
      }
    });
    document.body.append(panel); document.body.classList.add('document-workspace-open');
    const editor = window.ZigentMarkdownEditor.create({ mount: surface, content: state.content,
      memory: ['longTermMemory', 'behaviorRules'].includes(state.options.id), onChange: content => {
      state.content = content; state.error = ''; state.reloadArmed = false; update(state);
    } });
    state.view = { panel, title, editor, save: saveButton, notice, feedback, conflict, conflictText, reload: reloadButton };
    syncBackground(); update(state); panel.tabIndex = -1; panel.focus({ preventScroll: true });
  }

  function open(options) {
    if (!options || typeof options.key !== 'string' || typeof options.content !== 'string') throw new TypeError('Document key and content are required');
    let state = drafts.get(options.key);
    if (!state) {
      state = { key: options.key, content: options.content, savedContent: options.content, revision: options.revision,
        saving: false, saveRequired: options.saveRequired === true, error: '', remote: null, reloadArmed: false, reloading: false, didSave: false };
      drafts.set(options.key, state);
    } else if (options.revision !== state.revision || options.content !== state.savedContent) {
      if (dirty(state) || state.saving) state.remote = { content: options.content, revision: options.revision };
      else {
        state.content = state.savedContent = options.content; state.revision = options.revision; state.remote = null;
        state.saveRequired = options.saveRequired === true;
        if (state.view) state.view.editor.setContent(state.content);
      }
    }
    state.options = { ...options };
    if (active === state) { update(state); return { close: () => { if (active === state) close(); }, getState: () => snapshot(state) }; }
    close(); state.opener = document.activeElement; active = state; mount(state);
    return { close: () => { if (active === state) close(); }, getState: () => snapshot(state) };
  }

  window.addEventListener('beforeunload', event => {
    if ([...drafts.values()].some(dirty)) { event.preventDefault(); event.returnValue = ''; }
  });
  window.ZigentDocumentWorkspace = { open, close, clear: () => { close(); drafts.clear(); }, getState: () => snapshot(active) };
})();
