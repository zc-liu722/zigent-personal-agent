(() => {
  'use strict';
  const ns = 'http://www.w3.org/2000/svg';
  const display = text => String(text || '').replace(/（北京时间）|(?: · )?北京时间/g, '');
  let serial = 0;
  const svgNode = (tag, attributes = {}, text) => {
    const item = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
    if (text !== undefined) item.textContent = display(text);
    return item;
  };
  function wrap(text, limit) {
    const lines = []; let line = '', size = 0;
    const tokens = display(text).match(/[A-Za-z0-9_:./+-]+|[^\x00-\xff]|\s+|./gu) || [];
    const push = token => {
      const width = [...token].reduce((sum, char) => sum + (/[\x00-\xff]/.test(char) ? .55 : 1), 0);
      if (token.includes('\n') || size + width > limit) { if (line.trim()) lines.push(line.trim()); line = ''; size = 0; }
      if (!token.includes('\n')) { line += token; size += width; }
    };
    for (const token of tokens) {
      if (token.length * .55 > limit) for (const char of token) push(char);
      else push(token);
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }
  function layout(value) {
    if (value.operator) {
      const children = value.conditions.map(layout), gap = 20;
      return { value, children, width: Math.max(224, children.reduce((sum, child) => sum + child.width, 0) + gap * (children.length - 1)),
        height: Math.max(...children.map(child => child.height)) + 132 };
    }
    const title = wrap(value.label, value.kind === 'condition' ? 9 : 14), detail = wrap(value.detail, value.kind === 'condition' ? 11 : 18);
    const content = title.length * 19 + detail.length * 16 + (detail.length ? 6 : 0);
    const height = value.kind === 'condition' ? Math.max(104, content * 2 + 12) : Math.max(52, content + 26);
    const cancellations = (value.cancelOn || []).map(layout);
    return { value, title, detail, width: cancellations.length ? 476 : 224, nodeHeight: height, cancellations,
      height: Math.max(height, cancellations.reduce((sum, item) => sum + item.height + 20, -20)) };
  }
  function description(value) {
    return [display(value.label), display(value.detail), value.conditions?.length ? `（${value.conditions.map(description).join('；')}）` : '', ...(value.cancelOn || []).map(item => `取消等待：${description(item)}`)].filter(Boolean).join('，');
  }
  function render(diagram) {
    const region = document.createElement('div'); region.className = 'trigger-diagram';
    region.tabIndex = 0; region.setAttribute('role', 'region'); region.setAttribute('aria-label', '触发逻辑图');
    if (!diagram?.steps?.length) { region.textContent = '暂时无法加载触发逻辑'; return region; }
    const steps = diagram.steps.map(layout), width = Math.max(...steps.map(step => step.width)) + 24;
    const height = steps.reduce((sum, step) => sum + step.height, 0) + (steps.length - 1) * 46 + 24;
    region.style.setProperty('--diagram-width', `${width}px`); region.style.setProperty('--diagram-height', `${height}px`);
    const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-labelledby': `trigger-title-${++serial}` });
    svg.append(svgNode('title', { id: `trigger-title-${serial}` }, diagram.steps.map(description).join(' → ') + '。条件不满足或未知时不触发。'));
    const markerId = `trigger-arrow-${serial}`, defs = svgNode('defs'), marker = svgNode('marker', { id: markerId, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.append(svgNode('path', { d: 'M1 1 9 5 1 9', fill: 'none', class: 'trigger-arrow', 'stroke-width': 1.5 })); defs.append(marker); svg.append(defs);
    const edges = svgNode('g', { class: 'trigger-edges', fill: 'none' }), shapes = svgNode('g'); svg.append(edges, shapes);
    const edge = (d, label, x, y, cancel = false) => {
      edges.append(svgNode('path', { d, class: cancel ? 'trigger-edge cancel' : 'trigger-edge', 'marker-end': `url(#${markerId})` }));
      if (label) shapes.append(svgNode('text', { x, y, class: 'trigger-edge-label', 'text-anchor': 'middle' }, label));
    };
    function draw(item, x, y) {
      const cx = x + item.width / 2, value = item.value;
      if (item.children) {
        let offset = x; const bottom = y + item.height - 92;
        for (const child of item.children) {
          const childX = offset + child.width / 2;
          edge(`M${cx} ${y}V${y + 12}H${childX}V${y + 30}`);
          const output = draw(child, offset, y + 30);
          edge(`M${output.x} ${output.y}V${bottom}H${cx}V${bottom + 10}`);
          offset += child.width + 20;
        }
        const gate = svgNode('g', { class: `trigger-node operator ${value.operator}`, 'data-kind': value.operator });
        gate.append(svgNode('circle', { cx, cy: bottom + 38, r: 28 }), svgNode('text', { x: cx, y: bottom + 43, 'text-anchor': 'middle', class: 'trigger-operator-symbol' }, { all: 'AND', any: 'OR', not: 'NOT' }[value.operator]),
          svgNode('text', { x: cx + 40, y: bottom + 43, class: 'trigger-node-label' }, value.label));
        shapes.append(gate); edge(`M${cx} ${bottom + 66}V${y + item.height}`); return { x: cx, y: y + item.height };
      }
      const nodeX = item.cancellations.length ? x + 112 : cx, h = item.nodeHeight, centerY = y + h / 2;
      const group = svgNode('g', { class: `trigger-node ${value.kind}`, 'data-kind': value.kind });
      if (value.kind === 'condition') group.append(svgNode('polygon', { points: `${nodeX},${y} ${nodeX + 104},${centerY} ${nodeX},${y + h} ${nodeX - 104},${centerY}` }));
      else if (value.kind === 'delay') group.append(svgNode('path', { d: `M${nodeX - 94} ${y}H${nodeX + 72}Q${nodeX + 108} ${centerY} ${nodeX + 72} ${y + h}H${nodeX - 94}Z` }));
      else group.append(svgNode('rect', { x: nodeX - 104, y, width: 208, height: h, rx: value.kind === 'event' || value.kind === 'stop' ? Math.min(28, h / 2) : 5 }));
      const total = item.title.length * 19 + item.detail.length * 16 + (item.detail.length ? 6 : 0);
      let textY = centerY - total / 2 + 14;
      for (const line of item.title) { group.append(svgNode('text', { x: nodeX, y: textY, 'text-anchor': 'middle', class: 'trigger-node-label' }, line)); textY += 19; }
      textY += 4;
      for (const line of item.detail) { group.append(svgNode('text', { x: nodeX, y: textY, 'text-anchor': 'middle', class: 'trigger-node-detail' }, line)); textY += 16; }
      shapes.append(group);
      let cancelY = y;
      for (const cancel of item.cancellations) {
        const cancelX = x + 252; draw(cancel, cancelX, cancelY);
        edge(`M${cancelX + 8} ${cancelY + cancel.nodeHeight / 2}H${x + 232}V${centerY}H${nodeX + 102}`, '取消', x + 236, centerY - 8, true);
        cancelY += cancel.height + 20;
      }
      if (item.height > h) edge(`M${nodeX} ${y + h}V${y + item.height}`);
      return { x: nodeX, y: y + item.height };
    }
    let y = 12, prior;
    steps.forEach((step, index) => {
      const x = 12 + (width - 24 - step.width) / 2;
      const inputX = step.cancellations?.length ? x + 112 : x + step.width / 2;
      if (prior) {
        const previous = steps[index - 1].value;
        const label = previous.kind === 'condition' ? '满足' : previous.kind === 'delay' ? '到时' : '';
        edge(`M${prior.x} ${prior.y}V${y - 23}H${inputX}V${y}`, label, inputX - 24, y - 18);
        if (previous.kind === 'condition') {
          edge(`M${prior.x} ${prior.y}V${prior.y + 27}H${prior.x + 58}`, '否／未知', prior.x + 76, prior.y + 10);
          const stop = svgNode('g', { class: 'trigger-node stop', 'data-kind': 'stop' });
          stop.append(svgNode('rect', { x: prior.x + 58, y: prior.y + 17, width: 56, height: 20, rx: 10 }), svgNode('text', { x: prior.x + 86, y: prior.y + 31, 'text-anchor': 'middle', class: 'trigger-stop-label' }, '不触发'));
          shapes.append(stop);
        }
      }
      prior = draw(step, x, y); y += step.height + 46;
    });
    region.append(svg); return region;
  }
  window.ZigentTriggerDiagram = { render };
})();
