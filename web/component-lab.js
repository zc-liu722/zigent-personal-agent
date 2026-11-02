import { componentScenarios } from './components/fixtures.js';
import { el } from './dom.js';
export function createComponentLab(root, { api, release }) {
  let selected = componentScenarios[0], ready = false, disposed = false, serial = 0, loadedRelease = release, currentRelease = release;
  const toolbar = el('div', 'lab-toolbar'), search = el('input'), state = el('select'), width = el('select'), theme = el('select'), response = el('select');
  search.type = 'search'; search.placeholder = '搜索场景'; search.setAttribute('aria-label', '搜索组件场景');
  const select = (control, label, options) => {
    control.setAttribute('aria-label', label);
    for (const [value, text] of options) { const option = el('option', '', text); option.value = value; control.append(option); }
    const field = el('label', 'lab-field'); field.append(el('span', '', label), control); return field;
  };
  const build = el('button', 'control lab-build', release ? `BUILD ${release.slice(0, 8)}` : '重新载入'); build.type = 'button'; build.onclick = () => location.reload();
  toolbar.append(select(state, '状态', [['original', '场景默认'], ['pending', '待操作'], ['completed', '已完成'], ['failed', '失败'], ['expired', '过期'], ['cancelled', '取消']]),
    select(width, '宽度', [['fluid', '自适应'], ['390', '手机 · 390'], ['768', '平板 · 768'], ['1100', '桌面 · 1100']]),
    select(theme, '主题', [['light', '浅色'], ['dark', '深色']]), select(response, '模拟响应', [['success', '成功'], ['failure', '失败'], ['slow', '延迟']]), build);
  const layout = el('div', 'lab-layout'), sidebar = el('aside', 'lab-catalogue'), catalogue = el('div', 'lab-scenarios'), count = el('span', 'lab-count');
  sidebar.append(search, count, catalogue);
  const main = el('div', 'lab-main'), heading = el('div', 'lab-heading'), title = el('h2'), source = el('code', 'lab-source'), stage = el('div', 'lab-stage');
  heading.append(title, source);
  const frame = el('iframe', 'lab-frame'); frame.title = '交互组件预览'; frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.setAttribute('referrerpolicy', 'same-origin');
  stage.append(frame);
  const details = el('details', 'lab-data'), summary = el('summary', '', 'Mock 数据'), editor = el('textarea', 'lab-editor'), actions = el('div', 'lab-data-actions'), apply = el('button', 'control', '应用数据'), reset = el('button', 'control', '重置场景');
  editor.spellcheck = false; editor.setAttribute('aria-label', 'Mock JSON 数据'); editor.rows = 16;
  apply.type = reset.type = 'button'; actions.append(apply, reset); details.append(summary, editor, actions);
  const feedback = el('p', 'lab-feedback'), events = el('details', 'lab-events'), eventSummary = el('summary', '', '操作记录'), eventList = el('pre'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  events.append(eventSummary, eventList); main.append(heading, stage, feedback, details, events); layout.append(sidebar, main); root.replaceChildren(toolbar, layout);
  const showError = text => { feedback.textContent = text; feedback.hidden = !text; };
  function renderCatalogue() {
    const matches = componentScenarios.filter(item => `${item.name} ${item.group} ${item.id}`.toLowerCase().includes(search.value.trim().toLowerCase()));
    count.textContent = `${matches.length} / ${componentScenarios.length} 场景`;
    catalogue.replaceChildren(); let group;
    for (const item of matches) {
      if (group !== item.group) { group = item.group; catalogue.append(el('h3', '', group)); }
      const button = el('button', 'lab-scenario', item.name); button.type = 'button'; button.setAttribute('aria-pressed', String(item.id === selected.id));
      button.onclick = () => { selected = item; state.value = 'original'; resetScenario(); renderCatalogue(); }; catalogue.append(button);
    }
    if (!matches.length) catalogue.append(el('p', '', '无匹配场景'));
  }
  async function renderPreview() {
    const own = ++serial;
    showError('');
    if (!ready || disposed) return;
    try {
      const data = JSON.parse(editor.value);
      if (!data || typeof data !== 'object' || !Array.isArray(data.actions) || typeof data.id !== 'string' || typeof data.title !== 'string'
        || !['schedule-reminder','browser','authorization','actions','output','task-proposal','memory-proposal','operation-confirmation','user-question','subagent-preview'].includes(data.kind)) throw new Error('请填写有效的交互组件数据');
      if (data.kind === 'user-question' && (!data.questions?.length || !data.questions.every(question => question && typeof question.id === 'string' && ['text','single_select','multi_select'].includes(question.type)))) throw new Error('请填写有效的问题');
      if (state.value !== 'original') {
        data.status = state.value; if (data.kind === 'subagent-preview') data.previewState = state.value; delete data.statusMessage;
        if (state.value === 'expired') data.expiresAt = Date.now() - 1000; else delete data.expiresAt;
        if (data.kind === 'user-question' && data.status === 'completed') data.answers ||= Object.fromEntries(data.questions.map(question => [question.id, question.type === 'text' ? { text: '集中维护交互组件' } : { selectedOptionIds: [question.options?.[0]?.id].filter(Boolean) }]));
      }
      let pages = {};
      if (data.kind === 'output') {
        // The only network operation renders mock HTML; it never invokes an Agent or a service action.
        const result = await api('component-output', 'POST', { output: data.output, theme: theme.value }); pages = result.pages;
      }
      if (own !== serial || disposed) return;
      frame.contentWindow.postMessage({ type: 'zigent:component:render', scenario: { id: selected.id, mode: selected.mode }, data, theme: theme.value, response: response.value, pages }, location.origin);
    } catch (error) { if (own === serial && !disposed) showError(error.message || 'Mock 数据无法加载'); }
  }
  function resetScenario() {
    state.disabled = response.disabled = selected.data.kind === 'output';
    state.querySelector('[value="pending"]').textContent = selected.mode === 'subagents' ? '进行中' : '待操作';
    state.querySelector('[value="cancelled"]').textContent = selected.mode === 'subagents' ? '停止' : '取消';
    state.querySelector('[value="expired"]').disabled = selected.mode === 'subagents'; editor.value = JSON.stringify(structuredClone(selected.data), null, 2); title.textContent = selected.name; source.textContent = selected.source; eventList.textContent = ''; void renderPreview();
  }
  function receive(event) {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || disposed) return;
    if (event.data?.type === 'zigent:component:ready') { ready = true; clearTimeout(readyTimer); void renderPreview(); }
    if (event.data?.type === 'zigent:component:error') showError(event.data.error);
    if (event.data?.type === 'zigent:component:action') {
      eventList.textContent = `${event.data.label}\n${JSON.stringify(event.data.value, null, 2)}\n\n${eventList.textContent}`.slice(0, 12000); events.open = true;
    }
  }
  window.addEventListener('message', receive);
  frame.onload = () => { if (ready) return; showError('正在载入组件…'); };
  const readyTimer = setTimeout(() => { if (!ready && !disposed) showError('组件加载失败，请重新载入'); }, 12000);
  frame.src = new URL('./component-preview.html', import.meta.url).href;
  state.onchange = theme.onchange = response.onchange = () => void renderPreview();
  width.onchange = () => { frame.style.width = width.value === 'fluid' ? '100%' : `${width.value}px`; };
  search.oninput = renderCatalogue; apply.onclick = () => void renderPreview(); reset.onclick = resetScenario;
  editor.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void renderPreview(); } });
  renderCatalogue(); resetScenario();
  return {
    updateRelease(value) { currentRelease = value; build.textContent = currentRelease && currentRelease !== loadedRelease ? `载入 ${currentRelease.slice(0, 8)} ↻` : loadedRelease ? `BUILD ${loadedRelease.slice(0, 8)} ↻` : '重新载入'; },
    dispose() { disposed = true; serial++; clearTimeout(readyTimer); window.removeEventListener('message', receive); frame.remove(); root.replaceChildren(); }
  };
}
