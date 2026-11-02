const $ = id => document.getElementById(id);
const active = state => ['starting', 'running', 'reconnecting', 'stopping'].includes(state?.status);
const labels = { idle: '就绪', starting: '正在连接', running: '正在处理', reconnecting: '正在重连', stopping: '正在停止', completed: '已完成', interrupted: '已停止', failed: '处理失败' };
export function createComponentChat({ api, events, capture, canSend, canMerge, onChange }) {
  const records = new Map(), composers = new Map(), requests = new Map(), activityIds = new Set(), knownActive = new Set(), conflicts = new Map(), attempts = new Set(), loading = new Set();
  let selected, models = [], connected = false, connecting = false, connectionError = '', submitting = new Set(), refreshTimer, mergeTimer;
  const preferenceKey = id => `zigent.component-chat.${id}`;
  function preferences(id) { try { return JSON.parse(localStorage.getItem(preferenceKey(id))) || {}; } catch { return {}; } }
  function savePreferences() {
    if (!selected || !models.length) return;
    const prefs = preferences(selected.id); prefs.model = $('chat-model').value; prefs.efforts ||= {}; prefs.efforts[prefs.model] = $('chat-effort').value;
    try { localStorage.setItem(preferenceKey(selected.id), JSON.stringify(prefs)); } catch {}
  }
  function choices() {
    const saved = selected && records.get(selected.id), prefs = selected ? preferences(selected.id) : {};
    const name = prefs.model || saved?.model;
    const model = models.find(item => item.available !== false && item.name === name) || models.find(item => item.available !== false && item.isDefault) || models.find(item => item.available !== false);
    $('chat-model').replaceChildren(...models.map(item => { const option = document.createElement('option'); option.value = item.name; option.textContent = `${item.name}${item.available === false ? ' · 不可用' : ''}`; option.disabled = item.available === false; return option; }));
    if (model) $('chat-model').value = model.name;
    efforts(prefs.efforts?.[model?.name] || (saved?.model === model?.name ? saved.effort : null));
  }
  function efforts(preferred) {
    const model = models.find(item => item.name === $('chat-model').value);
    $('chat-effort').replaceChildren(...(model?.reasoning.levels || []).map(level => { const option = document.createElement('option'); option.value = level; option.textContent = level; return option; }));
    if (model) $('chat-effort').value = model.reasoning.levels.includes(preferred) ? preferred : model.reasoningEffort;
  }
  function controls() {
    const state = selected && records.get(selected.id), running = selected && (knownActive.has(selected.id) || active(state)), pending = selected && submitting.has(selected.id);
    $('chat-send').disabled = !selected || !connected || running || pending || loading.has(selected.id);
    $('chat-stop').hidden = !running; $('chat-stop').disabled = !running || state?.status === 'stopping';
    $('chat-model').disabled = $('chat-effort').disabled = !connected || running || pending;
    $('instruction').disabled = !selected;
    const merging = selected && conflicts.get(selected.id)?.conflictKey;
    $('chat-status').textContent = merging && connected ? running ? 'AI 自动合并中' : state?.blockedMergeKey ? '合并待重试' : '准备自动合并' : pending ? '正在发送' : !connected ? connecting ? '正在连接模型' : '模型未连接' : labels[state?.status] || '就绪';
    $('chat-connect').hidden = connected && !connectionError; $('chat-connect').disabled = connecting;
    onChange(); scheduleMerge();
  }
  function render() {
    const state = selected && records.get(selected.id), messages = $('chat-messages'), nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
    const fragment = document.createDocumentFragment();
    for (const item of state?.messages || []) {
      const article = document.createElement('article'); article.className = `chat-message ${item.role}`;
      const label = document.createElement('span'); label.className = 'chat-speaker'; label.textContent = item.role === 'user' ? item.automatic ? '自动合并' : '你' : item.model?.startsWith('kimi-') ? 'Kimi' : 'Codex'; if (item.model) label.title = item.model;
      const text = document.createElement('div'); text.className = 'chat-text'; text.textContent = item.text || '…'; article.append(label, text); fragment.append(article);
    }
    messages.replaceChildren(fragment); messages.hidden = !state?.messages.length;
    if (nearBottom) messages.scrollTop = messages.scrollHeight;
    const last = state?.activity?.at(-1); $('chat-activity').textContent = last ? `${last.label}${last.path ? ` · ${last.path}` : ''}` : '';
    const usage = state?.usage?.at(-1);
    $('chat-usage').textContent = usage ? `输入 ${usage.inputTokens.toLocaleString()} · 输出 ${usage.outputTokens.toLocaleString()} token · ¥0` : '';
    $('chat-error').textContent = state?.error || connectionError; $('chat-error').hidden = !state?.error && !connectionError;
    controls();
  }
  async function refresh(id) {
    const sequence = (requests.get(id) || 0) + 1; requests.set(id, sequence);
    const data = await api(`proposals/${id}/chat`);
    if (requests.get(id) !== sequence) return;
    records.set(id, data); if (active(data)) knownActive.add(id); else knownActive.delete(id);
    if (selected?.id === id) render(); else onChange();
  }
  async function connect(refresh = false) {
    if (connecting) return; connecting = true; controls();
    try { const data = await api(`codex/status${refresh ? '?refresh=1' : ''}`); models = data.models; connected = data.connected; connectionError = data.warning || ''; choices(); render(); }
    catch (error) { connected = false; connectionError = error.message; $('chat-error').textContent = error.message; $('chat-error').hidden = false; }
    finally { connecting = false; controls(); }
  }
  async function select(target) {
    if (selected) composers.set(selected.id, $('instruction').value);
    clearTimeout(mergeTimer); selected = target; if (target) loading.add(target.id); $('chat-component').textContent = target?.name || '选择组件'; $('instruction').value = target ? composers.get(target.id) || '' : '';
    $('chat-messages').replaceChildren(); $('chat-messages').hidden = true; choices(); render();
    if (!target) return;
    try { await refresh(target.id); if (selected?.id === target.id) choices(); }
    catch (error) { if (selected?.id === target.id) { $('chat-error').textContent = error.message; $('chat-error').hidden = false; } }
    finally { loading.delete(target.id); controls(); }
  }
  async function send({ mergeOnly = false, retry = false } = {}) {
    if (!selected || !connected || active(records.get(selected.id)) || submitting.has(selected.id)) return;
    const target = { ...selected }, message = $('instruction').value.trim(), model = $('chat-model').value, effort = $('chat-effort').value;
    if (!message && !mergeOnly) { $('instruction').focus(); return; }
    if (mergeOnly ? !canMerge() : !canSend()) return;
    const cancelGeneration = records.get(target.id)?.cancelGeneration;
    const conflictKey = conflicts.get(target.id)?.conflictKey;
    if (mergeOnly && !conflictKey) return;
    if (mergeOnly) attempts.add(`${target.id}:${conflictKey}:${model}:${effort}`);
    savePreferences(); submitting.add(target.id); controls();
    try {
      const context = await capture(target.id);
      const data = await api(`proposals/${target.id}/chat${mergeOnly ? '/merge' : ''}`, 'POST', { message, model, effort, context, cancelGeneration, ...(mergeOnly ? { conflictKey, retry } : {}) });
      records.set(target.id, data); if (active(data)) knownActive.add(target.id);
      if (!mergeOnly && (composers.get(target.id) || '').trim() === message) composers.set(target.id, '');
      if (selected?.id === target.id) { if (!mergeOnly && $('instruction').value.trim() === message) $('instruction').value = ''; render(); }
    } catch (error) { if (selected?.id === target.id) { $('chat-error').textContent = error.message; $('chat-error').hidden = false; } }
    finally { submitting.delete(target.id); controls(); }
  }
  function scheduleMerge() {
    clearTimeout(mergeTimer);
    if (!selected || !connected || connecting || loading.has(selected.id) || !records.has(selected.id) || !canMerge()) return;
    const state = records.get(selected.id), conflict = conflicts.get(selected.id), model = $('chat-model').value, effort = $('chat-effort').value;
    if (!conflict?.conflictKey || active(state) || knownActive.has(selected.id) || submitting.has(selected.id)) return;
    const key = `${conflict.conflictKey}:${model}:${effort}`;
    if (state.blockedMergeKey === key || attempts.has(`${selected.id}:${key}`)) return;
    const id = selected.id;
    mergeTimer = setTimeout(() => { if (selected?.id === id) void send({ mergeOnly: true }); }, 700);
  }
  $('chat-connect').onclick = () => void connect(true); $('chat-send').onclick = () => void send();
  $('chat-stop').onclick = async () => {
    const id = selected?.id; if (!id) return;
    try { await api(`proposals/${id}/chat/stop`, 'POST', {}); await refresh(id); }
    catch (error) { if (selected?.id === id) { $('chat-error').textContent = error.message; $('chat-error').hidden = false; } }
  };
  $('instruction').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } };
  $('chat-model').onchange = () => { efforts(preferences(selected.id).efforts?.[$('chat-model').value]); savePreferences(); scheduleMerge(); };
  $('chat-effort').onchange = () => { savePreferences(); scheduleMerge(); };
  events.addEventListener('chat', event => {
    try { activityIds.add(JSON.parse(event.data).proposalId); } catch { return; }
    if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; const ids = [...activityIds]; activityIds.clear(); for (const id of ids) void refresh(id).catch(() => {}); }, 120);
  });
  events.addEventListener('chat-inspect', async event => {
    try { const { proposalId, requestId } = JSON.parse(event.data); if (selected?.id !== proposalId) return;
      const context = await capture(proposalId); await api(`proposals/${proposalId}/chat/preview`, 'POST', { requestId, context });
    } catch {}
  });
  events.addEventListener('open', () => { if (selected) void refresh(selected.id).catch(() => {}); });
  return { select, connect, merge: () => send({ mergeOnly: true, retry: true }),
    conflicts(id, preview) { conflicts.set(id, preview); if (!preview.conflictKey) for (const key of attempts) if (key.startsWith(id + ':')) attempts.delete(key); scheduleMerge(); },
    isActive: id => knownActive.has(id) || submitting.has(id), anyActive: () => knownActive.size > 0 || submitting.size > 0,
    syncActive(ids) { knownActive.clear(); for (const id of ids || []) knownActive.add(id); controls(); } };
}
