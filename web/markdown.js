import { el, messageButton } from './dom.js';
import { interactionUrl } from './components/interaction-model.js';
import { loadScript, loadStyle } from './lazy-assets.js';

let mathReady = false, mathDownload;
let highlightDownload;
function highlightCode(node, code, language) {
  if (!language || code.length > 100000) return;
  highlightDownload ||= loadScript('./vendor/highlight/highlight.min.js').catch(error => { highlightDownload = undefined; throw error; });
  void highlightDownload.then(() => {
    const highlighter = window.ZigentHighlight;
    if (highlighter?.getLanguage(language)) node.innerHTML = highlighter.highlight(code, { language, ignoreIllegals: true }).value;
  }).catch(() => {});
}
function loadMath() {
  return mathDownload ||= Promise.all([loadStyle('./vendor/katex/katex.min.css'), loadScript('./vendor/katex/katex.min.js')])
    .then(() => { mathReady = true; }).catch(error => { mathDownload = undefined; throw error; });
}

export function createMarkdownRenderer({ copyText, openConversationDocument, toast, captureReadingPosition, restoreReadingPosition, rememberReadingPosition }) {
  const pendingMath = new Map();
  let mathScheduled = false;
  function scheduleMath() {
    if (mathScheduled) return;
    mathScheduled = true;
    void loadMath().then(() => {
      requestAnimationFrame(() => {
        mathScheduled = false;
        const renders = [...pendingMath].filter(([node]) => node.isConnected);
        pendingMath.clear();
        if (!renders.length) return;
        // One position read and restoration for the whole batch, rather than
        // alternating layout reads and DOM writes for every formula.
        const position = captureReadingPosition?.();
        for (const [, render] of renders) render();
        if (position) {
          restoreReadingPosition(position, false, true);
          rememberReadingPosition();
        }
      });
    }).catch(() => { mathScheduled = false; pendingMath.clear(); });
  }
  function mathNode(source, raw, display = false, block = false) {
    const node = el(block ? 'div' : 'span', block ? 'math-fallback' : '', raw);
    const render = () => {
      try {
        window.katex.render(source, node, { displayMode: display, output: 'htmlAndMathml',
          throwOnError: true, trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 });
        node.className = block ? 'math-block' : 'math-inline';
        if (block) { node.tabIndex = 0; node.setAttribute('role', 'region'); node.setAttribute('aria-label', '公式，可横向滚动'); }
      } catch { node.className = block ? 'math-fallback' : ''; node.textContent = raw; }
    };
    if (mathReady) render();
    else { pendingMath.set(node, render); scheduleMath(); }
    return node;
  }
  function inline(parent, text, depth = 0) {
    // Build text nodes, never interpret model HTML. Links allow only HTTP(S).
    // Code and escapes take precedence; TeX is consumed before Markdown emphasis.
    const expression = /(?<ticks>`+)(?<code>[^\n]*?)\k<ticks>(?!`)|\\\((?<paren>[\s\S]*?)\\\)|\\\[(?<bracket>[\s\S]*?)\\\]|\$\$(?<display>[\s\S]*?)\$\$|\$(?![\s$])(?<math>(?:\\[\s\S]|[^$\\`])+?)\$(?![\d$])|\\(?<escape>[\\`*{}\[\]()#+\-.!_$>~|])|\*\*(?<strong>[^*]+)\*\*|\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^\s)]+)\)|\*(?<em>[^*\n]+)\*|~~(?<del>[^~]+)~~/g;
    const appendText = value => value.split('\n').forEach((line, index) => {
      if (index) parent.append(el('br')); if (line) parent.append(document.createTextNode(line));
    });
    let offset = 0;
    for (let match; (match = expression.exec(text));) {
      appendText(text.slice(offset, match.index));
      const token = match.groups, formula = token.paren ?? token.bracket ?? token.display ?? token.math;
      if (token.code !== undefined) parent.append(el('code', '', token.code));
      else if (formula !== undefined) {
        // A closing currency sign preceded by whitespace is not a math delimiter.
        if (token.math !== undefined && /\s$/.test(formula)) {
          appendText('$'); offset = expression.lastIndex = match.index + 1; continue;
        }
        if (!formula.trim()) appendText(match[0]);
        else parent.append(mathNode(formula, match[0], token.bracket !== undefined || token.display !== undefined));
      } else if (token.escape !== undefined) appendText(token.escape);
      else if (token.label !== undefined) {
        const url = interactionUrl(token.url);
        if (url) { const a = el('a'); if (depth < 8) inline(a, token.label, depth + 1); else a.textContent = token.label; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
        else appendText(match[0]);
      } else {
        const node = el(token.strong !== undefined ? 'strong' : token.em !== undefined ? 'em' : 'del');
        const value = token.strong ?? token.em ?? token.del;
        if (depth < 8) inline(node, value, depth + 1); else node.textContent = value;
        parent.append(node);
      }
      offset = match.index + match[0].length;
    }
    appendText(text.slice(offset));
  }
  function contentButton(icon, label, className) {
    const button = messageButton(icon, label); button.className = `content-icon ${className}`; return button;
  }
  function codeBlock(code, language, preserveLayout = false) {
    const block = el('div', `code-block${preserveLayout ? ' preserve-layout' : ''}`), heading = el('div', 'code-heading'), copy = contentButton('copy', '复制代码', 'code-copy'), pre = el('pre');
    heading.dataset.selectionControl = 'true';
    copy.type = 'button'; copy.onclick = () => copyText(code, copy, '复制代码');
    const codeNode = el('code', '', code);
    highlightCode(codeNode, code, language.toLowerCase());
    heading.append(el('span', '', language || '文本'), copy); pre.append(codeNode); block.append(heading, pre); return block;
  }
  function writingBlock(original, title, depth, message) {
    const source = Object.values(message?.writingEdits || {}).find(edit => edit.original === original)?.content ?? original;
    const block = el('section', 'writing-block'), heading = el('div', 'writing-heading');
    const actions = el('div', 'writing-actions'), edit = contentButton('edit', '编辑文稿', 'writing-edit'), copy = contentButton('copy', '复制文稿', 'writing-copy');
    const body = markdown(source, depth + 1);
    body.className = 'writing-body';
    block.setAttribute('role', 'group'); block.setAttribute('aria-label', title || '文稿');
    heading.dataset.selectionControl = 'true';
    edit.disabled = !message || message.snapshot?.status === 'running';
    edit.onclick = async () => {
      try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(original));
        const key = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
        await openConversationDocument({ id: 'writing' }, message, `writing:${key}`, edit);
      } catch (error) { toast(error); }
    };
    copy.onclick = () => {
      // A draft may contain code blocks. Exclude their toolbar labels while
      // retaining the browser's paragraph breaks, table spacing and indentation.
      const controls = [...body.querySelectorAll('[data-selection-control]')], hidden = controls.map(node => node.hidden);
      let text;
      try { controls.forEach(node => { node.hidden = true; }); text = (body.innerText || body.textContent).trim(); }
      finally { controls.forEach((node, index) => { node.hidden = hidden[index]; }); }
      return copyText(text, copy, '复制文稿');
    };
    actions.append(edit, copy); heading.append(el('span', 'writing-title', title || '文稿'), actions);
    block.append(heading, body); return block;
  }
  function tableCells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  }
  function markdown(text, depth = 0, message) {
    const container = el('div', 'message-text'), lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const fence = line => /^\s{0,3}(`{3,}|~{3,})\s*([\w.+-]*)([^\n]*)$/.exec(line);
    const list = line => /^(\s*)([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    const heading = line => {
      const match = /^\s{0,3}(#{1,6})[\t ]+(.+?)[\t ]*$/.exec(line);
      if (match) match[2] = match[2].replace(/[\t ]+#+[\t ]*$/, '');
      return match;
    };
    const rule = line => /^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(line);
    const table = index => lines[index]?.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '');
    const displayMath = index => {
      const opening = /^\s{0,3}(\$\$|\\\[)(.*)$/.exec(lines[index]);
      if (!opening) return;
      const closing = opening[1] === '$$' ? /(?<!\\)\$\$/ : /\\\]/, content = [];
      for (let end = index; end < lines.length; end++) {
        const line = end === index ? opening[2] : lines[end], match = closing.exec(line);
        if (match) {
          if (line.slice(match.index + match[0].length).trim()) return;
          content.push(line.slice(0, match.index));
          return { source: content.join('\n'), raw: lines.slice(index, end + 1).join('\n'), end: end + 1 };
        }
        content.push(line);
      }
    };
    const boundary = index => !lines[index].trim() || fence(lines[index]) || displayMath(index) || heading(lines[index]) || rule(lines[index]) || list(lines[index]) || /^\s*>/.test(lines[index]) || table(index);
    let index = 0;
    while (index < lines.length) {
      if (!lines[index].trim()) { index++; continue; }
      const marker = fence(lines[index]), title = heading(lines[index]);
      if (marker) {
        const code = []; index++;
        while (index < lines.length && !new RegExp(`^\\s{0,3}${marker[1][0]}{${marker[1].length},}\\s*$`).test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index++;
        container.append(depth < 8 && /^(writing|email|letter|reply)$/i.test(marker[2])
          ? writingBlock(code.join('\n'), marker[3].trim(), depth, message)
          : codeBlock(code.join('\n'), marker[2], /(?:^|\s)nowrap(?:\s|$)/i.test(marker[3]))); continue;
      }
      const formula = displayMath(index);
      if (formula) { container.append(mathNode(formula.source, formula.raw, true, true)); index = formula.end; continue; }
      if (title) { const node = el(`h${title[1].length}`); inline(node, title[2]); container.append(node); index++; continue; }
      if (rule(lines[index])) { container.append(el('hr')); index++; continue; }
      if (/^\s*>/.test(lines[index]) && depth < 8) {
        const quoted = []; while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*> ?/, ''));
        const quote = el('blockquote'), content = markdown(quoted.join('\n'), depth + 1, message); quote.append(...content.childNodes); container.append(quote); continue;
      }
      if (table(index)) {
        const wrapper = el('div', 'table-scroll'), node = el('table'), head = el('thead'), row = el('tr'), headers = tableCells(lines[index]), aligns = tableCells(lines[index + 1]);
        wrapper.setAttribute('tabindex', '0'); wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', '表格，可横向滚动');
        headers.forEach(value => { const cell = el('th'); cell.setAttribute('scope', 'col'); inline(cell, value); row.append(cell); }); head.append(row); node.append(head); index += 2;
        const body = el('tbody');
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
          const values = tableCells(lines[index++]), tr = el('tr');
          headers.forEach((_, column) => { const cell = el('td'); if (/^:.*:$/.test(aligns[column])) cell.style.textAlign = 'center'; else if (/:$/.test(aligns[column])) cell.style.textAlign = 'right'; inline(cell, values[column] || ''); tr.append(cell); }); body.append(tr);
        }
        node.append(body); wrapper.append(node); container.append(wrapper); continue;
      }
      if (list(lines[index])) {
        const stack = [];
        while (index < lines.length) {
          const match = list(lines[index]); if (!match) break;
          const indent = match[1].replace(/\t/g, '    ').length, ordered = /^\d/.test(match[2]);
          while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
          if (stack.length && indent === stack[stack.length - 1].indent && ordered !== stack[stack.length - 1].ordered) stack.pop();
          if (!stack.length || indent > stack[stack.length - 1].indent) {
            const node = el(ordered ? 'ol' : 'ul');
            if (ordered && parseInt(match[2], 10) !== 1) node.setAttribute('start', String(parseInt(match[2], 10)));
            const parent = stack[stack.length - 1]; (parent?.last || container).append(node); stack.push({ node, indent, ordered });
          }
          const parent = stack[stack.length - 1], item = el('li'), task = /^\[([ xX])\]\s+(.+)$/.exec(match[3]);
          if (task) { item.className = 'task-item'; const check = el('span', `task-check${task[1] === ' ' ? '' : ' checked'}`, task[1] === ' ' ? '' : '✓'); check.setAttribute('role', 'img'); check.setAttribute('aria-label', task[1] === ' ' ? '未完成' : '已完成'); item.append(check); inline(item, task[2]); }
          else inline(item, match[3]);
          parent.node.append(item); parent.last = item; index++;
        }
        continue;
      }
      const paragraph = el('p'), content = [];
      do { content.push(lines[index++]); } while (index < lines.length && !boundary(index));
      inline(paragraph, content.join('\n'));
      container.append(paragraph);
    }
    return container;
  }
  // Reconcile in place: moving every message through a fragment restarts animations
  // and discards the browser's native details/scroll state on every stream update.
  return { markdown, inline };
}
