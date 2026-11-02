(() => {
  'use strict';
  const $ = id => document.getElementById(id), scriptBase = new URL('.', document.currentScript.src);
  const standalone = document.body.classList.contains('recovery-standalone');
  let close = () => {}, report, selection, timer, controller, busy = false, generation = 0;
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const visible = () => standalone || $('recovery-dialog').open;
  const versionLabel = value => value?.id ? value.id.slice(0, 12) : '未知版本';
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';
  async function request(path, method = 'GET', value) {
    const response = await fetch(new URL(`api/${path}`, scriptBase), { method, credentials: 'same-origin', cache: 'no-store', signal: controller?.signal,
      ...(value === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }) });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || '暂时无法连接恢复服务。'); error.status = response.status; throw error; }
    return result;
  }
  function message(text) { $('recovery-status').textContent = text; }
  function showLogin(show) { $('recovery-login').hidden = !show; $('recovery-content').hidden = show; $('recovery-confirm').hidden = true; }
  function render() {
    const service = report.service;
    $('recovery-current').textContent = versionLabel(service.current);
    $('recovery-current-time').textContent = date(service.current?.createdAt);
    const versions = $('recovery-versions'); versions.replaceChildren();
    $('recovery-confirm').hidden = true;
    $('recovery-return').hidden = service.lastResult?.status !== 'completed';
    if (service.previous && service.available) {
      const item = node('button', 'recovery-version'); item.type = 'button';
      item.disabled = busy || service.busy;
      const identity = node('span', 'recovery-version-identity'); identity.append(node('strong', '', versionLabel(service.previous)), node('time', '', date(service.previous.createdAt)));
      item.append(identity, node('span', 'recovery-version-action', '选择回退 →'));
      item.onclick = () => {
        const ticket = report.confirmation;
        if (!ticket || ticket.expiresAt <= Date.now() || ticket.targetVersion !== service.previous.id || ticket.expectedCurrent !== service.current?.id) { message('版本状态已变化，请刷新后重试。'); return; }
        selection = { confirmationId: ticket.id, expectedCurrent: ticket.expectedCurrent, targetVersion: ticket.targetVersion };
        $('recovery-target').textContent = `${versionLabel(service.current)} → ${versionLabel(service.previous)}`;
        $('recovery-confirm').hidden = false; $('recovery-submit').disabled = false; $('recovery-submit').focus({ preventScroll: true });
      };
      versions.append(item);
    } else versions.append(node('p', 'recovery-empty', '暂无可回退版本'));
    if (service.busy || service.lastResult?.status === 'running') message('正在回退服务');
    else if (service.lastResult?.status === 'completed') message('回退完成');
    else if (service.lastResult?.status === 'failed') message(service.lastResult.message || '回退失败，请重试。');
    else message('');
  }
  async function load() {
    clearTimeout(timer); const epoch = ++generation; controller?.abort(); controller = new AbortController();
    $('recovery-refresh').disabled = true; $('recovery-retry').hidden = true;
    try {
      const result = await request('recovery'); if (epoch !== generation || !visible()) return;
      report = result; selection = undefined; showLogin(false); render();
      if (report.service.busy || report.service.lastResult?.status === 'running') timer = setTimeout(load, 2000);
    } catch (error) {
      if (epoch !== generation || error.name === 'AbortError') return;
      if (error.status === 401) { showLogin(true); message('请登录恢复服务'); }
      else { message(error.message || '暂时无法连接恢复服务。'); $('recovery-retry').hidden = false; }
    } finally { if (epoch === generation) $('recovery-refresh').disabled = false; }
  }
  function initialize(options = {}) {
    close = options.close || close;
    $('close-recovery')?.addEventListener('click', () => close('recovery-dialog'));
    $('recovery-refresh').onclick = load; $('recovery-retry').onclick = load;
    $('recovery-cancel').onclick = () => { selection = undefined; $('recovery-confirm').hidden = true; $('recovery-versions').querySelector('button')?.focus(); };
    $('recovery-submit').onclick = async () => {
      if (!selection || busy) return;
      busy = true; $('recovery-submit').disabled = true; message('正在提交回退');
      try { await request('recovery/rollback', 'POST', selection); selection = undefined; await load(); }
      catch (error) { if (error.name !== 'AbortError') { message(error.message || '未能确认回退状态，请刷新核对。'); $('recovery-retry').hidden = false; } }
      finally { busy = false; $('recovery-submit').disabled = false; }
    };
    $('recovery-login').onsubmit = async event => {
      event.preventDefault(); const submit = $('recovery-login-submit'); submit.disabled = true;
      try { await request('login', 'POST', { password: $('recovery-password').value }); $('recovery-password').value = ''; await load(); }
      catch (error) { message(error.message || '登录失败，请重试。'); }
      finally { submit.disabled = false; }
    };
    $('recovery-dialog')?.addEventListener('close', () => { generation++; controller?.abort(); clearTimeout(timer); selection = undefined; });
  }
  window.ZigentRecovery = { initialize, open() { message('正在读取版本'); report = undefined; showLogin(false); $('recovery-versions').replaceChildren(); void load(); } };
  if (standalone) { initialize(); window.ZigentRecovery.open(); }
})();
