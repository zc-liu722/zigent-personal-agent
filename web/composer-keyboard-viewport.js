/*!
 * Keyboard focus/closing guard adapted from Vaul (MIT).
 * Copyright (c) 2023 Emil Kowalski. License: ./vendor/vaul/LICENSE.md
 * https://github.com/emilkowalski/vaul/blob/3e97aac6a38e4481bade71d7233ed6002e80f9b0/src/index.tsx#L476-L534
 */

// Track keyboard lifetime for the floating composer. The transcript keeps
// native document scrolling throughout keyboard opening and dismissal.
export function createComposerKeyboardViewport(composer) {
  let keyboardIsOpen = false;
  function reset() { keyboardIsOpen = false; return false; }
  function update(mobile, height, layoutHeight) {
    const isInput = isEditableElement(composer.ownerDocument.activeElement);
    // Vaul keeps tracking after blur until the keyboard has closed. A 120px
    // reduction filters browser chrome; layout-resizing keyboards need no lift.
    keyboardIsOpen = Boolean(mobile && (isInput || keyboardIsOpen) && layoutHeight - height > 120);
    return keyboardIsOpen;
  }
  return { update, reset };
}

export function visualViewportClientBottom(doc) {
  const viewport = doc.defaultView.visualViewport, root = doc.documentElement;
  if (!viewport) return root.clientHeight;
  // Client rects and visualViewport.offsetTop need not share an origin on iOS:
  // https://bugs.webkit.org/show_bug.cgi?id=306779. The untransformed root starts
  // at document y=0. Its client top converts the viewport's document coordinates
  // into the same space as the composer, including short-page keyboard panning.
  return root.getBoundingClientRect().top + viewport.pageTop + viewport.height;
}

