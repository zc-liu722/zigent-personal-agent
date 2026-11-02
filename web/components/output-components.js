'use strict';
// Native data renderers; generated HTML is handled exclusively by the isolated preview.
(() => {
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = String(text); return element; };
  const labels = { artifact: '文件', metrics: '关键指标', chart: '图表', table: '数据表', steps: '步骤', resources: '参考资料', document: 'Markdown 文档', interactive: '交互可视化', animation: '动态画面' };
  const stepLabels = { pending: '待开始', active: '进行中', completed: '已完成' };
  const colors = ['#b7684c', '#637867', '#727fa0', '#a38a59'];
  const safeUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; } };
  const string = (value, max = 500) => typeof value === 'string' && value.length <= max;
  function valid(output) {
    if (!output || !string(output.id, 64) || !/^[a-zA-Z0-9_-]{1,64}$/.test(output.id) || !string(output.title, 120) || !output.title.trim() || !Array.isArray(output.blocks) || !output.blocks.length || output.blocks.length > 8) return false;
    if (output.description !== undefined && !string(output.description, 500)) return false;
    if (JSON.stringify(output).length > 48000) return false;
    if (output.blocks.filter(block => ['interactive', 'animation'].includes(block?.type)).length > 3) return false;
    return output.blocks.every(block => {
      if (!block || !Object.hasOwn(labels, block.type)) return false;
      if (block.type === 'artifact') return /^[a-f0-9-]{36}$/.test(block.versionId) && /^[a-f0-9-]{36}$/.test(block.fileId)
        && (block.previousVersions === undefined || Array.isArray(block.previousVersions) && block.previousVersions.length <= 100 && block.previousVersions.every(version => version && /^[a-f0-9-]{36}$/.test(version.versionId) && string(version.filename, 240) && Number.isSafeInteger(version.size) && version.size >= 0))
        && string(block.filename, 240) && string(block.mime, 160) && Number.isSafeInteger(block.size) && block.size >= 0 && /^[a-f0-9]{64}$/.test(block.sha256);
      if (block.title !== undefined && !string(block.title, 120)) return false;
      if (block.type === 'animation' && (!Number.isFinite(block.duration) || block.duration < 1 || block.duration > 300)) return false;
      if (['interactive', 'animation'].includes(block.type)) return string(block.html, 32000) && !!block.html.trim() && !block.html.includes('\0') && string(block.summary, 1500) && !!block.summary.trim() && (block.height === undefined || Number.isInteger(block.height) && block.height >= 240 && block.height <= 720);
      if (block.type === 'document') return string(block.content, 32000) && string(block.filename, 120) && /^[^/\\\x00-\x1f]+\.md$/i.test(block.filename) && !['.', '..'].includes(block.filename);
      if (block.type === 'chart') return (block.unit === undefined || string(block.unit, 40)) && ['bar', 'line'].includes(block.chartType) && Array.isArray(block.labels) && block.labels.length > 0 && block.labels.length <= 48 && block.labels.every(label => string(label, 80)) && Array.isArray(block.series) && block.series.length > 0 && block.series.length <= 4 && block.series.every(series => series && string(series.label, 80) && Array.isArray(series.values) && series.values.length === block.labels.length && series.values.every(value => Number.isFinite(value) && Math.abs(value) <= 1e15));
      if (block.type === 'table') return Array.isArray(block.columns) && block.columns.length > 0 && block.columns.length <= 8 && block.columns.every(column => string(column, 80)) && Array.isArray(block.rows) && block.rows.length <= 50 && block.rows.every(row => Array.isArray(row) && row.length === block.columns.length && row.every(cell => cell === null || Number.isFinite(cell) || string(cell, 300)));
      return Array.isArray(block.items) && block.items.length > 0 && block.items.length <= ({ metrics: 6, steps: 12, resources: 8 }[block.type]) && block.items.every(item => {
        if (!item) return false;
        if (block.type === 'metrics') return string(item.label, 80) && string(item.value, 100) && (item.change === undefined || string(item.change, 100));
        if (block.type === 'steps') return string(item.title, 160) && Object.hasOwn(stepLabels, item.status) && (item.description === undefined || string(item.description, 500));
        return string(item.title, 160) && typeof item.url === 'string' && item.url.length <= 2048 && safeUrl(item.url) && (item.description === undefined || string(item.description, 300)) && (item.format === undefined || string(item.format, 40));
      });
    });
  }
  const display = value => value === null ? '—' : String(value);
  function table(columns, rows, caption) {
    const wrap = node('div', 'output-table-scroll'), table = node('table', 'output-table'), head = node('thead'), body = node('tbody'), row = node('tr');
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', caption || '数据表，可横向滚动');
    if (caption) { const cap = node('caption', 'output-sr-only', caption); table.append(cap); }
    for (const column of columns) { const cell = node('th', '', column); cell.scope = 'col'; row.append(cell); }
    head.append(row);
    for (const values of rows) { const tr = node('tr'); for (const value of values) tr.append(node('td', '', display(value))); body.append(tr); }
    table.append(head, body); wrap.append(table); return wrap;
  }
  function svgNode(tag, attributes = {}) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
  function chart(block) {
    const wrap = node('div', 'output-chart'), svg = svgNode('svg', { viewBox: '0 0 600 260', role: 'img', 'aria-label': `${block.title || labels.chart}${block.unit ? `（${block.unit}）` : ''}。完整数值见下方图表数据。` });
    const values = block.series.flatMap(series => series.values), min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    const x = index => block.chartType === 'bar' ? 48 + (index + .5) * 520 / block.labels.length : 48 + (block.labels.length === 1 ? 260 : index * 520 / (block.labels.length - 1));
    const y = value => 218 - ((value - min) / span) * 190, zero = y(0);
    for (let i = 0; i <= 4; i++) {
      const value = min + span * i / 4, pos = y(value), label = svgNode('text', { x: 40, y: pos + 4, 'text-anchor': 'end', class: 'output-axis-label' });
      label.textContent = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
      svg.append(svgNode('line', { x1: 48, x2: 580, y1: pos, y2: pos, class: 'output-chart-grid' }), label);
    }
    const skip = Math.max(1, Math.ceil(block.labels.length / 6));
    block.labels.forEach((label, index) => {
      if (index % skip && index !== block.labels.length - 1) return;
      const text = svgNode('text', { x: x(index), y: 244, 'text-anchor': 'middle', class: 'output-axis-label' });
      text.textContent = label.length > 8 ? `${label.slice(0, 7)}…` : label; svg.append(text);
    });
    block.series.forEach((series, seriesIndex) => {
      const color = colors[seriesIndex];
      if (block.chartType === 'line') {
        svg.append(svgNode('polyline', { points: series.values.map((value, index) => `${x(index)},${y(value)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        series.values.forEach((value, index) => { const dot = svgNode('circle', { cx: x(index), cy: y(value), r: 3, fill: color }); const title = svgNode('title'); title.textContent = `${block.labels[index]} · ${series.label}: ${value}${block.unit || ''}`; dot.append(title); svg.append(dot); });
      } else {
        const group = 520 / block.labels.length, slot = group * .72 / block.series.length, width = Math.min(38, slot * .85);
        series.values.forEach((value, index) => {
          const center = 48 + index * group + group * .14 + (seriesIndex + .5) * slot, left = center - width / 2;
          const rect = svgNode('rect', { x: left, y: Math.min(zero, y(value)), width, height: Math.max(1, Math.abs(y(value) - zero)), rx: 2, fill: color });
          const title = svgNode('title'); title.textContent = `${block.labels[index]} · ${series.label}: ${value}${block.unit || ''}`; rect.append(title); svg.append(rect);
        });
      }
    });
    const legend = node('div', 'output-chart-legend');
    block.series.forEach((series, index) => { const item = node('span'), dot = node('i'); dot.style.backgroundColor = colors[index]; dot.setAttribute('aria-hidden', 'true'); item.append(dot, document.createTextNode(series.label)); legend.append(item); });
    wrap.append(legend, svg);
    if (block.unit) wrap.append(node('p', 'output-unit', `单位：${block.unit}`));
    const details = node('details', 'output-chart-data'), summary = node('summary', '', '查看图表数据');
    details.append(summary, table(['', ...block.series.map(series => series.label)], block.labels.map((label, i) => [label, ...block.series.map(series => series.values[i])]), block.title || '图表数据'));
    wrap.append(details); return wrap;
  }
  function renderBlock(block, outputId, index, view) {
    const section = node('section', `output-block output-block-${block.type}`), heading = node('div', 'output-block-heading');
    heading.append(node('h3', '', block.title || labels[block.type])); heading.hidden = view.singleBlock && (!block.title || block.title === view.output.title || ['interactive', 'animation'].includes(block.type)); section.append(heading);
    if (block.type === 'artifact') {
      heading.hidden = true;
      const card = node('div', 'output-artifact'), copy = node('div', 'output-artifact-copy'), actions = node('div', 'output-artifact-actions');
      copy.append(node('strong', '', block.filename), node('span', 'output-resource-meta', new Intl.NumberFormat('zh-CN', {maximumFractionDigits:1}).format(block.size / (block.size >= 1048576 ? 1048576 : 1024)) + (block.size >= 1048576 ? ' MB' : ' KB')));
      const base = new URL('./', location.href);
      if (/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(block.filename) || /^(application\/pdf|image\/(png|jpeg|webp|gif)|text\/plain(?:;|$))/.test(block.mime)) {
        const preview = node('a', '', '预览'); preview.href = new URL(`api/workbench/versions/${block.versionId}/preview`,base).href; preview.target = '_blank'; preview.rel = 'noopener'; if(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(block.filename)){preview.dataset.documentPreview='';preview.dataset.versionId=block.versionId;preview.dataset.filename=block.filename;} actions.append(preview);
      }
      const download = node('a', '', '下载'); download.href = new URL(`api/workbench/versions/${block.versionId}/download`,base).href; download.download = block.filename; actions.append(download);
      card.append(copy,actions); section.append(card);
      if (Array.isArray(block.previousVersions) && block.previousVersions.length) {
        const history = node('details', 'output-artifact-history'); history.append(node('summary', '', '旧版本'));
        for (const version of [...block.previousVersions].reverse()) {
          if (!/^[a-f0-9-]{36}$/.test(version.versionId)) continue;
          const link = node('a', '', version.filename); link.href = new URL(`api/workbench/versions/${version.versionId}/download`, base).href; link.download = version.filename;
          const actions=node('div','document-version-actions');actions.append(link);
          if(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(version.filename)) {const preview=node('a','','预览');preview.href=new URL(`api/workbench/versions/${version.versionId}/preview`,base).href;preview.dataset.documentPreview='';preview.dataset.versionId=version.versionId;preview.dataset.filename=version.filename;actions.append(preview);}
          history.append(actions);
        }
        section.append(history);
      }
    }
    if (['interactive', 'animation'].includes(block.type)) {
      if (window.ZigentInteractiveOutput && view.interactiveUrl) {
        const preview = window.ZigentInteractiveOutput.create(block, view.interactiveUrl(index), { resize: update => view.resize ? view.resize(update) : update() });
        view.previews.push(preview); section.append(preview.node);
      } else section.append(node('p', 'interactive-summary', block.summary));
    }
    if (block.type === 'document') {
      const button = node('button', 'document-file-card'); button.type = 'button';
      heading.hidden = true;
      const copy = node('span', 'document-file-copy'); copy.append(node('strong', '', block.title || block.filename));
      button.setAttribute('aria-label', `打开文档：${block.title || block.filename}`); button.append(copy);
      button.onclick = () => { view.closeForAction(); view.openDocument?.(index, button); }; section.append(button);
    }
    if (block.type === 'metrics') {
      const group = node('dl', 'output-metrics');
      for (const item of block.items) { const metric = node('div'); metric.append(node('dt', '', item.label), node('dd', 'output-metric-value', item.value)); if (item.change) metric.append(node('dd', 'output-metric-change', item.change)); group.append(metric); }
      section.append(group);
    }
    if (block.type === 'chart') section.append(chart(block));
    if (block.type === 'table') {
      section.append(table(block.columns, block.rows, block.title || '数据表'));
      if (!block.rows.length) section.append(node('p', 'output-empty', '暂无数据。'));
    }
    if (block.type === 'steps') {
      const list = node('ol', 'output-steps');
      block.items.forEach((item, i) => { const entry = node('li', `output-step ${item.status}`), mark = node('span', 'output-step-mark', item.status === 'completed' ? '✓' : i + 1), content = node('div'); mark.setAttribute('aria-hidden', 'true'); content.append(node('strong', '', item.title), node('span', 'output-step-state', stepLabels[item.status])); if (item.description) content.append(node('p', '', item.description)); entry.append(mark, content); list.append(entry); });
      section.append(list);
    }
    if (block.type === 'resources') {
      const list = node('ul', 'output-resources');
      for (const item of block.items) {
        const entry = node('li'), link = node('a', 'output-resource-link'), title = node('strong', '', item.title), url = safeUrl(item.url);
        if (!url) continue;
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
        link.append(title, node('span', 'output-resource-meta', `${item.format ? `${item.format} · ` : ''}${new URL(url).hostname} ↗`));
        if (item.description) link.append(node('p', '', item.description)); entry.append(link); list.append(entry);
      }
      section.append(list);
    }
    return section;
  }
  function createView() {
    const view = { previews: [], node: node('section', 'output-card'), opener: node('button', 'output-card-open'), title: node('strong', 'output-card-title'), meta: node('span', 'output-card-meta'), preview: node('span', 'output-card-preview'),
      surface: node('div', 'output-surface'), inline: node('div', 'output-inline'), dialog: node('dialog', 'output-sheet'), heading: node('h2'), description: node('p', 'output-description'), content: node('div', 'output-sheet-content') };
    view.opener.type = 'button';
    const text = node('span', 'output-card-copy'); text.append(view.title, view.meta, view.preview); view.opener.append(text);
    const header = node('header', 'output-inline-header'), actions = node('div', 'output-header-actions'), expand = node('button', 'output-expand'), close = node('button', 'output-close', '×');
    const expandIcon = svgNode('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' });
    expandIcon.append(svgNode('path', { d: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5' })); expand.append(expandIcon); expand.title = '放大';
    expand.type = close.type = 'button'; close.setAttribute('aria-label', '关闭成果'); close.hidden = true;
    actions.append(expand, close); header.append(view.heading, actions);
    view.expand = expand; view.close = close;
    view.surface.append(header, view.description, view.content); view.inline.append(view.surface); view.node.append(view.opener, view.inline);
    const stop = () => view.previews.forEach(preview => preview.unmount());
    view.mount = () => { view.mounted = true; if (view.node.isConnected && !view.surface.hidden) view.previews.forEach(preview => preview.mount()); };
    // Only live iframes need a connected dialog between inline and enlarged modes.
    // Files and static results stay ordinary document content until explicitly enlarged.
    view.placeInline = () => {
      const host = view.persistentDialog ? view.dialog : view.inline;
      if (view.surface.parentNode !== host) host.append(view.surface);
      if (view.persistentDialog) {
        if (view.dialog.parentNode !== view.node) view.node.append(view.dialog);
        view.dialog.open = true; view.dialog.setAttribute('role', 'none');
      } else { view.dialog.open = false; view.dialog.remove(); }
    };
    view.collapse = () => {
      if (!view.expanded) return;
      view.expanded = false; view.dialog.close();
      view.dialog.classList.remove('output-sheet-expanded'); view.dialog.removeAttribute('aria-label');
      view.placeInline(); view.node.style.minHeight = ''; expand.hidden = Boolean(view.filesOnly); close.hidden = true;
      if (view.mounted && view.node.isConnected && view.restoreFocus) expand.focus({ preventScroll: true });
    };
    expand.onclick = () => {
      if (!view.output || view.expanded) return;
      const update = () => {
        view.node.style.minHeight = `${view.surface.getBoundingClientRect?.().height || 0}px`; view.restoreFocus = true;
        if (!view.persistentDialog) { view.dialog.append(view.surface); view.node.append(view.dialog); }
        view.expanded = true; expand.hidden = true; close.hidden = false; view.dialog.className += ' output-sheet-expanded'; view.dialog.setAttribute('role', 'dialog'); view.dialog.setAttribute('aria-label', view.output.title);
        view.dialog.open = false; view.dialog.showModal(); close.focus();
      };
      if (view.resize) view.resize(update); else update();
    };
    view.opener.onclick = () => view.openDocument?.(0, view.opener);
    view.closeForAction = () => { view.restoreFocus = false; if (view.expanded) view.dialog.close(); };
    close.onclick = () => view.dialog.close();
    view.dialog.addEventListener('cancel', event => { event.preventDefault(); view.dialog.close(); });
    view.dialog.addEventListener('close', () => {
      // A queued close event may belong to an earlier expansion of this view.
      if (!view.expanded || view.dialog.open) return;
      if (view.resize) view.resize(view.collapse); else view.collapse();
    });
    view.dispose = () => { view.mounted = false; stop(); view.collapse(); };
    view.dialog.addEventListener('click', event => { if (!view.expanded || event.target !== view.dialog) return; const rect = view.dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) view.dialog.close(); });
    return view;
  }
  function render(output, previousView, options = {}) {
    const view = previousView || createView(); view.openDocument = options.openDocument; view.interactiveUrl = options.interactiveUrl; view.resize = options.resize;
    if (!valid(output)) {
      view.dispose(); view.previews = []; view.content.replaceChildren(); view.surface.hidden = view.dialog.hidden = true; view.opener.hidden = false; view.output = undefined; view.key = undefined;
      view.opener.disabled = true; view.title.textContent = '此成果暂时无法显示'; view.meta.textContent = '请让 Agent 重新整理'; view.preview.hidden = true; return view;
    }
    const key = JSON.stringify(output); if (key === view.key) return view;
    view.key = key; view.output = output; view.opener.disabled = false; view.title.textContent = output.title;
    view.singleBlock = output.blocks.length === 1; view.interactiveOnly = view.singleBlock && ['interactive', 'animation'].includes(output.blocks[0].type);
    const documentOnly = view.singleBlock && output.blocks[0].type === 'document';
    const filesOnly = output.blocks.every(block => block.type === 'artifact');
    const persistentDialog = output.blocks.some(block => ['interactive', 'animation'].includes(block.type));
    if (view.expanded && (documentOnly || filesOnly || persistentDialog !== view.persistentDialog)) view.collapse();
    view.persistentDialog = persistentDialog; view.filesOnly = filesOnly;
    if (!view.expanded) view.placeInline();
    view.node.className = `output-card${documentOnly ? '' : ' output-card-inline'}`; view.opener.hidden = !documentOnly; view.surface.hidden = view.dialog.hidden = documentOnly;
    view.dialog.className = `output-sheet output-sheet-inline${view.interactiveOnly ? ' output-sheet-interactive' : ''}${view.expanded ? ' output-sheet-expanded' : ''}`;
    view.opener.setAttribute('aria-haspopup', 'false'); view.opener.setAttribute('aria-label', `打开文档：${output.title}`); if (view.expanded) view.dialog.setAttribute('aria-label', output.title); else view.dialog.removeAttribute('aria-label');
    view.expand.setAttribute('aria-label', `放大查看：${output.title}`); view.surface.setAttribute('role', 'region'); view.surface.setAttribute('aria-label', output.title);
    view.meta.textContent = documentOnly ? `${output.blocks[0].filename} · 可编辑` : ''; view.preview.hidden = true;
    view.heading.parentElement.hidden = filesOnly; view.expand.hidden = filesOnly;
    view.node.classList.toggle('output-card-files', filesOnly);
    view.heading.textContent = output.title; view.description.textContent = output.description || ''; view.description.hidden = true;
    const top = view.content.scrollTop; view.previews.forEach(preview => preview.unmount()); view.previews = [];
    view.content.replaceChildren(...(documentOnly ? [] : output.blocks.map((block, index) => renderBlock(block, output.id, index, view)))); view.content.scrollTop = top;
    if (view.mounted) view.mount();
    return view;
  }
  window.ZigentOutputComponents = Object.freeze({ render });
})();
