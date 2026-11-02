import { el, syncChildren, updateText } from '../dom.js';
import { mochiSvg, randomMochiHue } from './mochi.js';

/** Older replies flattened children into tool rows. Rebuild only explicit ID boundaries. */
export function subagentTimeline(items = [], parentStatus) {
  const children = new Map(), timeline = [];
  for (const item of items) {
    if (item.type === 'subagent') { children.set(item.id, item); timeline.push(item); continue; }
    const match = item.type === 'tool' && /^subagent:([^:]+):(\d+)(?::|$)/.exec(item.id);
    if (!match) {
      // Old dispatch/wait/read bookkeeping adds no information to the child panel.
      if (item.type !== 'tool' || item.name !== 'subagents' || item.status === 'failed') timeline.push(item);
      continue;
    }
    const id = `subagent:${match[1]}:${match[2]}`;
    let child = children.get(id);
    if (!child) {
      child = { id, type: 'subagent', agentId: match[1], generation: Number(match[2]), title: '子任务',
        status: 'running', legacy: true, snapshot: { status: 'running', items: [], answerDraft: '' } };
      children.set(id, child); timeline.push(child);
    }
    if (item.id === id) {
      child.title = item.presentation.title || child.title;
      child.status = item.status;
      if (item.status === 'failed' && /已停止子任务/.test(item.presentation.message)) child.status = 'cancelled';
      child.durationMs = item.durationMs;
      child.snapshot.status = child.status;
      if (item.status === 'failed') child.snapshot.failureMessage = item.presentation.message;
    } else {
      const title = item.presentation.title?.replace(/^[\s\S]*? · /, '');
      child.snapshot.items.push({ ...item, presentation: { ...item.presentation, title } });
    }
  }
  // A restart can leave historical child rows running after the owning reply has ended.
  for (const child of children.values()) if (child.status === 'running' && parentStatus !== 'running') {
    const stopped = { ...child, status: 'cancelled', snapshot: { ...child.snapshot, status: 'cancelled' } };
    children.set(child.id, stopped); timeline[timeline.indexOf(child)] = stopped;
  }
  return { items: timeline, children: [...children.values()] };
}