// Use the same bottom anchor with and without a keyboard. WebKit may publish
// the closing viewport in one late step (https://bugs.webkit.org/show_bug.cgi?id=265578).
// Start returning on blur when possible; ease only discontinuous closing steps,
// rather than adding a transition behind every native viewport animation frame.
export function createComposerKeyboardMotion(composer, onChange) {
  const doc = composer.ownerDocument, view = doc.defaultView, root = doc.documentElement;
  const timeline = doc.getElementById('timeline');
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const zero = () => ({ lift: 0, inset: 0, top: 0 });
  let current = zero(), dismissing = false, animation, paddingAnimation;
  function cancelAnimation() {
    if (animation) { animation.onfinish = null; animation.cancel(); animation = undefined; }
    if (paddingAnimation) { paddingAnimation.cancel(); paddingAnimation = undefined; }
    root.removeAttribute('data-composer-moving');
  }
  function move(next, smooth) {
    if (Object.keys(current).every(key => Math.abs(next[key] - current[key]) < .5)) return;
    const changingClearance = Math.abs(next.inset - current.inset) >= .5;
    const animate = smooth && !reducedMotion.matches && composer.animate;
    const from = animate
      ? view.getComputedStyle(composer).transform : undefined;
    // Shrink the document's real keyboard clearance alongside the dock. Native
    // scroll-range clamping brings a bottom reader down with it; history readers
    // keep their scroll position. Never transform the transcript or its fixed bars.
    const fromPadding = animate && changingClearance && timeline?.animate && doc.getElementById('welcome')?.hidden
      ? view.getComputedStyle(timeline).paddingBottom : undefined;
    cancelAnimation();
    current = next;
    if (from) {
      const timing = { duration: 240, easing: 'cubic-bezier(.2, .65, .3, 1)' };
      root.setAttribute('data-composer-moving', '');
      animation = composer.animate([{ transform: from }, { transform: `translateY(${-next.lift}px)` }], timing);
      if (fromPadding) paddingAnimation = timeline.animate([{ paddingBottom: fromPadding },
        { paddingBottom: `calc(var(--composer-height, 100px) + ${next.inset}px)` }], timing);
      animation.onfinish = () => { cancelAnimation(); onChange(); };
    }
    // Install the padding animation before removing its underlying clearance,
    // so a style/layout flush cannot clamp the document to the final range early.
    composer.style.setProperty('--composer-keyboard-lift', `${next.lift}px`);
    root.style.setProperty('--chat-keyboard-inset', `${next.inset}px`);
    // Navigation uses the projected closing state, not the last keyboard pan
    // WebKit reported. A late offset must not drop the top controls into the page.
    root.style.setProperty('--chat-chrome-top', `${next.top}px`);
    onChange();
  }
  function reset() {
    if (!Object.values(current).some(Boolean) && !dismissing && !animation) return;
    cancelAnimation(); current = zero(); dismissing = false;
    composer.style.removeProperty('--composer-keyboard-lift');
    root.style.removeProperty('--chat-keyboard-inset');
    root.style.removeProperty('--chat-chrome-top');
    onChange();
  }
  function measureLift() {
    const style = view.getComputedStyle(composer);
    const translation = style.transform === 'none' ? 0 : new view.DOMMatrixReadOnly(style.transform).m42;
    const edge = parseFloat(style.getPropertyValue('--composer-edge-gap')) || 0;
    // Safari can reposition the native fixed bottom independently of clientHeight
    // during keyboard animation and document scrolling. Measure that anchor with
    // our own (possibly animated) translation removed; lift only the remaining gap.
    const nativeBottom = composer.getBoundingClientRect().bottom - translation;
    return Math.max(0, nativeBottom - visualViewportClientBottom(doc) + edge);
  }
  function update(active, geometry, closingJump) {
    if (!active) dismissing = false;
    const target = dismissing ? zero() : geometry;
    move(target, (target.lift < current.lift || target.inset < current.inset) && (closingJump || !active));
  }
  function dismiss() {
    if (current.lift <= 0 && current.inset <= 0) return;
    // Ignore the old keyboard rectangle until closure is confirmed. A new
    // editor focus/tap explicitly resumes tracking, including focus-preserving
    // keyboard reopening; stale resize/scroll events must not lift it again.
    dismissing = true; move(zero(), true);
  }
  function resume() {
    if (!dismissing) return;
    // The last open rectangle may predate both a native pan and dismissal.
    // Resume from the next fresh viewport transaction instead of replaying it.
    dismissing = false;
  }
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { cancelAnimation(); onChange(); } });
  view.addEventListener('pagehide', reset);
  return { update, dismiss, resume, reset, measureLift };
}

export function isEditableElement(element) {
  return Boolean(element?.isContentEditable ||
    element?.matches('textarea, input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=color]):not([type=hidden]):not([type=reset]):not([type=image])') &&
    !element.readOnly && !element.disabled);
}

// WebKit's native focus reveal can scroll even a fixed textarea. Make only the
// editor transparent across the focus transaction so there is nothing to reveal;
// retain its layout, native caret placement, and the document's scroll owner.
export function createComposerFocusGuard(composer) {
  const view = composer.ownerDocument.defaultView;
  const navigator = view.navigator;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  let pending;
  function restore() {
    if (!pending) return;
    const { element, opacity, priority, firstFrame, secondFrame } = pending;
    view.cancelAnimationFrame(firstFrame); view.cancelAnimationFrame(secondFrame);
    if (opacity) element.style.setProperty('opacity', opacity, priority);
    else element.style.removeProperty('opacity');
    pending = undefined;
  }
  function prepare(element) {
    if (!ios || !composer.contains(element) || !isEditableElement(element)) return;
    restore();
    pending = { element, opacity: element.style.getPropertyValue('opacity'), priority: element.style.getPropertyPriority('opacity') };
    element.style.setProperty('opacity', '0');
    // Flush the style before WebKit decides whether native focus needs a reveal.
    element.getBoundingClientRect();
    pending.firstFrame = view.requestAnimationFrame(() => {
      if (pending) pending.secondFrame = view.requestAnimationFrame(restore);
    });
  }
  view.addEventListener('pagehide', restore);
  return { prepare };
}
