import { conversationOutputSchema, type OutputBlock } from "../channels/output.js";
import type { WebStore } from "./store.js";
import { animationRuntime } from "./animation-output.js";
import { interactiveThemeRuntime } from "./interactive-theme.js";

type InteractiveBlock = Extract<OutputBlock, { type: "interactive" | "animation" }>;

/** Resolve only a validated artifact already delivered to this conversation. No paths or supplied HTML. */
export function findInteractiveOutput(store: WebStore, conversationId: string, messageId: string, interactionId: string, index: number): InteractiveBlock | undefined {
  const message = store.message(messageId);
  if (message?.conversationId !== conversationId || !store.conversationInfo(conversationId)) return;
  const interaction = message.interactions?.find(item => item.id === interactionId && item.kind === "output");
  const parsed = conversationOutputSchema.safeParse(interaction?.output);
  const block = parsed.success ? parsed.data.blocks[index] : undefined;
  return block?.type === "interactive" || block?.type === "animation" ? block : undefined;
}

/** A response-level policy cannot be weakened by generated markup. Sandbox also applies to direct visits. */
export function interactiveOutputPolicy(origin: string): string {
  return `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
}

export function interactiveOutputPage(block: InteractiveBlock, origin: string, theme: "light" | "dark", tokens: string): string {
  const parentOrigin = JSON.stringify(origin).replace(/</g, "\\u003c");
  // This bridge reports size, readiness, bounded controls and animation playback state.
  // It cannot call tools, submit messages, navigate the host or write server state.
  const runtime = `(() => {
    const origin = ${parentOrigin};
    const send = (kind, extra = {}) => parent.postMessage({type:'zigent:interactive', kind, ...extra}, origin);
    ${interactiveThemeRuntime()}
    ${block.type === "animation" ? animationRuntime(block.duration) : ""}
    const controls = () => [...document.querySelectorAll('input[id],select[id],textarea[id]')]
      .filter(el => !['password','file','hidden'].includes(el.type) && el.id.length <= 80).slice(0,32);
    const snapshot = () => controls().map(el => ({id:el.id, value:String(el.value).slice(0,500), checked:!!el.checked}));
    const size = () => send('size', {height:Math.min(960, Math.max(240, document.body?.scrollHeight || 400))});
    addEventListener('error', () => send('error'));
    addEventListener('unhandledrejection', () => send('error'));
    document.addEventListener('click', event => { if (event.target.closest?.('a,area')) event.preventDefault(); }, true);
    document.addEventListener('submit', event => event.preventDefault(), true);
    let restoring = false;
    for (const type of ['input','change']) document.addEventListener(type, () => { if (!restoring) send('state', {controls:snapshot()}); });
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== origin) return;
      if (event.data?.type === 'zigent:theme' && ['light','dark'].includes(event.data.theme)) {
        document.documentElement.dataset.theme = event.data.theme;
        document.documentElement.style.colorScheme = event.data.theme;
        return;
      }
      if (event.data?.type !== 'zigent:restore' || !Array.isArray(event.data.controls)) return;
      restoring = true;
      for (const saved of event.data.controls.slice(0,32)) {
        const el = controls().find(el => el.id === saved?.id);
        if (!el || typeof saved.value !== 'string' || saved.value.length > 500 || typeof saved.checked !== 'boolean') continue;
        el.value = saved.value; if (el.type === 'checkbox' || el.type === 'radio') el.checked = saved.checked;
        el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true}));
      }
      restoring = false; send('state', {controls:snapshot()}); size();
    });
    addEventListener('DOMContentLoaded', () => { send('ready'); size(); new ResizeObserver(size).observe(document.body); });
  })();`;
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" style="color-scheme:${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>交互预览</title><style id="zigent-preview-base">
    ${tokens}
    :root{font:400 var(--ui-body)/1.6 var(--ui-font);color-scheme:${theme};color:var(--ui-text);background:var(--ui-bg);--accent:var(--ui-accent);-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}body{margin:0;padding:0;overflow-wrap:anywhere}h1,h2,h3,p,figure{margin:0}h1,h2,h3{font-size:var(--ui-heading);font-weight:500}svg,canvas,img{max-width:100%}input,select,textarea,button{font:inherit;color:inherit;max-width:100%}input,select,button{min-height:var(--ui-control-height)}input[type=range]{accent-color:var(--ui-accent);width:100%}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--ui-accent);outline-offset:3px}
    svg{fill:currentColor}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  </style><script>${runtime}</script></head><body>${block.html}</body></html>`;
}
