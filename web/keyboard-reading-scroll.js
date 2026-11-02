// Keep the native document as the scroll owner, but give a keyboard reading
// gesture one owner from its first move through deceleration. Letting WebKit
// pan first and correcting scrollTop afterwards makes the two owners fight.
export function createKeyboardReadingScroll({ scroller, range, canScroll, onMove }) {
  let gesture, frame;
  function cancel() {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined; gesture = undefined;
  }
  function scroll(delta) {
    if (!delta) return 0;
    const root = scroller(), before = root.scrollTop;
    const target = Math.max(0, Math.min(range(root), before + delta));
    // An outward drag at the boundary must perform no scroll write at all.
    // A late viewport measurement must never reverse the requested direction.
    if ((target - before) * delta <= 0 || Math.abs(target - before) < .5) return 0;
    onMove(); root.scrollTop = target;
    return root.scrollTop - before;
  }
  function start(event) {
    cancel();
    const root = scroller();
    // Nested controls retain their own native scrolling for the whole gesture.
    for (const node of event.composedPath()) {
      if (node === root) break;
      if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 1 &&
        /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) return;
    }
    const touch = event.touches[0];
    gesture = { id: touch.identifier, x: touch.screenX, y: touch.screenY,
      lastY: touch.screenY, time: event.timeStamp, velocity: 0, active: false };
  }
  function move(event) {
    if (!gesture) return false;
    if (!canScroll() || event.touches.length !== 1 || window.getSelection()?.isCollapsed === false) { cancel(); return false; }
    const touch = [...event.touches].find(value => value.identifier === gesture.id);
    if (!touch) { cancel(); return false; }
    if (!gesture.active && Math.abs(touch.screenY - gesture.y) <= Math.abs(touch.screenX - gesture.x)) {
      cancel(); return false;
    }
    // This handler is installed before touchstart and cancels the first vertical
    // move, before the browser can start its own scrolling or keyboard pan.
    if (!event.cancelable) { cancel(); return false; }
    event.preventDefault();
    const elapsed = Math.max(1, event.timeStamp - gesture.time);
    // Screen coordinates stay stable when the visual viewport or keyboard moves.
    const delta = gesture.lastY - touch.screenY, moved = scroll(delta);
    gesture.velocity = Math.abs(moved - delta) > 1 ? 0 : Math.max(-3, Math.min(3, moved / elapsed));
    gesture.active = true; gesture.lastY = touch.screenY; gesture.time = event.timeStamp;
    return true;
  }
  function end(event) {
    const active = gesture;
    cancel();
    if (!active?.active || event?.type !== 'touchend' || event.touches.length ||
      event.timeStamp - active.time > 80 || Math.abs(active.velocity) < .05) return;
    let velocity = active.velocity, previous = performance.now();
    const tick = now => {
      frame = undefined;
      if (!canScroll()) return;
      const elapsed = Math.min(32, now - previous); previous = now;
      velocity *= Math.exp(-elapsed / 240);
      const delta = velocity * elapsed, moved = scroll(delta);
      // Stop at the first boundary frame. No spring, reversal or repeated clamp.
      if (Math.abs(velocity) < .02 || Math.abs(moved - delta) > 1 || !moved) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }
  return { start, move, end, cancel, isActive: () => Boolean(gesture?.active || frame !== undefined) };
}
