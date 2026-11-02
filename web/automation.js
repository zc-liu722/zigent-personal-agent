(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const node = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const date = value => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '—';
  const count = value => new Intl.NumberFormat('zh-CN').format(value || 0);
  const labels = { active: '已启用', paused: '已暂停', cancelled: '已取消', draft: '草稿', pending: '排队中', running: '执行中', succeeded: '执行完成', failed: '执行失败',
    delivered: '已送达', stale: '已过期', uncertain: '待核对', none: '未发送', disabled: '已停用' };
  let api, close, conversation, navigate, discuss, renderRun, report, tab = 'tasks', version = 0, controller, timer, busy = false;
  const expanded = new Set();
  const histories = new Map();
  let selectedRun, runTimer, deleteTarget, deleteRequest;
  function button(label, action, className = '') {
    const item = node('button', `automation-button ${className}`.trim(), label); item.type = 'button';
    item.onclick = action; item.disabled = busy; return item;
  }
  function iconButton(label, path, action) {
    const item = button('', event => { event.preventDefault(); event.stopPropagation(); action(); }, 'automation-icon');
    item.setAttribute('aria-label', label); item.title = label;
    item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
    return item;
  }
  function taskControls(task) {
    const controls = node('div', 'automation-task-controls');
    controls.append(iconButton(task.status === 'active' ? '暂停' : '启用', task.status === 'active' ? 'M8 5v14M16 5v14' : 'm8 5 11 7-11 7Z', () => control(task, task.status === 'active' ? 'pause' : 'resume')));
    return controls;
  }
  function deleteTask(task) {
    deleteTarget = task; deleteRequest = crypto.randomUUID();
    $('automation-delete-title').textContent = `删除「${task.title}」？`;
    $('automation-delete-status').textContent = ''; $('automation-delete-submit').disabled = false;
    $('automation-delete-dialog').showModal();
  }
  function badge(value) { return node('span', `automation-badge ${value}`, labels[value] || value); }
  function line(label, value) {
    const item = node('div', 'automation-fact'); item.append(node('dt', '', label), node('dd', '', value)); return item;
  }
  function section(label, ...content) {
    const item = node('section', 'automation-section'); item.append(node('h3', 'automation-section-title', label), ...content); return item;
  }
  function diagram(value, context) {
    const visual = window.ZigentTriggerVisual.render(value?.visual, context);
    if (!visual) return window.ZigentTriggerDiagram.render(value);
    const group = node('div', 'trigger-presentation'), logic = node('details', 'trigger-visual-logic');
    logic.append(node('summary', '', '完整逻辑'), window.ZigentTriggerDiagram.render(value));
    logic.ontoggle = () => centerDiagrams(logic);
    group.append(visual, logic); return group;
  }
  function centerDiagrams(root) {
    for (const graph of root.querySelectorAll('.trigger-diagram')) if (graph.clientWidth && !graph.dataset.centered) {
      graph.scrollLeft = Math.max(0, (graph.scrollWidth - graph.clientWidth) / 2); graph.dataset.centered = 'true';
    }
  }
  function entry(kind, value, subtitle, status) {
    const details = node('details', 'automation-entry'); details.dataset.id = value.id;
    const key = `${kind}:${value.id}`; details.open = expanded.has(key);
    details.ontoggle = () => { if (details.open) { expanded.add(key); centerDiagrams(details); } else expanded.delete(key); };
    const summary = node('summary'), main = node('div', 'automation-identity');
    main.append(node('strong', '', value.title || value.name), node('span', 'automation-subtitle', subtitle));
    summary.append(main);
    if (kind !== 'task' || status !== 'active') summary.append(badge(status));
    details.append(summary); return details;
  }
  function runRow(run) {
    const row = button('', () => showRun(run.taskId, run.id), 'automation-run'); row.dataset.runId = run.id; row.setAttribute('aria-label', `查看 ${date(run.triggeredAt)} 的工作过程`);
    const heading = node('div', 'automation-run-heading'); heading.append(node('time', '', date(run.triggeredAt)), badge(run.state));
    const facts = node('div', 'automation-run-facts');
    facts.append(node('span', '', run.deliveredAt ? `已送达 ${date(run.deliveredAt)}` : run.notificationStatus === 'pending' ? '待发送' : labels[run.notificationStatus] || '未发送'));
    if (run.tokens) facts.append(node('span', '', `${count(run.tokens.input + run.tokens.output)} token`));
    if (run.model) facts.append(node('span', 'automation-model', run.model));
    row.append(heading, facts); return row;
  }
  function renderTasks() {
    return report.tasks.map(task => {
      const item = entry('task', task, task.schedule, task.status), body = node('div', 'automation-entry-body');
      item.querySelector(':scope > summary').append(taskControls(task));
      const facts = node('dl', 'automation-facts automation-task-facts');
      facts.append(line('通知', task.deliveryPolicy === 'always' ? '每次执行' : '按需发送'));
      if (task.nextAt && task.status === 'active') facts.append(line('下次执行', date(task.nextAt)));
      body.append(section('触发逻辑', diagram(task.diagram, { kind: 'task', id: task.id, revision: task.revision })), section('任务提示词', node('p', 'automation-instruction', task.instruction), facts));
      const actions = node('div', 'automation-actions');
      if (task.status !== 'cancelled') {
        const picker = node('select', 'automation-model'); picker.setAttribute('aria-label', '执行模型');
        for (const model of new Set([task.model, ...(report.models || [])].filter(Boolean))) { const option = node('option', '', model); option.value = model; picker.append(option); }
        picker.value = task.model || report.defaultModel || '';
        const save = button('保存模型', async () => {
          save.disabled = true; picker.disabled = true;
          try { await api('proactive-tasks/model', 'POST', { id: task.id, model: picker.value || null, revision: task.revision }); await load(); status('已保存'); }
          catch (error) { status(error.message); }
          finally { save.disabled = false; picker.disabled = false; }
        });
        const modelControls = node('div', 'automation-actions'); modelControls.append(picker, save); body.append(section('执行模型', modelControls));
      }
      if (task.status !== 'cancelled') {
        actions.append(iconButton('修改', 'M4 20h4L20 8l-4-4L4 16v4ZM13 7l4 4', () => discuss(`修改主动任务「${task.title}」：`)),
          iconButton('删除', 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7', () => deleteTask(task)));
      }
      const runs = node('div', 'automation-runs');
      const saved = histories.get(task.id);
      if (saved) runs.append(...saved.map(runRow));
      else if (task.latestRun) runs.append(runRow(task.latestRun));
      if (saved && !saved.length || !saved && !task.latestRun) runs.append(node('p', 'automation-empty', '暂无运行'));
      const history = button('全部记录', async () => {
        history.disabled = true;
        try { const result = await api(`proactive-tasks/${encodeURIComponent(task.id)}/runs`); histories.set(task.id, result.runs); runs.replaceChildren(...result.runs.map(runRow)); if (!result.runs.length) runs.append(node('p', 'automation-empty', '暂无运行')); history.remove(); status(''); }
        catch (error) { status(error.message || '暂时无法加载运行历史。'); history.textContent = '重试加载'; history.disabled = false; }
      });
      body.append(section('运行历史', runs, ...(!saved ? [history] : [])), actions); item.append(body); return item;
    });
  }
  function renderTriggerPoints() {
    return report.triggerPoints.map(trigger => {
      const item = entry('trigger', trigger, trigger.summary, trigger.status), body = node('div', 'automation-entry-body');
      const facts = node('dl', 'automation-facts');
      facts.append(line('运行版本', trigger.activeRevision ? `v${trigger.activeRevision}` : '未启用'), line('订阅任务', count(trigger.subscriberCount)), line('最新版本', `v${trigger.revision}`),
        line('验证', trigger.validation ? trigger.validation.passed ? `${count(trigger.validation.checks)} 项通过` : '验证失败' : '待验证'));
      if (trigger.lastFiredAt) facts.append(line('最近触发', date(trigger.lastFiredAt)));
      if (trigger.nextAt) facts.append(line('等待至', date(trigger.nextAt)));
      body.append(section('触发逻辑', diagram(trigger.diagram, { kind: 'point', id: trigger.id, revision: trigger.activeRevision })), facts);
      if (trigger.candidateDiagram) {
        const candidate = node('details', 'automation-candidate'); candidate.ontoggle = () => centerDiagrams(candidate);
        candidate.append(node('summary', '', `候选 v${trigger.revision}`), diagram(trigger.candidateDiagram, { kind: 'point', id: trigger.id, revision: trigger.revision })); body.append(candidate);
      }
      const actions = node('div', 'automation-actions');
      if (trigger.status === 'active' && trigger.activeRevision) actions.append(button('用于任务', () => discuss(`使用已有触发点「${trigger.title}」创建主动任务，复用其已启用的固定逻辑。\n任务提示词：`)));
      if (trigger.validation?.passed && trigger.revision !== trigger.activeRevision) actions.append(button(`启用 v${trigger.revision}`, () => operate(trigger, 'trigger_activate', trigger.revision)));
      if (trigger.activeRevision) actions.append(button(trigger.status === 'paused' ? '恢复' : '暂停', () => operate(trigger, trigger.status === 'paused' ? 'trigger_resume' : 'trigger_pause')));
      if (trigger.previousRevision) actions.append(button(`回退 v${trigger.previousRevision}`, () => operate(trigger, 'trigger_rollback')));
      actions.append(button('修改', () => discuss(`修改触发点「${trigger.title}」的固定逻辑：`)));
      body.append(actions); item.append(body); return item;
    });
  }
  function render() {
    if (!report) return;
    window.ZigentTriggerContext?.capabilities(report.capabilities);
    const points = tab === 'triggers' ? renderTriggerPoints() : [];
    if (tab === 'triggers' && !points.length) points.push(node('p', 'automation-empty', '暂无触发点'));
    const content = tab === 'tasks' ? renderTasks() : [section('触发点', ...points),
      section('触发器', ...report.triggerTypes.map(type => window.ZigentAutomationTriggers.render(type, report.sources, discuss)))];
    $('automation-list').replaceChildren(...content);
    centerDiagrams($('automation-list'));
    if (!content.length) $('automation-list').append(node('p', 'automation-empty', '暂无任务'));
    $('automation-create').hidden = tab !== 'triggers';
    $('automation-list').setAttribute('aria-labelledby', `automation-tab-${tab}`);
    for (const control of $('automation-tabs').querySelectorAll('button')) {
      const selected = control.dataset.tab === tab; control.setAttribute('aria-selected', String(selected)); control.setAttribute('aria-pressed', String(selected)); control.tabIndex = selected ? 0 : -1;
    }
  }
  function status(message) { $('automation-status').textContent = message; }
  async function load() {
    if (selectedRun) return;
    const selected = ++version; controller?.abort(); controller = new AbortController();
    status(report ? '' : '正在加载'); $('automation-retry').hidden = true; $('automation-refresh').disabled = true;
    $('automation-list').setAttribute('aria-busy', 'true');
    try {
      const result = await api('proactive-tasks', 'GET', undefined, controller.signal);
      if (selected !== version || !$('automation-dialog').open || selectedRun) return;
      for (const task of result.tasks) {
        const saved = histories.get(task.id);
        if (saved && task.latestRun) histories.set(task.id, [task.latestRun, ...saved.filter(run => run.id !== task.latestRun.id)].slice(0, 30));
      }
      report = result; render(); status('');
    } catch (error) {
      if (selected !== version || error.name === 'AbortError') return;
      status(error.name === 'TypeError' ? '暂时无法加载主动任务。' : error.message || '暂时无法加载主动任务。'); $('automation-retry').hidden = false;
    } finally {
      if (selected === version) { $('automation-refresh').disabled = false; $('automation-list').setAttribute('aria-busy', 'false'); }
    }
  }
  async function control(task, action, requestId = crypto.randomUUID()) {
    if (busy) return;
    busy = true; status('正在保存');
    for (const button of $('automation-list').querySelectorAll('button')) button.disabled = true;
    $('automation-delete-submit').disabled = true; $('automation-delete-cancel').disabled = true;
    try {
      const receipt = await api('proactive-tasks/control', 'POST', { requestId, id: task.id, revision: task.revision, action });
      if (action === 'delete') { $('automation-delete-dialog').close(); histories.delete(task.id); report.tasks = report.tasks.filter(item => item.id !== task.id); }
      else report.tasks = report.tasks.map(item => item.id === task.id ? { ...item, ...receipt } : item);
      render(); await load();
    } catch (error) {
      if (action === 'delete') $('automation-delete-status').textContent = error.message || '删除失败，请重试。';
      else status(error.message || '保存失败，请重试。');
    } finally {
      busy = false; $('automation-delete-submit').disabled = false; $('automation-delete-cancel').disabled = false;
      for (const button of $('automation-list').querySelectorAll('button')) button.disabled = false;
    }
  }
  async function showRun(taskId, runId) {
    if (busy) return;
    clearTimeout(runTimer);
    const key = `${taskId}/${runId}`, selected = ++version; selectedRun = key; controller?.abort();
    $('automation-toolbar').hidden = true; $('automation-refresh').hidden = true;
    const back = button('返回任务', () => { clearTimeout(runTimer); selectedRun = undefined; $('automation-toolbar').hidden = false; $('automation-refresh').hidden = false; render(); void load(); });
    const content = node('div', 'automation-work'), heading = node('h3', 'automation-work-title');
    let work;
    $('automation-list').replaceChildren(back, content); status('正在加载');
    const update = async () => {
      if (selected !== version || selectedRun !== key || !$('automation-dialog').open) return;
      try {
        const result = await api(`proactive-tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`);
        if (selected !== version || selectedRun !== key || !$('automation-dialog').open) return;
        heading.textContent = `${report.tasks.find(task => task.id === taskId)?.title || ''} · ${date(result.triggeredAt)}`;
        work = renderRun(result, work);
        const delivery = badge(result.notificationStatus);
        if (result.notificationStatus === 'pending') delivery.textContent = '待发送';
        content.replaceChildren(heading, badge(result.state), delivery, work);
        if (result.conversationId) content.append(button('打开对话', async () => { close('automation-dialog'); await navigate(result); }));
        status('');
        if (['running', 'pending'].includes(result.state) || result.notificationStatus === 'pending') runTimer = setTimeout(update, 3000);
      } catch (error) {
        if (selected !== version || selectedRun !== key) return;
        status(error.message || '暂时无法加载工作过程。');
        content.append(button('重试加载', () => showRun(taskId, runId)));
      }
    };
    await update();
  }
  async function operate(resource, action, revision) {
    if (busy) return;
    busy = true; status('正在准备变更');
    const requestId = crypto.randomUUID();
    try {
      const conversationId = await conversation();
      const result = await api('proactive-tasks/operations', 'POST', { requestId, conversationId, id: resource.id, action, ...(revision ? { revision } : {}) });
      close('automation-dialog'); await navigate(result);
    } catch (error) { status(error.message || '未能准备变更，请重试。'); }
    finally { busy = false; }
  }
  window.ZigentAutomation = {
    initialize(options) {
      ({ api, close, conversation, navigate, discuss, renderRun } = options);
      $('automation-delete-cancel').onclick = () => $('automation-delete-dialog').close();
      $('automation-delete-submit').onclick = () => { if (deleteTarget) void control(deleteTarget, 'delete', deleteRequest); };
      $('automation-delete-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
      $('automation-delete-dialog').addEventListener('close', () => { if (!busy) $('automation-list').querySelector(`[data-id="${deleteTarget?.id}"] button[aria-label="删除"]`)?.focus(); });
      $('close-automation').onclick = () => close('automation-dialog'); $('automation-refresh').onclick = load; $('automation-retry').onclick = load;
      $('automation-create').onclick = () => discuss('我想创建一个可复用触发点，固定逻辑为：');
      $('automation-tabs').onclick = event => { const control = event.target.closest('button[data-tab]'); if (control) { tab = control.dataset.tab; render(); } };
      $('automation-tabs').onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const tabs = ['tasks', 'triggers'], index = tabs.indexOf(tab);
        tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs[(index + 1) % 2];
        event.preventDefault(); render(); $(`automation-tab-${tab}`).focus();
      };
      $('automation-dialog').addEventListener('close', () => { version++; selectedRun = undefined; clearTimeout(runTimer); controller?.abort(); clearInterval(timer); if ($('automation-delete-dialog').open) $('automation-delete-dialog').close(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden && $('automation-dialog').open && !busy) void load(); });
    },
    open() { selectedRun = undefined; $('automation-toolbar').hidden = false; $('automation-refresh').hidden = false; report = undefined; histories.clear(); $('automation-list').replaceChildren(); void load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden && !busy && !selectedRun && !$('automation-delete-dialog').open && !document.activeElement?.closest('.automation-trigger-form') && ![...document.querySelectorAll('.trigger-context-calendar:not([hidden]), .trigger-map-dialog[open]')].some(element => element.getClientRects().length)) void load(); }, 30_000); }
  };
})();
