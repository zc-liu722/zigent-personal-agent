import { el, syncChildren, updateText } from '../dom.js';

export const activitySourceKey = message => `${message.conversationId}:${message.id}:${message.activityRevision}`;
const toolIcons = {
  read: '<path d="M10 5C7.8 3 5 2.8 2 3.5v12c3-.7 5.8-.5 8 1.5 2.2-2 5-2.2 8-1.5v-12c-3-.7-5.8-.5-8 1.5Zm0 0v12M5 6v6M15 6v6"/>',
  edit: '<path d="m12.5 3.5 4 4M3 17l4.5-1L17 6.5a2.8 2.8 0 0 0-4-4l-9.5 9.5L3 17Z"/>',
  terminal: '<rect x="2" y="3.5" width="16" height="13" rx="2"/><path d="m5.5 7 3 3-3 3M10.5 13h4"/>',
  document: '<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h5"/>'
};

function renderActivityDiff(entry) {
  const patch = entry.diffData?.patch;
  if (!entry.node.open || !patch || entry.renderedDiff === patch) return;
  entry.renderedDiff = patch;
  const groups = [];
  const lines = patch.split('\n');
  for (const [index, line] of lines.entries()) {
    const fileHeader = line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')
      || line.startsWith('+++ ') && lines[index - 1]?.startsWith('--- ');
    const kind = line.startsWith('@@') ? 'hunk' : fileHeader ? 'file'
      : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context';
    if (groups.at(-1)?.kind === kind) groups.at(-1).lines.push(line);
    else groups.push({ kind, lines: [line] });
  }
  const fragment = document.createDocumentFragment();
  for (const [index, group] of groups.entries()) fragment.append(el('span', `activity-diff-${group.kind}`,
    group.lines.join('\n') + (index < groups.length - 1 ? '\n' : '')));
  entry.diffCode.replaceChildren(fragment);
}

