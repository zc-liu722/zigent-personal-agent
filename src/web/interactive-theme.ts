/** Theme compatibility runs only inside the generated document's opaque sandbox. */
export function interactiveThemeRuntime(): string {
  return `(() => {
    const root = document.documentElement;
    const token = name => getComputedStyle(root).getPropertyValue(name).trim();
    let paletteTheme, palette;
    const isPalette = channels => {
      if (paletteTheme !== root.dataset.theme || !palette) {
        paletteTheme = root.dataset.theme;
        palette = new Set(['--ui-bg', '--ui-surface', '--ui-text', '--ui-muted', '--ui-line', '--ui-accent', '--ui-track'].map(name => {
          let hex = token(name).replace(/^#/, '');
          if (hex.length === 3) hex = [...hex].map(part => part + part).join('');
          return /^[0-9a-f]{6}$/i.test(hex) ? [0, 2, 4].map(start => parseInt(hex.slice(start, start + 2), 16)).join(',') : '';
        }));
      }
      return palette.has(channels.map(Math.round).join(','));
    };
    // Old fragments use fixed neutral paints or pass unresolved CSS colors to Canvas.
    // Adapt only neutral colors; categorical hues, images and transparent paints stay intact.
    const neutral = (value, role = 'paint') => {
      if (typeof value !== 'string') return;
      const color = value.trim().toLowerCase();
      let channels, alpha = 1;
      if (color === 'black') channels = [0, 0, 0];
      else if (color === 'white') channels = [255, 255, 255];
      else if (/^#[0-9a-f]{3,4}$/.test(color)) {
        channels = [...color.slice(1, 4)].map(part => parseInt(part + part, 16));
        if (color.length === 5) alpha = parseInt(color[4] + color[4], 16) / 255;
      } else if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(color)) {
        channels = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16));
        if (color.length === 9) alpha = parseInt(color.slice(7), 16) / 255;
      } else {
        const rgb = color.match(/^rgba?\\(([^)]+)\\)$/);
        if (!rgb) return;
        const parts = rgb[1].split(/[\\s,/]+/).filter(Boolean);
        if (parts.length < 3 || parts.length > 4) return;
        channels = parts.slice(0, 3).map(part => parseFloat(part) * (part.endsWith('%') ? 2.55 : 1));
        if (parts[3]) alpha = parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1);
      }
      if (!channels.every(Number.isFinite) || !Number.isFinite(alpha) || alpha <= 0) return;
      const high = Math.max(...channels), low = Math.min(...channels);
      // A resolved theme surface/grid passed back through a Canvas setter keeps its role.
      if (high - low > 16 || isPalette(channels)) return;
      if (high > 64 && low < 240) return;
      const name = role === 'surface' ? '--ui-bg' : role === 'foreground' || high <= 64 ? '--ui-text' : '--ui-bg';
      if (!name) return;
      return alpha >= 1 ? 'var(' + name + ')' : 'color-mix(in srgb, var(' + name + ') ' + (alpha * 100) + '%, transparent)';
    };
    const probe = document.createElement('span');
    probe.hidden = true;
    root.append(probe);
    const resolve = (value, role = 'paint', adapt = true) => {
      if (typeof value !== 'string') return value;
      const paint = (adapt && neutral(value, role)) || value;
      if (!/var\\(|light-dark\\(|color-mix\\(|currentcolor/i.test(paint)) return paint;
      // Resolve via a real color property, never a raw custom-property value.
      probe.style.color = '';
      probe.style.color = paint;
      return probe.style.color ? getComputedStyle(probe).color : token('--ui-text');
    };
    const context = globalThis.CanvasRenderingContext2D?.prototype;
    if (context) {
      const paints = {};
      for (const name of ['fillStyle', 'strokeStyle']) {
        const descriptor = Object.getOwnPropertyDescriptor(context, name);
        if (!descriptor?.get || !descriptor.set || !descriptor.configurable) continue;
        paints[name] = descriptor;
        Object.defineProperty(context, name, {...descriptor, set(value) { descriptor.set.call(this, resolve(value, 'paint', false)); }});
      }
      for (const name of ['fill', 'fillRect', 'fillText', 'stroke', 'strokeRect', 'strokeText']) {
        const original = context[name], paint = paints[name.startsWith('stroke') ? 'strokeStyle' : 'fillStyle'];
        if (!original || !paint) continue;
        context[name] = function(...args) {
          let role = name.endsWith('Text') || name.startsWith('stroke') ? 'foreground' : 'paint';
          if (name === 'fillRect') {
            const [x, y, width, height] = args, transform = this.getTransform();
            if (transform.b === 0 && transform.c === 0 && transform.a > 0 && transform.d > 0 &&
                x * transform.a + transform.e <= 0 && y * transform.d + transform.f <= 0 &&
                (x + width) * transform.a + transform.e >= this.canvas.width &&
                (y + height) * transform.d + transform.f >= this.canvas.height) role = 'surface';
          }
          const current = paint.get.call(this), adapted = resolve(current, role);
          if (adapted !== current) paint.set.call(this, adapted);
          try { return original.apply(this, args); }
          finally { if (adapted !== current) paint.set.call(this, current); }
        };
      }
      const gradient = globalThis.CanvasGradient?.prototype;
      if (gradient) {
        const original = gradient.addColorStop;
        gradient.addColorStop = function(offset, color) { return original.call(this, offset, resolve(color)); };
      }
    }
    const properties = ['color', 'background-color', 'fill', 'stroke', 'stop-color', 'outline-color', 'text-decoration-color',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'];
    const normalizeStyle = (style, fillRole = 'paint') => {
      for (const name of [...properties, ...Array.from(style).filter(name => name.startsWith('--'))]) {
        const role = name === 'background-color' || /^--.*(bg|background|surface)/.test(name) ? 'surface' :
          name === 'fill' || name === 'stop-color' ? fillRole : 'foreground';
        const value = style.getPropertyValue(name), adapted = neutral(value, role);
        // A fragment may redeclare a shared token locally; do not create a self-reference.
        if (adapted) style.setProperty(name, name.startsWith('--') ? adapted.replaceAll('var(' + name + ')', token(name)) : adapted, style.getPropertyPriority(name));
      }
    };
    const normalizeRules = rules => {
      for (const rule of rules) {
        if (rule.style) normalizeStyle(rule.style, /text|label|tick|title/i.test(rule.selectorText || '') ? 'foreground' : 'paint');
        if (rule.cssRules) normalizeRules(rule.cssRules);
      }
    };
    const normalize = element => {
      if (!(element instanceof Element) || element === probe) return;
      if (element.matches('style') && element.id !== 'zigent-preview-base') {
        if (element.sheet) normalizeRules(element.sheet.cssRules);
      }
      const text = element.matches('text,tspan,textPath');
      if (element.hasAttribute('style')) normalizeStyle(element.style, text ? 'foreground' : 'paint');
      if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
        for (const name of ['fill', 'stroke', 'stop-color']) {
          const value = element.getAttribute(name), adapted = neutral(value, text || name === 'stroke' ? 'foreground' : 'paint');
          if (adapted) element.setAttribute(name, adapted);
        }
      }
    };
    // Observe fragments as they are parsed, including nodes created by their scripts.
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') normalize(record.target);
        else if (record.target.nodeType === Node.TEXT_NODE) normalize(record.target.parentElement);
        else {
          normalize(record.target);
          for (const node of record.addedNodes) if (node instanceof Element) {
            normalize(node); node.querySelectorAll('style,[style],svg *').forEach(normalize);
          }
        }
      }
    }).observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['style','fill','stroke','stop-color']});
    Object.defineProperty(window, 'zigentTheme', {value:Object.freeze({color:value => resolve(value, 'paint', false)}), writable:false, configurable:false});
  })();`;
}
