import { createMarkdownRenderer } from './markdown.js';
import { createSubagentRenderer, createActivityRenderer } from './components/index.js';
import { createInteractionRenderer } from './components/index.js';
import { createImageGeneration } from './components/image-generation.js';
const root = document.getElementById('preview-root');
const parentOrigin = window.ZigentComponentPreviewContext?.parentOrigin || location.origin;
const conversation = { current: 'component-preview', messages: [] };
let item, scenario, view, pages = {}, response = 'success', renderer, renderSubagents, subagentLoads = 0;
const message = { id: 'preview-message', conversationId: conversation.current };
const send = (type, extra = {}) => parent.postMessage({ type: `zigent:component:${type}`, ...extra }, parentOrigin);
function documentPreview(current, ignored, id) {
  document.getElementById('preview-document-title').textContent = current.documents?.find(document => document.id === id)?.title || current.output?.title || '文档';
  document.getElementById('preview-document-content').textContent = current.output?.blocks?.[id]?.content || current.memoryChanges?.map(change => change.after).join('\n') || '预览文档';
  document.getElementById('preview-document').showModal(); send('action', { label: '打开文档', value: id });
}
document.getElementById('preview-document-close').onclick = () => document.getElementById('preview-document').close();
function createSubagents() {
  const { markdown, inline } = createMarkdownRenderer({ copyText: async () => send('action', { label: '复制内容', value: {} }),
    openConversationDocument: documentPreview, toast: error => send('error', { error: String(error) }) });
  const { activity } = createActivityRenderer({ inline, load: loadSubagents });
  return createSubagentRenderer({ markdown, activity, load: loadSubagents, resize: update => update() });
}
async function loadSubagents() {
  const current = item; subagentLoads++;
  const fail = response === 'failure' || current.loadFailureOnce && subagentLoads === 1;
  send('action', { label: '加载子 Agent 记录', value: { attempt: subagentLoads } });
  await new Promise(resolve => setTimeout(resolve, response === 'slow' ? 1800 : 400));
  if (current !== item) throw new DOMException('Aborted', 'AbortError');
  if (fail) throw new Error('模拟加载失败，请重试。');
  return { status: current.subagents.some(child => child.status === 'running') ? 'running' : 'completed', items: current.subagents };
}
function draw() {
  if (!item) return;
  root.classList.toggle('model-sheet', scenario.mode === 'model');
  if (item.kind === 'image-generation-preview') {
    view ||= createImageGeneration(); root.replaceChildren(view.node);
  } else if (item.kind === 'subagent-preview') {
    view = renderSubagents(item.subagents, { ...message, activityRevision: 1, activityDeferred: !!item.deferred }, view);
    root.replaceChildren(view.node);
  } else if (item.kind === 'output') {
    view = window.ZigentOutputComponents.render(item.output, view, { openDocument: index => documentPreview(item, message, index), interactiveUrl: index => pages[index] ? { html: pages[index], key: `${item.id}:${index}` } : undefined });
    root.replaceChildren(view.node); view.mount();
  } else {
    view = renderer.renderInteraction(item, message, view, scenario.mode === 'model' ? chooseModel : undefined);
    root.replaceChildren(view.node);
  }
}
async function simulate(value, input = {}) {
  const active = item;
  send('action', { label: '处理中', value: { ...value, ...input } });
  await new Promise(resolve => setTimeout(resolve, response === 'slow' ? 1800 : 400));
  if (active !== item) return {};
  if (response === 'failure') { send('action', { label: '模拟失败', value }); throw new Error('模拟请求失败，请重试。'); }
  if (value.type === 'authorization-retry') { item.status = 'pending'; item.statusMessage = '正在等待授权'; }
  else if (value.type === 'model-select') {
    for (const action of item.actions) { action.selected = action.value?.model === value.model; if (action.selected && value.reasoningEffort) action.reasoning.selected = value.reasoningEffort; }
  } else if (value.type === 'browser-control') {
    item.status = value.action === 'stop' ? 'cancelled' : 'pending'; item.statusMessage = value.action === 'pause' ? '浏览器已暂停' : '浏览器已打开';
  } else { item.status = value.cancel || value.confirm === false || value.action === 'interrupt' ? 'cancelled' : 'completed'; item.statusMessage = item.status === 'completed' ? '操作已完成。' : '操作已取消。'; }
  if (input.answers) item.answers = input.answers;
  send('action', { label: item.status === 'pending' ? '已更新' : item.status === 'completed' ? '已完成' : '已取消', value });
  draw(); return {};
}
const chooseModel = action => simulate(action.value);
async function mockApi(path, method, input) {
  if (path.startsWith('codex/task?')) return { task: { phase: '正在调整组件' }, cursor: 2, hasMore: false, items: [
    { attempt: 1, itemId: 'one', seq: 1, at: Date.now() - 3000, kind: 'message', status: 'completed', title: '方案', text: '已集中组件入口，正在补充场景。' },
    { attempt: 1, itemId: 'two', seq: 2, at: Date.now(), kind: 'command', status: 'completed', title: '编译', text: 'npm run build', output: '编译完成', exitCode: 0 }
  ] };
  if (path !== 'interactions') throw new Error('此操作没有预览数据');
  const action = item.actions.find(action => action.id === input.actionId);
  if (!action) throw new Error('操作已失效');
  return simulate(action.value, input);
}
const createRenderer = () => createInteractionRenderer({ conversation, api: mockApi, loadModelLibrary: async () => send('action', { label: '选择模型', value: {} }), openConversationDocument: documentPreview,
  openBrowserWorkspace: async () => send('action', { label: '查看浏览器', value: {} }), openPanel: () => {}, refresh: async () => {}, renderMessages: draw });
