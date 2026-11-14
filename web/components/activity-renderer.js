import { el, syncChildren, updateText } from '../dom.js';

export const activitySourceKey = message => `${message.conversationId}:${message.id}:${message.activityRevision}`;

if (typeof document !== 'undefined') {
  const syncVisibility = () => document.documentElement.toggleAttribute('data-activity-hidden', document.hidden);
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
}

const toolIcons = {
  wait: '<circle cx="10" cy="10" r="7.5"/><path d="M10 10V5.5"/><path data-motion="clock-hand" d="m10 10 3 2"/>',
  read: `<path d="M10 5C7.8 3 5 2.8 2 3.5v12c3-.7 5.8-.5 8 1.5 2.2-2 5-2.2 8-1.5v-12c-3-.7-5.8-.5-8 1.5Zm0 0v12"/>
    <path data-motion="book-print" d="M5 6.5l2 .5m-2 2.5 2 .5m6-3 2-.5m-2 3.5 2-.5"/>
    <path data-motion="book-page" opacity="0" d="M10 5c1.6-2 3.8-2.7 6-2.5v11.8c-2.2-.1-4.4.7-6 2.7"/>`,
  edit: `<path data-motion="pencil" d="m12.5 3.5 4 4M3 17l4.5-1L17 6.5a2.8 2.8 0 0 0-4-4l-9.5 9.5L3 17Z"/>
    <path data-motion="pencil-line" opacity="0" pathLength="1" d="M3 18h3.5"/>`,
  terminal: `<rect x="2" y="3.5" width="16" height="13" rx="2"/><path data-motion="terminal-prompt" d="m5.5 7 3 3-3 3M10.5 13h4"/>
    <svg x="4.5" y="5.5" width="11" height="9" viewBox="0 0 11 9" overflow="hidden">
      <path data-motion="terminal-output" opacity="0" stroke-width="1" d="m0 0 1 1-1 1M3 1h7M1 4h6M3 7h7m-10 2 1 1-1 1m3-1h7m-9 3h6m-4 3h7"/>
    </svg>`,
  document: '<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4"/><path data-motion="document-lines" pathLength="1" d="M7.5 10h5m-5 3h5"/>',
  search: '<g data-motion="search-lens"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4.5 4.5"/></g>',
  browser: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M2 7h16M5 5h.1M7.5 5h.1"/><path data-motion="browser-load" opacity="0" pathLength="1" d="M5 11h10"/>',
  folder: '<path d="M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/><path data-motion="folder-flap" opacity="0" d="M2 14 4.5 9.5H18"/>',
  image: '<rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="7.5" r="1.25"/><path d="m3 15 4-4 2.5 2.5 4-4L18 14"/><path data-motion="image-scan" opacity="0" stroke-width="1" d="M3.5 5.5h13"/>',
  video: '<rect x="2" y="3.5" width="16" height="13" rx="2"/><path data-motion="video-play" d="m8 7 5 3-5 3z"/><path data-motion="video-progress" opacity="0" pathLength="1" stroke-width="1" d="M4.5 14.5h11"/>',
  mail: '<rect x="2" y="4" width="16" height="12" rx="2"/><path data-motion="mail-flap" d="m3 6 7 5 7-5"/>',
  calendar: '<rect x="3" y="4" width="14" height="13" rx="2"/><path d="M6.5 2.5v3M13.5 2.5v3M3 8h14M7 12h.1M10 12h.1M13 12h.1"/><rect data-motion="calendar-day" opacity="0" x="5.5" y="10.5" width="3" height="3" rx=".6" stroke-width="1"/>',
  tasks: '<rect x="3.5" y="3.5" width="13" height="13" rx="2"/><path data-motion="task-check" pathLength="1" d="m6.5 10 2.5 2.5 4.5-5"/>',
  chart: '<path d="M3 3v14h14"/><path data-motion="chart-bar" d="M7 13v-3"/><path data-motion="chart-bar" d="M11 13V6"/><path data-motion="chart-bar" d="M15 13V8"/>',
  location: '<g data-motion="location-pin"><path d="M16 8c0 4.2-6 9-6 9s-6-4.8-6-9a6 6 0 1 1 12 0Z"/><circle cx="10" cy="8" r="2"/></g><path data-motion="location-ground" opacity="0" d="M7 18h6"/>',
  health: '<path d="M10 16.5 3.8 10.3a4.2 4.2 0 0 1 6.2-5.7 4.2 4.2 0 0 1 6.2 5.7L10 16.5Z"/><path data-motion="health-trace" opacity="0" pathLength="1" stroke-width="1" d="M5.5 9.5H8l1-2 1.3 4.5 1.3-2.5h2.9"/>',
  transit: `<g data-motion="train-car"><rect x="3.5" y="6" width="13" height="8" rx="2"/><path d="M6 8.5h2.5m2.5 0h3m0 0V11h2.5"/><circle cx="6.5" cy="15" r="1"/><circle cx="13.5" cy="15" r="1"/></g>
    <path d="M2 17h16"/><path data-motion="train-streak" opacity="0" stroke-width="1" d="M2.5 9h1.5m-2 2.5h1.5"/>`,
  mindmap: `<rect x="2" y="8" width="5" height="4" rx="1"/>
    <g data-motion="map-branch"><path d="M7 10h3V5h3"/><rect x="13" y="3" width="5" height="4" rx="1"/></g>
    <g data-motion="map-branch"><path d="M10 10v5h3"/><rect x="13" y="13" width="5" height="4" rx="1"/></g>`,
  bell: '<g data-motion="bell-ring"><path d="M4 14h12l-1.5-2.5V8a4.5 4.5 0 0 0-9 0v3.5zM8 16.5a2 2 0 0 0 4 0M10 3.5V2"/></g>',
  code: '<path data-motion="code-left" d="m6 6-4 4 4 4"/><path data-motion="code-right" d="m14 6 4 4-4 4"/><path data-motion="code-slash" pathLength="1" d="m11.5 4.5-3 11"/>',
  question: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v6a2.5 2.5 0 0 1-2.5 2.5H8l-4 3v-3.5a2.5 2.5 0 0 1-1-2z"/><path data-motion="question-mark" d="M8.5 6.5a1.7 1.7 0 1 1 2.2 2c-.5.2-.7.5-.7 1m0 2.3h.1"/>',
  microphone: '<rect x="7.5" y="2.5" width="5" height="10" rx="2.5"/><path d="M5.5 9.5v.5a4.5 4.5 0 0 0 9 0v-.5M10 14.5v3"/><path data-motion="microphone-wave" opacity="0" stroke-width="1" d="M4.5 5.5v3m-2-4v5m13-4v3m2-4v5"/>'
};

