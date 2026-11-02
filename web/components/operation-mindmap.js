import { el } from '../dom.js';

const NS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};
const plain = value => String(value || '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '');
function wrap(value, width) {
  const lines = []; let current = '', units = 0;
  for (const character of plain(value)) {
    const size = /[\u0000-\u00ff]/.test(character) ? .56 : 1;
    if (character === '\n' || units + size > width) { lines.push(current); current = ''; units = 0; }
    if (character !== '\n') { current += character; units += size; }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}
function layout(state) {
  let count = 0;
  const make = (source, depth, branch) => {
    if (!source || typeof source.label !== 'string' || depth > 40 || ++count > 500) throw new Error('Invalid map');
    const lines = wrap(source.label, depth === 0 ? 12 : 10), width = depth === 0 ? 184 : 150;
    const node = { label: source.label, lines, width, height: Math.max(depth === 0 ? 60 : 44, lines.length * 19 + 24), depth, branch };
    node.children = (Array.isArray(source.children) ? source.children : []).map(child => make(child, depth + 1, branch));
    node.span = Math.max(node.height + 20, node.children.reduce((sum, child) => sum + child.span, 0));
    return node;
  };
  const root = make({ label: state.title || '思维导图' }, 0, 0);
  const branches = (Array.isArray(state.roots) ? state.roots : []).map((node, index) => make(node, 1, index % 5));
  const sides = [[], []], heights = [0, 0];
  for (const branch of branches) { const side = heights[0] <= heights[1] ? 0 : 1; sides[side].push(branch); heights[side] += branch.span; }
  const height = Math.max(root.height + 70, ...heights) + 48, nodes = [root], paths = [];
  root.x = 0; root.y = height / 2;
  const position = (node, parent, direction, centerY) => {
    node.x = direction * (122 + (node.depth - 1) * 194 + node.width / 2); node.y = centerY;
    nodes.push(node);
    const start = parent.x + direction * parent.width / 2, end = node.x - direction * node.width / 2;
    paths.push({ d: `M${start},${parent.y} C${start + direction * 28},${parent.y} ${end - direction * 28},${node.y} ${end},${node.y}`, branch: node.branch });
    let top = node.y - node.children.reduce((sum, child) => sum + child.span, 0) / 2;
    for (const child of node.children) { position(child, node, direction, top + child.span / 2); top += child.span; }
  };
  sides.forEach((side, index) => { let top = (height - heights[index]) / 2;
    for (const node of side) { position(node, root, index === 0 ? 1 : -1, top + node.span / 2); top += node.span; }
  });
  const left = Math.min(...nodes.map(node => node.x - node.width / 2)) - 24;
  const right = Math.max(...nodes.map(node => node.x + node.width / 2)) + 24;
  return { root, nodes, paths, left, width: right - left, height };
}
function outline(state) {
  const list = el('ul', 'mindmap-outline-list');
  const append = (parent, nodes) => nodes.forEach(node => {
    const item = el('li', '', plain(node.label)); parent.append(item);
    if (node.children?.length) { const children = el('ul'); item.append(children); append(children, node.children); }
  });
  append(list, state.roots || []); return list;
}
function draw(state) {
  const geometry = layout(state), svg = svgNode('svg', { viewBox: `${geometry.left} 0 ${geometry.width} ${geometry.height}`, role: 'img', 'aria-label': `${state.title}，${geometry.nodes.length - 1} 个分支节点` });
  const title = svgNode('title'); title.textContent = state.title; svg.append(title);
  for (const path of geometry.paths) svg.append(svgNode('path', { d: path.d, class: `mindmap-edge mindmap-color-${path.branch}`, fill: 'none' }));
  for (const node of geometry.nodes) {
    const group = svgNode('g', { class: `mindmap-topic ${node.depth === 0 ? 'mindmap-root' : `mindmap-color-${node.branch}`}`, transform: `translate(${node.x - node.width / 2} ${node.y - node.height / 2})` });
    const title = svgNode('title'); title.textContent = plain(node.label);
    group.append(title, svgNode('rect', { width: node.width, height: node.height, rx: node.depth === 0 ? 15 : 10 }));
    const text = svgNode('text', { x: node.width / 2, y: (node.height - node.lines.length * 19) / 2 + 14, 'text-anchor': 'middle' });
    node.lines.forEach((line, index) => { const span = svgNode('tspan', { x: node.width / 2, dy: index ? 19 : 0 }); span.textContent = line; text.append(span); });
    group.append(text); svg.append(group);
  }
  return { svg, geometry };
}

function renderMindmapCanvas(presentation) {
  if (presentation?.kind !== 'mindmap') return undefined;
  const state = presentation.after || presentation.before;
  if (!state || typeof state.title !== 'string') return undefined;
  let current;
  try { current = draw(state); } catch { return undefined; }
  const node = el('section', 'mindmap-preview'), toolbar = el('div', 'mindmap-toolbar'), heading = el('span', 'mindmap-caption'),
    controls = el('div', 'mindmap-controls'), viewport = el('div', 'mindmap-viewport'), canvas = el('div', 'mindmap-canvas');
  const minus = el('button', '', '−'), plus = el('button', '', '+'), fit = el('button', 'mindmap-fit', '适应'), percent = el('span', 'mindmap-percent');
  for (const [button, label] of [[minus, '缩小导图'], [plus, '放大导图'], [fit, '适应导图大小']]) { button.type = 'button'; button.setAttribute('aria-label', label); }
  percent.setAttribute('aria-live', 'polite');
  const review = el('details', 'mindmap-outline'), summary = el('summary', '', '查看大纲'), body = el('div', 'mindmap-outline-body');
  review.append(summary, body);
  controls.append(minus, percent, plus, fit); toolbar.append(heading, controls); canvas.append(current.svg); viewport.append(canvas); node.append(viewport);
  viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', '思维导图，可滚动和缩放');
  let scale = 1, sizing = 'initial', needsCenter = true, selected = 'after';
  const apply = () => {
    canvas.style.width = `${current.geometry.width * scale}px`; canvas.style.height = `${current.geometry.height * scale}px`;
    // Inline dimensions override the application's shared 24px icon rule.
    current.svg.style.width = `${current.geometry.width * scale}px`; current.svg.style.height = `${current.geometry.height * scale}px`;
    percent.textContent = `${Math.round(scale * 100)}%`; minus.disabled = scale <= .25; plus.disabled = scale >= 1.8;
  };
  const resize = () => {
    if (!viewport.clientWidth) return;
    if (sizing !== 'user') {
      // Start with readable labels; fitting the whole sheet is an explicit choice.
      scale = Math.max(sizing === 'fit' ? .25 : .75, Math.min(1, (viewport.clientWidth - 8) / current.geometry.width));
      apply();
    }
    if (needsCenter) {
      const inset = Math.max(0, (viewport.clientWidth - current.geometry.width * scale) / 2);
      viewport.scrollLeft = (current.geometry.root.x - current.geometry.left) * scale + inset - viewport.clientWidth / 2;
      viewport.scrollTop = current.geometry.root.y * scale - viewport.clientHeight / 2;
      needsCenter = false;
    }
  };
  const zoom = factor => {
    sizing = 'user'; needsCenter = false; const previous = scale;
    scale = Math.max(.25, Math.min(1.8, Math.round(scale * factor * 100) / 100)); apply();
    viewport.scrollLeft = (viewport.scrollLeft + viewport.clientWidth / 2) * scale / previous - viewport.clientWidth / 2;
    viewport.scrollTop = (viewport.scrollTop + viewport.clientHeight / 2) * scale / previous - viewport.clientHeight / 2;
  };
  minus.onclick = () => zoom(1 / 1.25); plus.onclick = () => zoom(1.25);
  fit.onclick = () => { sizing = 'fit'; needsCenter = false; resize(); viewport.scrollLeft = 0; viewport.scrollTop = 0; };
  const show = (value, side) => {
    let next; try { next = draw(value); } catch { return; }
    selected = side; current = next; canvas.replaceChildren(current.svg);
    heading.textContent = value.scope === 'fragment' ? '本次分支' : side === 'before' ? '原导图' : '导图预览';
    body.replaceChildren(el('strong', '', plain(value.title)), outline(value));
    sizing = 'initial'; needsCenter = true; resize(); apply();
    for (const button of toolbar.querySelectorAll('[data-map-side]')) button.setAttribute('aria-pressed', String(button.dataset.mapSide === selected));
  };
  if (presentation.before && presentation.after) {
    const tabs = el('div', 'mindmap-tabs');
    for (const [side, label] of [['before', '原图'], ['after', presentation.after.scope === 'fragment' ? '本次分支' : '修改后']]) {
      const button = el('button', '', label); button.type = 'button'; button.dataset.mapSide = side;
      button.onclick = () => show(presentation[side], side); tabs.append(button);
    }
    toolbar.replaceChild(tabs, heading); tabs.prepend(heading); heading.classList.add('mindmap-sr-only');
  }
  show(state, presentation.after ? 'after' : 'before');
  viewport.style.touchAction = 'none';
  const touches = new Map();
  let last;
  const measure = () => {
    const p = [...touches.values()];
    return !p.length ? null : p.length === 1 ? { ...p[0], d: 0 } : { x:(p[0].x+p[1].x)/2, y:(p[0].y+p[1].y)/2, d:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y) };
  };
  viewport.onpointerdown = e => {
    touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
    viewport.setPointerCapture(e.pointerId); last=measure();
  };
  viewport.onpointermove = e => {
    if (!touches.has(e.pointerId)) return;
    e.preventDefault();
    touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
    const next=measure(), rect=viewport.getBoundingClientRect(), old=scale;
    sizing='user'; needsCenter=false;
    if(last.d && next.d) scale=Math.max(.25,Math.min(3,scale*next.d/last.d));
    const left=viewport.scrollLeft, top=viewport.scrollTop;
    apply();
    viewport.scrollLeft=(left+last.x-rect.left)*scale/old-(next.x-rect.left);
    viewport.scrollTop=(top+last.y-rect.top)*scale/old-(next.y-rect.top);
    last=next;
  };
  const release=e=>{touches.delete(e.pointerId);last=measure();};
  viewport.onpointerup=release; viewport.onpointercancel=release; viewport.onlostpointercapture=release;
  // The observer only belongs to this element and is disconnected once its card is removed.
  let resizeFrame = 0, lastWidth = -1, lastHeight = -1;
  const observer = new ResizeObserver(() => {
    if (!node.isConnected && node.dataset.connected) {
      observer.disconnect(); cancelAnimationFrame(resizeFrame); return;
    }
    if (node.isConnected) node.dataset.connected = 'true';
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (!node.isConnected) return;
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (width === lastWidth && height === lastHeight) return;
      lastWidth = width; lastHeight = height;
      resize();
    });
  });
  observer.observe(viewport);
  return node;
}