renderer = createRenderer();
// Preview links never navigate, authorize accounts, download files or submit forms.
document.addEventListener('click', event => {
  const link = event.target.closest('a'); if (!link) return; event.preventDefault();
  send('action', { label: link.textContent.trim() || '打开链接', value: link.getAttribute('href') });
  if (item?.kind === 'authorization') { item.status = 'completed'; item.statusMessage = '账号已连接'; draw(); }
}, true);
document.addEventListener('submit', event => event.preventDefault(), true);
window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'zigent:component:render') return;
  try {
    view?.dispose?.(); renderer.dispose(); renderer = createRenderer(); document.getElementById('preview-document').close();
    root.replaceChildren(); view = undefined;
    ({ scenario, pages = {}, response = 'success' } = event.data); item = structuredClone(event.data.data);
    subagentLoads = 0;
    if (item.kind === 'subagent-preview') {
      if (!Array.isArray(item.subagents)) throw new Error('子 Agent 场景数据无效');
      const status = { pending: 'running', completed: 'completed', failed: 'failed', expired: 'cancelled', cancelled: 'cancelled' }[item.previewState];
      if (status) for (const child of item.subagents) {
        child.status = child.snapshot.status = status;
        if (status === 'completed') child.snapshot.answerDraft ||= '已完成组件检查。';
        else child.snapshot.answerDraft = '';
        if (status === 'failed') child.snapshot.failureMessage = '模拟子任务未完成，请查看执行过程。';
        else delete child.snapshot.failureMessage;
      }
      renderSubagents = createSubagents();
    }
    document.documentElement.dataset.theme = event.data.theme === 'dark' ? 'dark' : 'light';
    // Keep repeated resets deterministic and separate drafts from real conversations.
    try { sessionStorage.removeItem(`${location.pathname}:question:${item.id}`); } catch {}
    conversation.messages = [{ ...message, interactions: [item] }]; draw(); send('rendered');
  } catch (error) { send('error', { error: error.message || '预览数据无法渲染' }); }
});
send('ready');