const defaultToolIcons = {
  web_search: 'search', browser: 'browser',
  workspaces: 'folder', files: 'folder', project_files: 'folder', project_sync: 'folder', artifact_files: 'folder', google_drive: 'folder',
  view_image: 'image', view_session_image: 'image', image_assets: 'image', image_generation: 'image', video_generation: 'video',
  schedule: 'calendar', google_calendar: 'calendar',
  gmail: 'mail', todoist: 'tasks', health_tasks: 'tasks', proactive_tasks: 'tasks',
  present_output: 'chart', user_location: 'location', health_data: 'health', beijing_subway: 'transit', xmind: 'mindmap',
  phone_notifications: 'bell', codex: 'code', deployment_status: 'code', ask_user_question: 'question', voice_call: 'microphone',
  skills: 'read', load_skill: 'read', update_skill: 'edit', conversation_history: 'read',
  exec_command: 'terminal', write_stdin: 'terminal', apply_patch: 'edit'
};

function activityToolIcon(item) {
  const { actionKind, fileOperation, waiting, title } = item.presentation;
  if (Object.hasOwn(toolIcons, actionKind)) return actionKind;
  if (item.name === 'view_image') return 'image';
  if (item.name === 'documents' && (title === '检索文档' || title?.startsWith('检索 '))) return 'search';
  if (fileOperation === 'read' || fileOperation === 'edit') return fileOperation;
  if (waiting === true || item.name === 'subagents' && waiting === false) return 'wait';
  return Object.hasOwn(defaultToolIcons, item.name) ? defaultToolIcons[item.name] : 'document';
}

