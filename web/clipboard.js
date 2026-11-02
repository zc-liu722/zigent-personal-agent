import { setMessageIcon } from './dom.js';

export function createClipboard({ toast }) {
  async function copyText(text, button, idle = '复制') {
    const icon = button.dataset.icon;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(text);
      toast('');
      if (icon) { setMessageIcon(button, 'check'); button.setAttribute('aria-label', '已复制'); button.title = '已复制'; }
      else button.textContent = '已复制';
    } catch { if (!icon) button.textContent = '复制失败'; toast('暂时无法访问剪贴板，请长按或选中文字复制。'); }
    if (!icon) button.setAttribute('aria-label', button.textContent);
    setTimeout(() => { if (icon) setMessageIcon(button, icon); else button.textContent = idle; button.setAttribute('aria-label', idle); button.title = idle; }, 1800);
  }
  return { copyText };
}
