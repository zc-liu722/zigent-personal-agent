import { el } from './dom.js';

// Keep submitted drafts and their attachment bytes until the server accepts
// the complete message. A reload can resume uploads with the same message ID.
export function createMessageOutbox({ base, imageUploads, api, onChange, onDelivered, userMessageText }) {
  const items = new Map();
  let database, enabled = false, generation = 0;
  function db() {
    return database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(`zigent-outbox:${base}`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('messages', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('暂时无法保存待发送消息，请重试。'));
    }).catch(error => { database = undefined; throw error; });
  }
  async function storage(mode, operation) {
    const database = await db();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('messages', mode);
      const request = operation(transaction.objectStore('messages'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(new Error('暂时无法保存待发送消息，请重试。'));
    });
  }
  async function save(item) {
    const { id, conversationId, text, createdAt } = item;
    const assets = await Promise.all(item.assets.map(id => imageUploads.snapshot(id)));
    return storage('readwrite', store => store.put({ id, conversationId, text, createdAt, assets }));
  }
  function changed() { onChange(); queueMicrotask(pump); }
  async function deliver(item) {
    const epoch = generation;
    item.sending = true; onChange();
    try {
      // Persist resolved asset IDs before POST; retrying a lost response must
      // reuse the exact message ID and attachment set.
      await save(item);
      if (!enabled || epoch !== generation || items.get(item.id) !== item) return;
      const result = await api('messages', 'POST', { id: item.id, conversationId: item.conversationId, text: item.text, assets: [...item.assets] });
      await storage('readwrite', store => store.delete(item.id));
      if (epoch !== generation) return;
      await onDelivered(item, result);
      items.delete(item.id);
    } catch (error) {
      if (epoch === generation) item.error = error.message;
    } finally {
      item.sending = false;
      if (epoch === generation) changed();
    }
  }
  function pump() {
    if (!enabled) return;
    const conversations = new Set();
    for (const item of items.values()) {
      if (item.confirmed) continue;
      if (conversations.has(item.conversationId)) continue;
      conversations.add(item.conversationId);
      if (!item.saving && !item.sending && !item.removing && !item.error && item.assets.every(id => imageUploads.isReady(id))) void deliver(item);
    }
  }
  async function remove(item) {
    if (item.sending || item.saving || item.removing) return;
    item.removing = true; onChange();
    try { await storage('readwrite', store => store.delete(item.id)); items.delete(item.id); }
    catch (error) { item.error = error.message; }
    finally { item.removing = false; changed(); }
  }
  return {
    async restore() {
      const epoch = ++generation;
      const saved = await storage('readonly', store => store.getAll());
      if (epoch !== generation) return;
      for (const item of saved.sort((a, b) => a.createdAt - b.createdAt)) {
        if (items.has(item.id)) continue;
        item.assets = await Promise.all(item.assets.map(asset => imageUploads.restore(asset)));
        if (epoch !== generation) return;
        items.set(item.id, item);
      }
      enabled = true; changed();
    },
    suspend() { enabled = false; generation++; items.clear(); },
    has(conversationId) { return [...items.values()].some(item => item.conversationId === conversationId); },
    contains(id) { return items.has(id); },
    conversations() {
      const rows = new Map();
      for (const item of items.values()) if (!rows.has(item.conversationId)) rows.set(item.conversationId,
        { id: item.conversationId, title: item.text.slice(0, 60) || '附件消息', updatedAt: item.createdAt });
      return [...rows.values()];
    },
    async discardConversation(conversationId) {
      const discarded = [...items.values()].filter(item => item.conversationId === conversationId);
      for (const item of discarded) item.removing = true;
      try {
        for (const item of discarded) { await storage('readwrite', store => store.delete(item.id)); items.delete(item.id); }
      } finally { for (const item of discarded) item.removing = false; changed(); }
    },
    assets() { return [...items.values()].flatMap(item => item.assets); },
    replaceAsset(localId, id) {
      for (const item of items.values()) item.assets = item.assets.map(value => value === localId ? id : value);
    },
    pump,
    async enqueue(message) {
      const epoch = generation;
      const item = { ...message, createdAt: Date.now(), saving: true };
      items.set(item.id, item);
      try {
        await api('conversations/retain', 'POST', { conversationId: item.conversationId, title: item.text.slice(0, 60) });
        if (epoch !== generation) throw new Error('请登录后继续发送。');
        await save(item);
        if (epoch !== generation) throw new Error('请登录后继续发送。');
        enabled = true;
      }
      catch (error) { items.delete(item.id); throw error; }
      finally { item.saving = false; }
      // The caller clears the composer before mounting the same upload views.
      return item;
    },
    render(conversationId, knownIds) {
      // SSE/read refresh can acknowledge a POST whose HTTP response was lost.
      // Such a message must neither block later drafts nor offer another send.
      for (const item of items.values()) {
        if (item.conversationId !== conversationId || !knownIds.has(item.id) || item.confirmed) continue;
        item.confirmed = true;
        const epoch = generation;
        void storage('readwrite', store => store.delete(item.id)).then(() => {
          if (epoch === generation) { items.delete(item.id); changed(); }
        }).catch(() => { item.confirmed = false; });
        queueMicrotask(pump);
      }
      return [...items.values()].filter(item => item.conversationId === conversationId && !item.saving && !knownIds.has(item.id)).map(item => {
        if (!item.view) {
          const article = el('article', 'message user message-outbox'); article.dataset.id = `outbox:${item.id}`;
          const attachments = el('div', 'attachments'), actions = el('div', 'outbox-actions');
          const status = el('span', 'outbox-status'), retry = el('button', 'text-button', '重试发送'), cancel = el('button', 'text-button', '取消发送');
          status.setAttribute('role', 'status'); retry.type = cancel.type = 'button';
          retry.onclick = () => { item.error = undefined; changed(); };
          cancel.onclick = () => void remove(item);
          if (item.text) article.append(userMessageText(item.text));
          actions.append(status, retry, cancel); article.append(attachments, actions);
          item.view = { article, attachments, status, retry, cancel };
        }
        const { article, attachments, status, retry, cancel } = item.view;
        const uploading = item.assets.some(id => !imageUploads.isReady(id));
        status.textContent = item.error || (item.removing ? '正在取消…' : item.sending ? '正在发送…' : uploading ? '等待附件上传' : '等待发送');
        retry.hidden = !item.error; retry.disabled = cancel.disabled = Boolean(item.sending || item.removing);
        imageUploads.render(attachments, item.assets, { disabled: Boolean(item.sending || item.removing) });
        return article;
      });
    }
  };
}
