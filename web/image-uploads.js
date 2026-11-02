import { el, syncChildren } from './dom.js';
import { parseJsonResponse, requestError } from './http-errors.js';
import { compressImage } from './image-compression.js';

const INITIAL_CHUNK_BYTES = 128 * 1024;
// Match the server's per-request limit while keeping the first retry cheap.
const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_RETRIES = 6;
const STALL_MS = 30000;
const retryable = error => error.network || error.timeout || [408, 429].includes(error.status) || error.status >= 500
  || error.status >= 200 && error.status < 300 && error.responseFormat;

export function createImageUploads({ url, assetUrl, fileInfo, onComplete, onChange, onUnauthorized, storage }) {
  const records = new Map();
  let active = 0, enabled = false;

  function update(record) {
    if (!record.view) return;
    const { item, status, retry, preview, download } = record.view;
    if(preview){preview.hidden=record.state!=='ready';preview.dataset.uploadId=record.id;preview.dataset.filename=record.name;}
    if(download){download.hidden=record.state!=='ready';download.href=assetUrl(record.id);download.download=record.name;}
    item.dataset.state = record.state;
    item.setAttribute('aria-busy', String(['queued', 'preparing', 'uploading', 'retrying', 'paused'].includes(record.state)));
    status.hidden = record.state === 'ready' || record.state === 'failed';
    status.textContent = navigator.onLine === false && record.state !== 'ready' ? '等待联网'
      : record.state === 'paused' ? '等待续传' : record.state === 'preparing' ? '正在压缩…' : record.state === 'retrying' ? `续传 ${record.progress || 0}%`
      : record.state === 'queued' ? '等待上传' : record.progress === 100 ? '正在保存…'
      : record.progress === undefined ? '正在上传…' : `上传 ${record.progress}%`;
    retry.textContent = record.offset && record.file ? `续传 ${Math.floor(record.offset / record.file.size * 100)}%` : '重试上传';
    retry.hidden = record.state !== 'failed';
    retry.title = record.error || '';
    retry.setAttribute('aria-label', record.error ? `${record.error} 点击重试上传` : '重试上传');
  }

  function describe(record) {
    return { id: record.id, name: record.name, mime: record.mime, document: record.document };
  }

  function persist(record, completed) {
    const value = completed ? { ...describe(record), resolvedId: completed.id, name: completed.name || record.name, mime: completed.mime || record.mime }
      : { ...describe(record), file: record.file, prepared: record.prepared, uploadId: record.uploadId, offset: record.offset };
    return record.persistence = (record.persistence || Promise.resolve()).catch(() => {}).then(() => storage.put(value));
  }

  async function prepare(record) {
    if (record.prepared) {
      if (!record.persistedPrepared) { await persist(record); record.persistedPrepared = true; }
      return;
    }
    // Save selected bytes before decoding so an OS page eviction can restore them.
    await (record.initialPersistence || persist(record));
    if (records.get(record.id) !== record) return;
    if (!record.document) {
      record.compression = new AbortController();
      const original = record.file, file = await compressImage(original, record.compression.signal);
      if (records.get(record.id) !== record) return;
      if (file !== original) {
        record.file = file; record.uploadId = crypto.randomUUID(); record.offset = 0; record.needsSync = false;
      }
    }
    record.prepared = true;
    await persist(record); record.persistedPrepared = true;
  }

  function request(record, method, start, end) {
    return new Promise((resolve, reject) => {
      const xhr = record.request = new XMLHttpRequest();
      const started = performance.now(), trace = crypto.randomUUID();
      let outcome = 'error', reason = 'response', stalled = false, loaded = -1;
      record.lastActivity = Date.now();
      xhr.open(method, method === 'GET' ? `${url}/uploads/${record.uploadId}` : url);
      xhr.timeout = 120000;
      if (method === 'POST') {
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${record.file.size}`);
        xhr.setRequestHeader('X-Upload-Id', record.uploadId);
        if (record.document) xhr.setRequestHeader('X-File-Name', encodeURIComponent(record.name));
        xhr.upload.onprogress = event => {
          if (event.loaded !== loaded) { loaded = event.loaded; record.lastActivity = Date.now(); }
          // Display only server-acknowledged bytes. Sending to the edge is not a receipt.
        };
      }
      xhr.setRequestHeader('X-Zigent-Trace', trace);
      const watchdog = setInterval(() => {
        if (!document.hidden && Date.now() - record.lastActivity > STALL_MS) { stalled = true; xhr.abort(); }
      }, 5000);
      xhr.onload = () => {
        record.lastActivity = Date.now();
        reason = `http-${xhr.status}`;
        if (method === 'GET' && xhr.status === 404) { outcome = 'ok'; resolve({ offset: 0, complete: false }); return; }
        try {
          const result = parseJsonResponse(xhr.responseText, {
            status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300,
            headers: { get: name => xhr.getResponseHeader(name) }
          }, { path: 'assets', method });
          if (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > record.file.size
            || typeof result.complete !== 'boolean' || result.complete !== (result.offset === record.file.size)
            || method === 'GET' && (result.total !== record.file.size || (result.name || undefined) !== (record.document ? record.name : undefined))
            || result.complete && (typeof result.id !== 'string' || !/^[a-f0-9-]{36}$/.test(result.id)))
            throw Object.assign(new Error('附件续传记录不匹配，请移除后重新选择。'), { status: 409 });
          outcome = 'ok'; reason = 'ok'; resolve(result);
        } catch (error) { reject(error); }
      };
      xhr.onerror = () => { reason = navigator.onLine === false ? 'offline' : 'network'; reject(Object.assign(new Error('附件连接中断，请重试续传。'), { network: true })); };
      xhr.ontimeout = () => { reason = 'timeout'; reject(Object.assign(new Error('附件上传超时，请重试续传。'), { timeout: true })); };
      xhr.onabort = () => {
        outcome = 'cancelled'; reason = stalled || record.recovering ? 'stalled' : 'cancelled';
        reject(Object.assign(new Error('附件上传已暂停。'), { network: stalled || record.recovering }));
      };
      xhr.onloadend = () => {
        clearInterval(watchdog);
        window.ZigentTelemetry?.record('web.api', performance.now() - started,
          `assets/${method === 'GET' ? 'status' : 'chunk'}/${reason}${document.hidden ? '-background' : ''}`, outcome,
          xhr.getResponseHeader('X-Zigent-Trace') || trace);
      };
      try { xhr.send(method === 'GET' ? null : record.file.slice(start, end)); }
      catch (error) { clearInterval(watchdog); reject(requestError(error, { path: 'assets', method })); }
    });
  }

  async function complete(record, result) {
    const localId = record.id;
    await persist(record, result);
    if (records.get(localId) !== record) return;
    records.delete(localId); record.storageId = localId; record.id = result.id; record.state = 'ready';
    record.name = result.name || record.name; record.mime = result.mime || record.mime; record.file = undefined;
    records.set(record.id, record); onComplete(localId, record.id);
  }

  async function send(record) {
    record.uploadId ??= record.id.slice('upload:'.length);
    record.offset ??= 0; record.retries ??= 0; record.rewinds ??= 0;
    active++; record.running = true; record.state = record.prepared ? 'uploading' : 'preparing'; update(record);
    try {
      await prepare(record);
      if (records.get(record.id) !== record) return;
      record.state = 'uploading'; update(record);
      if (record.needsSync) {
        const result = await request(record, 'GET');
        if (records.get(record.id) !== record) return;
        record.offset = result.offset; record.needsSync = false;
        record.progress = Math.floor(record.offset / record.file.size * 100); update(record);
        if (result.complete) { await complete(record, result); return; }
      }
      while (records.get(record.id) === record) {
        const start = record.offset, chunkBytes = record.chunkBytes ?? INITIAL_CHUNK_BYTES;
        const result = await request(record, 'POST', start, Math.min(start + chunkBytes, record.file.size));
        if (records.get(record.id) !== record) return;
        if (result.offset <= start && ++record.rewinds > 2) throw new Error('附件续传失败，请移除后重新选择文件。');
        record.chunkBytes = result.offset > start ? Math.min(MAX_CHUNK_BYTES, chunkBytes * 2) : INITIAL_CHUNK_BYTES;
        record.offset = result.offset; record.retries = 0;
        // Checkpoint only a tiny receipt; never rewrite the recording Blob per chunk.
        await storage.checkpoint(record.id, record.uploadId, record.offset).catch(() => {});
        if (records.get(record.id) !== record) return;
        record.progress = Math.floor(record.offset / record.file.size * 100); update(record);
        if (!result.complete) continue;
        await complete(record, result); return;
      }
    } catch (error) {
      if (records.get(record.id) !== record) return;
      record.chunkBytes = INITIAL_CHUNK_BYTES;
      record.needsSync = true; record.retryable = Boolean(retryable(error));
      record.state = record.retryable && (navigator.onLine === false || document.hidden) ? 'paused'
        : record.retryable && record.retries < MAX_RETRIES ? 'retrying' : 'failed';
      record.error = /[\u3400-\u9fff]/.test(error.message) ? error.message : requestError(error, { path: 'assets', method: 'POST' }).message;
      if (record.state === 'retrying') {
        record.retryTimer = setTimeout(() => {
          record.retryTimer = undefined;
          if (records.get(record.id) !== record) return;
          record.state = 'queued'; update(record); onChange(); pump();
        }, Math.min(30000, 1000 * 2 ** record.retries++) + Math.random() * 500);
      }
      if (error.status === 401) onUnauthorized();
    } finally {
      active--; record.running = false; record.request = undefined; record.recovering = false;
      if (records.get(record.id) === record) { update(record); onChange(); }
      pump();
    }
  }

  function pump() {
    if (!enabled || navigator.onLine === false) return;
    // Bound simultaneous transfers so large selections do not saturate mobile connections.
    for (const record of records.values()) {
      if (active >= 2) break;
      if (record.state === 'queued' && !record.running) void send(record);
    }
  }

  function discard(id) {
    const record = records.get(id);
    if (!record) return;
    clearTimeout(record.retryTimer);
    records.delete(id); record.compression?.abort(); record.request?.abort();
    void (record.persistence || Promise.resolve()).catch(() => {}).then(() => storage.remove(record.storageId || id)).catch(() => {});
    if (record.file) void fetch(`${url}/uploads/${record.uploadId ?? id.slice('upload:'.length)}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true }).catch(() => {});
    if (record.preview) URL.revokeObjectURL(record.preview);
    record.view?.item.remove();
  }

  function resume() {
    if (!enabled || navigator.onLine === false) return;
    for (const record of records.values()) {
      if (record.running) {
        if (record.request && Date.now() - record.lastActivity > STALL_MS) { record.recovering = true; record.request.abort(); }
      } else if (record.state === 'paused' || record.state === 'retrying' || record.state === 'failed' && record.retryable) {
        clearTimeout(record.retryTimer); record.retryTimer = undefined;
        record.state = 'queued'; record.retries = 0; record.needsSync = true; update(record);
      }
    }
    onChange(); pump();
  }
  window.addEventListener('online', resume);
  window.addEventListener('pageshow', resume);
  document.addEventListener('resume', resume);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  window.addEventListener('offline', () => { for (const record of records.values()) update(record); });

  return {
    add(file) {
      const id = `upload:${crypto.randomUUID()}`;
      const record = { id, file, uploadId: id.slice('upload:'.length), offset: 0, retries: 0, rewinds: 0,
        document: !/^image\//.test(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name), name: file.name, mime: file.type,
        preview: /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name) ? URL.createObjectURL(file) : undefined, state: 'queued' };
      records.set(id, record);
      // Persist every selected file, including those waiting for a transfer slot.
      record.initialPersistence = persist(record);
      record.initialPersistence.catch(() => { record.initialPersistence = undefined; });
      // The caller inserts and renders every placeholder before any transfer starts.
      queueMicrotask(pump); return id;
    },
    async snapshot(id) {
      const record = records.get(id);
      const metadata = fileInfo?.(id);
      if (id.startsWith('upload:') && !record?.file) throw new Error('附件已失效，请重新添加。');
      // Persist the currently available bytes immediately. If compression later
      // changes them, prepare() assigns a different upload identity to those bytes.
      return { id: record?.id ?? id, name: record?.name ?? metadata?.name, mime: record?.mime ?? metadata?.mime, document: record?.document ?? Boolean(metadata), ...(record?.file ? { file: record.file, prepared: record.prepared, uploadId: record.uploadId, offset: record.offset } : {}) };
    },
    async restore(asset) {
      if (records.has(asset.id)) return asset.id;
      const saved = asset.id.startsWith('upload:') ? await storage.get(asset.id).catch(error => { if (!asset.file) throw error; }) : undefined;
      const { id, file, prepared = false, uploadId, offset = 0, name, mime, document: isDocument, resolvedId } = saved || asset;
      if (resolvedId) {
        records.set(resolvedId, { id: resolvedId, storageId: id, name, mime, document: Boolean(isDocument), state: 'ready' });
        return resolvedId;
      }
      if (id.startsWith('upload:') && !file) throw new Error('续传文件已被浏览器清理，请重新添加附件。');
      if (!records.has(id)) records.set(id, file
        ? { id, file, prepared, uploadId, offset, needsSync: true, name: name || file.name, mime: mime || file.type,
          document: Boolean(isDocument), preview: isDocument ? undefined : URL.createObjectURL(file), progress: Math.floor(offset / file.size * 100), state: 'queued' }
        : { id, name, mime, document: Boolean(isDocument), state: 'ready' });
      return id;
    },
    describe(id) { return records.has(id) ? describe(records.get(id)) : { id }; },
    resume() { enabled = true; resume(); },
    suspend() {
      enabled = false;
      for (const record of records.values()) {
        clearTimeout(record.retryTimer); record.compression?.abort(); record.request?.abort();
        if (record.preview) URL.revokeObjectURL(record.preview);
        record.view?.item.remove();
      }
      records.clear();
    },
    isReady(id) { return records.get(id)?.state === 'ready' || !id.startsWith('upload:'); },
    retain(ids) { for (const id of records.keys()) if (!ids.has(id)) discard(id); },
    clear() { for (const id of records.keys()) discard(id); },
    render(container, ids, { remove, disabled }) {
      const views = ids.map(id => {
        let record = records.get(id);
        if (!record) { record = { id, state: 'ready' }; records.set(id, record); }
        const metadata = fileInfo?.(id);
        if (metadata && !record.file) {
          if (!record.document) { record.view?.item.remove(); record.view = undefined; }
          Object.assign(record, metadata, { document: true });
        }
        if (!record.view) {
          const item = el('div', 'attachment'), image = el('img'), button = el('button', 'attachment-remove', '×');
          const status = el('span', 'attachment-status'), retry = el('button', 'attachment-retry', '重试上传');
          let preview, download;
          if (record.document) {
            item.classList.add('attachment-document');
            const label = el('span', 'attachment-file-name', record.name || '文档'); label.title = record.name || ''; item.append(label);
            if(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(record.name||'')){
              preview=el('button','attachment-preview','预览');preview.type='button';preview.dataset.documentPreview='';item.append(preview);
              download=el('a','attachment-download','下载');item.append(download);
            }
          } else { image.src = record.preview || assetUrl(id); image.alt = '待发送图片'; image.decoding = 'async'; item.append(image); }
          button.type = retry.type = 'button'; button.setAttribute('aria-label', '移除附件');
          status.setAttribute('role', 'status');
          retry.onclick = () => {
            if (record.state !== 'failed') return;
            record.state = 'queued'; record.error = undefined; record.retries = 0; record.rewinds = 0;
            update(record); onChange(); pump();
          };
          item.append(status, retry, button); record.view = { item, button, status, retry, preview, download };
        }
        record.view.button.hidden = !remove;
        record.view.button.onclick = () => remove?.(record.id);
        record.view.button.disabled = record.view.retry.disabled = disabled;
        update(record); return record.view.item;
      });
      syncChildren(container, views);
    }
  };
}
