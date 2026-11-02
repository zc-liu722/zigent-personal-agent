import { el } from '../dom.js';

// Every control in this module changes only the local preview.
export function renderContentPreview(presentation) {
  if (!['document', 'table'].includes(presentation?.kind)) return undefined;
  const card = el('section', `content-preview content-preview-${presentation.kind}`), header = el('header', 'content-preview-heading');
  const heading = el('div', 'content-preview-identity');
  if (presentation.kind !== 'table') heading.append(el('span', 'content-preview-format', presentation.format || '文档'));
  heading.append(el('h4', '', presentation.title));
  header.append(heading); card.append(header);
  const content = el('div'), navigation = el('div', 'content-preview-navigation');
  const sides = ['before', 'after'].filter(side => presentation[side] !== undefined);
  let selected = sides.includes('after') ? 'after' : 'before';
  const buttons = sides.map(side => {
    const button = el('button', '', side === 'before' ? '修改前' : sides.length > 1 ? '修改后' : '本次内容');
    button.type = 'button'; button.onclick = () => { selected = side; render(); }; navigation.append(button); return [side, button];
  });
  const details = el(presentation.kind === 'table' ? 'div' : 'details', 'content-preview-details');
  if (presentation.kind !== 'table') details.append(el('summary', '', '查看内容'));
  if (presentation.kind !== 'table' && sides.length > 1) details.append(navigation);
  details.append(content); card.append(details);
  function render() {
    buttons.forEach(([side, button]) => button.setAttribute('aria-pressed', String(side === selected)));
    content.replaceChildren(presentation.kind === 'table' ? tablePreview(presentation, selected) : documentPreview(presentation[selected]));
  }
  render(); return card;
}

function documentPreview(value) {
  const text = typeof value === 'string' ? value : '', body = el('div', 'content-document');
  if (!text) { body.append(el('p', 'content-document-empty', '空白')); return body; }
  const lines = text.split('\n'), article = el('article', 'content-document-page');
  let expanded = false;
  function render() {
    article.replaceChildren();
    for (const line of expanded ? lines : lines.slice(0, 14)) {
      const heading = line.match(/^(#{1,6})\s+(.+)$/), bullet = line.match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
      const node = el(heading ? `h${Math.min(heading[1].length + 1, 6)}` : 'p', bullet ? 'content-document-bullet' : '', heading ? heading[2] : bullet ? bullet[1] : line || '\u00a0');
      article.append(node);
    }
  }
  body.append(article); render();
  if (lines.length > 14) {
    const toggle = el('button', 'content-preview-expand', `展开全文 · ${lines.length} 行`); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => { expanded = !expanded; toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起全文' : `展开全文 · ${lines.length} 行`; render(); };
    body.append(toggle);
  }
  return body;
}

function tablePreview(presentation, side) {
  const rows = Array.isArray(presentation[side]) ? presentation[side] : [], body = el('div'), viewport = el('div', 'content-table-viewport');
  viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', `${presentation.title} ${presentation.range || ''}，可滚动`);
  const table = el('table', 'content-table'), caption = el('caption', 'sr-only', `${presentation.range || presentation.title} · ${side === 'after' ? '修改后' : '修改前'}`);
  table.append(caption); viewport.append(table); body.append(viewport);
  const coordinates = String(presentation.range || '').match(/(?:^|!)(\$?[A-Z]+)\$?(\d+)(?::|$)/i);
  const letters = index => { let result = ''; for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result; return result; };
  const startColumn = coordinates ? [...coordinates[1].replace('$', '').toUpperCase()].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1 : 0;
  const startRow = coordinates ? Number(coordinates[2]) : 1, columns = rows.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  let expanded = false;
  function render() {
    const head = el('thead'), header = el('tr'); header.append(el('th'));
    for (let column = 0; column < columns; column++) { const cell = el('th', '', letters(startColumn + column)); cell.scope = 'col'; header.append(cell); }
    head.append(header); const tbody = el('tbody');
    for (const [index, row] of (expanded ? rows : rows.slice(0, 40)).entries()) {
      const tr = el('tr'), number = el('th', '', String(startRow + index)); number.scope = 'row'; tr.append(number);
      for (let column = 0; column < columns; column++) {
        const supplied = Object.hasOwn(row, column), value = supplied ? String(row[column] ?? '') : '', cell = el('td', '', value);
        if (!supplied) cell.classList.add('omitted-cell');
        if (side === 'after' && supplied && value !== String(presentation.before?.[index]?.[column] ?? '')) cell.classList.add('changed-cell');
        tr.append(cell);
      }
      tbody.append(tr);
    }
    table.replaceChildren(caption, head, tbody);
  }
  render();
  if (rows.length > 40) {
    const toggle = el('button', 'content-preview-expand', `显示全部 ${rows.length} 行`); toggle.type = 'button'; toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => { expanded = !expanded; toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起表格' : `显示全部 ${rows.length} 行`; render(); }; body.append(toggle);
  }
  return body;
}
