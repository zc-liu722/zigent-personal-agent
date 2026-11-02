import { createComponentChat } from '/chat.js';
import { componentScenarios } from '/fixtures.js';
const $ = id => document.getElementById(id);
const element = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined) item.textContent = text; return item; };
let state, selected = componentScenarios.find(item => item.id === location.hash.slice(1)) || componentScenarios[0], proposal, preview, busy = false, previewSequence = 0, file, fileDirty = false, refreshTimer;
const frames = new Map(), inspections = new Map();
async function api(path, method = 'GET', body) {
  const response = await fetch(`/api/${path}`, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '操作失败'); return data;
}
function feedback(text = '', success = false) { $('feedback').textContent = text; $('feedback').hidden = !text; $('feedback').classList.toggle('success', success); }
const pending = () => state?.proposals.filter(item => item.files.length || item.error) || [];
function affectedScenes() {
  const files = proposal?.files.map(item => item.path) || [];
  const affected = new Set();
  for (const path of files) {
    if (/^(?:style\.css|theme\.css|dom\.js)$|components\/(?:interaction|index\.|fixtures\.)/.test(path)) return componentScenarios.length;
    for (const scene of componentScenarios) {
      const name = path.replace('components/', '');
      if (scene.source.includes(name) || name.startsWith('operation-calendar') && ['calendar', 'reminder'].includes(scene.id)
        || name.startsWith('operation-content') && ['document-change', 'table-change'].includes(scene.id)
        || name.startsWith('operation-todo') && scene.id === 'todo' || name.startsWith('operation-mindmap') && scene.id === 'mindmap'
        || name.startsWith('output-components') && scene.data.kind === 'output'
        || /^(interactive-output|interactive-tokens)/.test(name) && ['interactive', 'animation'].includes(scene.id)
        || name === 'document-cards.css' && ['memory', 'document', 'artifact'].includes(scene.id)
        || /^(subagent|activity)/.test(name) && scene.mode === 'subagents'
        || name.startsWith('trigger') && scene.id === 'task') affected.add(scene.id);
    }
  }
  return affected.size;
}
function buttons() {
  const count = pending().length;
  $('resolve-conflicts').hidden = !preview?.conflictFiles?.length;
  $('resolve-conflicts').disabled = busy || chat.isActive(proposal?.id);
  $('resolve-conflicts').textContent = chat.isActive(proposal?.id) ? 'AI 合并中' : 'AI 重新合并';
  $('pending-count').textContent = count ? `${count} 项待保存` : '无待保存改动';
  $('save-all').disabled = busy || chat.anyActive() || !!preview?.conflicts.length || !count;
  $('discard-all').disabled = busy || !count && !chat.anyActive();
  $('save').disabled = busy || chat.isActive(proposal?.id) || !proposal?.files?.length;
  $('discard').disabled = busy || !proposal?.files?.length && !proposal?.error && !chat.isActive(proposal?.id);
  $('code-after').readOnly = chat.isActive(proposal?.id);
  $('update-draft').disabled = !fileDirty || chat.isActive(proposal?.id);
  $('save').disabled ||= !!preview?.conflicts.length || !preview || frames.get('after')?.rendered !== true;
  $('copy-path').disabled = $('copy-prompt').disabled = busy || !proposal;
  $('component-state').textContent = proposal?.error ? '草稿需要修复' : proposal?.files?.length ? `${proposal.files.length} 个文件改动${affectedScenes() > 1 ? ` · 共用 ${affectedScenes()} 个场景` : ''}` : proposal?.savedAt ? '已写入源码 · 未提交' : '与当前源码一致';
  $('component-state').classList.toggle('pending', !!proposal?.files?.length || !!proposal?.error);
  $('draft-state').textContent = proposal?.files?.length ? '待保存' : '草稿预览';
}
function catalogue() {
  $('scene-count').textContent = componentScenarios.length;
  $('scenes').replaceChildren(); let group;
  const search = $('search').value.trim().toLowerCase();
  for (const scene of componentScenarios.filter(scene => `${scene.name} ${scene.group} ${scene.id}`.toLowerCase().includes(search))) {
    if (group !== scene.group) { group = scene.group; $('scenes').append(element('h3', '', group)); }
    const button = element('button', 'scene'), name = element('span', 'scene-name', scene.name), candidate = state?.proposals.find(item => item.scenarioId === scene.id);
    button.type = 'button'; button.setAttribute('aria-current', String(selected.id === scene.id)); button.append(name);
    if (candidate?.files.length || candidate?.error) button.append(element('span', 'scene-count', candidate.error ? '!' : candidate.files.length));
    else if (candidate?.savedAt) button.append(element('span', 'scene-saved'));
    button.onclick = () => void choose(scene); $('scenes').append(button);
  }
}
async function refreshState() {
  state = await api('state'); proposal = state.proposals.find(item => item.scenarioId === selected.id);
  chat.syncActive(state.chatting); catalogue(); buttons(); $('draft-path').textContent = proposal?.draftDirectory || '';
  $('file-count').textContent = proposal?.files.length || 0;
}
function dropFrames() { for (const entry of frames.values()) { clearTimeout(entry.timer); entry.node.remove(); } frames.clear(); }
async function choose(scene) {
  if (busy) return;
  if (fileDirty) { feedback('请先更新草稿，或点击“重新加载”放弃编辑器中的改动'); return; }
  void chat.select(null); proposal = undefined;
  selected = scene; preview = undefined; file = undefined; dropFrames();
  $('scene-name').textContent = scene.name; $('scene-group').textContent = scene.group; $('events').textContent = ''; $('code-before').value = $('code-after').value = '';
  $('status').value = 'original';
  $('status').querySelector('[value="pending"]').textContent = scene.mode === 'subagents' ? '进行中' : '待操作';
  $('status').querySelector('[value="cancelled"]').textContent = scene.mode === 'subagents' ? '停止' : '取消';
  $('status').querySelector('[value="expired"]').disabled = scene.mode === 'subagents'; history.replaceState(null, '', `#${scene.id}`); feedback(); catalogue(); buttons();
  try {
    await api('proposals', 'POST', { scenarioId: scene.id, name: scene.name });
    if (selected !== scene) return;
    await refreshState(); if (selected !== scene) return;
    if (proposal) void chat.select({ id: proposal.id, name: scene.name });
    await refreshPreview(true); await loadFileOptions();
  } catch (error) { if (selected === scene) feedback(error.message); }
}
function frameData() { return { type: 'zigent:studio:render', scenarioId: selected.id, status: $('status').value, theme: $('theme').value, response: $('response').value }; }
function renderFrame(side) {
  const entry = frames.get(side); if (!entry?.ready) return;
  entry.rendered = false; entry.node.contentWindow.postMessage(frameData(), state.previewOrigin); buttons();
}
function viewport() { for (const { node } of frames.values()) node.style.width = $('viewport').value === 'fluid' ? '100%' : `${$('viewport').value}px`; }
async function refreshPreview(force = false) {
  if (!proposal) return;
  const own = ++previewSequence, candidateId = proposal.id;
  try {
    const next = await api(`proposals/${proposal.id}/preview`);
    if (own !== previewSequence || proposal?.id !== candidateId) return;
    chat.conflicts(candidateId, next);
    const previousConflict = preview?.conflicts.join('；');
    if (previousConflict && $('feedback').textContent === previousConflict) feedback();
    if (!force && preview?.version === next.version) { preview = next; buttons(); return; }
    preview = next; dropFrames();
    for (const side of ['before', 'after']) {
      $(`error-${side}`).hidden = true;
      const node = element('iframe'); node.title = `${selected.name} · ${side === 'before' ? '更改前' : '更改后'}`;
      node.setAttribute('sandbox', 'allow-scripts allow-same-origin'); node.setAttribute('referrerpolicy', 'no-referrer');
      const entry = { node, id: proposal.id, version: next.version, ready: false, rendered: false, timer: setTimeout(() => { if (!entry.rendered) { $(`error-${side}`).hidden = false; $(`error-${side}`).textContent = '组件加载失败，请修复草稿后重放'; } }, 12000) };
      frames.set(side, entry); $(`stage-${side}`).replaceChildren(node);
      node.src = `${state.previewOrigin}/${proposal.id}/${next.version}/${side}/component-preview.html`;
    }
    viewport(); buttons();
  } catch (error) { if (own === previewSequence) feedback(error.message); }
}
window.addEventListener('message', async event => {
  if (!state || event.origin !== state.previewOrigin) return;
  const match = [...frames].find(([, entry]) => entry.node.contentWindow === event.source); if (!match) return;
  const [side, entry] = match;
  if (event.data?.type === 'zigent:studio:inspected') {
    const request = inspections.get(event.data.requestId);
    if (request?.entry === entry) request.resolve(event.data.snapshot);
    return;
  }
  if (event.data?.type === 'zigent:component:ready') { entry.ready = true; renderFrame(side); }
  if (event.data?.type === 'zigent:component:rendered') { entry.rendered = true; clearTimeout(entry.timer); $(`error-${side}`).hidden = true; buttons(); }
  if (event.data?.type === 'zigent:component:error') { entry.rendered = false; clearTimeout(entry.timer); $(`error-${side}`).textContent = event.data.error || '组件渲染失败'; $(`error-${side}`).hidden = false; buttons(); }
  if (event.data?.type === 'zigent:component:action') {
    $('events').textContent = `${side === 'before' ? '更改前' : '更改后'} · ${event.data.label}\n${JSON.stringify(event.data.value, null, 2)}\n\n${$('events').textContent}`.slice(0, 12000);
  }
  if (event.data?.type === 'zigent:studio:output') {
    try {
      const result = await api('component-output', 'POST', { output: event.data.output, theme: $('theme').value, id: entry.id, version: entry.version, side });
      if (frames.get(side) !== entry) return;
      entry.node.contentWindow.postMessage({ type: 'zigent:studio:output-pages', sequence: event.data.sequence, pages: result.pages }, state.previewOrigin);
    } catch (error) { if (frames.get(side) === entry) { $(`error-${side}`).textContent = error.message; $(`error-${side}`).hidden = false; } }
  }
});
async function act(action, all) {
  const selectedProposals = all ? state.proposals.filter(item => item.files.length || item.error || action === 'discard' && chat.isActive(item.id)) : [proposal]; if (!selectedProposals.length || busy) return;
  if (fileDirty) { feedback('请先更新草稿，或点击“重新加载”放弃编辑器中的改动'); return; }
  busy = true; buttons(); feedback();
  try {
    const result = await api(action, 'POST', { ids: selectedProposals.map(item => item.id), revisions: Object.fromEntries(selectedProposals.map(item => [item.id, item.id === proposal?.id && preview ? preview.revision : item.revision])) });
    await refreshState(); await refreshPreview(true); await loadFileOptions();
    feedback(action === 'save' ? `已写入源码 · ${result.files.length} 个文件 · 未提交` : '已撤销草稿', true);
  } catch (error) { feedback(error.message); }
  finally { busy = false; buttons(); }
}
const commonFiles = ['components/mochi.js', 'components/image-generation.js', 'components/subagent-view.js', 'components/subagent.css', 'components/activity-renderer.js', 'components/activity.css', 'components/interaction-renderer.js', 'components/interaction.css', 'components/operation-calendar.js', 'components/operation-calendar.css', 'components/operation-todo.js', 'components/operation-todo.css', 'components/operation-mindmap.js', 'components/operation-mindmap.css', 'components/operation-content.js', 'components/operation-content.css', 'components/output-components.js', 'components/output-components.css', 'components/interactive-output.js', 'components/interactive-tokens.css', 'components/document-cards.css', 'components/trigger-visual.js', 'components/trigger-diagram.js', 'components/trigger.css', 'components/fixtures.js', 'components/index.js', 'style.css', 'theme.css', 'dom.js'];
async function loadFileOptions() {
  const candidates = [...new Set([...(proposal?.files.map(item => item.path) || []), ...selected.source.split(' · ').map(path => `components/${path}`), ...commonFiles])];
  const previous = $('file').value;
  $('file').replaceChildren(...candidates.map(path => { const option = element('option', '', `${proposal?.files.some(item => item.path === path) ? '● ' : ''}${path}`); option.value = path; return option; }));
  if (candidates.includes(previous) && file?.id === proposal?.id) $('file').value = previous;
  if ($('code-panel').open && !fileDirty) await loadFile();
}
async function loadFile() {
  if (!proposal) return;
  const id = proposal.id, path = $('file').value;
  try {
    const data = await api(`proposals/${id}/file?${new URLSearchParams({ path })}`);
    if (proposal?.id !== id || $('file').value !== path) return;
    file = { ...data, id }; fileDirty = false; $('code-before').value = data.current || ''; $('code-after').value = data.after || ''; $('update-draft').disabled = true; buttons();
  } catch (error) { feedback(error.message); }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); feedback('已复制', true); }
  catch { $('prompt-fallback').hidden = false; $('prompt-fallback').value = text; $('prompt-fallback').focus(); $('prompt-fallback').select(); }
}
$('copy-path').onclick = () => copy(proposal.draftDirectory);
$('copy-prompt').onclick = () => copy(`请在 Zigent 本地交互工坊中修改「${selected.name}」。\n\n要求：${$('instruction').value.trim() || '根据我随后提出的要求调整组件。'}\n\n实际源码：${state.root}/web\n本组件草稿：${proposal.draftDirectory}\n本地页面：${location.href}\n\n请阅读组件代码和预览页面，所有改动只写入上述草稿目录。可修改 components/*.js、components/*.css、style.css、theme.css、dom.js。草稿内也包含组件 mock 数据 components/fixtures.js。请复用真实组件实现，不另画一份效果图；不要修改预览适配器 component-preview.*，不要保存到真实源码，不要提交或推送 Git。文件保存后右侧自动更新，最终由我在页面点击保存或撤销。共享文件会影响其他使用它的场景。`);
$('update-draft').onclick = async () => {
  if (!file || !proposal) return;
  try { await api(`proposals/${proposal.id}/file`, 'POST', { path: file.path, content: $('code-after').value, revision: file.revision }); fileDirty = false; await loadFile(); await refreshState(); await refreshPreview(true); feedback('草稿已更新', true); }
  catch (error) { feedback(error.message); }
};
$('resolve-conflicts').onclick = () => void chat.merge();
$('code-after').oninput = () => { fileDirty = true; $('update-draft').disabled = !file; };
$('file').onchange = () => { if (fileDirty) { $('file').value = file.path; feedback('请先更新草稿，或点击“重新加载”放弃编辑器中的改动'); return; } void loadFile(); };
$('reload-file').onclick = () => { fileDirty = false; void loadFile(); };
$('code-panel').ontoggle = () => { if ($('code-panel').open && !fileDirty) void loadFile(); };
$('save').onclick = () => void act('save', false); $('discard').onclick = () => void act('discard', false);
$('save-all').onclick = () => void act('save', true); $('discard-all').onclick = () => void act('discard', true);
$('search').oninput = catalogue; $('viewport').onchange = viewport;
for (const id of ['status', 'theme', 'response']) $(id).onchange = () => { for (const side of frames.keys()) renderFrame(side); };
$('replay').onclick = () => void refreshPreview(true);
$('refresh').onclick = async () => { try { await refreshState(); await refreshPreview(true); } catch (error) { feedback(error.message); } };
async function capturePreview(id) {
  if (proposal?.id !== id) throw new Error('组件页面已切换，请在原组件页面重新发送');
  const context = { component: selected.id, name: selected.name, version: preview?.version, status: $('status').value, theme: $('theme').value, response: $('response').value, viewport: $('viewport').value, conflicts: preview?.conflicts || [] };
  const sides = await Promise.all(['before', 'after'].map(side => new Promise(resolve => {
    const entry = frames.get(side), requestId = crypto.randomUUID();
    if (!entry?.ready) { resolve([side, { ready: false, error: $(`error-${side}`).textContent }]); return; }
    const timer = setTimeout(() => done({ ready: entry.rendered, unavailable: true }), 1500);
    const done = snapshot => { clearTimeout(timer); inspections.delete(requestId); resolve([side, snapshot]); };
    inspections.set(requestId, { entry, resolve: done });
    entry.node.contentWindow.postMessage({ type: 'zigent:studio:inspect', requestId }, state.previewOrigin);
  })));
  return { ...context, previews: Object.fromEntries(sides) };
}
const events = new EventSource('/events');
const chat = createComponentChat({ api, events, capture: capturePreview, canMerge: () => !fileDirty && !busy, canSend: () => { if (fileDirty || busy) { feedback('请先更新草稿，或放弃编辑器中的改动后再发送'); return false; } return true; }, onChange: buttons });
events.onopen = () => { $('connection').classList.remove('disconnected'); $('connection').lastChild.textContent = '实时同步'; };
events.onerror = () => { $('connection').classList.add('disconnected'); $('connection').lastChild.textContent = '正在重连'; };
events.onmessage = () => {
  clearTimeout(refreshTimer); refreshTimer = setTimeout(async () => {
    if (busy) return;
    try { await refreshState(); await refreshPreview(); if (!fileDirty && $('code-panel').open) await loadFileOptions(); }
    catch (error) { feedback(error.message); }
  }, 300);
};
window.addEventListener('beforeunload', event => { if (fileDirty) { event.preventDefault(); event.returnValue = ''; } });
void chat.connect();
try { await refreshState(); await choose(selected); } catch (error) { feedback(error.message); }