function updateToolIcon(entry, icon, running) {
  if (entry.iconRunning !== running) {
    entry.iconRunning = running;
    entry.icon.classList.toggle('is-running', running);
  }
  if (entry.iconKey === icon) return;
  entry.iconKey = icon;
  entry.icon.setAttribute('aria-hidden', 'true');
  entry.icon.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${toolIcons[icon]}</svg>`;
}

function activityTitle({ status, startedAt, endedAt }) {
  if (status === 'running') return 'Working';
  if (status === 'failed') return '这次处理未完成';
  if (status === 'cancelled') return '已停止';
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return 'Worked';
  const seconds = Math.max(1, Math.round((endedAt - startedAt) / 1000));
  return `Worked for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function thoughtSummary(text) {
  return /^[^\r\n]+/.exec(text.trimStart())?.[0].trimEnd() || '';
}

function setExpandable(entry, hasDetails) {
  if (entry.hasDetails === hasDetails) return;
  entry.hasDetails = hasDetails;
  entry.node.classList.toggle('has-details', hasDetails);
  entry.summary.tabIndex = hasDetails ? 0 : -1;
  entry.summary.setAttribute('aria-disabled', String(!hasDetails));
  if (!hasDetails) entry.node.open = false;
}

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
  const liveToolRows = new WeakMap();
  function renderThoughtText(node, text) {
    node.replaceChildren();
    inline(node, text);
    if (node.firstChild?.nodeName === 'STRONG') node.firstChild.classList.add('activity-thinking-heading');
  }

  // Old searches keep their keywords in the allowlisted presentation details.
  // Never infer subjects from raw tool arguments or a completed-result sentence.
  function activityToolTitle(item) {
    if (item.name === 'web_search') {
      const keywords = item.presentation.details?.find(field => field.label === '搜索关键词')?.value?.trim();
      return keywords ? `搜索 ${keywords}` : item.presentation.title === '搜索网页' ? '搜索' : item.presentation.title || '搜索';
    }
    return item.presentation.title || ({ project_files: '查阅项目资料', project_sync: '同步项目资料',
      present_output: '展示可视化', skills: '技能', load_skill: '阅读技能', update_skill: '更新技能',
      conversation_history: '查阅历史会话', view_session_image: '查看图片',
      image_generation: '生成图片', video_generation: '生成视频', long_term_memory: '整理记忆', health_data: '查阅健康数据',
      health_tasks: '管理健康任务', proactive_tasks: '管理任务', user_location: '查询位置',
      beijing_subway: '查阅地铁时刻表',
      ask_user_question: '等待选择', codex: '处理代码任务' })[item.name]
      || item.presentation.message.replace(/^我(?:正在|已|会|先)/, '').replace(/[。…]+$/, '');
  }

  function updateLivePreview(view) {
    const { container, snapshot } = view;
    if (snapshot.status !== 'running' || container.open) {
      clearLivePreview(view);
      return;
    }
    // Stream patches replace changed items and retain references to earlier rows.
    const rows = snapshot.items.filter(item => item.type !== 'response' && item.type !== 'subagent').map(item => {
      if (item.type === 'tool') {
        let row = liveToolRows.get(item);
        if (!row) {
          row = { id: item.id, icon: activityToolIcon(item), status: item.status,
            text: item.status === 'failed' ? item.presentation.message : activityToolTitle(item) };
          liveToolRows.set(item, row);
        }
        return row;
      }
      const expanded = item.type === 'thought' && item.status === 'running';
      return { id: item.id, expanded, text: expanded ? item.text.trimStart() : thoughtSummary(item.text).slice(0, 240) };
    }).filter(row => row.text);
    if (!rows.length) {
      clearLivePreview(view);
      return;
    }
    if (!view.live) {
      const viewport = el('span', 'activity-live'), content = el('span', 'activity-live-content');
      viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', '工作进度'); viewport.tabIndex = 0;
      viewport.addEventListener('click', event => event.preventDefault());
      viewport.addEventListener('keydown', event => event.stopPropagation());
      viewport.append(content); view.summary.append(viewport);
      view.live = { viewport, content, rows: new Map(), interacting: false };
      viewport.addEventListener('touchstart', () => { view.live.interacting = true; }, { passive: true });
      viewport.addEventListener('touchend', () => { if (view.live) view.live.interacting = false; }, { passive: true });
      viewport.addEventListener('touchcancel', () => { if (view.live) view.live.interacting = false; }, { passive: true });
    }
    const live = view.live;
    let followBottom, orderChanged = rows.length !== live.rows.size;
    const beforeContentChange = () => {
      followBottom ??= !live.interacting && live.viewport.scrollHeight - live.viewport.scrollTop - live.viewport.clientHeight <= 4;
    };
    const entries = rows.map((row, index) => {
      let entry = live.rows.get(row.id);
      if (!entry || Boolean(row.icon) !== Boolean(entry.icon)) {
        const node = el('span', 'activity-live-row');
        entry = { node, text: document.createTextNode('') };
        if (row.icon) {
          entry.icon = el('span', 'activity-tool-icon');
          const label = el('span', 'activity-live-tool-text'); label.append(entry.text);
          node.classList.add('activity-live-tool'); node.append(entry.icon, label);
        }
      }
      if (entry.icon) {
        updateToolIcon(entry, row.icon, row.status === 'running');
        if (entry.node.dataset.status !== row.status) entry.node.dataset.status = row.status;
      }
      if (entry.node !== live.content.children[index]) orderChanged = true;
      if (entry.expanded !== row.expanded) {
        beforeContentChange();
        entry.expanded = row.expanded;
        entry.node.classList.toggle('activity-live-expanded', Boolean(row.expanded));
      }
      if (entry.value !== row.text) {
        beforeContentChange();
        if (entry.icon) entry.text.data = row.text;
        else renderThoughtText(entry.node, row.text);
        entry.value = row.text;
      }
      return [row.id, entry];
    });
    if (orderChanged) {
      beforeContentChange();
      live.rows = new Map(entries);
      syncChildren(live.content, entries.map(([, entry]) => entry.node));
    }
    if (followBottom) queueMicrotask(() => {
      if (view.live === live && !live.interacting) live.viewport.scrollTop = live.viewport.scrollHeight;
    });
  }

  function clearLivePreview(view) {
    if (!view.live) return;
    view.live.viewport.remove(); view.live = undefined;
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
  function activity(snapshot, id, container, source) {
    if (!container) {
      container = el('details', 'activity activity-process'); container.dataset.messageId = id;
      const summary = el('summary'), heading = el('span', 'activity-heading'), preview = el('span', 'activity-preview'), section = el('section');
      heading.append(preview); summary.append(heading); container.append(summary, section);
      activityViews.set(container, { container, summary, preview, section, items: new Map(), failure: el('p', 'activity-failure') });
      container.addEventListener('toggle', event => {
        if (event.target !== container) return;
        const view = activityViews.get(container);
        updateLivePreview(view);
        if (container.open) showActivity(view);
      });
    }
    const view = activityViews.get(container);
    if (view.snapshot?.status === 'running' && snapshot.status !== 'running') {
      container.open = false;
      for (const entry of view.items.values()) if (entry.node.classList.contains('activity-thought')) entry.node.open = false;
    }
    view.snapshot = snapshot; view.source = source; view.sourceKey = source?.activityDeferred ? activitySourceKey(source) : undefined;
    container.classList.toggle('running', snapshot.status === 'running');
    updateText(view.preview, activityTitle(snapshot));
    updateLivePreview(view);
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
          entry.summary = el('summary'); entry.icon = el('span', 'activity-tool-icon');
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
          entry.summary.onclick = event => { if (!entry.hasDetails && !event.target.closest?.('a')) event.preventDefault(); };
          entry.summary.append(entry.preview); entry.node.append(entry.summary, entry.text);
        } else entry.node.append(entry.text);
        view.items.set(item.id, entry);
      }
      children.push(entry.node);
      const recovered = Boolean(item.type === 'tool' && item.status === 'failed' && item.operationKey
        && snapshot.operationResults?.[item.operationKey] === 'completed');
      const running = snapshot.status === 'running' && item.status === 'running';
      if (entry.item === item && entry.recovered === recovered && entry.running === running) continue;
      entry.item = item; entry.recovered = recovered; entry.running = running;
      const waiting = item.type === 'tool' && item.status !== 'failed' && item.presentation.waiting === true;
      const displayStatus = recovered ? 'recovered' : waiting && item.status !== 'running' ? 'waiting' : item.status;
      if (entry.node.dataset.status !== displayStatus) entry.node.dataset.status = displayStatus;
      if (item.type === 'thought') {
        entry.node.classList.toggle('is-running', running);
        if (entry.thoughtText !== item.text) {
          const text = item.text.trimStart(), end = text.search(/\r?\n/);
          const rest = end < 0 ? '' : text.slice(end + 1).trimEnd();
          const heading = thoughtSummary(text) || '…';
          if (entry.thoughtHeading !== heading) {
            renderThoughtText(entry.preview, heading);
            entry.thoughtHeading = heading;
          }
          entry.text.replaceChildren(); inline(entry.text, rest); entry.text.hidden = !rest;
          setExpandable(entry, Boolean(rest));
          entry.thoughtText = item.text;
        }
        continue;
      }
      if (item.type !== 'tool') {
        updateText(entry.text, item.text);
        continue;
      }
      const title = activityToolTitle(item);
      const fileOperation = ['read', 'edit'].includes(item.presentation.fileOperation) ? item.presentation.fileOperation : undefined;
      const icon = activityToolIcon(item);
      entry.node.classList.toggle('activity-search', icon === 'search');
      updateToolIcon(entry, icon, running);
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
      updateText(entry.text, hasCommand && !fileOperation ? lines[first] : title);
      const rest = hasCommand ? fileOperation ? command : lines.slice(first + 1).join('\n').trimEnd() : '';
      updateText(entry.command, rest); entry.command.hidden = !rest || hasDiff;
      entry.node.classList.toggle('activity-command', hasCommand && !fileOperation);
      entry.node.classList.toggle('activity-file', Boolean(fileOperation));
      const status = recovered ? '已重试' : item.status === 'failed' ? '未完成' : waiting ? '等待'
        : item.name === 'subagents' && item.presentation.waiting === false && item.status === 'completed' ? '已收到' : '';
      updateText(entry.state, status);
      const stateLabel = status || (item.status !== 'running' ? '已完成' : running ? '进行中' : '已中止');
      entry.summary.setAttribute('aria-label', `${entry.text.textContent}${hasStats ? `，新增 ${diff.additions} 行，删除 ${diff.deletions} 行` : ''}，${stateLabel}`);
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
      setExpandable(entry, Boolean(hasDiff || rest || fields.length || resources.length || message));
    }
    for (const itemId of view.items.keys()) if (!itemIds.has(itemId)) view.items.delete(itemId);
    if (snapshot.failureMessage) { updateText(view.failure, snapshot.failureMessage); children.push(view.failure); }
    const mounted = view.section.childNodes;
    if (mounted.length !== children.length || children.some((child, index) => child !== mounted[index])) {
      syncChildren(view.section, children);
    }
  }
  return { activity, activityViews };
}