const statusText = { running: '进行中', completed: '已完成', failed: '未完成', cancelled: '已停止' };
function duration(value) {
  if (!Number.isFinite(value)) return '';
  const seconds = Math.max(1, Math.round(value / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
/* Each new child gets a random color, then keeps it through status changes. */

export function createSubagentRenderer({ markdown, activity, load, resize, runningText = () => '正在处理' }) {
  function renderBody(entry, item) {
    const key = JSON.stringify([item.task, item.model, item.durationMs, item.snapshot]);
    if (entry.bodyKey === key) return;
    entry.bodyKey = key;
    const nodes = [], meta = [item.model, item.generation > 1 ? `第 ${item.generation} 轮` : ''].filter(Boolean);
    if (meta.length) nodes.push(el('p', 'subagent-meta', meta.join(' · ')));
    if (item.task) {
      entry.assignment ||= el('details', 'subagent-assignment');
      const summary = entry.assignment.firstElementChild || el('summary', '', '任务');
      syncChildren(entry.assignment, [summary, el('p', '', item.task)]); nodes.push(entry.assignment);
    }
    if (item.snapshot?.items.length) {
      const snapshot = { ...item.snapshot, failureMessage: undefined, items: item.snapshot.items.map(child =>
        item.status !== 'running' && child.status === 'running' && child.type === 'tool' ? { ...child, status: 'failed' } : child) };
      entry.process = activity(snapshot, item.id, entry.process);
      if (item.status !== 'running') updateText(entry.process.querySelector('.activity-preview'), '执行过程');
      nodes.push(entry.process);
    }
    if (item.snapshot?.answerDraft) {
      entry.result ||= el('div', 'subagent-result');
      if (entry.resultText !== item.snapshot.answerDraft) {
        entry.resultText = item.snapshot.answerDraft;
        entry.result.replaceChildren(markdown(entry.resultText));
      }
      nodes.push(el('h4', 'subagent-result-label', '结果'), entry.result);
    } else if (item.status === 'running') nodes.push(el('p', 'subagent-empty', '正在处理…'));
    if (item.snapshot?.failureMessage) nodes.push(el('p', 'activity-failure', item.snapshot.failureMessage));
    syncChildren(entry.body, nodes);
  }
  function show(view, entry) {
    if (view.openId !== entry.item.id) return;
    const { source, item } = entry;
    const sourceKey = source.activityDeferred ? `${source.conversationId}:${source.id}:${source.activityRevision}` : undefined;
    if (!sourceKey) { renderBody(entry, item); return; }
    if (entry.resolvedKey === sourceKey) { renderBody(entry, entry.resolved); return; }
    if (entry.loadingKey === sourceKey) return;
    entry.loadingKey = sourceKey; entry.body.setAttribute('aria-busy', 'true');
    entry.body.replaceChildren(el('p', 'subagent-empty', '正在加载…')); entry.bodyKey = undefined;
    const current = () => entry.source === source && view.openId === item.id && view.node.isConnected;
    void load(source).then(snapshot => {
      if (!current()) return;
      const resolved = subagentTimeline(snapshot.items, snapshot.status).children.find(child => child.id === item.id);
      if (!resolved) throw new Error('子任务记录不可用');
      entry.resolvedKey = sourceKey; entry.resolved = resolved;
      resize(() => renderBody(entry, resolved));
    }).catch(error => {
      if (!current() || error.name === 'AbortError') return;
      const retry = el('button', 'text-button', '重试'); retry.type = 'button'; retry.onclick = () => show(view, entry);
      resize(() => entry.body.replaceChildren(el('p', 'activity-failure', error.message), retry));
    }).finally(() => {
      if (entry.loadingKey === sourceKey) {
        entry.loadingKey = undefined; entry.body.removeAttribute('aria-busy');
        // A message refresh during the request must still resolve its open workspace.
        if (entry.source !== source && view.openId === item.id && view.node.isConnected) show(view, entry);
      }
    });
  }
  function layout(view) {
    const entry = view.openId && view.entries.get(view.openId);
    if (!entry) { syncChildren(view.node, [view.heading, view.grid]); return; }
    const { item } = entry;
    view.detail.dataset.status = item.status;
    view.detailOrb.style.setProperty('--hue', entry.hue);
    updateText(view.detailTitle, item.name || item.title);
    updateText(view.detailProfession, item.profession || ''); view.detailProfession.hidden = !item.profession;
    updateText(view.detailState, statusText[item.status] || '已停止');
    if (view.detailBody.firstChild !== entry.body) view.detailBody.replaceChildren(entry.body);
    syncChildren(view.node, [view.detail]);
  }
  return function render(items, source, view) {
    if (!view) {
      view = { node: el('section', 'activity subagent-team'), heading: el('div', 'subagent-heading'), entries: new Map(),
        grid: el('div', 'subagent-grid'), openId: null, detail: el('div', 'subagent-detail'), hues: new Map() };
      view.node.setAttribute('aria-label', '子 Agent');
      view.heading.append(el('span', '', '子 Agent')); view.count = el('span', 'subagent-count'); view.heading.append(view.count);
      const back = el('button', 'subagent-back'); back.type = 'button'; back.setAttribute('aria-label', '返回');
      back.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4 7 10l5.5 6"/></svg>';
      back.onclick = () => { view.openId = null; layout(view); };
      view.detailOrb = el('span', 'subagent-avatar'); view.detailOrb.setAttribute('aria-hidden', 'true');
      view.detailOrb.innerHTML = mochiSvg();
      view.detailTitle = el('span', 'subagent-detail-title'); view.detailProfession = el('span', 'subagent-profession');
      view.detailState = el('span', 'subagent-detail-state'); view.detailBody = el('div', 'subagent-detail-body');
      const identity = el('div', 'subagent-detail-identity'); identity.append(view.detailTitle, view.detailProfession);
      const head = el('div', 'subagent-detail-head'); head.append(back, view.detailOrb, identity, view.detailState);
      view.detail.append(head, view.detailBody);
      view.node.append(view.heading, view.grid);
    }
    const cells = [], ids = new Set();
    for (const item of items) {
      ids.add(item.id);
      let entry = view.entries.get(item.id);
      if (!entry) {
        const key = item.agentId || item.id;
        if (!view.hues.has(key)) view.hues.set(key, randomMochiHue());
        entry = { item, hue: view.hues.get(key), body: el('div'),
          cell: el('button', 'subagent-cell'), avatar: el('span', 'subagent-avatar'),
          name: el('span', 'subagent-name'), meta: el('span', 'subagent-cell-meta') };
        entry.cell.type = 'button';
        entry.avatar.setAttribute('aria-hidden', 'true');
        entry.avatar.style.setProperty('--hue', entry.hue);
        entry.avatar.innerHTML = mochiSvg();
        entry.cell.append(entry.avatar, entry.name, entry.meta);
        entry.cell.onclick = () => { view.openId = entry.item.id; layout(view); show(view, entry); };
        view.entries.set(item.id, entry);
      }
      entry.item = item; entry.source = source; entry.cell.dataset.status = item.status;
      updateText(entry.name, item.name || item.title);
      const statusBit = item.status === 'running' ? runningText()
        : item.status === 'completed' ? duration(item.durationMs) : statusText[item.status] || '已停止';
      updateText(entry.meta, [item.profession, statusBit].filter(Boolean).join(' · '));
      entry.cell.setAttribute('aria-label', `${item.name || item.title}，${statusText[item.status] || '已停止'}`);
      show(view, entry);
      cells.push(entry.cell);
    }
    for (const id of view.entries.keys()) if (!ids.has(id)) view.entries.delete(id);
    if (view.openId && !ids.has(view.openId)) view.openId = null;
    updateText(view.count, `${items.length}`);
    syncChildren(view.grid, cells);
    layout(view);
    return view;
  };
}
