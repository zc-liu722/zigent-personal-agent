export const $ = id => document.getElementById(id);

export function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
const messageIcons = {
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5m0 8v5h-5m-8 0H3v-5"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  annotate: '<path d="M14 4H5a2 2 0 0 0-2 2v15l4-4h10a2 2 0 0 0 2-2v-3M13 10l1-4 5-5 3 3-5 5Z"/>',
  edit: '<path d="m16 3 5 5M4 20l4-1L21 6a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  'reply-add': '<path d="M20 10V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v11l4-3h4M17 13v8m-4-4h8"/>',
  'reply-new': '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 8v8m-4-4h8"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M6 15h4a8 8 0 0 0 8-8"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
export function setMessageIcon(button, name) {
  // Only fixed application icons enter this markup; message content never does.
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${messageIcons[name]}</svg>`;
}
export function messageButton(name, label) {
  const button = el('button', `message-action message-${name}`); button.type = 'button'; button.dataset.icon = name;
  button.setAttribute('aria-label', label); button.title = label; setMessageIcon(button, name); return button;
}
export function syncChildren(parent, children) {
  const wanted = new Set(children);
  // Remove replaced content before inserting new content, so its keyed siblings
  // (including a focused authorization button) never need to move.
  for (const child of [...parent.childNodes]) if (!wanted.has(child)) child.remove();
  let next = parent.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else parent.insertBefore(child, next);
  }
  while (next) { const stale = next; next = next.nextSibling; stale.remove(); }
}
export function updateText(node, text) { if (node.textContent !== text) node.textContent = text; }
