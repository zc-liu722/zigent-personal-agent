(() => {
  let active, generation = 0, frameTimer, stateTimer, frameUrl, trigger, gesture, lastPointerAt = 0, dragEnabled = false, panEnabled = false, fitEnabled = true;
  let frameSocket, frameSocketRetry, frameSocketActive = false, inputBoostTimer;
  let editorQueue = [], editorDrain;
  const editors = new Map(), passwordMask = "\ue000";
  const touches = new Set(), inputGestures = new Set();
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text) node.textContent = text; return node; };
  const dialog = el('dialog', 'browser-workspace'); dialog.setAttribute('aria-label', '浏览器工作区');
  const header = el('header', 'browser-heading'), close = el('button', 'browser-close', '‹'); close.type = 'button'; close.setAttribute('aria-label', '返回对话');
  const site = el('button', 'browser-site'), title = el('strong', '', '浏览器'), status = el('span', 'browser-status'); site.type = 'button'; site.setAttribute('aria-label', '编辑网址'); status.setAttribute('role', 'status'); site.append(title, status);
  const take = el('button', 'browser-take', '接管'), more = el('button', 'browser-more', '⋯'); take.type = more.type = 'button'; more.setAttribute('aria-label', '浏览器操作'); more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'browser-drawer');
  header.append(close, site, take, more);
  const drawer = el('section', 'browser-drawer'); drawer.id = 'browser-drawer'; drawer.hidden = true; drawer.setAttribute('aria-label', '浏览器操作');
  const drawerHeading = el('div', 'browser-drawer-heading'), drawerTitle = el('strong', '', '浏览与操作'), drawerClose = el('button', '', '×'); drawerClose.type = 'button'; drawerClose.setAttribute('aria-label', '收起操作'); drawerHeading.append(drawerTitle, drawerClose);
  const tabs = el('nav', 'browser-tabs'); tabs.setAttribute('aria-label', '浏览器标签页');
  const address = el('form', 'browser-address'), url = el('input'), go = el('button', '', '前往');
  url.setAttribute('aria-label', '网址'); url.type = 'url'; url.placeholder = '输入网址'; url.autocomplete = 'off'; address.append(url, go);
  const drawerActions = el('div', 'browser-drawer-actions'), newTab = el('button', '', '新标签'), pageLayout = el('button', '', '手机版'), pause = el('button', '', '暂停'), stop = el('button', '', '停止'), upload = el('button', '', '上传文件'), keyboard = el('button', '', '兼容输入');
  for (const button of [newTab, upload, keyboard, pageLayout, pause, stop]) button.type = 'button';
  drawerActions.append(newTab, upload, keyboard);
  const display = el('details', 'browser-advanced'), displaySummary = el('summary', '', '显示与手势'); display.append(displaySummary);
  const modes = el('div', 'browser-modes'), drag = el('button', '', '拖动'), pan = el('button', '', '平移'), fit = el('button', '', '放大页面');
  for (const button of [drag, pan, fit]) { button.type = 'button'; button.setAttribute('aria-pressed', 'false'); }
  modes.append(pageLayout, drag, pan, fit); display.append(modes);
  drag.setAttribute('aria-label', '拖动页面控件'); pan.setAttribute('aria-label', '平移浏览器画面');
  const session = el('details', 'browser-advanced'), sessionSummary = el('summary', '', '会话与网络'); session.append(sessionSummary);
  const sessionActions = el('div', 'browser-drawer-actions'); sessionActions.append(pause, stop);
  const networkRow = el('label', 'browser-network-row'), networkLabel = el('span', '', '网络线路');
  const network = el('select', 'browser-network'); network.setAttribute('aria-label', '浏览器网络');
  for (const [value, label] of [['direct', '直连'], ['proxy', '代理']]) { const option = el('option', '', label); option.value = value; network.append(option); }
  networkRow.append(networkLabel, network); session.append(sessionActions, networkRow);
  const viewport = el('div', 'browser-viewport'), surface = el('div', 'browser-surface'), image = el('img', 'browser-frame'), editorLayer = el('div', 'browser-editors');
  image.alt = '服务器浏览器实时画面'; image.draggable = false; image.tabIndex = 0; image.setAttribute('aria-label', '远程页面，接管后可点击或使用键盘'); surface.append(image, editorLayer); viewport.append(surface);
  const feedback = el('div', 'browser-feedback'); feedback.setAttribute('role', 'status');
  const dialogActions = el('div', 'browser-dialog-actions'), dialogText = el('span'), accept = el('button', '', '确定'), dismiss = el('button', '', '取消'); dialogActions.append(dialogText, accept, dismiss); dialogActions.hidden = true;
  const submission = el('div', 'browser-dialog-actions'), submissionLabel = el('span'), confirmSubmission = el('button', '', '确认提交'), cancelSubmission = el('button', '', '取消提交'); submission.append(submissionLabel, confirmSubmission, cancelSubmission); submission.hidden = true;
  const footer = el('div', 'browser-input-bar'), textForm = el('form', 'browser-text-form'), text = el('input'), send = el('button', '', '输入'); footer.hidden = true;
  text.placeholder = '输入文字…'; text.autocomplete = 'off'; text.setAttribute('aria-label', '向远程页面输入文字'); textForm.append(text, send);
  const key = el('select'); key.setAttribute('aria-label', '远程按键');
  for (const [value, label] of [['', '按键'], ['Enter', '回车'], ['Tab', 'Tab'], ['Backspace', '退格'], ['Escape', 'Esc'], ['ControlOrMeta+A', '全选'], ['ArrowDown', '向下'], ['ArrowUp', '向上']]) { const option = el('option', '', label); option.value = value; key.append(option); }
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.hidden = true;
  footer.append(textForm, key);
  const files = el('div', 'browser-files');
  drawer.append(drawerHeading, address, tabs, drawerActions, display, session, footer, files, fileInput);
  dialog.append(header, viewport, feedback, submission, dialogActions, drawer); document.body.append(dialog);
  const labels = { agent: '空闲', user: '你正在操作', paused: '已暂停', stopped: '已停止' };
  const pauseLabels = { user: '已手动暂停', handoff: '等待登录操作', verification: '等待安全验证', restricted: '网站访问受限', navigation_loop: '网页反复跳转，已停止加载', idle: '空闲已关闭', restart: '重启后已暂停', disconnected: '断连后已暂停', launch_failed: '启动未完成', submission_cancelled: '取消提交后已暂停' };
  function query(path, extra = {}) {
    const result = new URL('api/browser' + path, location.href); result.searchParams.set('conversationId', active.conversationId);
    if (active.id) result.searchParams.set('id', active.id);
    for (const [key, value] of Object.entries(extra)) result.searchParams.set(key, value);
    return result;
  }
  async function request(path, method = 'GET', body, headers) {
    const { readJsonResponse, requestError } = await import('./http-errors.js');
    const context = { path: `browser${path}`, method };
    let response;
    try {
      response = await fetch(query(path), { method, cache: 'no-store', ...(body !== undefined
        ? headers ? { headers, body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    } catch (error) { throw requestError(error, context); }
    return readJsonResponse(response, context);
  }
  function render(state) {
    if (!active) return; active.state = state; active.id = state.id;
    const control = state.mode === 'user' && state.canControl;
    dialog.dataset.mode = state.mode; dialog.dataset.control = String(control);
    const activeTab = state.tabs.find(item => item.id === state.activeTab);
    let hostname = ''; try { hostname = new URL(activeTab?.recoveryUrl || activeTab?.url || '').hostname; } catch {}
    title.textContent = hostname || activeTab?.title || state.title || '浏览器';
    site.title = activeTab?.url || '';
    status.textContent = state.error || (state.pauseReason === 'verification' ? (control ? '请完成安全验证' : '等待安全验证') : control && active.busy ? '正在操作…' : control && panEnabled ? '平移画面' : control && dragEnabled ? '拖动控件' : state.mode === 'user' && !control ? '其他设备操作中' : state.mode === 'paused' ? pauseLabels[state.pauseReason] || labels.paused : state.mode === 'agent' && state.agentRunning ? 'Zigent 正在操作' : labels[state.mode]);
    if ([...inputGestures].some(g => !control || state.activeTab !== g.tab || active.viewportPending || g.viewport.width !== state.viewport.width || g.viewport.height !== state.viewport.height)) cancelGesture();
    take.textContent = control ? '完成' : '接管'; take.setAttribute('aria-label', control ? '交还控制' : '接管'); take.disabled = active.busy;
    pause.textContent = ['paused', 'stopped'].includes(state.mode) ? '继续浏览' : '暂停'; pause.disabled = active.busy || state.mode === 'user'; stop.disabled = state.mode === 'stopped';
    for (const node of [url, go, newTab, pageLayout, text, send, key, drag, pan, fit, upload, keyboard]) node.disabled = active.busy || !control;
    pageLayout.textContent = state.viewport.width <= 700 ? '电脑版' : '手机版';
    network.value = state.network || 'direct'; network.disabled = active.busy || !control;
    network.querySelector('[value="proxy"]').disabled = !state.proxyAvailable;
    go.textContent = activeTab?.recoveryUrl ? '恢复网页' : '前往';
    upload.textContent = state.fileChooser ? '选择上传文件' : '上传文件'; text.type = state.passwordField ? 'password' : 'text';
    image.classList.toggle('controllable', control && !panEnabled); image.setAttribute('aria-disabled', String(!control || panEnabled));
    if (document.activeElement !== url) url.value = (activeTab?.recoveryUrl || activeTab?.url || '').replace(/^about:blank$/, '');
    tabs.replaceChildren();
    for (const tab of state.tabs) {
      const group = el('div', 'browser-tab'), select = el('button', '', tab.title || '新标签页'), remove = el('button', '', '×');
      select.setAttribute('aria-pressed', String(tab.id === state.activeTab)); select.title = tab.url; select.disabled = !control || active.busy;
      remove.setAttribute('aria-label', '关闭 ' + (tab.title || '标签页')); remove.disabled = !control || active.busy;
      select.onclick = () => command('switch_tab', { tab: tab.id }); remove.onclick = () => command('close_tab', { tab: tab.id }); group.append(select, remove); tabs.append(group);
    }
    dialogActions.hidden = !state.dialog; dialogText.textContent = state.dialog?.message || ''; accept.disabled = dismiss.disabled = !control || active.busy;
    submission.hidden = !state.pendingSubmission; submissionLabel.textContent = state.pendingSubmission?.label || ''; confirmSubmission.disabled = cancelSubmission.disabled = active.busy;
    files.replaceChildren();
    for (const file of state.files || []) {
      const node = el(file.direction === 'download' ? 'a' : 'span', '', file.name);
      if (file.direction === 'download') { node.href = query('/file', { file: file.id }); node.download = file.name; }
      files.append(node);
    }
    files.hidden = !files.childNodes.length;
    image.style.visibility = state.running && !active.viewportPending && frameMatches() ? '' : 'hidden'; syncEditors(state); layoutSurface();
  }
  function command(action, fields = {}) {
    if (!active || !active.state) return Promise.resolve();
    const context = active, version = generation;
    if (['viewport', 'takeover', 'set_network'].includes(action)) { context.viewportPending = true; context.frameEpoch = (context.frameEpoch || 0) + 1; }
    if (['takeover', 'resume', 'pause', 'stop', 'set_network', 'confirm_submission', 'cancel_submission'].includes(action)) {
      cancelGesture();
      if (action === 'set_network') clearEditors();
      context.inputEpoch = (context.inputEpoch || 0) + 1; return runCommand(action, fields);
    }
    if (action === 'viewport') { cancelGesture(); clearEditors(); context.inputEpoch = (context.inputEpoch || 0) + 1; context.freezeUntil = 0; }
    const epoch = context.inputEpoch || 0;
    const task = (context.inputTail || Promise.resolve()).then(() => {
      if (generation !== version || (context.inputEpoch || 0) !== epoch) return;
      return runCommand(action, fields);
    });
    context.inputTail = task.catch(() => {}); return task;
  }
  async function runCommand(action, fields = {}) {
    if (!active || !active.state) return;
    const context = active, version = generation; active.pending = (active.pending || 0) + 1; active.busy = true; boostFrameStream(); render(active.state); feedback.textContent = '';
    try {
      const next = await request('/control', 'POST', { id: crypto.randomUUID(), revision: context.state.revision, action, ...fields });
      if (generation === version && next.revision >= active.state.revision) render(next);
      return next;
    } catch (error) {
      if (generation === version) { feedback.textContent = error.message; await refreshState().catch(() => {}); }
      return false;
    } finally { if (generation === version) { if (['viewport', 'takeover', 'set_network'].includes(action)) active.viewportPending = false; active.pending = Math.max(0, active.pending - 1); active.busy = active.pending > 0; render(active.state); } }
  }
  async function refreshState() { const version = generation; const next = await request('/state'); if (generation === version && (!active.state || next.revision >= active.state.revision)) render(next); }
  function showFrame(blob, version, epoch, requestedAt) {
    if (generation !== version || !active || epoch !== (active.frameEpoch || 0) || active.viewportPending || !blob.size) return;
    const next = URL.createObjectURL(blob), previous = frameUrl;
    active.frameRequestedAt = requestedAt; active.loadingFrameEpoch = epoch;
    image.src = next; frameUrl = next; if (previous) URL.revokeObjectURL(previous);
    if (active.frameError && feedback.textContent === active.frameError) feedback.textContent = '';
    active.frameError = '';
  }
  function boostFrameStream() {
    clearTimeout(inputBoostTimer);
    if (frameSocket?.readyState === WebSocket.OPEN) frameSocket.send(JSON.stringify({ type: 'input', active: true }));
    inputBoostTimer = setTimeout(() => { if (frameSocket?.readyState === WebSocket.OPEN) frameSocket.send(JSON.stringify({ type: 'input', active: false })); }, 600);
  }
  function closeFrameStream() {
    clearTimeout(frameSocketRetry); clearTimeout(inputBoostTimer); frameSocketActive = false;
    if (frameSocket) { frameSocket.onclose = frameSocket.onerror = frameSocket.onmessage = frameSocket.onopen = null; frameSocket.close(); }
    frameSocket = undefined;
  }
  function connectFrameStream(version) {
    if (generation !== version || !active?.id || !dialog.open || document.hidden) return;
    const socket = new WebSocket(query('/stream').href.replace(/^http/, 'ws'), 'zigent-browser-v1');
    frameSocket = socket; socket.binaryType = 'blob';
    socket.onopen = () => {
      if (generation !== version || frameSocket !== socket) return socket.close();
      frameSocketActive = true; clearTimeout(frameTimer);
      if (active.frameError && feedback.textContent === active.frameError) feedback.textContent = '';
      active.frameError = '';
      socket.send(JSON.stringify({ type: 'visibility', visible: !document.hidden }));
    };
    socket.onmessage = event => {
      if (generation !== version || frameSocket !== socket) return;
      if (event.data instanceof Blob) showFrame(event.data, version, active.frameEpoch || 0, performance.now());
      else try {
        const message = JSON.parse(event.data);
        if (message.type === 'status' && message.state === 'reconnecting') {
          active.frameError = '正在恢复画面…';
          if (!feedback.textContent) feedback.textContent = active.frameError;
        }
      } catch {}
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (frameSocket !== socket || generation !== version) return;
      frameSocket = undefined; frameSocketActive = false;
      if (!active.frameError) active.frameError = '正在恢复画面…';
      if (!feedback.textContent) feedback.textContent = active.frameError;
      clearTimeout(frameTimer); refreshFrame(version);
      frameSocketRetry = setTimeout(() => connectFrameStream(version), 1200);
    };
  }
  async function refreshFrame(version) {
    if (generation !== version || !dialog.open || frameSocketActive) return;
    try {
      if (!document.hidden && active.state?.running) {
        const requestedAt = performance.now(), frameEpoch = active.frameEpoch || 0;
        const response = await fetch(query('/frame'), { cache: 'no-store' });
        if (!response.ok) throw new Error('画面暂时不可用，正在重连');
        const blob = await response.blob(); showFrame(blob, version, frameEpoch, requestedAt);
      }
    } catch (error) { if (generation === version) { if (!feedback.textContent || feedback.textContent === active.frameError) feedback.textContent = error.message; active.frameError = error.message; } }
    if (generation === version && !frameSocketActive) frameTimer = setTimeout(() => refreshFrame(version), active.busy || [...inputGestures].some(g => g.mode === 'drag') ? 100 : 300);
  }
  async function refreshLoop(version) {
    if (generation !== version || !dialog.open) return;
    try { if (!active.busy) await refreshState(); } catch (error) { if (generation === version) feedback.textContent = error.message; }
    if (generation === version) stateTimer = setTimeout(() => refreshLoop(version), 1500);
  }
  function dispose() {
    cancelGesture(); touches.clear(); clearEditors(); setDrawer(false); closeFrameStream();
    generation++; clearTimeout(frameTimer); clearTimeout(stateTimer); active = undefined; text.value = ''; feedback.textContent = ''; image.removeAttribute('src');
    if (frameUrl) URL.revokeObjectURL(frameUrl); frameUrl = undefined;
    if (dialog.open) dialog.close(); trigger?.focus();
  }
  async function open({ conversationId, id, opener } = {}) {
    if (!conversationId) return; dispose(); trigger = opener || document.activeElement; active = { conversationId, id, busy: false }; const version = generation;
    dialog.showModal(); feedback.textContent = '正在连接…';
    try {
      let state;
      if (!id) { const found = await request(''); if (generation !== version) return; id = found.sessions[0]?.id; active.id = id; }
      state = id ? await request('/state') : await request('/open', 'POST');
      if (generation !== version) return; render(state); feedback.textContent = ''; refreshFrame(version); connectFrameStream(version); refreshLoop(version);
    } catch (error) { if (generation === version) { feedback.textContent = error.message; take.disabled = false; take.textContent = '重新连接'; } }
  }
  close.onclick = dispose; dialog.addEventListener('cancel', event => { event.preventDefault(); if (!drawer.hidden) setDrawer(false); else dispose(); });
  function setDrawer(open) { drawer.hidden = !open; more.setAttribute('aria-expanded', String(open)); }
  more.onclick = () => setDrawer(drawer.hidden); drawerClose.onclick = () => setDrawer(false);
  site.onclick = () => { setDrawer(true); if (!url.disabled) { url.focus(); url.select(); } };
  keyboard.onclick = () => { footer.hidden = false; text.focus(); };
  network.onchange = () => command('set_network', { network: network.value });
  fit.onclick = () => { fitEnabled = !fitEnabled; fit.textContent = fitEnabled ? '放大页面' : '适合屏幕'; fit.setAttribute('aria-pressed', String(!fitEnabled)); layoutSurface(true); };
  viewport.addEventListener('pointerdown', () => { if (!drawer.hidden) setDrawer(false); }, { capture: true });
  function phoneViewport() {
    return { viewportWidth: matchMedia('(max-width:700px)').matches ? Math.max(320, Math.round(viewport.clientWidth)) : 390,
      viewportHeight: Math.max(360, Math.min(900, Math.round(viewport.clientHeight))) };
  }
  take.onclick = () => {
    if (!active.state) return open({ conversationId: active.conversationId, id: active.id });
    setDrawer(false);
    const action = active.state.mode === 'user' && active.state.canControl ? 'resume' : 'takeover';
    command(action, action === 'takeover' && matchMedia('(max-width:700px)').matches ? phoneViewport() : {});
  };
  pageLayout.onclick = () => {
    fitEnabled = true; fit.textContent = '放大页面'; fit.setAttribute('aria-pressed', 'false');
    command('viewport', active.state.viewport.width <= 700 ? { viewportWidth: 1280, viewportHeight: 800 } : phoneViewport());
    setDrawer(false);
  };
  pause.onclick = () => command(['paused', 'stopped'].includes(active?.state?.mode) ? 'resume' : 'pause'); stop.onclick = () => command('stop');
  address.onsubmit = event => {
    event.preventDefault(); const value = url.value.trim();
    if (value && value === active?.state?.tabs.find(item => item.id === active.state.activeTab)?.recoveryUrl) command('restore_tab');
    else if (value) command('navigate', { url: value });
    url.blur(); setDrawer(false);
  };
  newTab.onclick = () => { command('new_tab'); setDrawer(false); };
  textForm.onsubmit = event => { event.preventDefault(); const value = text.value; if (!value) return; text.value = ''; command('text', { text: value }); };
  key.onchange = () => { if (key.value) command('key', { key: key.value }); key.value = ''; };
  function currentNativeEditor() { return [...editors.values()].find(item => item.node === document.activeElement); }
  function layoutSurface(recenter = false) {
    if (!active?.state || !dialog.open || !viewport.clientWidth || !viewport.clientHeight) return;
    const dimensions = active.state.viewport, width = viewport.clientWidth, height = viewport.clientHeight;
    const previousScale = active.surfaceScale || 1, previousWidth = active.viewportWidth || width;
    const center = !active.surfaceWidth || active.surfaceWidth <= previousWidth ? dimensions.width / 2 : (viewport.scrollLeft + previousWidth / 2) / previousScale;
    const native = currentNativeEditor(), frozen = native || performance.now() < (active.freezeUntil || 0);
    const cover = !fitEnabled;
    const scale = frozen && active.frozenScale ? active.frozenScale : cover ? Math.max(width / dimensions.width, height / dimensions.height) : Math.min(width / dimensions.width, height / dimensions.height);
    const changed = active.surfaceScale !== scale;
    surface.style.width = dimensions.width * scale + 'px'; surface.style.height = dimensions.height * scale + 'px';
    surface.style.marginTop = (native?.pointerActive ? native.pointerMargin : Math.max(0, (height - dimensions.height * scale) / 2)) + 'px';
    active.surfaceScale = scale; active.viewportWidth = width; active.surfaceWidth = dimensions.width * scale;
    if (!active.hasLayout || recenter) viewport.scrollLeft = Math.max(0, (dimensions.width * scale - width) / 2);
    else if (changed && !native) viewport.scrollLeft = Math.max(0, center * scale - width / 2);
    active.hasLayout = true;
    for (const item of editors.values()) positionEditor(item);
    if (native && !native.pointerActive) requestAnimationFrame(() => {
      if (!active || native.pointerActive || native.node !== document.activeElement) return;
      const field = native.node.getBoundingClientRect(), view = viewport.getBoundingClientRect();
      if (field.right > view.right - 12 || field.left < view.left + 12) viewport.scrollLeft += (field.left + field.right - view.left - view.right) / 2;
      if (field.bottom > view.bottom - 14) viewport.scrollTop += field.bottom - view.bottom + 14;
      else if (field.top < view.top + 14) viewport.scrollTop += field.top - view.top - 14;
    });
  }
  new ResizeObserver(() => layoutSurface()).observe(viewport);
  function frameMatches() { return active?.state && active.displayedFrameEpoch === (active.frameEpoch || 0) && active.displayedViewport?.width === active.state.viewport.width && active.displayedViewport?.height === active.state.viewport.height; }
  image.addEventListener('load', () => {
    if (!active) return;
    active.displayedFrameEpoch = active.loadingFrameEpoch;
    active.displayedViewport = { width: image.naturalWidth, height: image.naturalHeight };
    image.style.visibility = !active.viewportPending && frameMatches() ? '' : 'hidden'; editorLayer.hidden = !canInput();
    layoutSurface();
    for (const item of editors.values()) if (item.visibleUntilFrame && active?.frameRequestedAt >= item.visibleUntilFrame && !editorPending(item)) {
      item.visibleUntilFrame = 0; item.node.classList.remove('browser-editor-pending');
    }
  });
  function editorValue(editor) { return editor.password ? passwordMask.repeat(Math.min(16000, editor.length)) : editor.value || ''; }
  function editorValid(item) {
    return active === item.context && generation === item.generation && (active.inputEpoch || 0) === item.epoch && canInput() && editors.get(item.id) === item;
  }
  function editorPending(item) { return item.inFlight || item.composing || editorQueue.some(operation => operation.item === item); }
  function clearEditors() {
    editorQueue = [];
    for (const item of editors.values()) { item.node.blur(); item.node.remove(); }
    editors.clear();
  }
  function positionEditor(item) {
    if (!active?.state) return;
    const meta = item.meta, dimensions = active.state.viewport, scale = active.surfaceScale || 1;
    const bounds = meta.bounds, style = item.node.style;
    style.left = bounds.x / dimensions.width * 100 + '%'; style.top = bounds.y / dimensions.height * 100 + '%';
    style.width = bounds.width / dimensions.width * 100 + '%'; style.height = bounds.height / dimensions.height * 100 + '%';
    style.fontSize = Math.max(16, (parseFloat(meta.fontSize) || 16) * scale) + 'px';
    style.fontFamily = meta.fontFamily || 'inherit'; style.color = meta.color || '#222';
    style.backgroundColor = !meta.backgroundColor || /(?:transparent|rgba\(0, 0, 0, 0\))/.test(meta.backgroundColor) ? '#fff' : meta.backgroundColor;
  }
  function setEditorValue(item, value, selection) {
    const node = item.node, focused = node === document.activeElement;
    const start = node.selectionStart, end = node.selectionEnd;
    if (node.value !== value) node.value = value;
    item.shadow = value;
    if (focused) {
      const nextStart = selection?.selectionStart ?? start ?? value.length, nextEnd = selection?.selectionEnd ?? end ?? nextStart;
      try { node.setSelectionRange(Math.min(value.length, nextStart), Math.min(value.length, nextEnd)); } catch {}
    }
  }
  function syncEditors(state) {
    const control = state.mode === 'user' && state.canControl && !panEnabled && !active.viewportPending;
    editorLayer.hidden = !control || !frameMatches();
    if (!control) { clearEditors(); return; }
    const incoming = new Map((state.editors || []).map(editor => [editor.id, editor]));
    for (const [id, item] of editors) if (!incoming.has(id)) { item.node.blur(); item.node.remove(); editors.delete(id); }
    for (const meta of incoming.values()) {
      let item = editors.get(meta.id);
      if (!item) {
        const node = el(meta.multiline ? 'textarea' : 'input', 'browser-native-editor');
        if (!meta.multiline) node.type = meta.password ? 'password' : 'text';
        node.setAttribute('data-native-selection', ''); node.autocomplete = 'off'; node.autocapitalize = 'off'; node.spellcheck = !meta.password; node.maxLength = 16000;
        node.setAttribute('aria-label', meta.label || (meta.password ? '网页密码' : '网页输入框')); node.inputMode = meta.inputMode || (meta.kind === 'number' ? 'decimal' : meta.kind === 'tel' ? 'tel' : 'text');
        item = { id: meta.id, meta, node, context: active, generation, epoch: active.inputEpoch || 0, version: meta.version, shadow: editorValue(meta), ack: editorValue(meta), blocked: false };
        node.value = item.shadow; editors.set(meta.id, item); editorLayer.append(node); wireEditor(item);
      }
      item.meta = meta;
      item.node.setAttribute('aria-label', meta.label || (meta.password ? '网页密码' : '网页输入框'));
      if (!editorPending(item)) {
        const previousVersion = item.version;
        item.version = meta.version; item.ack = editorValue(meta);
        // Focused passwords retain the user's known local characters; unknown
        // characters are represented only by a private placeholder, never sent.
        if (!meta.password || item.node !== document.activeElement || item.shadow.length !== meta.length || previousVersion !== meta.version) setEditorValue(item, item.ack);
      }
      positionEditor(item);
    }
  }
  function difference(before, after) {
    let start = 0, end = before.length, afterEnd = after.length;
    while (start < end && start < afterEnd && before[start] === after[start]) start++;
    while (end > start && afterEnd > start && before[end - 1] === after[afterEnd - 1]) { end--; afterEnd--; }
    return { editStart: start, editEnd: end, text: after.slice(start, afterEnd) };
  }
  function captureEdit(item, inputType = '') {
    return { value: item.shadow, start: item.node.selectionStart ?? item.shadow.length, end: item.node.selectionEnd ?? item.shadow.length, inputType };
  }
  function queueNativeEdit(item, before = item.before || captureEdit(item)) {
    const after = item.node.value;
    if (!editorValid(item) || item.blocked) { setEditorValue(item, item.shadow); return; }
    if (before.value === after) { item.shadow = after; return; }
    let change = difference(before.value, after);
    if (item.meta.password && before.inputType.startsWith('delete') && before.value.length >= after.length) {
      const count = before.value.length - after.length;
      let start = before.start, end = before.end;
      if (start === end) { if (/Backward$/.test(before.inputType)) start = Math.max(0, start - count); else end = Math.min(before.value.length, end + count); }
      const textEnd = after.length - (before.value.length - end), text = after.slice(start, Math.max(start, textEnd));
      if (before.value.slice(0, start) + text + before.value.slice(end) === after) change = { editStart: start, editEnd: end, text };
    }
    if (change.text.includes(passwordMask)) {
      feedback.textContent = '输入状态已变化，请重新点选输入框'; setEditorValue(item, item.ack); return;
    }
    item.shadow = after; item.before = undefined; item.node.classList.add('browser-editor-pending');
    item.visibleUntilFrame = Infinity;
    editorQueue.push({ kind: 'edit', item, ...change, expectedLength: before.value.length, after }); drainEditors();
  }
  function resyncEditor(item, allowContinue = false) {
    editorQueue = editorQueue.filter(operation => operation.item !== item || operation.kind === 'focus');
    item.blocked = true;
    const fresh = active?.state?.editors?.find(editor => editor.id === item.id);
    if (fresh) { item.meta = fresh; item.version = fresh.version; item.ack = editorValue(fresh); setEditorValue(item, item.ack, fresh); item.blocked = !allowContinue; item.visibleUntilFrame = performance.now(); item.node.classList.add('browser-editor-pending'); }
  }
  function drainEditors() {
    if (editorDrain) return;
    editorDrain = (async () => {
      while (editorQueue.length) {
        const operation = editorQueue.shift(), item = operation.item;
        if (!editorValid(item) || operation.kind !== 'focus' && item.blocked) continue;
        item.inFlight = true;
        let result;
        try {
          if (operation.kind === 'focus') {
            item.blocked = false;
            result = await command('focus_editor', { editorId: item.id, ...operation.point });
          } else if (operation.kind === 'edit') {
            result = await command('edit', { editorId: item.id, editorVersion: item.version, editStart: operation.editStart,
              editEnd: operation.editEnd, text: operation.text, expectedLength: operation.expectedLength });
          } else result = await command('key', { key: 'Enter', editorId: item.id });
          if (!editorValid(item)) continue;
          const fresh = result?.editors?.find(editor => editor.id === item.id);
          if (!result || !fresh) { resyncEditor(item, operation.kind === 'edit'); continue; }
          item.meta = fresh; item.version = fresh.version;
          if (operation.kind === 'edit') {
            const expected = operation.after;
            if (fresh.password && fresh.length !== expected.length || !fresh.password && fresh.value !== expected) { resyncEditor(item, true); continue; }
            item.ack = fresh.password ? expected : fresh.value || ''; item.visibleUntilFrame = performance.now(); item.node.classList.add('browser-editor-pending');
          } else {
            item.ack = fresh.password && fresh.length === operation.base?.length ? operation.base : editorValue(fresh);
            if (operation.kind === 'focus' && operation.base !== item.ack && editorQueue.some(next => next.item === item && next.kind === 'edit')) {
              feedback.textContent = '输入框已更新，请重新点选'; resyncEditor(item); continue;
            }
          }
          if (!item.composing && !editorQueue.some(next => next.item === item && next.kind === 'edit')) setEditorValue(item, item.ack);
        } finally { item.inFlight = false; if (operation.kind === 'enter') item.enterPending = false; }
      }
    })().finally(() => { editorDrain = undefined; if (editorQueue.length) drainEditors(); });
  }
  function beginEditorFocus(item, location) {
    if (!editorValid(item)) return;
    cancelGesture(); setDrawer(false); footer.hidden = true;
    active.frozenScale = active.surfaceScale; active.freezeUntil = 0;
    item.blocked = false;
    const point = location ? { x: Math.max(0, Math.min(active.state.viewport.width - 1, location.x)), y: Math.max(0, Math.min(active.state.viewport.height - 1, location.y)) } : {};
    editorQueue.push({ kind: 'focus', item, point, base: item.shadow }); drainEditors();
  }
  function wireEditor(item) {
    const node = item.node;
    function zoomEditor() {
      if (!editorValid(item) || node !== document.activeElement) return;
      if (matchMedia('(max-width:700px)').matches) active.frozenScale = Math.max(active.frozenScale || active.surfaceScale, 16 / (parseFloat(item.meta.fontSize) || 16));
      layoutSurface();
    }
    node.addEventListener('pointerdown', event => {
      if (!editorValid(item) || event.button !== 0 || !event.isPrimary) return;
      const box = image.getBoundingClientRect(), dimensions = active.state.viewport;
      item.pointerActive = true; item.pointerMargin = parseFloat(surface.style.marginTop) || 0;
      item.pointerFocus = true;
      beginEditorFocus(item, { x: (event.clientX - box.left) / box.width * dimensions.width, y: (event.clientY - box.top) / box.height * dimensions.height });
      // This runs synchronously in the real user gesture, before any HTTP wait.
      node.focus({ preventScroll: true }); item.pointerFocus = false;
    });
    node.addEventListener('focus', () => { if (!item.pointerFocus) { beginEditorFocus(item); zoomEditor(); } });
    // Keep the target stationary through touchend. Moving it on pointerdown can
    // make the browser's final click land elsewhere and dismiss its keyboard.
    node.addEventListener('click', () => { item.pointerActive = false; zoomEditor(); });
    node.addEventListener('pointerup', () => { setTimeout(() => { if (item.pointerActive) { item.pointerActive = false; zoomEditor(); } }, 350); });
    node.addEventListener('pointercancel', () => { item.pointerActive = false; requestAnimationFrame(zoomEditor); });
    node.addEventListener('blur', () => {
      if (item.composing) { item.composing = false; queueNativeEdit(item, item.compositionBefore); }
      if (active) { active.freezeUntil = performance.now() + 400; setTimeout(() => layoutSurface(), 420); }
    });
    node.addEventListener('beforeinput', event => { if (!item.composing) item.before = captureEdit(item, event.inputType || ''); });
    node.addEventListener('compositionstart', () => { item.compositionBefore = captureEdit(item, 'insertCompositionText'); item.composing = true; });
    node.addEventListener('compositionend', () => { item.composing = false; queueNativeEdit(item, item.compositionBefore); item.compositionBefore = undefined; });
    node.addEventListener('input', event => { if (!item.composing && !event.isComposing) queueNativeEdit(item); });
    node.addEventListener('keydown', event => {
      if (event.isComposing || item.composing) return;
      if (event.key === 'Escape') { event.preventDefault(); node.blur(); return; }
      if (event.key === 'Enter' && !item.meta.multiline) {
        event.preventDefault();
        if (!event.repeat && !item.enterPending && editorValid(item)) { item.enterPending = true; editorQueue.push({ kind: 'enter', item }); drainEditors(); }
      }
    });
  }
  const canInput = () => active?.state?.mode === 'user' && active.state.canControl && !panEnabled && !active.viewportPending && frameMatches();
  const validGesture = g => active === g.context && generation === g.version && (active.inputEpoch || 0) === g.epoch && canInput() && active.state.activeTab === g.tab;
  function point(g, event) {
    return { x: Math.max(0, Math.min(g.viewport.width - 1, (event.clientX - g.box.left) / g.box.width * g.viewport.width)),
      y: Math.max(0, Math.min(g.viewport.height - 1, (event.clientY - g.box.top) / g.box.height * g.viewport.height)) };
  }
  function finishGesture(g) { inputGestures.delete(g); g.resolve(); }
  function cancelGesture(target) {
    const targets = target ? [target] : [...inputGestures];
    for (const g of targets) {
      if (gesture === g) gesture = undefined;
      g.cancelled = true; g.pending = undefined; g.end = undefined;
      if (g.mode !== 'drag') { finishGesture(g); continue; }
      if (g.cleanup) continue;
      g.cleanup = true;
      // Wait for an already-sent press/move before cleanup, including closing the viewer.
      // The server also releases on control changes and after an abandoned connection.
      void Promise.allSettled([g.down, g.flight]).then(() => fetch(g.endpoint, { method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), revision: g.revision, action: 'pointer', pointerId: g.id, phase: 'cancel' }) })).catch(() => {}).finally(() => finishGesture(g));
    }
  }
  function pump(g) {
    if (g.flight || g.cancelled) return;
    g.flight = (async () => {
      await g.previous;
      if (g.down && !await g.down) { g.cancelled = true; return; }
      while (!g.cancelled && validGesture(g)) {
        const pending = g.pending; g.pending = undefined;
        if (pending) {
          const ok = g.mode === 'scroll' ? await command('scroll', pending) : await command('pointer', { pointerId: g.id, phase: 'move', ...pending });
          if (!ok) { g.cancelled = true; break; }
        } else if (g.end) {
          const end = g.end; g.end = undefined;
          await command('pointer', { pointerId: g.id, phase: 'up', ...end }); break;
        } else break;
      }
    })().finally(() => {
      g.flight = undefined;
      if (!g.cancelled && (g.pending || g.end) && validGesture(g)) pump(g);
      else if (g.cancelled || !validGesture(g)) cancelGesture(g);
      else if (g.ended) finishGesture(g);
    });
  }
  function startDrag(g) {
    g.mode = 'drag'; g.down = g.previous.then(() => {
      if (!g.cancelled && validGesture(g)) return command('pointer', { pointerId: g.id, phase: 'down', ...g.start });
      return false;
    });
  }
  image.addEventListener('pointerdown', event => {
    lastPointerAt = performance.now();
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size > 1) { cancelGesture(); return; }
    }
    if (!canInput() || gesture || event.button !== 0 || !event.isPrimary) return;
    const g = { id: crypto.randomUUID(), pointerId: event.pointerId, context: active, version: generation, epoch: active.inputEpoch || 0,
      tab: active.state.activeTab, viewport: active.state.viewport, revision: active.state.revision, endpoint: query('/control').href,
      box: image.getBoundingClientRect(), clientX: event.clientX, clientY: event.clientY, lastY: event.clientY, mode: 'pending' };
    g.previous = Promise.allSettled([...inputGestures].map(item => item.done));
    g.done = new Promise(resolve => { g.resolve = resolve; });
    g.start = point(g, event); gesture = g; inputGestures.add(g); image.setPointerCapture(event.pointerId);
    if (event.pointerType !== 'touch') startDrag(g);
  });
  image.addEventListener('pointermove', event => {
    const g = gesture; if (!g || event.pointerId !== g.pointerId || !validGesture(g)) return;
    if (g.mode === 'pending') {
      const dx = Math.abs(event.clientX - g.clientX), dy = Math.abs(event.clientY - g.clientY);
      if (Math.max(dx, dy) < 10) return;
      if (dragEnabled || dx >= dy) startDrag(g); else g.mode = 'scroll';
    }
    if (g.mode === 'drag') g.pending = point(g, event);
    else {
      const delta = (g.lastY - event.clientY) * g.viewport.height / g.box.height;
      g.pending = { delta: Math.round(Math.max(-2000, Math.min(2000, (g.pending?.delta || 0) + delta))) };
      g.lastY = event.clientY;
    }
    pump(g);
  });
  image.addEventListener('pointerup', event => {
    touches.delete(event.pointerId);
    const g = gesture; if (!g || event.pointerId !== g.pointerId) return;
    gesture = undefined;
    g.ended = true;
    if (!validGesture(g)) { cancelGesture(g); return; }
    if (g.mode === 'pending') {
      void g.previous.then(() => { if (!g.cancelled && validGesture(g)) return command('click', g.start); }).finally(() => finishGesture(g));
    }
    else if (g.mode === 'drag') { g.end = point(g, event); pump(g); }
    else if (!g.flight) finishGesture(g);
  });
  const cancelPointer = event => { touches.delete(event.pointerId); if (gesture?.pointerId === event.pointerId) cancelGesture(); };
  image.addEventListener('pointercancel', cancelPointer); image.addEventListener('lostpointercapture', cancelPointer);
  // Native click synthesis is unreliable on iOS and would duplicate pointerup.
  // Keep only assistive activation, which has no preceding pointer events.
  image.onclick = event => { if (canInput() && performance.now() - lastPointerAt > 1000 && event.detail === 0 && !event.pointerType) {
    const box = image.getBoundingClientRect(); command('click', point({ box, viewport: active.state.viewport }, { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
  } };
  image.addEventListener('touchmove', event => { if (canInput() && event.touches.length === 1 && event.cancelable) event.preventDefault(); }, { passive: false });
  drag.onclick = () => { cancelGesture(); dragEnabled = !dragEnabled; panEnabled = false; drag.setAttribute('aria-pressed', String(dragEnabled)); pan.setAttribute('aria-pressed', 'false'); render(active.state); setDrawer(false); };
  pan.onclick = () => { cancelGesture(); panEnabled = !panEnabled; dragEnabled = false; pan.setAttribute('aria-pressed', String(panEnabled)); drag.setAttribute('aria-pressed', 'false'); render(active.state); setDrawer(false); };
  window.addEventListener('blur', () => cancelGesture());
  document.addEventListener('visibilitychange', () => {
    if (!active || !dialog.open) return;
    if (document.hidden) { cancelGesture(); touches.clear(); closeFrameStream(); clearTimeout(frameTimer); }
    else { refreshFrame(generation); connectFrameStream(generation); }
  });
  image.onkeydown = event => {
    if (!canInput() || event.isComposing) return;
    if (event.key === 'Escape') return;
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) command('text', { text: event.key });
    else command('key', { key: [event.ctrlKey ? 'Control' : '', event.metaKey ? 'Meta' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', event.key === ' ' ? 'Space' : event.key].filter(Boolean).join('+') });
  };
  image.onpaste = event => { if (!canInput()) return; event.preventDefault(); const value = event.clipboardData?.getData('text/plain'); if (value) command('text', { text: value.slice(0, 16000) }); };
  image.addEventListener('wheel', event => { if (!canInput()) return; event.preventDefault(); command('scroll', { delta: Math.round(Math.max(-2000, Math.min(2000, event.deltaY))) }); }, { passive: false });
  confirmSubmission.onclick = () => command('confirm_submission', { pendingId: active.state.pendingSubmission?.id }); cancelSubmission.onclick = () => command('cancel_submission', { pendingId: active.state.pendingSubmission?.id });
  accept.onclick = () => command('dialog', { accept: true }); dismiss.onclick = () => command('dialog', { accept: false });
  upload.onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0]; fileInput.value = ''; if (!file || !active || active.busy) return;
    if (file.size > 25 * 1024 * 1024) { feedback.textContent = '文件需小于 25 MB'; return; }
    const version = generation; active.busy = true; render(active.state);
    try {
      await request('/upload', 'POST', file, { 'X-File-Name': encodeURIComponent(file.name) });
      if (generation === version) await refreshState();
    } catch (error) { if (generation === version) feedback.textContent = error.message; }
    finally { if (generation === version) { active.busy = false; render(active.state); } }
  };
  window.ZigentBrowser = { open, close: dispose };
})();
