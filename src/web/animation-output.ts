/** Runs inside the existing opaque-origin preview. Only the authenticated parent controls playback. */
export function animationRuntime(duration: number): string {
  return `(() => {
    const duration = ${duration};
    let render, time = 0, visible = false, initialized = false;
    let frame = 0, previous = null, lastReport = 0, broken = false;
    const report = () => { lastReport = performance.now(); send('animation', {time}); };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = null; };
    const draw = () => {
      if (!render || broken) return;
      try { render(Object.freeze({time, progress:time / duration, duration})); }
      catch { broken = true; stop(); send('error'); }
    };
    const tick = now => {
      frame = 0;
      if (!visible || document.hidden || broken) { previous = null; return; }
      if (previous !== null) time = (time + Math.max(0, now - previous) / 1000) % duration;
      previous = now;
      draw();
      if (now - lastReport >= 250) report();
      if (!broken) frame = requestAnimationFrame(tick);
      else previous = null;
    };
    const schedule = () => {
      stop();
      if (initialized && render && visible && !document.hidden && !broken) frame = requestAnimationFrame(tick);
    };
    const register = callback => {
      if (typeof callback !== 'function' || render) throw new Error('Register one animation renderer');
      render = callback; draw(); schedule();
    };
    const api = {};
    // Models sometimes assign the callback instead of invoking render(callback).
    // Keep both forms on the same single-registration path.
    Object.defineProperty(api, 'render', {get:() => register, set:register, enumerable:true});
    Object.defineProperty(window, 'zigentAnimation', {value:Object.freeze(api), writable:false, configurable:false});
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== origin || event.data?.type !== 'zigent:animation' || broken) return;
      const data = event.data;
      if (data.action === 'init' && !initialized) {
        initialized = true;
        if (Number.isFinite(data.time)) time = Math.max(0, data.time) % duration;
        visible = data.visible === true;
      } else if (!initialized) return;
      else if (data.action === 'visibility') visible = data.visible === true;
      else return;
      draw(); report(); schedule();
    });
    document.addEventListener('visibilitychange', schedule);
    addEventListener('DOMContentLoaded', () => { if (!render) { broken = true; send('error'); } });
  })();`;
}