export function renderMindmapPreview(presentation) {
  const preview = renderMindmapCanvas(presentation);
  if (!preview) return undefined;
  const card = el('section', 'mindmap-summary');
  card.append(preview);
  return card;
}

/** Recover only explicit structure from older saved confirmation cards. */
export function inferLegacyMindmap(change) {
  if (typeof change?.after !== 'string' || !/xmind|思维导图|脑图|导图/i.test(change.title || '')) return undefined;
  const content = change.after, markdown = content.match(/(?:^|\n)\s*markdown[：:]\s*([\s\S]+)$/i)?.[1];
  if (!markdown) return undefined;
  const heading = markdown.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
  if (!heading) return undefined;
  const roots = [], stack = [], headings = [];
  for (const line of markdown.split('\n')) {
    const headingLine = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingLine) {
      const level = headingLine[1].length;
      while (headings.length && headings.at(-1).level >= level) headings.pop();
      stack.length = 0;
      if (!roots.length && headingLine[2].trim() === heading && !headings.length) headings.push({ level, node: { children: roots } });
      else {
        const node = { label: headingLine[2].trim() };
        if (headings.length) (headings.at(-1).node.children ||= []).push(node); else roots.push(node);
        headings.push({ level, node });
      }
      continue;
    }
    const match = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '    ').length, node = { label: match[2] };
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1)?.node || headings.at(-1)?.node;
    if (parent) (parent.children ||= []).push(node); else roots.push(node);
    stack.push({ indent, node });
  }
  return roots.length ? { kind: 'mindmap', action: 'xmind_edit_mindmap', after: { title: heading, roots, scope: 'fragment' } } : undefined;
}