/** The conversation and preview share the same expandable thought/tool process view. */
export function createActivityRenderer({ inline, load: fetchActivity, cache: activityCache = new Map(), activityViews = new WeakMap(),
  captureReadingPosition = () => undefined, restoreReadingPosition = () => {}, rememberReadingPosition = () => {} }) {
  const activityKey = activitySourceKey;
  // Old snapshots predate concise titles. Use fixed actions for known tools;
  // never infer subjects from raw tool arguments or a completed-result sentence.
  function activityToolTitle(item) {
    return item.presentation.title || ({ project_files: '查阅项目资料', project_sync: '同步项目资料',
      web_search: '搜索网页', present_output: '展示可视化', load_skill: '阅读技能', update_skill: '更新技能',
      browser: '浏览网页', conversation_history: '查阅历史会话', view_session_image: '查看图片',
      image_generation: '生成图片', video_generation: '生成视频', google_drive: '查阅云端文件',
      schedule: '处理日程与待办', google_calendar: '处理日历', long_term_memory: '整理记忆', health_data: '查阅健康数据',
      health_tasks: '管理健康任务', proactive_tasks: '管理任务', user_location: '查询位置',
      beijing_subway: '查阅地铁时刻表', notion: '处理 Notion 内容', todoist: '处理待办', xmind: '处理思维导图',
      ask_user_question: '等待选择', codex: '处理代码任务' })[item.name]
      || item.presentation.message.replace(/^我(?:正在|已|会)/, '').replace(/[。…]+$/, '');
  }
  const activityRenderKey = view => JSON.stringify([view.sourceKey, view.snapshot.status, view.snapshot.failureMessage, view.snapshot.items.map(item => item.id)]);
  function renderResolvedActivity(view, full) {
    const ids = new Set(view.snapshot.items.map(item => item.id));
    renderActivityItems(view, { ...view.snapshot, items: full.items.filter(item => ids.has(item.id)),
      operationResults: Object.fromEntries(full.items.filter(item => item.type === 'tool' && item.operationKey).map(item => [item.operationKey, item.status])) });
  }
  function showActivity(view) {
    const source = view.source, key = view.sourceKey;
    if (!source?.activityDeferred) {
      view.loadingKey = undefined; view.renderedKey = undefined; view.section.removeAttribute('aria-busy');
      renderActivityItems(view, view.snapshot); return;
    }
    // An immutable process already shown in this group needs neither a redraw nor another download.
    if (view.renderedKey === activityRenderKey(view)) return;
    const cached = activityCache.get(key);
    if (cached) {
      activityCache.delete(key); activityCache.set(key, cached);
      view.section.removeAttribute('aria-busy'); renderResolvedActivity(view, cached.snapshot); view.renderedKey = activityRenderKey(view); return;
    }
    if (view.loadingKey === key) return;
    view.loadingKey = key; view.section.setAttribute('aria-busy', 'true');
    view.section.replaceChildren(el('p', '', '正在加载…'));
    const current = () => view.sourceKey === key && view.container.open && view.container.isConnected;
    void fetchActivity(source).then(snapshot => {
      if (!current()) return;
      const position = captureReadingPosition();
      renderResolvedActivity(view, snapshot);
      view.renderedKey = activityRenderKey(view);
      restoreReadingPosition(position); rememberReadingPosition();
    }).catch(error => {
      if (!current() || error.name === 'AbortError') return;
      const retry = el('button', 'text-button', '重试'); retry.type = 'button';
      retry.onclick = () => showActivity(view);
      view.section.replaceChildren(el('p', 'activity-failure', error.message), retry);
    }).finally(() => {
      if (view.loadingKey === key) { view.loadingKey = undefined; view.section.removeAttribute('aria-busy'); }
    });
  }
  function activity(snapshot, id, container, _restoreScroll, source) {
    const running = snapshot.status === 'running';
    if (!container) {
      container = el('details', 'activity activity-process'); container.dataset.messageId = id;
      const summary = el('summary'), preview = el('span', 'activity-preview'), section = el('section');
      summary.append(preview); container.append(summary, section);
      activityViews.set(container, { container, summary, preview, section, items: new Map(), failure: el('p', 'activity-failure') });
      container.addEventListener('toggle', event => {
        if (event.target === container && container.open) showActivity(activityViews.get(container));
      });
    }
    const view = activityViews.get(container);
    view.snapshot = snapshot; view.source = source; view.sourceKey = source?.activityDeferred ? activityKey(source) : undefined;
    container.className = `activity activity-process ${running ? 'running' : ''}`;
    const items = (snapshot.items || []).filter(item => item.type !== 'response' && item.type !== 'subagent');
    // Restore the original top-level lifecycle presentation (2026-10-21).
    const lastTool = [...items].reverse().find(item => item.type === 'tool');
    const title = running ? (lastTool?.presentation?.message || '正在思考…')
      : snapshot.status === 'failed' ? '这次处理未完成' : snapshot.status === 'cancelled' ? '已停止' : '查看思考与过程';
    updateText(view.preview, title);
    // Closed process groups create no tool/thought DOM and request no details.
    if (container.open) showActivity(view);
    return container;
  }
  function renderActivityItems(view, snapshot) {
    const children = [], itemIds = new Set();
    const items = (snapshot.items || []).filter(item => item.type !== 'response' && item.type !== 'subagent');
    for (const item of items) {
      itemIds.add(item.id);
      let entry = view.items.get(item.id);
      if (!entry) {
        entry = { node: el(item.type === 'tool' || item.type === 'thought' ? 'details' : 'div', `activity-item activity-${item.type}`), text: el('p'),
          body: el('div', 'activity-tool-details'), context: el('div'), links: el('div', 'activity-resources'), resources: '', detailKey: '' };
        if (item.type === 'tool') {
          entry.summary = el('summary'); entry.icon = el('span', 'activity-tool-icon'); entry.icon.setAttribute('aria-hidden', 'true');
          entry.state = el('span', 'activity-tool-state');
          entry.diffStats = el('span', 'activity-diff-stats'); entry.diffStats.hidden = true;
          entry.additions = el('span', 'activity-diff-add'); entry.deletions = el('span', 'activity-diff-remove');
          entry.diffStats.append(entry.additions, entry.deletions);
          entry.summary.append(entry.icon, entry.text, entry.diffStats, entry.state);
          entry.summary.onclick = event => { if (!entry.hasDetails) event.preventDefault(); };
          entry.command = el('pre', 'activity-command-rest'); entry.command.hidden = true;
          entry.diffCard = el('div', 'activity-diff-card'); entry.diffCard.hidden = true;
          const diffHeader = el('div', 'activity-diff-header'), copy = el('button', 'activity-diff-copy');
          copy.type = 'button'; copy.setAttribute('aria-label', '复制 Diff'); copy.title = '复制 Diff';
          copy.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="6" width="10" height="11" rx="2"/><path d="M7 6V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-2"/></svg>';
          copy.onclick = async () => {
            try { await navigator.clipboard.writeText(entry.diffData.patch); copy.title = '已复制'; copy.setAttribute('aria-label', '已复制'); }
            catch { copy.title = '复制失败，点击重试'; copy.setAttribute('aria-label', copy.title); }
          };
          diffHeader.append(el('span', '', 'Diff'), copy);
          entry.diffCode = el('code'); const diffPre = el('pre'); diffPre.append(entry.diffCode);
          entry.diffCard.append(diffHeader, diffPre);
          entry.node.addEventListener('toggle', event => { if (event.target === entry.node) renderActivityDiff(entry); });
          entry.body.append(entry.diffCard, entry.command, entry.context, entry.links); entry.node.append(entry.summary, entry.body);
        } else if (item.type === 'thought') {
          entry.summary = el('summary'); entry.preview = el('span', 'activity-thought-preview');
          entry.summary.append(entry.preview); entry.node.append(entry.summary, entry.text);
        } else entry.node.append(entry.text);
        view.items.set(item.id, entry);
      }
      const recovered = item.type === 'tool' && item.status === 'failed' && item.operationKey
        && snapshot.operationResults?.[item.operationKey] === 'completed';
      entry.node.dataset.status = recovered ? 'recovered' : item.status;
      if (item.type !== 'tool') {
        if (item.type === 'thought') {
          if (entry.thoughtText !== item.text) {
            const lines = item.text.split(/\r?\n/), first = lines.findIndex(line => line.trim());
            // The summary is also the opening of the expanded text; render it only once.
            const rest = first < 0 ? '' : lines.slice(first + 1).join('\n');
            entry.preview.replaceChildren();
            inline(entry.preview, first < 0 ? '…' : lines[first].trim());
            entry.text.replaceChildren();
            inline(entry.text, rest); entry.text.hidden = !rest;
            entry.thoughtText = item.text;
          }
        } else updateText(entry.text, item.text);
        children.push(entry.node); continue;
      }
      // Keep the action stable while its status and optional details update in place.
      entry.title ||= activityToolTitle(item);
      const fileOperation = ['read', 'edit'].includes(item.presentation.fileOperation) ? item.presentation.fileOperation : undefined;
      const icon = fileOperation || (['exec_command', 'write_stdin'].includes(item.name) ? 'terminal' : item.name === 'apply_patch' ? 'edit' : 'document');
      if (entry.iconKey !== icon) {
        entry.iconKey = icon;
        entry.icon.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${toolIcons[icon]}</svg>`;
      }
      const command = item.name === 'exec_command' ? item.presentation.command : undefined;
      const lines = command?.split(/\r?\n/), first = lines?.findIndex(line => line.trim()) ?? -1;
      const hasCommand = first >= 0;
      const diff = item.presentation.diff;
      entry.diffData = diff;
      const hasDiff = Boolean(diff?.patch);
      const hasStats = Number.isInteger(diff?.additions) && Number.isInteger(diff?.deletions);
      entry.diffStats.hidden = !hasStats; entry.diffCard.hidden = !hasDiff;
      updateText(entry.additions, hasStats ? `+${diff.additions}` : '');
      updateText(entry.deletions, hasStats ? `−${diff.deletions}` : '');
      entry.diffStats.setAttribute('aria-label', hasStats ? `新增 ${diff.additions} 行，删除 ${diff.deletions} 行` : '');
      entry.node.classList.toggle('has-diff', hasDiff);
      if (hasDiff) renderActivityDiff(entry);
      updateText(entry.text, hasCommand && !fileOperation ? lines[first] : item.presentation.title || entry.title);
      const rest = hasCommand ? fileOperation ? command : lines.slice(first + 1).join('\n') : '';
      updateText(entry.command, rest); entry.command.hidden = !rest || hasDiff;
      entry.node.classList.toggle('activity-command', hasCommand && !fileOperation);
      entry.node.classList.toggle('activity-file', Boolean(fileOperation));
      const status = recovered ? '已重试' : item.status === 'failed' ? '未完成' : '';
      updateText(entry.state, status);
      entry.summary.setAttribute('aria-label', `${entry.text.textContent}${hasStats ? `，新增 ${diff.additions} 行，删除 ${diff.deletions} 行` : ''}，${status || (item.status === 'running' ? '进行中' : '已完成')}`);
      const resources = (item.presentation.resources || []).filter(resource => /^https?:\/\//i.test(resource.url || ''));
      const resourceKey = JSON.stringify(resources);
      if (entry.resources !== resourceKey) {
        entry.resources = resourceKey;
        entry.links.replaceChildren(...resources.map(resource => {
          const a = el('a', '', resource.title); a.href = resource.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
        }));
      }
      const fields = item.presentation.details || [];
      const failure = recovered ? '首次展示未完成，重试已成功' : item.status === 'failed' ? item.presentation.message : '';
      const message = failure || (fileOperation && !hasDiff ? item.presentation.message : '');
      entry.context.hidden = hasDiff && !failure;
      const detailKey = JSON.stringify([fields, message]);
      if (entry.detailKey !== detailKey) {
        entry.detailKey = detailKey;
        entry.context.replaceChildren(...(message ? [el('p', '', message)] : []), ...fields.map(field => {
          const row = el('p'); row.append(el('span', 'activity-detail-label', `${field.label} · `), el('span', '', field.value)); return row;
        }));
      }
      entry.hasDetails = Boolean(hasDiff || fileOperation || hasCommand || fields.length || resources.length || failure);
      entry.node.classList.toggle('has-details', entry.hasDetails);
      entry.summary.tabIndex = entry.hasDetails ? 0 : -1;
      entry.summary.setAttribute('aria-disabled', String(!entry.hasDetails));
      if (!entry.hasDetails) entry.node.open = false;
      children.push(entry.node);
    }
    for (const itemId of view.items.keys()) if (!itemIds.has(itemId)) view.items.delete(itemId);
    if (snapshot.failureMessage) { updateText(view.failure, snapshot.failureMessage); children.push(view.failure); }
    syncChildren(view.section, children);
  }
  return { activity, activityViews };
}
