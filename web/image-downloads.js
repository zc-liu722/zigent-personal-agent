import { el } from './dom.js';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif' };
const invalid = () => Object.assign(new Error('图片下载失败，请重试。'), { permanent: true });

/** One resumable transfer per original, shared by opening and saving; no persistent private cache. */
export function createImageDownloads({ assetUrl }) {
  const entries = new Map();
  let warmed, generation = 0;
  const touch = (id, entry) => { entries.delete(id); entries.set(id, entry); };
  function trim() {
    const ready = [...entries].filter(([, entry]) => entry.file);
    let bytes = ready.reduce((sum, [, entry]) => sum + entry.file.size, 0);
    // Retain at most eight files / 64 MiB, or the single current file if it is larger.
    while (ready.length > 1 && (bytes > 64 * 1024 * 1024 || ready.length > 8)) {
      const [id, entry] = ready.shift(); bytes -= entry.file.size;
      URL.revokeObjectURL(entry.url); entries.delete(id);
    }
  }
  async function transfer(id, entry) {
    let chunks = [], received = 0, total, etag, mime;
    const deadline = setTimeout(() => entry.controller.abort(new Error('图片下载超时，请重试。')), 120_000);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
        const request = new AbortController(), abort = () => request.abort();
        entry.controller.signal.addEventListener('abort', abort, { once: true });
        let stalled, reader, response;
        const arm = () => { clearTimeout(stalled); stalled = setTimeout(() => request.abort(), 20_000); };
        try {
          arm();
          response = await fetch(assetUrl(id), { credentials: 'same-origin', signal: request.signal,
            priority: entry.foreground ? 'high' : 'low', headers: received && etag ? { Range: `bytes=${received}-`, 'If-Range': etag } : {} });
          // A proxy may omit Content-Length and disconnect after delivering the final byte.
          if (response.status === 416 && received && etag && response.headers.get('ETag') === etag
            && response.headers.get('Content-Range') === `bytes */${received}`) {
            return new File(chunks, `image-${id}.${extensions[mime]}`, { type: mime });
          }
          if (!response.ok) throw Object.assign(new Error('图片下载失败，请重试。'), { permanent: response.status < 500 && ![408, 429].includes(response.status) });
          const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
          const lengthHeader = response.headers.get('Content-Length');
          const length = lengthHeader === null ? undefined : Number(lengthHeader);
          const version = response.headers.get('ETag');
          if (!extensions[type] || length !== undefined && (!Number.isSafeInteger(length) || length < 1) || !response.body) throw invalid();
          if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
            const size = Number(range?.[3]);
            if (!range || !Number.isSafeInteger(size) || size <= received || Number(range[1]) !== received
              || total !== undefined && size !== total || version !== etag || Number(range[2]) !== size - 1
              || length !== undefined && length !== size - received || type !== mime) throw invalid();
            total = size;
          } else if (response.status === 200) {
            chunks = []; received = 0; total = length; etag = version; mime = type;
          } else throw invalid();
          reader = response.body.getReader();
          for (;;) {
            arm(); const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value); received += value.byteLength;
            if (total !== undefined) {
              if (received > total) throw invalid();
              const progress = Math.floor(received / total * 100);
              if (entry.progress !== progress) { entry.progress = progress; for (const listener of entry.listeners) listener(progress); }
              if (received === total) break;
            }
          }
          if (!received || total !== undefined && received !== total) throw new Error('图片下载中断。');
          return new File(chunks, `image-${id}.${extensions[mime]}`, { type: mime });
        } catch (error) {
          if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
          if (error.permanent) throw error;
          if (attempt === 2) throw new Error('图片下载失败，请重试。', { cause: error });
        } finally {
          clearTimeout(stalled); entry.controller.signal.removeEventListener('abort', abort);
          if (reader) await reader.cancel().catch(() => {});
          else await response?.body?.cancel().catch(() => {});
        }
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    } finally { clearTimeout(deadline); }
  }
  function prepare(id, { background = false, onProgress } = {}) {
    let entry = entries.get(id);
    if (!entry) {
      if ([...entries.values()].filter(entry => !entry.file).length >= 3) return Promise.reject(new Error('正在下载其他图片，请稍后重试。'));
      entry = { controller: new AbortController(), foreground: !background, listeners: new Set(), progress: 0 };
      entries.set(id, entry);
      entry.promise = transfer(id, entry).then(file => {
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
        entry.file = file; entry.url = URL.createObjectURL(file); touch(id, entry); trim(); return file;
      }).catch(error => { if (entries.get(id) === entry) entries.delete(id); throw error; });
    }
    if (!background) entry.foreground = true;
    touch(id, entry);
    if (!onProgress) return entry.promise;
    entry.listeners.add(onProgress); onProgress(entry.progress);
    return entry.promise.finally(() => entry.listeners.delete(onProgress));
  }
  function cancelWarm() {
    const entry = entries.get(warmed);
    if (entry && !entry.file && !entry.foreground) { entry.controller.abort(); entries.delete(warmed); }
    warmed = undefined;
  }
  function warm(id) {
    cancelWarm();
    const connection = navigator.connection;
    if (document.hidden || connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')
      || [...entries.values()].some(entry => !entry.file)) return;
    warmed = id; void prepare(id, { background: true }).catch(() => {});
  }
  function open(id, placeholder) {
    const current = generation;
    const entry = entries.get(id);
    const initial = entry?.url || placeholder || assetUrl(id);
    const popup = window.open(initial, '_blank');
    if (!popup) return false;
    popup.opener = null;
    const navigate = url => {
      try {
        if (current === generation && !popup.closed && [initial, 'about:blank'].includes(popup.location.href)) popup.location.replace(url);
      } catch { /* The user may have navigated the tab. */ }
    };
    if (!entry?.file) void prepare(id).then(() => {
      const ready = entries.get(id);
      if (ready) navigate(ready.url);
    }).catch(error => {
      if (current === generation && error.name !== 'AbortError' && !popup.closed) {
        navigate(assetUrl(id));
      }
    });
    else touch(id, entry);
    return true;
  }
  function save(id) {
    const entry = entries.get(id);
    if (!entry?.file) return;
    touch(id, entry);
    const link = el('a'); link.href = entry.url; link.download = entry.file.name; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
  }
  function clear() {
    generation++;
    cancelWarm();
    for (const entry of entries.values()) { entry.controller.abort(); if (entry.url) URL.revokeObjectURL(entry.url); }
    entries.clear();
  }
  return { prepare, warm, cancelWarm, open, save, clear, peek: id => entries.get(id)?.file };
}
