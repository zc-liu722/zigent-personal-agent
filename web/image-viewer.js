import { el } from './dom.js';

/** Show the already decoded thumbnail immediately; fetch full-screen media only on demand. */
export function createImageViewer({ assetUrl, downloads }) {
  let dialog, stage, original, retry, loading, returnFocus;
  function close() { if (dialog?.open) dialog.close(); }
  function stop() {
    downloads.cancelWarm();
    if (loading) { loading.onload = loading.onerror = null; loading.removeAttribute('src'); loading = undefined; }
  }
  function load(id) {
    stop(); retry.hidden = true; stage.setAttribute('aria-busy', 'true');
    const image = el('img'); image.alt = '图片预览'; image.decoding = 'async'; image.fetchPriority = 'high';
    loading = image;
    image.onload = async () => {
      try { await image.decode(); } catch { /* Loaded media can still be displayed without decode(). */ }
      if (loading !== image || !dialog.open) return;
      stage.replaceChildren(image); stage.removeAttribute('aria-busy'); loading = undefined;
      downloads.warm(id);
    };
    image.onerror = () => {
      if (loading !== image) return;
      loading = undefined; stage.removeAttribute('aria-busy'); retry.hidden = false;
    };
    image.src = assetUrl(id, 'display');
  }
  function open(id, thumbnail, trigger) {
    if (!dialog) {
      dialog = el('dialog', 'image-viewer'); dialog.setAttribute('aria-label', '图片预览');
      const toolbar = el('div', 'image-viewer-toolbar'), dismiss = el('button', '', '关闭'); dismiss.type = 'button';
      original = el('a', '', '打开原图'); original.target = '_blank'; original.rel = 'noopener';
      retry = el('button', '', '加载失败，重试'); retry.type = 'button'; retry.hidden = true;
      stage = el('div', 'image-viewer-stage');
      toolbar.append(retry, original, dismiss); dialog.append(toolbar, stage); document.body.append(dialog);
      dismiss.onclick = close;
      dialog.addEventListener('click', event => { if (event.target === stage || event.target === dialog) close(); });
      dialog.addEventListener('close', () => {
        if (dialog.open) return;
        stop(); stage.replaceChildren(); stage.removeAttribute('aria-busy');
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        returnFocus = undefined;
      });
    }
    stop(); returnFocus = trigger; original.href = assetUrl(id);
    const placeholder = el('img'); placeholder.alt = thumbnail.alt;
    placeholder.src = thumbnail.currentSrc || thumbnail.src;
    stage.replaceChildren(placeholder);
    retry.onclick = () => load(id);
    original.onclick = event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (downloads.open(id, stage.querySelector('img')?.src)) event.preventDefault();
    };
    if (!dialog.open) dialog.showModal();
    load(id);
  }
  return { open, close };
}
