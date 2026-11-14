import { mermaidRoleStyles, mermaidTheme } from './plugins/palette/mermaid.js';

// This script runs only in an opaque-origin iframe. Diagram text never enters
// the conversation DOM, and the frame has no network or account capabilities.
const diagram = document.getElementById('diagram');
const engine = import('mermaid').then(module => module.default);
const send = data => parent.postMessage({ type: 'zigent:mermaid', ...data }, '*');
const origin = new URL(location.href).origin;
let busy = false;
addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== origin || event.data?.type !== 'zigent:mermaid:render' || busy) return;
  const { source, theme, palette, id } = event.data;
  if (typeof source !== 'string' || source.length > 50000 || !Number.isSafeInteger(id)) return;
  busy = true;
  try {
    const mermaid = await engine;
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.palette = typeof palette === 'string' ? palette : 'brown';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict',
      theme: 'base', darkMode: dark, themeVariables: mermaidTheme(dark), themeCSS: mermaidRoleStyles(), fontFamily: 'system-ui, sans-serif',
      secure: [...mermaid.mermaidAPI.defaultConfig.secure, 'theme', 'themeVariables', 'themeCSS'],
      suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500 });
    const { svg } = await mermaid.render(`mermaid-${id}`, source);
    diagram.innerHTML = svg;
    const node = diagram.querySelector('svg');
    let { x, y, width, height } = node.viewBox.baseVal;
    if (!(width > 0 && height > 0)) {
      ({ x, y, width, height } = node.getBBox());
      if (!(width > 0 && height > 0)) throw new Error('Missing diagram bounds');
      node.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    }
    node.setAttribute('width', width);
    node.setAttribute('height', height);
    node.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    node.style.color = getComputedStyle(diagram).color;
    node.style.colorScheme = dark ? 'dark' : 'light';
    const image = new XMLSerializer().serializeToString(node);
    const title = node.querySelector('title')?.textContent?.slice(0, 500);
    const description = node.querySelector('desc')?.textContent?.slice(0, 1000);
    send({ state: 'rendered', id, width, height, image, title, description });
  } catch {
    send({ state: 'error', id });
  } finally {
    diagram.replaceChildren();
    busy = false;
  }
});
engine.then(() => send({ state: 'ready' }), () => send({ state: 'error' }));
