import { $, el, messageButton, syncChildren } from './dom.js';
import { interactionStatus, messageInteractions } from './components/interaction-model.js';
import { createConversationState } from './app-state.js';
import { createComposerFocusGuard, createComposerKeyboardMotion, createComposerKeyboardViewport, isEditableElement, visualViewportClientBottom } from './composer-keyboard-viewport.js';
import { createKeyboardReadingScroll } from './keyboard-reading-scroll.js';
import { createClipboard } from './clipboard.js';
import { createMarkdownRenderer } from './markdown.js';
import { createInteractionRenderer } from './components/index.js';
import { createMessageRenderer } from './message-renderer.js';
import { createConversationSync } from './conversation-sync.js';
import { createImageUploads } from './image-uploads.js';
import { createMessageOutbox } from './message-outbox.js';
import { createUploadStorage } from './upload-storage.js';
import { loadScript, loadStyle } from './lazy-assets.js';
import { errorMessage, readJsonResponse, requestError } from './http-errors.js';

performance.mark('zigent:app-ready');
const base = new URL('./', location.href).pathname;
const assetUrl = (id, preview = false) => `${base}api/assets/${encodeURIComponent(id)}${preview ? `?preview=${preview === 'display' ? 'display' : '1'}` : ''}`;
const appState = createConversationState();
const mobileLayout = matchMedia('(max-width:650px), (max-width:1024px) and (pointer:coarse)');
let readingTouch = false, readingMotionUntil = 0;
let keyboardReadingScrollActive = () => false;
let keyboardReadingPosition;
let uploads = [], choosingImages = false, messageSending = false, installPrompt;
const stoppingReplies = new Set();
const queueViews = new Map(), queueRequests = new Set(), queueErrors = new Map(), queueRetakes = new Map();
const historyViews = new Map();
let memoryVersion = 0, agentName = document.title;
let fileWorkbench;
let speechInput, speechDraft, speechConfigured = false, speechBusy = false, speechSubmitting = false, speechComposing = false, speechPending;
let selectedModel = '', defaultModel = '', modelSaving = false, modelLibraryView;
let modelLibraryVersion = 0, modelRecoveryRequestId, modelLibraryCatalogue, modelLibraryRequest;
let forking = false, userMessageActions, replySelection, editing, olderRequest;
let replyQuotes = [];
let replySelectionBranchRequest;
let draftRestored = false, draftSignature = '', draftSave = Promise.resolve(), draftStorageError = false;
const uploadStorage = createUploadStorage(base);
const imageUploads = createImageUploads({ url: `${base}api/assets`, assetUrl, storage: uploadStorage,
  fileInfo: id => [...appState.messages, ...appState.queuedMessages].find(message => message.files?.[id])?.files[id],
  onComplete: (localId, id) => {
    uploads = uploads.map(value => value === localId ? id : value);
    messageOutbox.replaceAsset(localId, id);
    if (editing) editing.priorDraft.assets = editing.priorDraft.assets.map(value => value === localId ? id : value);
    appState.draftId = undefined;
  },
  onChange: () => { renderUploads(); scheduleMessages(); messageOutbox.pump(); }, onUnauthorized: showLogin });
const messageOutbox = createMessageOutbox({ base, imageUploads, api, userMessageText,
  onChange: () => { renderUploads(); renderHistory(); scheduleMessages(); },
  onDelivered: async (item, result) => {
    if (appState.current === item.conversationId && result.conversationId && result.conversationId !== item.conversationId) await selectConversation(result.conversationId);
    else await refresh();
  } });
const imagePickerStatus = el('div', 'attachment attachment-picker', '正在选择…');
imagePickerStatus.setAttribute('role', 'status');
const { copyText } = createClipboard({ toast });
const { markdown, inline } = createMarkdownRenderer({ copyText, openConversationDocument, toast, captureReadingPosition, restoreReadingPosition, rememberReadingPosition });
const interactionRenderer = createInteractionRenderer({ conversation: appState, api, loadModelLibrary, openConversationDocument, openBrowserWorkspace, openPanel, refresh, renderMessages });
const messageRenderer = createMessageRenderer({ conversation: appState, assetUrl, loadActivity: loadMessageActivity,
  branchReply, captureReadingPosition, copyText, isForking: () => forking, inline, markdown, toast,
  openConversationDocument, openCurrentBrowser, readingMetrics, readingScroller, readingTopEdge, rememberReadingPosition,
  renderInteraction, renderSend, restoreReadingPosition, scrollReadingToBottom, scheduleInteractionExpiry: interactionRenderer.scheduleInteractionExpiry, userMessageText,
  subagentRunningText: () => agentName === '小昌' ? '大昌正在工作中' : '子agent正在工作中',
  pendingArticles: () => messageOutbox.render(appState.current, new Set([...appState.messages, ...appState.queuedMessages].map(item => item.id))) });
const conversationSync = createConversationSync({ conversation: appState, base, api, closeMenu, refreshCodexExecutions: interactionRenderer.refreshCodexExecutions,
  renderHistory, renderMessages, renderQueue, scheduleMessages, captureReadingPosition, restoreReadingPosition, rememberReadingPosition,
  beforeSelect: id => {
    cancelModelLibraryLoad();
    readingTouch = false; readingMotionUntil = 0;
    messageRenderer.cancelActivityLoads();
    olderRequest?.abort(); olderRequest = undefined; $('older').disabled = false;
    cancelSpeech(); memoryVersion++;
    userMessageActions?.close(); replySelection?.close(); cancelEdit(false);
    if (id !== appState.current) replyQuotes = [];
    renderReplyQuotes(); window.ZigentDocumentWorkspace?.close(); window.ZigentBrowser?.close();
    fileWorkbench?.close();
  },
  selectModel: model => { selectedModel = model || defaultModel; renderModel(); },
  setReconnecting: value => { reconnecting = value; renderStatusNotice(); }, toast });
function renderMessages(...args) { return messageRenderer.renderMessages(...args); }
function scheduleMessages(...args) { return messageRenderer.scheduleMessages(...args); }
function renderBrowserEntry(...args) { return messageRenderer.renderBrowserEntry(...args); }
function renderInteraction(...args) { return interactionRenderer.renderInteraction(...args); }
function activity(...args) { return messageRenderer.activity(...args); }
function selectConversation(...args) { return conversationSync.selectConversation(...args); }
function refresh(...args) { return conversationSync.refresh(...args); }
function connectEvents(...args) { return conversationSync.connectEvents(...args); }
let drawerReturnFocus;
const sidebarPreference = `${base}sidebar-collapsed`;
let sidebarCollapsed = false;
try { sidebarCollapsed = localStorage.getItem(sidebarPreference) === '1'; } catch {}
function setSidebarCollapsed(value) {
  sidebarCollapsed = value;
  try { localStorage.setItem(sidebarPreference, value ? '1' : '0'); } catch {}
  syncSidebar();
}
const panelReturnFocus = new WeakMap();
function syncSidebar() {
  const open = mobileLayout.matches && $('sidebar').classList.contains('open');
  $('app').classList.toggle('sidebar-collapsed', !mobileLayout.matches && sidebarCollapsed);
  $('sidebar').inert = mobileLayout.matches ? !open : sidebarCollapsed;
  $('menu').setAttribute('aria-expanded', String(mobileLayout.matches ? open : !sidebarCollapsed));
  $('close-sidebar').setAttribute('aria-label', mobileLayout.matches ? '关闭对话列表' : '收起对话列表');
  if (open) { $('sidebar').setAttribute('role', 'dialog'); $('sidebar').setAttribute('aria-modal', 'true'); }
  else { $('sidebar').removeAttribute('role'); $('sidebar').removeAttribute('aria-modal'); }
  // The rest of the page stays outside the drawer's keyboard and accessibility tree.
  document.querySelector('.chat-main').inert = open;
  if (!mobileLayout.matches) { $('sidebar').classList.remove('open'); $('scrim').hidden = true; }
}
mobileLayout.addEventListener('change', syncSidebar); syncSidebar();
let scheduleReadingViewport, flushReadingViewport;
function observeAppViewport() {
  const root = document.documentElement, viewport = window.visualViewport, composer = document.querySelector('.composer-area');
  if (!root?.style || !composer) return;
  const composerKeyboard = createComposerKeyboardViewport(composer);
  const composerMotion = createComposerKeyboardMotion(composer, () => {
    scheduleReadingViewport?.(); requestAnimationFrame(syncComposer);
  });
  const properties = ['--app-width', '--app-height', '--app-left', '--app-top'];
  const previous = new Map();
  let frame, settleTimer, previousHeight = 0, orientationChanged = false, composerKeyboardActive = false;
  const pixels = value => `${Math.round(value * 100) / 100}px`;
  function update() {
    frame = undefined;
    if (document.hidden) return;
    // Pinch zoom changes the visible rectangle, not the page's layout. Keep the
    // existing layout and let the browser magnify/pan it without chasing the zoom.
    if (viewport && (!Number.isFinite(viewport.scale) || Math.abs(viewport.scale - 1) > .01)) {
      if (orientationChanged) {
        // A rotated, zoomed page must not retain the previous orientation's size.
        for (const property of properties) root.style.removeProperty(property);
        previous.clear(); composerKeyboard.reset(); composerMotion.reset(); composerKeyboardActive = false;
        root.removeAttribute('data-composer-keyboard'); orientationChanged = false;
        scheduleReadingViewport?.();
      }
      return;
    }
    const width = viewport ? viewport.width : root.clientWidth || window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight || root.clientHeight;
    if (![width, height].every(value => Number.isFinite(value) && value > 0)) return;
    const left = viewport ? viewport.offsetLeft : 0, top = viewport ? viewport.offsetTop : 0;
    if (![left, top].every(Number.isFinite)) return;
    // Safari can report offsets outside the layout viewport during rubber-band
    // scrolling. Those are not keyboard panning and must not move the controls.
    const layoutWidth = root.clientWidth, layoutHeight = root.clientHeight;
    const boundedLeft = Math.max(0, Math.min(left, layoutWidth - width));
    const keyboardOpen = composerKeyboard.update(Boolean(viewport && mobileLayout.matches), height, layoutHeight);
    const editingChat = composer.contains(document.activeElement) && isEditableElement(document.activeElement);
    // Only the composer follows the keyboard. The transcript always remains
    // document content, including while focus survives keyboard dismissal.
    composerKeyboardActive = mobileLayout.matches && !$('app').hidden && keyboardOpen &&
      (editingChat || composerKeyboardActive);
    // Safari can retain a small keyboard offset after dismissal. Clear it when
    // the composer returns to the native bottom edge.
    const boundedTop = mobileLayout.matches && !composerKeyboardActive
      ? 0
      : Math.max(0, Math.min(top, layoutHeight - height));
    // Keep the transcript in document flow while floating controls follow only
    // the real visible rectangle, including keyboard occlusion.
    // Focus panning changes offsetTop as the document scrolls. Feeding that
    // offset into document padding changes its scroll range again, creating a
    // feedback loop at the bottom. Only viewport shrinkage reserves space.
    // The motion controller projects clearance and navigation together when
    // dismissal starts ahead of WebKit's next viewport measurement.
    const keyboardInset = composerKeyboardActive ? Math.max(0, layoutHeight - height) : 0;
    const values = [width, height, boundedLeft, boundedTop].map(pixels);
    properties.forEach((property, index) => {
      if (previous.get(property) !== values[index]) { root.style.setProperty(property, values[index]); previous.set(property, values[index]); }
    });
    const keyboardChanged = root.hasAttribute('data-composer-keyboard') !== composerKeyboardActive;
    root.toggleAttribute('data-composer-keyboard', composerKeyboardActive);
    // Native keyboard frames are applied directly. Ease only a large viewport
    // expansion or the final close, never ordinary document/focus panning.
    const closingJump = previousHeight > 0 && height - previousHeight > 120 && !orientationChanged;
    previousHeight = height;
    if (orientationChanged) composerMotion.reset();
    if (mobileLayout.matches && !$('app').hidden) {
      composerMotion.update(composerKeyboardActive, {
        lift: composerKeyboardActive ? composerMotion.measureLift() : 0,
        inset: keyboardInset, top: boundedTop
      }, closingJump);
    } else composerMotion.reset();
    if (keyboardChanged) requestAnimationFrame(syncComposer);
    orientationChanged = false;
    // Apply bottom-follow in this viewport transaction, before the lifted dock
    // paints. Scheduling another frame leaves the transcript behind the editor.
    if (flushReadingViewport) flushReadingViewport();
    else scheduleReadingViewport?.();
    // Following the new scroll end can change Safari's native fixed anchor and
    // visual pan. Reconcile after that write, before painting the lifted editor.
    if (viewport && composerKeyboardActive) {
      const afterHeight = viewport.height, afterTop = viewport.offsetTop;
      if (Number.isFinite(afterHeight) && afterHeight > 0 && Number.isFinite(afterTop)) {
        const top = Math.max(0, Math.min(afterTop, root.clientHeight - afterHeight));
        composerMotion.update(true, { lift: composerMotion.measureLift(),
          inset: Math.max(0, root.clientHeight - afterHeight), top }, false);
      }
    }
  }
  function schedule() { if (frame === undefined) frame = requestAnimationFrame(update); }
  function settle() {
    schedule(); clearTimeout(settleTimer);
    // Safari may report its final rectangle only after the keyboard animation.
    // A bounded recheck also covers focus restoration and back/forward cache entry.
    settleTimer = setTimeout(schedule, 350);
  }
  viewport?.addEventListener('resize', schedule, { passive: true });
  viewport?.addEventListener('scroll', schedule, { passive: true });
  viewport?.addEventListener('scrollend', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('orientationchange', () => { orientationChanged = true; settle(); });
  window.addEventListener('pageshow', settle);
  mobileLayout.addEventListener('change', schedule);
  const resumeComposer = event => {
    if (mobileLayout.matches && composer.contains(event.target) && isEditableElement(event.target)) {
      composerMotion.resume(); schedule();
    }
  };
  document.addEventListener('pointerdown', resumeComposer, true);
  document.addEventListener('focusin', event => { resumeComposer(event); settle(); });
  document.addEventListener('focusout', event => {
    settle();
    if (!composer.contains(event.target) || !isEditableElement(event.target)) return;
    requestAnimationFrame(() => {
      // Focus can move into another field without dismissing the keyboard.
      if (mobileLayout.matches && !document.hidden && !isEditableElement(document.activeElement)) composerMotion.dismiss();
    });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) settle(); });
  update();
}
observeAppViewport();
function observeTouchScrolling() {
  let gesture, drawerFrame;
  const app = $('app'), sidebar = $('sidebar'), scrim = $('scrim'), timeline = $('timeline');
  const keyboardScroll = createKeyboardReadingScroll({ scroller: readingScroller, range: readingScrollRange,
    canScroll: () => mobileLayout.matches && !app.hidden && !document.hidden && !sidebar.classList.contains('open') &&
      !document.querySelector('dialog:modal') && Math.abs((window.visualViewport?.scale || 1) - 1) <= .01,
    onMove: () => { readingMotionUntil = performance.now() + 220; } });
  keyboardReadingScrollActive = keyboardScroll.isActive;
  const stopEdgeGesture = () => { if (gesture) gesture.edgeCandidate = false; };
  function paintDrawer() {
    drawerFrame = undefined;
    if (!gesture?.edgeLocked) return;
    const progress = Math.max(0, Math.min(1, gesture.edgeDistance / gesture.drawerWidth));
    sidebar.style.setProperty('--drawer-offset', `${(progress - 1) * 101}%`);
    scrim.style.setProperty('--drawer-progress', String(progress));
  }
  const end = event => {
    const active = gesture;
    keyboardScroll.end(event);
    if (drawerFrame !== undefined) cancelAnimationFrame(drawerFrame);
    drawerFrame = undefined;
    gesture = undefined;
    if (!active?.edgeLocked) return;
    const touch = event?.type === 'touchend'
      ? [...event.changedTouches].find(value => value.identifier === active.id) : undefined;
    const distance = touch ? touch.clientX - active.x : active.edgeDistance;
    const open = event?.type === 'touchend' && mobileLayout.matches && !$('app').hidden &&
      distance >= 48;
    sidebar.classList.remove('dragging');
    sidebar.style.removeProperty('--drawer-offset');
    scrim.style.removeProperty('--drawer-progress');
    scrim.hidden = !sidebar.classList.contains('open') && !open;
    if (open) openMenu();
  };
  function moveComposerSelection(event) {
    const input = gesture?.composerText;
    if (!input || event.touches.length !== 1) return;
    // Dragging a selection handle inside the raised composer must not scroll the
    // page. Ordinary single-finger pans without a selection keep native scrolling.
    if (input.selectionStart === input.selectionEnd) return;
    if (event.cancelable) event.preventDefault();
  }
  function moveBoundary(event) {
    if (!gesture || event.touches.length !== 1 || (window.visualViewport?.scale || 1) > 1.01) { end(); return; }
    if (gesture.edgeLocked) return;
    const touch = event.touches[0], dx = touch.clientX - gesture.lastX, dy = touch.clientY - gesture.lastY;
    gesture.lastX = touch.clientX; gesture.lastY = touch.clientY;
    if (Math.abs(dy) <= Math.abs(dx) || window.getSelection()?.isCollapsed === false) return;
    const root = readingScroller(), top = readingScrollTop(root);
    if (!(dy > 0 && top <= 0 || dy < 0 && top >= readingScrollRange(root) - 1)) return;
    // Safari can still start pull-to-refresh despite overscroll-behavior:none.
    // Cancel only an outward page-edge drag; nested controls keep their scroll.
    for (const node of event.composedPath()) {
      if (node === root) break;
      if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight + 1 || !/^(auto|scroll)$/.test(getComputedStyle(node).overflowY)) continue;
      if (dy > 0 && node.scrollTop > 0 || dy < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) return;
    }
    if (event.cancelable) event.preventDefault();
  }
  function moveEdge(event) {
    if (!gesture?.edgeCandidate) return;
    if (!mobileLayout.matches || app.hidden || event.touches.length !== 1 ||
      Math.abs((window.visualViewport?.scale || 1) - 1) > .01) { end(); return; }
    const touch = event.touches[0], dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.edgeLocked) {
      const horizontal = dx > 0 && dx > Math.abs(dy) * 1.2;
      // Cancel the first horizontal move, even below the direction-lock slop.
      // Once native scrolling owns a gesture, a later preventDefault is too late.
      if (horizontal && event.cancelable) event.preventDefault();
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      if (!horizontal || !event.cancelable) { stopEdgeGesture(); return; }
      // Decide direction once. Later vertical drift must not discard a swipe.
      gesture.edgeLocked = true;
      gesture.drawerWidth = sidebar.getBoundingClientRect().width;
      sidebar.style.setProperty('--drawer-offset', '-101%');
      scrim.style.setProperty('--drawer-progress', '0');
      sidebar.classList.add('dragging'); scrim.hidden = false;
      keyboardScroll.cancel();
      userMessageActions?.cancelPress(); replySelection?.cancelPress();
    }
    if (event.cancelable) event.preventDefault();
    gesture.edgeDistance = Math.max(0, dx);
    if (drawerFrame === undefined) drawerFrame = requestAnimationFrame(paintDrawer);
  }
  document.addEventListener('touchstart', event => {
    end();
    if (!mobileLayout.matches || $('app').hidden || event.touches.length !== 1 ||
      event.target.closest?.('.browser-frame.controllable, [data-native-selection]') || replySelection?.isSelecting(event.target)) return;
    const touch = event.touches[0], left = window.visualViewport?.offsetLeft || 0;
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastY: touch.clientY,
      composerText: event.target.closest?.('textarea') || undefined };
    const root = readingScroller(), top = readingScrollTop(root);
    gesture.boundary = !sidebar.classList.contains('open') && !event.target.closest?.('dialog:modal') &&
      (document.documentElement.hasAttribute('data-composer-keyboard') || top <= 0 || top >= readingScrollRange(root) - 1);
    if (gesture.boundary && timeline.contains(event.target) && document.documentElement.hasAttribute('data-composer-keyboard') &&
      parseFloat(document.documentElement.style.getPropertyValue('--chat-keyboard-inset')) > 0 &&
      !event.target.closest?.('dialog, input, textarea, [contenteditable]') && window.getSelection()?.isCollapsed !== false) {
      keyboardScroll.start(event);
    }
    if (touch.clientX >= left && touch.clientX <= left + 40 && !$('sidebar').classList.contains('open') &&
      !event.target.closest?.('dialog') && Math.abs((window.visualViewport?.scale || 1) - 1) <= .01) {
      gesture.edgeCandidate = true;
    }
  }, { passive: true, capture: true });
  document.addEventListener('touchend', end, { passive: true, capture: true });
  document.addEventListener('touchcancel', end, { passive: true, capture: true });
  function moveTouch(event) {
    moveEdge(event);
    if (gesture?.edgeLocked) return;
    moveComposerSelection(event);
    if (keyboardScroll.move(event)) return;
    if (gesture?.boundary) moveBoundary(event);
  }
  function syncEdgeListener() {
    end();
    // WebKit determines scroll-blocking regions before touchstart. Installing
    // this listener inside touchstart can leave the first moves uncancelable,
    // especially with native document scrolling. Keep it on the app in advance;
    // The same preinstalled handler owns keyboard reading pans and edge guards.
    // Other touches return immediately and retain their native behavior.
    // https://bugs.webkit.org/show_bug.cgi?id=184251
    if (mobileLayout.matches) app.addEventListener('touchmove', moveTouch, { passive: false, capture: true });
    else app.removeEventListener('touchmove', moveTouch, true);
  }
  mobileLayout.addEventListener('change', syncEdgeListener);
  syncEdgeListener();
  window.addEventListener('pagehide', end);
  window.addEventListener('blur', () => keyboardScroll.cancel());
  app.addEventListener('wheel', () => keyboardScroll.cancel(), { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) keyboardScroll.cancel(); });
}
observeTouchScrolling();
function readingScroller() { return mobileLayout.matches ? document.scrollingElement || document.documentElement : $('timeline'); }
function readingScrollRange(element) {
  const range = Math.max(0, element.scrollHeight - element.clientHeight);
  const root = document.documentElement, viewport = window.visualViewport;
  if (!mobileLayout.matches || $('app').hidden || !$('welcome').hidden || !viewport ||
    Math.abs(viewport.scale - 1) > .01 || !root.hasAttribute('data-composer-keyboard') ||
    !(parseFloat(root.style.getPropertyValue('--chat-keyboard-inset')) > 0)) return range;
  const timeline = $('timeline'), composer = document.querySelector('.composer-area');
  const padding = parseFloat(getComputedStyle(timeline).paddingBottom) || 0;
  const edge = parseFloat(getComputedStyle(composer).getPropertyValue('--composer-edge-gap')) || 0;
  // Keyboard clearance already reserves the occluded part of the layout
  // viewport. Safari's additional visual pan must not spend that space again.
  // Compare both edges in client coordinates rather than trusting the root's
  // scrollHeight (which can include a phantom tail) or offsetTop alone.
  const contentBottom = timeline.getBoundingClientRect().bottom - padding;
  const readingBottom = visualViewportClientBottom(document) - composer.offsetHeight - edge;
  return Math.max(0, Math.min(range, element.scrollTop + contentBottom - readingBottom));
}
function readingScrollTop(element) { return element.scrollTop; }
function setReadingScrollTop(element, top) {
  const range = readingScrollRange(element), value = Math.max(0, Math.min(top, range));
  if (Math.abs(element.scrollTop - value) > 1) element.scrollTop = value;
}
function scrollReadingToBottom() {
  if (mobileLayout.matches && !$('welcome').hidden) return;
  // Explicit navigation (including sending a message) ends history preservation.
  if (keyboardReadingPosition) keyboardReadingPosition.nearBottom = keyboardReadingPosition.atBottom = true;
  const element = readingScroller();
  setReadingScrollTop(element, readingScrollRange(element));
}
function readingGestureActive() { return readingTouch || keyboardReadingScrollActive() || performance.now() < readingMotionUntil; }
function observeReadingGestures() {
  const timeline = $('timeline'), composer = document.querySelector('.composer-area');
  let keyboardSwipe;
  const moving = () => { readingMotionUntil = performance.now() + 220; };
  timeline.addEventListener('touchstart', event => {
    readingTouch = true; moving(); keyboardSwipe = undefined;
    if (!mobileLayout.matches || event.touches.length !== 1 ||
      !document.documentElement.hasAttribute('data-composer-keyboard') ||
      !keyboardReadingPosition?.openedAtBottom || keyboardReadingPosition.conversation !== appState.current ||
      !composer.contains(document.activeElement) || !isEditableElement(document.activeElement) ||
      event.target.closest?.('dialog, input, textarea, [contenteditable], [data-native-selection], .browser-frame.controllable') ||
      replySelection?.isSelecting(event.target)) return;
    const touch = event.touches[0];
    keyboardSwipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, input: document.activeElement };
  }, { passive: true });
  timeline.addEventListener('touchmove', event => {
    if (!keyboardSwipe) return;
    if (event.touches.length !== 1 || Math.abs((window.visualViewport?.scale || 1) - 1) > .01 ||
      window.getSelection()?.isCollapsed === false) { keyboardSwipe = undefined; return; }
    const touch = [...event.touches].find(value => value.identifier === keyboardSwipe.id);
    if (!touch) return;
    const dx = touch.clientX - keyboardSwipe.x, dy = touch.clientY - keyboardSwipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
    const input = keyboardSwipe.input;
    keyboardSwipe = undefined;
    // Decide from the opening position, which scrolling must not overwrite.
    // A downward finger drag reveals the earlier transcript content.
    // Keep native scrolling while blur returns the composer with the keyboard.
    if (dy > 0 && dy > Math.abs(dx) * 1.2 && document.activeElement === input) input.blur();
  }, { passive: true });
  const release = event => {
    keyboardSwipe = undefined;
    if (!readingTouch) return;
    readingTouch = event.touches.length > 0; moving();
  };
  document.addEventListener('touchend', release, { passive: true });
  document.addEventListener('touchcancel', release, { passive: true });
  timeline.addEventListener('wheel', moving, { passive: true });
  // Momentum continues after touchend. Extend the guard only for a user scroll,
  // so our own explicit navigation does not disable subsequent bottom-follow.
  document.addEventListener('scroll', event => {
    if ((event.target === readingScroller() || event.target === document) && readingGestureActive()) moving();
  }, { passive: true, capture: true });
  document.addEventListener('scrollend', event => {
    if ((event.target === readingScroller() || event.target === document) && !readingTouch) readingMotionUntil = 0;
  }, { passive: true, capture: true });
  window.addEventListener('blur', () => { keyboardSwipe = undefined; readingTouch = false; readingMotionUntil = 0; });
}
observeReadingGestures();
function readingMetrics() {
  const element = readingScroller(), top = readingScrollTop(element);
  const remaining = readingScrollRange(element) - top;
  return { element, top, height: element.scrollHeight, nearBottom: remaining < 140, atBottom: remaining <= 4 };
}
function readingTopEdge() {
  const topbar = document.querySelector('.topbar');
  if (!mobileLayout.matches) return topbar.getBoundingClientRect().bottom;
  // Mobile navigation has no fixed wrapper. Measure the floating controls and
  // keep the same reading clearance for anchors, folding and text selection.
  const controls = [...topbar.children].map(node => node.getBoundingClientRect()).filter(rect => rect.width && rect.height);
  return controls.length ? Math.max(...controls.map(rect => rect.bottom)) + 8 : 0;
}
function captureReadingPosition() {
  const metrics = readingMetrics(), edge = readingTopEdge();
  // Rows are in vertical order. Skip hidden receipts before searching so their
  // zero-sized rectangles cannot break the ordering of visible message bounds.
  const rows = [...$('messages').children].filter(node => !node.hidden);
  let start = 0, end = rows.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (rows[middle].getBoundingClientRect().bottom > edge) end = middle;
    else start = middle + 1;
  }
  const anchor = rows[start];
  return { ...metrics, anchor, anchorOffset: anchor ? anchor.getBoundingClientRect().top - edge : undefined };
}
function restoreReadingPosition(position, prepend = false, followBottom = false) {
  // ResizeObserver, streaming, math and output resizing all share this guard.
  // Writing scrollTop during a native drag/deceleration can stop iOS scrolling.
  if (readingGestureActive() || mobileLayout.matches && keyboardReadingPosition &&
    keyboardReadingPosition.conversation === appState.current &&
    (keyboardReadingPosition.settling || !keyboardReadingPosition.nearBottom)) return;
  const metrics = readingMetrics();
  if (position.anchorId) position = { ...position, anchor: [...$('messages').children].find(node => node.dataset.id === position.anchorId) };
  let target;
  // The wider near-bottom window helps preloading, but must not pull a reader
  // through the last 140px whenever a message or viewport measurement updates.
  if (followBottom && position.atBottom) { scrollReadingToBottom(); return; }
  else if (position.anchor?.isConnected && position.anchorOffset !== undefined) {
    target = metrics.top + position.anchor.getBoundingClientRect().top - readingTopEdge() - position.anchorOffset;
  } else target = position.top + (prepend ? metrics.height - position.height : 0);
  // Leave native momentum alone when layout did not move the reading anchor.
  setReadingScrollTop(metrics.element, target);
}
let rememberedReadingPosition;
function rememberReadingPosition() { rememberedReadingPosition = captureReadingPosition(); }
function observeReadingViewport() {
  const root = document.documentElement, timeline = $('timeline'), composer = document.querySelector('.composer-area'), topbar = document.querySelector('.topbar');
  const focusGuard = createComposerFocusGuard(composer);
  const geometry = () => ({ root: readingScroller(), width: timeline.clientWidth,
    // Mobile browser chrome resizes the native scrollport during a swipe.
    // Only desktop's nested scrollport height changes transcript layout;
    // mobile keyboard changes are tracked by the inset and active state below.
    height: mobileLayout.matches ? 0 : readingScroller().clientHeight,
    // Measure control size, not its moving visual-viewport position. Native
    // panning is not a transcript layout change and must not trigger scrolling.
    header: mobileLayout.matches ? Math.max(0, ...[...topbar.children].map(node => node.offsetHeight)) : topbar.offsetHeight,
    // The mobile dock leaves an external gap at Safari's bottom edge. Reserve
    // it with the dock height so the last message keeps its existing clearance.
    composer: composer.offsetHeight + (parseFloat(getComputedStyle(composer).getPropertyValue('--composer-edge-gap')) || 0),
    keyboard: root.style.getPropertyValue('--chat-keyboard-inset'),
    // Read rendered clearance too: reopening during a dismissal can animate
    // padding while the CSS variable already contains its final value.
    clearance: mobileLayout.matches ? parseFloat(getComputedStyle(timeline).paddingBottom) || 0 : 0,
    keyboardActive: root.hasAttribute('data-composer-keyboard') || root.hasAttribute('data-composer-moving') });
  let previous = geometry(), composerHeight = 0, frame, settleTimer;
  const same = current => Object.keys(current).every(key => current[key] === previous[key]);
  const releaseKeyboardPosition = () => { keyboardReadingPosition = undefined; clearTimeout(settleTimer); };
  const keepKeyboardPosition = position => {
    keyboardReadingPosition = { ...position, nearBottom: position.atBottom, conversation: appState.current,
      openedAtBottom: keyboardReadingPosition?.openedAtBottom ?? position.atBottom,
      settling: keyboardReadingPosition?.settling ?? true };
  };
  const settleKeyboardPosition = () => {
    clearTimeout(settleTimer);
    // Preserve history and finish native focus panning after resizing goes quiet.
    // A bottom reader follows growing keyboard clearance immediately in resize.
    settleTimer = setTimeout(() => {
      const position = keyboardReadingPosition;
      if (!position) return;
      const open = root.hasAttribute('data-composer-keyboard');
      position.settling = false;
      if (!open) releaseKeyboardPosition();
      if (position.conversation === appState.current && mobileLayout.matches && !$('app').hidden && !readingGestureActive()) {
        if (position.nearBottom) scrollReadingToBottom();
        else if (!open) setReadingScrollTop(readingScroller(), position.top);
      }
      rememberReadingPosition();
    }, 450);
  };
  document.addEventListener('scroll', event => {
    if (event.target !== readingScroller() && event.target !== document) return;
    if (keyboardReadingPosition && readingGestureActive()) keepKeyboardPosition(captureReadingPosition());
    if ((!keyboardReadingPosition || readingGestureActive()) && same(geometry())) rememberReadingPosition();
  }, { passive: true, capture: true });
  const resize = () => {
    frame = undefined;
    if ($('app').hidden) return;
    const current = geometry();
    if (keyboardReadingPosition && (keyboardReadingPosition.conversation !== appState.current || !mobileLayout.matches)) releaseKeyboardPosition();
    const changed = !same(current);
    if (!changed && composerHeight === current.composer) {
      // Native focus panning can continue after the final resize. Let its
      // scroll events delay the one correction without changing page layout.
      if (keyboardReadingPosition?.settling) settleKeyboardPosition();
      return;
    }
    if (mobileLayout.matches && changed && (current.keyboardActive || previous.keyboardActive) &&
      !keyboardReadingPosition && rememberedReadingPosition && !readingGestureActive()) keepKeyboardPosition(rememberedReadingPosition);
    if (keyboardReadingPosition && changed) keyboardReadingPosition.settling = true;
    const position = keyboardReadingPosition || rememberedReadingPosition;
    // Increasing padding does not make the browser follow its new scroll end.
    // Only an editor opened from the bottom may bypass the settling guard;
    // viewport panning alone and a reader's drag must never force bottom-follow.
    const followOpening = mobileLayout.matches && keyboardReadingPosition?.nearBottom &&
      composer.contains(document.activeElement) && isEditableElement(document.activeElement) &&
      (current.clearance > previous.clearance + .5 || current.composer > previous.composer + .5) &&
      !readingGestureActive();
    if (current.composer !== composerHeight) {
      composerHeight = current.composer;
      root.style.setProperty('--composer-height', `${composerHeight}px`);
    }
    if (!current.keyboardActive && !composer.contains(document.activeElement)) {
      root.style.setProperty('--welcome-composer-height', `${composerHeight}px`);
    }
    if (current.root !== previous.root && !mobileLayout.matches) window.scrollTo(0, 0);
    previous = current;
    // Opening follows only the clearance growth captured above. Streaming,
    // history anchoring and dismissal retain the native-scroll settling guard.
    if (followOpening) scrollReadingToBottom();
    else if (position) restoreReadingPosition(position, false, true);
    rememberReadingPosition();
    if (keyboardReadingPosition) settleKeyboardPosition();
  };
  const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(resize); };
  const beforeKeyboard = event => {
    if (!mobileLayout.matches || $('app').hidden || !composer.contains(event.target) || !isEditableElement(event.target) ||
      Math.abs((window.visualViewport?.scale || 1) - 1) > .01) return;
    if (event.type !== 'focusout' && !root.hasAttribute('data-composer-keyboard')) focusGuard.prepare(event.target);
    if (event.type !== 'focusout') {
      // A deliberate editor tap/focus ends transcript momentum. Otherwise native
      // keyboard scrolling can be mistaken for a continuing reading gesture and
      // overwrite the bottom intent just as the keyboard clearance grows.
      readingTouch = false; readingMotionUntil = 0;
    }
    if (!keyboardReadingPosition) {
      const position = captureReadingPosition();
      if (!root.hasAttribute('data-composer-keyboard')) {
        const visibleBottom = visualViewportClientBottom(document);
        // WebKit may add a phantom root scroll tail. The actual transcript end
        // being visible also establishes bottom intent, without a 140px snap zone.
        if (timeline.getBoundingClientRect().bottom <= visibleBottom + 4) position.atBottom = true;
      }
      keepKeyboardPosition(position);
    }
    settleKeyboardPosition(); schedule();
  };
  // Pointer capture also covers reopening a keyboard whose textarea kept focus.
  document.addEventListener('pointerdown', beforeKeyboard, true);
  // A tap can last longer than the guard's two frames; refresh immediately
  // before the touch's default focus action, without cancelling caret placement.
  document.addEventListener('touchend', beforeKeyboard, { passive: true, capture: true });
  document.addEventListener('focusin', beforeKeyboard, true);
  document.addEventListener('focusout', beforeKeyboard, true);
  scheduleReadingViewport = schedule;
  flushReadingViewport = () => { if (frame !== undefined) cancelAnimationFrame(frame); resize(); };
  rememberReadingPosition();
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(schedule);
    for (const element of [timeline, composer, topbar, ...topbar.children]) observer.observe(element, { box: 'border-box' });
  }
  mobileLayout.addEventListener('change', schedule);
  schedule();
}
observeReadingViewport();
let reconnecting = false, feedbackNotice;
function renderStatusNotice() {
  // Keep action failures visible even while the event stream reconnects.
  const feedback = feedbackNotice && !(reconnecting && feedbackNotice.network && feedbackNotice.requestMethod === 'GET');
  const status = $('connection-status');
  status.hidden = !feedback && !reconnecting;
  status.dataset.kind = feedback ? feedbackNotice.kind : 'connection';
  $('connection').textContent = '正在重新连接…';
  $('connection').hidden = !!feedback;
  $('toast').textContent = feedback ? feedbackNotice.text : '';
  $('toast').hidden = !feedback;
  $('dismiss-notice').hidden = !feedback;
}
function toast(value) {
  const text = errorMessage(value);
  // A failed background refresh must not replace an unconfirmed user action.
  if (text && value?.requestMethod === 'GET' && feedbackNotice?.requestMethod && feedbackNotice.requestMethod !== 'GET') return;
  feedbackNotice = text ? { text, kind: typeof value === 'string' ? 'info' : value.network ? 'connection' : 'error',
    network: !!value.network, requestPath: value.requestPath, requestMethod: value.requestMethod } : undefined;
  renderStatusNotice();
}
$('dismiss-notice').onclick = () => toast('');
const conversationRead = (path, method = 'GET') => method === 'GET' && /^(conversations|messages)(?:\?|$)/.test(path);
async function request(path, options) {
  const context = { path, method: options.method || 'GET' };
  const sourceSignal = options.signal;
  const bounded = conversationRead(path, context.method) || /^models(?:\?|$|\/default$)/.test(path)
    || path === 'conversations' && context.method === 'POST';
  const deadline = bounded ? new AbortController() : undefined;
  const cancel = () => deadline.abort(sourceSignal.reason);
  let timeout;
  if (deadline) {
    if (sourceSignal?.aborted) cancel();
    else {
      sourceSignal?.addEventListener('abort', cancel, { once: true });
      timeout = setTimeout(() => deadline.abort(new DOMException('读取超时，请重试。', 'TimeoutError')), 8000);
    }
    options = { ...options, signal: deadline.signal };
  }
  let response;
  let outcome = 'ok';
  let headersMs = 0, background = document.hidden;
  const visibility = () => { background ||= document.hidden; };
  document.addEventListener('visibilitychange', visibility);
  let requestStarted = performance.now();
  const requestTrace = options.headers?.["X-Zigent-Trace"] || crypto.randomUUID();
  options.headers = { ...options.headers, "X-Zigent-Trace": requestTrace };
  try {
    if (path === 'bootstrap' && context.method === 'GET') window.ZigentStartupConsumed = true;
    const startupSource = path === 'bootstrap' && context.method === 'GET' ? window.ZigentStartup : undefined;
    const startup = startupSource?.takeBootstrap();
    const early = startup && await startup;
    if (early) { response = early; requestStarted = startupSource.started; }
    else response = await fetch(`${base}api/${path}`, options);
    headersMs = performance.now() - requestStarted;
    return { response, result: response.status === 304 ? undefined : await readJsonResponse(response, context) };
  } catch (error) {
    // Body readers can report AbortError even when the controller timed out.
    if (deadline?.signal.aborted) error = deadline.signal.reason;
    outcome = error.name === 'AbortError' ? 'cancelled' : 'error';
    if (error.status === 401 && path !== 'login') showLogin();
    throw requestError(error, context);
  } finally {
    clearTimeout(timeout); sourceSignal?.removeEventListener('abort', cancel);
    document.removeEventListener('visibilitychange', visibility);
    if (!path.startsWith('performance')) {
      const elapsed = performance.now() - requestStarted, trace = response?.headers.get('X-Zigent-Trace') || requestTrace;
      if (!response) headersMs = elapsed;
      const resource = response && performance.getEntriesByName(response.url, 'resource').find(entry => entry.serverTiming?.some(item => item.name === 'trace' && item.description === trace));
      const timing = { headersMs, bodyMs: Math.max(0, elapsed - headersMs), background, ...(resource ? {
        resourceMs: resource.duration, beforeResourceMs: Math.max(0, resource.startTime - requestStarted),
        ...(resource.responseEnd > 0 ? { afterResourceMs: Math.max(0, requestStarted + elapsed - resource.responseEnd) } : {}),
        ...(typeof resource.workerStart === 'number' ? { workerMs: resource.workerStart > 0 ? Math.max(0, resource.fetchStart - resource.workerStart) : 0 } : {})
      } : {}) };
      window.ZigentTelemetry?.record('web.api', elapsed, path, outcome, trace, timing);
      const server = /app;dur=([\d.]+)/.exec(response?.headers.get('Server-Timing') || '');
      if (server) window.ZigentTelemetry?.record('web.network', Math.max(0, elapsed - Number(server[1])), path, outcome, trace, timing);
    }
  }
}
async function api(path, method = 'GET', value, signal, validation) {
  const options = { method, credentials: 'same-origin', cache: 'no-store', signal };
  if (value !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(value); }
  if (path === 'messages' && method === 'POST' && value?.id) {
    options.headers = { ...options.headers, 'X-Zigent-Trace': value.id };
    window.ZigentTelemetry?.beginReply(value.id, value.conversationId, appState.current);
  }
  const cached = method === 'GET' && validation?.path === path && validation.etag ? { etag: validation.etag, result: validation.result } : undefined;
  if (cached) options.headers = { 'If-None-Match': cached.etag };
  let response, result;
  for (let attempt = 0; ; attempt++) {
    try { ({ response, result } = await request(path, options)); break; }
    catch (error) {
      // Retry only these idempotent reads, once, while their view is still active.
      if (attempt || !conversationRead(path, method) || !error.network || signal?.aborted
        || !appState.authenticated || document.hidden || navigator.onLine === false) throw error;
      await new Promise(resolve => setTimeout(resolve, 300));
      if (signal?.aborted) throw signal.reason;
      if (!appState.authenticated || document.hidden || navigator.onLine === false) throw error;
    }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const unchanged = response.status === 304 && cached?.result !== undefined;
  if (response.status === 304 && !unchanged) {
    throw Object.assign(new Error('缓存已失效，请刷新页面后重试（HTTP 304）。'), { status: response.status, requestPath: path, requestMethod: method });
  }
  if (feedbackNotice?.requestPath === path && feedbackNotice.requestMethod === method) toast('');
  if (unchanged) return cached.result;
  if (method === 'GET' && validation) Object.assign(validation, { path, etag: response.headers.get('ETag'), result });
  return result;
}
function showLogin() {
  $('startup-error').hidden = true;
  window.ZigentTelemetry?.enabled(false);
  messageRenderer.clearActivity();
  olderRequest?.abort(); olderRequest = undefined; $('older').disabled = false;
  cancelSpeech(); memoryVersion++;
  userMessageActions?.close(); replySelection?.close(); cancelEdit(false);
  saveComposerDraft(); draftRestored = false;
  messageOutbox.suspend();
  uploads = []; choosingImages = false; imageUploads.suspend(); renderUploads(); $('upload').value = '';
  replyQuotes = []; renderReplyQuotes();
  window.ZigentDocumentWorkspace?.clear();
  fileWorkbench?.clear();
  window.ZigentBrowser?.close();
  appState.browserSession = undefined; appState.browserVersion++; renderBrowserEntry();
  appState.authenticated = false; conversationSync.close(); $('app').hidden = true; $('login').hidden = false;
  historyViews.clear(); $('history').replaceChildren();
  reconnecting = false; toast('');
  closeMenu(false);
  for (const id of ['settings-dialog', 'model-dialog', 'memory-dialog', 'schedule-dialog', 'account-dialog', 'usage-dialog', 'automation-dialog', 'recovery-dialog', 'conversation-delete-dialog']) if ($(id).open) $(id).close();
  cancelModelLibraryLoad(); modelLibraryVersion++; modelLibraryCatalogue = undefined;
  $('model-library').replaceChildren(); selectedModel = ''; modelLibraryView = undefined;
  for (const article of $('messages').children) messageRenderer.disposeMessageOutputs(article);
  $('messages').replaceChildren(); appState.messages = []; appState.busy = false; appState.activeMessageId = undefined; appState.queuedMessages = []; renderQueue();
  interactionRenderer.clearExpiry();
}
async function branchReply(message, view) {
  if (forking) return;
  const selected = appState.current, selection = appState.selectionVersion;
  forking = true; view.feedback.textContent = '正在创建分支…'; renderMessages();
  const requestId = view.branchRequestId ??= crypto.randomUUID();
  try {
    const result = await api('branches', 'POST', { id: requestId, conversationId: selected, messageId: message.id });
    if (selection === appState.selectionVersion && appState.current === selected) {
      await selectConversation(result.id);
      toast('已创建分支，可以继续聊。');
      $('message').focus({ preventScroll: true });
    } else { toast('分支已保存到对话列表。'); await refresh(); }
    view.feedback.textContent = '';
  } catch (error) { view.feedback.textContent = `${error.message} 可再次点按重试。`; }
  finally { forking = false; renderMessages(); }
}
function cancelEdit(focus = true) {
  if (!editing) return;
  const prior = editing.priorDraft; editing = undefined;
  $('message').value = prior.text; uploads = prior.assets; replyQuotes = prior.quotes; appState.draftId = prior.id; renderReplyQuotes(); renderUploads(); resizeMessage();
  if (focus) $('message').focus({ preventScroll: true });
}
function editMessage(message) {
  if (forking || editing?.submitting) { toast('请等待当前操作完成后再编辑。'); return; }
  cancelSpeech();
  const priorDraft = editing?.priorDraft || { text: $('message').value, assets: [...uploads], quotes: [...replyQuotes], id: appState.draftId };
  editing = { conversationId: appState.current, messageId: message.id, priorDraft };
  $('message').value = message.text; uploads = [...(message.assets || [])]; replyQuotes = []; appState.draftId = undefined;
  toast(''); renderReplyQuotes(); renderUploads(); $('message').focus({ preventScroll: true });
  $('message').setSelectionRange(message.text.length, message.text.length); resizeMessage();
}
function addReplyToConversation(text) {
  if (speechBusy || editing?.submitting) { toast('请等待当前输入操作完成后再添加。'); return false; }
  const input = $('message'), quotes = replyQuotes.some(quote => quote.text === text) ? replyQuotes : [...replyQuotes, { id: crypto.randomUUID(), text }];
  if (composeMessageText(input.value.trim(), quotes).length > input.maxLength) { toast('所选内容与草稿超过输入长度，请缩短后重试。'); return false; }
  replyQuotes = quotes; appState.draftId = undefined; toast(''); renderReplyQuotes();
  input.focus({ preventScroll: true });
  renderSend(); resizeMessage();
}
async function addReplyToNewConversation(text, selected, branch = false) {
  if (forking || messageSending || speechBusy || choosingImages || editing?.submitting || modelSaving) {
    toast('请等待当前输入操作完成后再添加。'); return false;
  }
  const conversationId = appState.current, selection = appState.selectionVersion;
  const messageId = selected.body.closest('.message')?.dataset.id;
  const message = appState.messages.find(item => item.id === messageId && item.role === 'assistant');
  if (branch && (!message || message.snapshot && message.snapshot.status !== 'completed')) {
    toast('请等待完整回复后再创建分支。'); return false;
  }
  const draft = editing?.priorDraft.text ?? $('message').value;
  if (composeMessageText(draft.trim(), [{ text }]).length > $('message').maxLength) {
    toast('所选内容与草稿超过输入长度，请缩短后重试。'); return false;
  }
  if (branch && (replySelectionBranchRequest?.conversationId !== conversationId || replySelectionBranchRequest?.messageId !== messageId)) {
    replySelectionBranchRequest = { id: crypto.randomUUID(), conversationId, messageId };
  }
  forking = true; toast(''); renderMessages(); renderSend();
  try {
    const result = await api(branch ? 'branches' : 'conversations', 'POST', branch ? replySelectionBranchRequest : {});
    if (!appState.authenticated || selection !== appState.selectionVersion || appState.current !== conversationId) {
      if (appState.authenticated) { toast('会话已创建，请从对话列表打开。'); await refresh(); }
      return false;
    }
    // Selection clears the old quote cards synchronously. Add the captured text
    // immediately so a slow history read cannot overwrite a later composer edit.
    const selecting = selectConversation(result.id, result.greeting);
    const added = addReplyToConversation(text);
    if (branch) replySelectionBranchRequest = undefined;
    await selecting;
    return added;
  } catch (error) { toast(error); return false; }
  finally { forking = false; renderMessages(); renderSend(); }
}
function composeMessageText(text, quotes = replyQuotes) {
  return [...quotes.map(quote => quote.text.split(/\r?\n/).map(line => `> ${line}`).join('\n')), text].filter(Boolean).join('\n\n');
}
function replyQuoteCard(text) {
  const card = el('div', 'composer-quote'), mark = el('span', 'composer-quote-icon');
  card.setAttribute('role', 'group'); card.setAttribute('aria-label', '引用');
  mark.setAttribute('aria-hidden', 'true');
  const excerpt = el('blockquote', 'composer-quote-text', text); excerpt.title = text;
  card.append(mark, excerpt); return card;
}
function userMessageText(text) {
  const body = el('div', 'message-text'), lines = text.replace(/\r\n?/g, '\n').split('\n');
  const quotes = el('div', 'message-quotes'); let index = 0;
  // Composer quotes are stored as leading Markdown quote blocks. Decode only
  // that prefix so ordinary user text, code and line breaks stay literal.
  while (index < lines.length && /^ {0,3}>/.test(lines[index])) {
    const quoted = [];
    while (index < lines.length && /^ {0,3}>/.test(lines[index])) quoted.push(lines[index++].replace(/^ {0,3}> ?/, ''));
    quotes.append(replyQuoteCard(quoted.join('\n')));
    while (index < lines.length && !lines[index].trim()) index++;
  }
  if (!quotes.childNodes.length) { body.textContent = text; return body; }
  body.append(quotes);
  if (index < lines.length) body.append(el('div', 'message-draft', lines.slice(index).join('\n')));
  return body;
}
function renderReplyQuotes() {
  $('reply-quotes').replaceChildren(...replyQuotes.map(quote => {
    const card = replyQuoteCard(quote.text), remove = el('button', 'composer-quote-remove');
    remove.type = 'button'; remove.setAttribute('aria-label', '移除引用'); remove.title = '移除引用';
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    remove.onclick = () => {
      if (editing?.submitting) return;
      replyQuotes = replyQuotes.filter(item => item.id !== quote.id); appState.draftId = undefined;
      renderReplyQuotes(); $('message').focus({ preventScroll: true }); renderSend(); resizeMessage();
    };
    card.append(remove); return card;
  }));
}
async function submitEdit(text, submittedAt) {
  const edit = editing, selection = appState.selectionVersion, assets = [...uploads];
  if (!edit || edit.submitting) return;
  const attempt = edit.attempt ??= { sendId: crypto.randomUUID() }; edit.submitting = true; renderSend();
  window.ZigentTelemetry?.beginReply(attempt.sendId, edit.conversationId, appState.current, submittedAt);
  try {
    const result = await api('messages', 'POST', { id: attempt.sendId, conversationId: edit.conversationId, editMessageId: edit.messageId, text, assets });
    if (editing === edit && selection === appState.selectionVersion) {
      cancelEdit(false); toast(''); await selectConversation(result.conversationId || edit.conversationId);
    } else { await refresh(); }
  } catch (error) { toast(error); }
  finally { edit.submitting = false; renderSend(); }
}
function waitingForQuestion() {
  return appState.messages.some(message => messageInteractions(message).some(item => item.kind === 'user-question' && interactionStatus(item) === 'pending'));
}
async function openConversationDocument(item, message, documentId, trigger) {
  if (!appState.current) return;
  const selection = appState.selectionVersion;
  const scope = { conversationId: appState.current, messageId: message.id, interactionId: item.id, documentId };
  const read = async () => (await api(`documents?${new URLSearchParams(scope)}`)).document;
  if (trigger) trigger.disabled = true;
  try {
    const [document] = await Promise.all([read(), loadDocumentWorkspace()]);
    // A response from a conversation left while loading must not open over the new one.
    if (selection !== appState.selectionVersion || appState.current !== scope.conversationId || !appState.authenticated) return;
    window.ZigentDocumentWorkspace.open({ key: JSON.stringify(scope), ...document,
      saveRequired: document.editable !== false && document.pending === true,
      saveLabel: item.kind === 'memory-proposal' ? documentId.startsWith('archive-') ? '保存到存档记忆' : '保存到长期记忆' : '保存修改',
      onReload: read,
      onSave: document.editable === false ? undefined : async ({ content, revision }) => {
        const result = await api('documents', 'POST', { ...scope, content, revision });
        await refresh(); return result.document;
      }
    });
  } catch (error) { toast(error); }
  finally { if (trigger) trigger.disabled = false; }
}
function queueButton(label, path, action) {
  const button = el('button', 'queue-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
  button.onclick = action; return button;
}
function renderQueue() {
  const section = $('message-queue'), list = $('queue-list');
  const visible = [...appState.queuedMessages];
  for (const item of queueRetakes.values()) if (item.conversationId === appState.current && !visible.some(message => message.id === item.message.id)) visible.push(item.message);
  section.hidden = !visible.length;
  $('queue-count').textContent = visible.length ? `等待发送 · ${visible.length}` : '';
  const rows = [], retained = new Set();
  for (const message of visible) {
    retained.add(message.id);
    let view = queueViews.get(message.id);
    if (!view) {
      const row = el('div', 'queue-item'), preview = el('div', 'queue-preview'), text = el('p', 'queue-text'), assets = el('div', 'queue-assets');
      row.dataset.id = message.id; row.setAttribute('role', 'listitem'); preview.append(text, assets);
      const actions = el('div', 'queue-actions');
      const steer = queueButton('立即插入', 'M5 12h14m-6-6 6 6-6 6', () => void queueAction(message.id, 'steer'));
      steer.classList.add('queue-steer'); steer.append(el('span', '', 'Steer'));
      const edit = queueButton('取回编辑', 'm14 5 5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16l-1 4Z', () => void queueAction(message.id, 'edit'));
      const remove = queueButton('移除等待消息', 'm6 6 12 12M6 18 18 6', () => void queueAction(message.id, 'cancel'));
      actions.append(steer, edit, remove);
      const feedback = el('div', 'queue-feedback'), error = el('span'), retry = el('button', 'queue-retry', '重试');
      retry.type = 'button'; retry.onclick = () => void queueAction(message.id, queueErrors.get(message.id)?.action || 'retry');
      feedback.setAttribute('role', 'status'); feedback.append(error, retry); row.append(preview, actions, feedback);
      view = { row, text, assets, steer, edit, remove, feedback, error, retry, assetKey: '' }; queueViews.set(message.id, view);
    }
    view.text.textContent = message.text || '附件';
    const assetKey = JSON.stringify([message.assets, message.files]);
    if (view.assetKey !== assetKey) {
      view.assetKey = assetKey;
      view.assets.replaceChildren(...message.assets.map(id => {
        if (message.files?.[id]) return el('span', 'queue-document', message.files[id].name);
        const image = el('img'); image.decoding = 'async'; image.src = assetUrl(id, true); image.alt = '待发送图片'; return image;
      }));
    }
    view.assets.hidden = !message.assets.length;
    const error = queueErrors.get(message.id)?.message || message.error;
    view.feedback.hidden = !error; view.error.textContent = error || '';
    for (const control of [view.steer, view.edit, view.remove, view.retry]) control.disabled = queueRequests.has(message.id);
    view.steer.hidden = view.remove.hidden = queueRetakes.has(message.id);
    view.row.setAttribute('aria-busy', String(queueRequests.has(message.id))); rows.push(view.row);
  }
  for (const id of queueViews.keys()) if (!retained.has(id)) { queueViews.delete(id); queueErrors.delete(id); }
  syncChildren(list, rows);
}
async function queueAction(id, action) {
  if (queueRequests.has(id)) return;
  const selected = appState.current, message = appState.queuedMessages.find(item => item.id === id) || queueRetakes.get(id)?.message;
  if (!message) return;
  if (action === 'edit' && (editing || messageSending || speechBusy)) { toast('请先完成当前输入操作。'); return; }
  if (action === 'edit' && (uploads.length + message.assets.filter(id => !uploads.includes(id)).length > 4 || message.text.length + $('message').value.length + 2 > 16000)) {
    toast('请先发送当前草稿，再取回这条消息。'); return;
  }
  if (action === 'edit') {
    queueRetakes.set(id, { conversationId: selected, message });
    for (const [id, file] of Object.entries(message.files || {})) imageUploads.restore({ id, ...file, document: true });
  }
  queueRequests.add(id); queueErrors.delete(id); renderQueue();
  try {
    await api('messages/queue', 'POST', { conversationId: selected, id, action: action === 'edit' ? 'cancel' : action });
    if (appState.current !== selected) {
      if (action === 'edit') queueErrors.set(id, { action, message: '已取回，点击重试继续编辑。' });
      return;
    }
    if (action !== 'retry') { appState.queueVersion++; appState.queuedMessages = appState.queuedMessages.filter(item => item.id !== id); }
    if (action === 'edit') {
      if (uploads.length + message.assets.filter(id => !uploads.includes(id)).length > 4 || message.text.length + $('message').value.length + 2 > 16000)
        throw new Error('请先发送当前草稿，再重试取回。');
      $('message').value = [message.text, $('message').value].filter(Boolean).join('\n\n');
      queueRetakes.delete(id);
      uploads = [...new Set([...message.assets, ...uploads])]; appState.draftId = undefined; renderUploads(); resizeMessage(); $('message').focus();
    }
    renderQueue();
    await refresh();
  } catch (error) {
    if (appState.current === selected) queueErrors.set(id, { action, message: error.message });
  } finally { queueRequests.delete(id); renderQueue(); renderSend(); }
}
async function stopCurrentReply() {
  const selected = appState.current, messageId = appState.activeMessageId;
  if (!appState.busy || !selected || !messageId || stoppingReplies.has(messageId)) return;
  stoppingReplies.add(messageId); toast(''); renderSend();
  try { await api('messages/stop', 'POST', { conversationId: selected, messageId }); await refresh(); }
  catch (error) { if (appState.current === selected) toast(error); }
  finally { stoppingReplies.delete(messageId); renderSend(); }
}
function renderSend() {
  saveComposerDraft();
  syncComposer();
  const text = $('message').value.trim();
  const hasDraft = Boolean(text || replyQuotes.length || uploads.length || choosingImages || speechBusy);
  const stop = appState.busy && !editing && !hasDraft;
  const stopping = stoppingReplies.has(appState.activeMessageId);
  const waiting = messageSending || forking || editing?.submitting || speechSubmitting || modelSaving || stopping;
  const uploading = Boolean(editing) && uploads.some(id => !imageUploads.isReady(id));
  const button = $('send');
  button.type = stop ? 'button' : 'submit';
  button.disabled = waiting || choosingImages || uploading || (stop ? !appState.activeMessageId : !hasDraft);
  button.classList.toggle('is-stopping', stop);
  button.textContent = waiting ? '···' : stop ? '■' : '↑';
  const label = stopping ? '正在停止' : waiting ? '正在发送' : choosingImages ? '正在选择附件' : uploading ? '请等待附件上传完成或移除失败附件' : stop ? '停止回复' : editing ? '发送编辑后的消息' : !replyQuotes.length && text.toLowerCase() === '/new' ? '开始新对话' : '发送消息';
  button.setAttribute('aria-label', label); button.title = label;
}
function saveComposerDraft() {
  if (!draftRestored || !appState.authenticated) return;
  const prior = editing?.priorDraft;
  const value = { text: prior ? prior.text : $('message').value, assets: (prior?.assets || uploads).map(id => imageUploads.describe(id)),
    quotes: prior?.quotes || replyQuotes, id: prior ? prior.id : appState.draftId };
  const signature = JSON.stringify(value);
  if (signature === draftSignature) return;
  draftSignature = signature;
  draftSave = draftSave.catch(() => {}).then(() => uploadStorage.saveDraft(value)).catch(error => {
    draftSignature = '';
    if (!draftStorageError) { draftStorageError = true; toast(error); }
  });
}
$('send').onclick = () => { if ($('send').type === 'button') void stopCurrentReply(); };
function renderHistory() {
  const query = appState.historyQuery;
  const local = messageOutbox.conversations().filter(item => !appState.historyRows.some(row => row.id === item.id)
    && (!query || item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const filtered = [...local, ...appState.historyRows];
  const ids = new Set([...filtered, ...appState.conversations].map(item => item.id));
  for (const id of historyViews.keys()) if (!ids.has(id)) historyViews.delete(id);
  $('history-empty').hidden = filtered.length > 0;
  $('history-empty').textContent = appState.historyLoading ? '正在搜索…' : appState.historyError || (query ? '没有找到相关对话' : '还没有对话');
  $('history').setAttribute('aria-busy', String(appState.historyLoading));
  $('history-more').hidden = !appState.historyNextCursor && !appState.historyError;
  $('history-more').disabled = appState.historyLoading;
  $('history-more').textContent = appState.historyLoading ? '正在加载…' : appState.historyError ? '重试' : '加载更多';
  syncChildren($('history'), filtered.map(conversation => {
    let view = historyViews.get(conversation.id);
    if (!view) {
      const button = el('button'), saved = { ...conversation };
      button.dataset.conversationId = conversation.id;
      button.onclick = event => { if (heldConversation === saved.id) { heldConversation = undefined; event?.preventDefault(); return; } void selectConversation(saved.id); };
      button.addEventListener('pointerenter', event => { if (event.pointerType === 'mouse') conversationSync.prefetchConversation(saved.id); });
      button.addEventListener('focus', () => conversationSync.prefetchConversation(saved.id));
      button.addEventListener('pointerdown', event => { if (event.isPrimary && event.button === 0) conversationSync.prefetchConversation(saved.id, 0); });
      button.addEventListener('pointerleave', () => conversationSync.cancelPrefetch(saved.id));
      button.addEventListener('blur', () => conversationSync.cancelPrefetch(saved.id));
      bindHistoryDeletion(button, saved);
      view = { button, conversation: saved }; historyViews.set(conversation.id, view);
    }
    Object.assign(view.conversation, conversation);
    const { button } = view, active = conversation.id === appState.current;
    if (button.textContent !== conversation.title) button.textContent = conversation.title;
    if (button.title !== conversation.title) button.title = conversation.title;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    return button;
  }));
}
let deleteConversationTarget, deletingConversation = false, historyHold, heldConversation;
function cancelHistoryHold() { clearTimeout(historyHold?.timer); historyHold = undefined; }
function requestConversationDeletion(conversation, trigger) {
  cancelHistoryHold();
  if (deletingConversation || $('conversation-delete-dialog').open) return;
  deleteConversationTarget = conversation;
  $('conversation-delete-name').textContent = conversation.title;
  $('conversation-delete-status').hidden = true;
  $('conversation-delete-submit').textContent = '删除';
  openPanel('conversation-delete-dialog', trigger);
}
function bindHistoryDeletion(button, conversation) {
  button.addEventListener('pointerdown', event => {
    cancelHistoryHold(); heldConversation = undefined;
    if (!event.isPrimary || event.button !== 0) return;
    const hold = historyHold = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, conversationId: conversation.id };
    hold.timer = setTimeout(() => {
      if (historyHold !== hold || !button.isConnected) return;
      heldConversation = conversation.id;
      requestConversationDeletion(conversation, button);
    }, 550);
  });
  button.addEventListener('contextmenu', event => { event.preventDefault(); heldConversation = conversation.id; requestConversationDeletion(conversation, button); });
  button.addEventListener('keydown', event => {
    if (event.key !== 'Delete' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault(); requestConversationDeletion(conversation, button);
  });
}
document.addEventListener('pointermove', event => {
  if (historyHold && (event.pointerId !== historyHold.pointerId || Math.hypot(event.clientX - historyHold.x, event.clientY - historyHold.y) > 8)) { heldConversation = historyHold.conversationId; cancelHistoryHold(); }
});
document.addEventListener('pointerdown', event => { if (historyHold && event.pointerId !== historyHold.pointerId) cancelHistoryHold(); });
document.addEventListener('pointerup', cancelHistoryHold);
document.addEventListener('pointercancel', cancelHistoryHold);
$('history').addEventListener('scroll', cancelHistoryHold);
window.addEventListener('blur', cancelHistoryHold);
document.addEventListener('visibilitychange', cancelHistoryHold);
$('conversation-delete-cancel').onclick = () => closePanel('conversation-delete-dialog');
$('conversation-delete-dialog').addEventListener('cancel', event => { if (deletingConversation) event.preventDefault(); });
$('conversation-delete-submit').onclick = async () => {
  if (!deleteConversationTarget || deletingConversation) return;
  const target = deleteConversationTarget;
  deletingConversation = true;
  $('conversation-delete-cancel').disabled = $('conversation-delete-submit').disabled = true;
  $('conversation-delete-submit').textContent = '删除中';
  $('conversation-delete-status').hidden = true;
  try {
    await api('conversations', 'DELETE', { conversationId: target.id });
    await messageOutbox.discardConversation(target.id);
    appState.conversations = appState.conversations.filter(item => item.id !== target.id);
    appState.historyRows = appState.historyRows.filter(item => item.id !== target.id);
    if (appState.current === target.id) await selectConversation(appState.conversations[0]?.id);
    else { renderHistory(); await refresh(); }
    closePanel('conversation-delete-dialog');
  } catch (error) {
    $('conversation-delete-status').textContent = error.message || '删除失败，请重试。';
    $('conversation-delete-status').hidden = false;
    $('conversation-delete-submit').textContent = '重试删除';
  } finally {
    deletingConversation = false;
    $('conversation-delete-cancel').disabled = $('conversation-delete-submit').disabled = false;
  }
};
function closeMenu(restore = true) {
  cancelHistoryHold();
  const wasOpen = $('sidebar').classList.contains('open');
  $('sidebar').classList.remove('open'); $('scrim').hidden = true; syncSidebar();
  if (wasOpen && restore) drawerReturnFocus?.focus({ preventScroll: true });
}
function openMenu() {
  if (!mobileLayout.matches) { setSidebarCollapsed(false); $('close-sidebar').focus({ preventScroll: true }); return; }
  drawerReturnFocus = $('menu');
  $('sidebar').classList.add('open'); $('scrim').hidden = false; syncSidebar();
  // Opening history is a navigation action. Let the user choose when to search
  // instead of immediately summoning Safari's keyboard and focus zoom/pan.
  $('close-sidebar').focus({ preventScroll: true });
}
function openPanel(id, trigger) {
  const panel = $(id); panelReturnFocus.set(panel, trigger || document.activeElement); panel.showModal();
}
function closePanel(id) { $(id).close(); }
for (const id of ['settings-dialog', 'model-dialog', 'memory-dialog', 'schedule-dialog', 'account-dialog', 'usage-dialog', 'automation-dialog', 'recovery-dialog', 'conversation-delete-dialog']) {
  const panel = $(id);
  panel.addEventListener('click', event => { if (event.target === panel && !(id === 'conversation-delete-dialog' && deletingConversation)) panel.close(); });
  panel.addEventListener('close', () => {
    if (id === 'model-dialog') { cancelModelLibraryLoad(); modelLibraryVersion++; }
    if (!appState.authenticated) return;
    if (id === 'conversation-delete-dialog') {
      heldConversation = undefined;
      const row = [...$('history').children].find(node => node.dataset.conversationId === deleteConversationTarget?.id);
      (row || $('history-search')).focus({ preventScroll: true });
    } else panelReturnFocus.get(panel)?.focus();
  });
}
document.addEventListener('keydown', event => {
  if (!mobileLayout.matches || !$('sidebar').classList.contains('open') || $('conversation-delete-dialog').open) return;
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...$('sidebar').querySelectorAll('a[href], button:not([disabled]), input')].filter(node => !node.hidden && node.getClientRects().length);
  const first = controls[0], last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
async function enter() {
  const started = window.ZigentStartup?.started ?? performance.now();
  const bootstrap = await api('bootstrap'), { me } = bootstrap;
  // Keep only this navigation's initial milestones; later login/reconnects are not page startup.
  const initial = !performance.getEntriesByName('zigent:bootstrap-ready').length;
  if (initial) performance.mark('zigent:bootstrap-ready');
  agentName = me.name; defaultModel = me.defaultModel || ''; selectedModel = defaultModel;
  modelLibraryCatalogue = bootstrap.modelLibrary;
  window.ZigentTriggerContext?.capabilities(me.triggerCapabilities);
  appState.homeGreeting = me.greeting || ''; appState.conversationGreeting = '';
  $('open-schedule').hidden = !me.schedule;
  $('open-memory').hidden = !me.memory;
  $('open-files').hidden = !me.workbench;
  $('open-recovery').hidden = me.recovery === false;
  speechConfigured = Boolean(me.speech); renderSpeech();
  window.ZigentTelemetry?.enabled(true);
  appState.authenticated = true; $('login').hidden = true; $('app').hidden = false;
  renderModel(); $('message').placeholder = `和 ${agentName} 聊聊`;
  $('password').value = ''; $('login-error').textContent = '';
  if (initial) performance.mark('zigent:initial-render-start');
  await conversationSync.bootstrap(bootstrap, started);
  if (initial) performance.mark('zigent:initial-render-end');
  try { await messageOutbox.restore(); } catch (error) { toast(error); }
  try {
    await draftSave;
    const draft = await uploadStorage.draft();
    if (draft && !uploads.length && !$('message').value && !editing) {
      // Enqueue is persisted before clearing the composer; a reload in between must
      // not restore a second sendable copy of the submitted message.
      if (!draft.id || !messageOutbox.contains(draft.id)) {
        $('message').value = draft.text || ''; replyQuotes = draft.quotes || []; appState.draftId = draft.id;
        uploads = [];
        for (const asset of draft.assets || []) {
          try { uploads.push(await imageUploads.restore(asset)); } catch (error) { toast(error); }
        }
      }
    }
  } catch (error) { toast(error); }
  if (!appState.authenticated) { imageUploads.suspend(); return; }
  draftRestored = true; draftSignature = ''; renderReplyQuotes(); renderUploads(); resizeMessage(); imageUploads.resume();
  connectEvents();
}
async function newChat() { try { const result = await api('conversations', 'POST', {}); await selectConversation(result.id, result.greeting); $('message').focus(); } catch (error) { toast(error); } }
$('login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('login-error').textContent = '';
  try { await api('login', 'POST', { password: $('password').value }); await start(); } catch (error) { $('login-error').textContent = error.message; } finally { button.disabled = false; }
};
$('show-password').onclick = () => { const show = $('password').type === 'password'; $('password').type = show ? 'text' : 'password'; $('show-password').textContent = show ? '隐藏' : '显示'; $('show-password').setAttribute('aria-label', show ? '隐藏密码' : '显示密码'); };
$('new-mobile').onclick = newChat;
$('branch-origin').onclick = async () => { if (appState.branchOrigin) await selectConversation(appState.branchOrigin.conversationId); };
$('menu').onclick = openMenu; $('scrim').onclick = () => closeMenu(); $('close-sidebar').onclick = () => { if (mobileLayout.matches) closeMenu(); else { setSidebarCollapsed(true); $('menu').focus({ preventScroll: true }); } };
$('history-search').oninput = () => conversationSync.searchHistory($('history-search').value);
$('history-more').onclick = () => conversationSync.loadMoreHistory();
// Open the native picker within the user's click so Safari keeps user activation.
$('add-attachment').onclick = () => {
  if (messageSending || editing?.submitting) return;
  if (uploads.length >= 4) { toast('每次最多发送 4 个附件。'); return; }
  choosingImages = true; renderUploads();
  try { $('upload').click(); }
  catch (error) { choosingImages = false; renderUploads(); toast(error); }
};
$('upload').oncancel = () => { choosingImages = false; renderUploads(); };
$('set-default-model').onclick = async () => {
  const button = $('set-default-model'); button.disabled = true;
  try { const saved = await api('models/default', 'POST', { model: selectedModel }); defaultModel = saved.defaultModel; renderModel(); }
  catch (error) { $('model-library-status').textContent = error.message; }
  finally { renderModel(); }
};
function renderModel() {
  $('set-default-model').disabled = !selectedModel || selectedModel === defaultModel || modelSaving;
  $('set-default-model').textContent = selectedModel === defaultModel ? '默认模型' : '设为默认';
  $('model-name').textContent = selectedModel || '选择模型';
  $('model-picker').title = selectedModel;
  $('model-picker').setAttribute('aria-label', selectedModel ? `选择模型，当前 ${selectedModel}` : '选择模型');
}
function cancelModelLibraryLoad() {
  modelLibraryRequest?.abort(); modelLibraryRequest = undefined;
}
function rememberModelLibrary(interaction) {
  // Recovery availability belongs to one failed request, never to the cached catalogue.
  modelLibraryCatalogue = { ...interaction, actions: interaction.actions.map(action => {
    const { disabled, ...entry } = action;
    return entry;
  }) };
}
function showModelLibrary(interaction, target, recoveryRequestId) {
  let selection = appState.selectionVersion;
  const current = () => appState.authenticated && appState.current === target && appState.selectionVersion === selection;
  $('model-library-status').textContent = interaction.actions.length ? '' : '暂无可用模型，请稍后重新加载。';
  $('retry-models').hidden = interaction.actions.length > 0;
  const choose = async action => {
    if (!current()) throw new Error('当前对话已变化，请重新打开模型库。');
    if (modelSaving) throw new Error('正在保存模型，请稍后重试。');
    cancelModelLibraryLoad();
    modelSaving = true; renderModel(); $('send').disabled = true;
    try {
      // Opening the catalogue never creates or loads a conversation. Defer that work until selection.
      if (!target) {
        const created = await api('conversations', 'POST', {});
        if (!current()) throw new Error('当前对话已变化，请重新打开模型库。');
        target = created.id;
        const selecting = selectConversation(target, created.greeting);
        selection = appState.selectionVersion;
        await selecting;
      }
      if (!current()) throw new Error('当前对话已变化，请重新打开模型库。');
      const saved = await api('models', 'POST', { conversationId: target, actionId: action.id,
        ...(recoveryRequestId ? { fallbackRequestId: recoveryRequestId } : {}),
        ...(action.value.reasoningEffort !== undefined ? { reasoningEffort: action.value.reasoningEffort } : {}) });
      if (current()) {
        appState.selectedModel = selectedModel = saved.selectedModel; renderModel();
        rememberModelLibrary(saved.interaction);
        Object.assign(interaction, saved.interaction);
        if (recoveryRequestId) { closePanel('model-dialog'); await refresh(); }
      }
    } finally { modelSaving = false; renderModel(); renderSend(); }
  };
  modelLibraryView = renderInteraction(interaction, undefined, undefined, choose);
  $('model-library').replaceChildren(modelLibraryView.node);
}
async function loadModelLibrary(recoveryRequestId, reload = false) {
  cancelModelLibraryLoad();
  modelRecoveryRequestId = recoveryRequestId;
  const version = ++modelLibraryVersion;
  const target = appState.current, selection = appState.selectionVersion;
  if (modelLibraryCatalogue) {
    const interaction = structuredClone(modelLibraryCatalogue);
    for (const action of interaction.actions) {
      action.selected = action.id === (selectedModel || defaultModel);
      if (recoveryRequestId) action.disabled = true;
    }
    showModelLibrary(interaction, target, recoveryRequestId);
    if (!recoveryRequestId && !reload) return;
  } else { $('model-library').replaceChildren(); modelLibraryView = undefined; }
  $('model-library-status').textContent = '正在加载模型库…'; $('retry-models').hidden = true;
  const controller = new AbortController(); modelLibraryRequest = controller;
  try {
    const query = new URLSearchParams();
    if (target) query.set('conversationId', target);
    if (recoveryRequestId) query.set('fallbackRequestId', recoveryRequestId);
    const result = await api(`models${query.toString() ? `?${query}` : ''}`, 'GET', undefined, controller.signal);
    if (controller.signal.aborted || version !== modelLibraryVersion || selection !== appState.selectionVersion || !appState.authenticated) return;
    rememberModelLibrary(result.interaction);
    appState.selectedModel = selectedModel = result.selectedModel; renderModel();
    showModelLibrary(result.interaction, target, recoveryRequestId);
  } catch (error) {
    if (controller.signal.aborted || version !== modelLibraryVersion || selection !== appState.selectionVersion || !appState.authenticated) return;
    $('model-library-status').textContent = error.message; $('retry-models').hidden = false;
  } finally {
    if (modelLibraryRequest === controller) modelLibraryRequest = undefined;
  }
}
$('model-picker').onclick = () => { openPanel('model-dialog', $('model-picker')); void loadModelLibrary(); };
$('close-model').onclick = () => closePanel('model-dialog');
$('retry-models').onclick = () => { void loadModelLibrary(modelRecoveryRequestId, true); };
function resizeMessage() {
  $('message').style.height = 'auto';
  if ($('composer').classList.contains('is-expanded')) $('message').style.height = `${Math.min($('message').scrollHeight, 180)}px`;
}
let composerPointerActive = false;
function syncComposer() {
  const composer = $('composer'), message = $('message'), wasExpanded = composer.classList.contains('is-expanded');
  // Keep the toolbar steady while moving focus into its controls or sheets.
  // An empty, blurred editor collapses before the keyboard returns the dock;
  // retaining it for keyboard/motion flags adds a second layout jump at rest.
  const expanded = Boolean(editing) || choosingImages || document.activeElement === message || message.value.length > 0 || replyQuotes.length > 0 || uploads.length > 0 || wasExpanded &&
    (composerPointerActive || composer.contains(document.activeElement) || $('model-dialog').open);
  if (expanded === wasExpanded) return;
  if (expanded) composer.classList.add('is-expanded'); else composer.classList.remove('is-expanded');
  resizeMessage();
}
let lastModelWarmupKey = '', lastModelWarmupAt = -Infinity;
function warmSelectedModel() {
  if (!appState.authenticated || document.hidden || navigator.onLine === false || !(selectedModel || defaultModel)) return;
  const conversationId = appState.current || undefined;
  const key = `${conversationId || ''}\0${selectedModel || defaultModel}`, now = performance.now();
  if (key === lastModelWarmupKey && now - lastModelWarmupAt < 30000) return;
  lastModelWarmupKey = key; lastModelWarmupAt = now;
  void api('models/prewarm', 'POST', conversationId ? { conversationId } : {}).catch(() => {});
}
$('message').onfocus = () => { syncComposer(); warmSelectedModel(); };
$('composer').addEventListener('focusin', syncComposer);
$('composer').addEventListener('focusout', () => requestAnimationFrame(syncComposer));
// Safari can blur the editor before clicking a toolbar button without focusing
// that button. Keep its row in place until the pointer's click has completed.
$('composer').addEventListener('pointerdown', () => { composerPointerActive = true; });
function releaseComposerPointer() { requestAnimationFrame(() => { composerPointerActive = false; syncComposer(); }); }
document.addEventListener('pointerup', releaseComposerPointer);
document.addEventListener('pointercancel', releaseComposerPointer);
window.addEventListener('blur', releaseComposerPointer);
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('message').value = button.dataset.prompt; $('message').focus(); renderSend(); resizeMessage(); }; });
$('message').addEventListener('compositionstart', () => { speechComposing = true; });
$('message').addEventListener('compositionend', () => {
  speechComposing = false;
  speechDraft?.edit($('message').value);
  if (speechPending !== undefined) { const text = speechPending; speechPending = undefined; applySpeechText(text); }
});
$('message').oninput = () => { speechDraft?.edit($('message').value); appState.draftId = undefined; warmSelectedModel(); renderSend(); resizeMessage(); };
$('message').addEventListener('keydown', event => {
  if (event.key === 'Escape' && editing && !editing.submitting) { event.preventDefault(); cancelEdit(); }
});
function renderSpeech() {
  const supported = window.ZigentSpeechInput?.supported();
  const state = speechInput?.state || 'idle';
  const label = !supported ? '当前浏览器不支持语音输入' : !speechConfigured ? '语音输入尚未配置' : state === 'starting' ? '取消连接麦克风' : state === 'paused' ? '麦克风恢复中，点按结束' : state === 'reconnecting' ? '连接恢复中，点按结束' : state === 'listening' ? '结束语音输入' : state === 'finishing' ? '正在完成转录' : '开始语音输入';
  $('microphone').disabled = !supported || !speechConfigured || state === 'finishing' || speechSubmitting;
  $('microphone').title = label; $('microphone').setAttribute('aria-label', label);
  $('microphone').setAttribute('aria-pressed', String(speechBusy));
  $('microphone').classList.toggle('is-recording', speechBusy);
  const loading = ['starting', 'finishing', 'paused', 'reconnecting'].includes(state);
  $('microphone').classList.toggle('is-loading', loading);
  $('microphone').setAttribute('aria-busy', String(loading));
}
function speechCursorLine(input, position) {
  // The usual append case scrolls directly to the bottom. Measure a wrapped
  // line only when dictating into the middle of an existing draft.
  const style = getComputedStyle(input), mirror = document.createElement('div'), marker = document.createElement('span');
  for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textAlign', 'textIndent', 'textTransform', 'direction', 'tabSize', 'wordBreak', 'overflowWrap']) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
    boxSizing: 'border-box', width: `${input.clientWidth}px`, whiteSpace: 'pre-wrap' });
  mirror.setAttribute('aria-hidden', 'true');
  marker.textContent = input.value.slice(position) || '\u200b';
  mirror.append(document.createTextNode(input.value.slice(0, position)), marker); document.body.append(mirror);
  const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
  mirror.remove();
  return { top, bottom: top + parseFloat(style.lineHeight) };
}
function applySpeechText(text) {
  if (!speechDraft) return;
  if (text === speechDraft.text) return;
  const input = $('message');
  speechDraft.edit(input.value);
  const scrollTop = input.scrollTop, direction = input.selectionDirection;
  const followCursor = input.selectionStart === input.selectionEnd && input.selectionEnd === speechDraft.insertionEnd;
  let followViewport = false;
  if (followCursor) {
    if (input.selectionEnd === input.value.length) followViewport = input.scrollHeight - scrollTop - input.clientHeight <= 4;
    else {
      const line = speechCursorLine(input, input.selectionEnd);
      followViewport = line.top >= scrollTop - 4 && line.bottom <= scrollTop + input.clientHeight + 4;
    }
  }
  const selection = [speechDraft.anchor(input.selectionStart), speechDraft.anchor(input.selectionEnd)];
  const next = speechDraft.update(text);
  // Patch changed text only, preserving a selection outside the revision.
  let start = 0, end = input.value.length, nextEnd = next.length;
  while (start < end && start < nextEnd && input.value[start] === next[start]) start++;
  while (end > start && nextEnd > start && input.value[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  if (start !== end || start !== nextEnd) {
    input.setRangeText(next.slice(start, nextEnd), start, end, 'preserve');
    if (followCursor) input.setSelectionRange(speechDraft.insertionEnd, speechDraft.insertionEnd);
    else input.setSelectionRange(...selection.map(anchor => speechDraft.position(anchor)), direction);
  }
  appState.draftId = undefined; renderSend(); resizeMessage();
  // Resizing can reset the textarea viewport. Apply scrolling after its final
  // height is known, and retain the reading position when the user scrolls away.
  if (followViewport) {
    if (speechDraft.insertionEnd === input.value.length) input.scrollTop = input.scrollHeight;
    else {
      const line = speechCursorLine(input, speechDraft.insertionEnd);
      input.scrollTop = Math.max(0, Math.min(scrollTop, line.top), line.bottom - input.clientHeight);
    }
  } else input.scrollTop = scrollTop;
}
if (window.ZigentSpeechInput) speechInput = new window.ZigentSpeechInput({
  onState(state, message) {
    speechBusy = ['starting', 'listening', 'paused', 'reconnecting', 'finishing'].includes(state);
    if (state === 'error') toast(message);
    if (state === 'listening') $('message').focus({ preventScroll: true });
    renderSpeech(); renderSend();
  },
  onText(text) {
    if (speechComposing) speechPending = text; else applySpeechText(text);
  }
});
function prepareSpeech() {
  if (speechConfigured && !speechBusy && !speechSubmitting) speechInput?.prepare();
}
$('composer').addEventListener('focusin', prepareSpeech);
$('microphone').addEventListener('pointerenter', prepareSpeech, { passive: true });
$('microphone').addEventListener('pointerdown', prepareSpeech, { passive: true });
function startSpeech() {
  if (!speechInput || !speechConfigured || speechBusy || speechSubmitting) return;
  speechDraft = new window.ZigentSpeechDraft($('message')); speechPending = undefined;
  toast('');
  // Keep focus within the user's tap for mobile Safari's keyboard/caret.
  $('message').focus({ preventScroll: true });
  void speechInput.start();
}
function cancelSpeech() {
  speechDraft = undefined; speechPending = undefined; speechComposing = false;
  speechInput?.end();
}
$('microphone').onclick = () => { if (['listening', 'paused', 'reconnecting'].includes(speechInput?.state)) void speechInput.finish(); else if (speechBusy) speechInput?.end(); else startSpeech(); };
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && speechBusy) void speechInput?.resumeCapture();
  else if (document.hidden && !speechBusy) speechInput?.discardPrepared();
});
window.addEventListener('focus', () => { if (speechBusy) void speechInput?.resumeCapture(); });
document.addEventListener('pointerdown', () => { if (speechInput?.state === 'paused') void speechInput.resumeCapture(); }, { passive: true });
window.addEventListener('pagehide', cancelSpeech);
window.addEventListener('offline', () => speechInput?.networkChanged());
window.addEventListener('online', () => speechInput?.networkChanged());
$('message').onkeydown = event => {
  // An IME may end composition before its confirming Enter reaches keydown,
  // leaving isComposing false while keyCode is still 229. Keep that Enter
  // (and any held-key repeats) with the input method; the next press can send.
  if (event.isComposing || event.keyCode === 229 || event.repeat) return;
  if (event.key === 'Enter' && !event.shiftKey && !mobileLayout.matches) {
    event.preventDefault(); $('composer').requestSubmit();
  }
};
function renderUploads() {
  if (draftRestored) imageUploads.retain(new Set([...uploads, ...(editing?.priorDraft.assets || []), ...messageOutbox.assets()]));
  imageUploads.render($('attachments'), uploads, { disabled: Boolean(messageSending || editing?.submitting),
    remove: id => {
      if (messageSending || editing?.submitting) return;
      uploads = uploads.filter(value => value !== id); appState.draftId = undefined; renderUploads();
    } });
  if (choosingImages) $('attachments').append(imagePickerStatus);
  $('add-attachment').setAttribute('aria-busy', String(choosingImages));
  renderSend();
}
$('upload').onchange = () => {
  const files = [...$('upload').files]; $('upload').value = '';
  choosingImages = false;
  if (messageSending || editing?.submitting) { renderUploads(); return; }
  toast('');
  for (const file of files) {
    if (uploads.length >= 4) { toast('每次最多发送 4 个附件。'); break; }
    const image = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
    const document = /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|zip|txt|md|csv|tsv|json|xml|html?|ya?ml|py|js|mjs|cjs|ts|tsx|jsx|css|scss|sql|sh|ps1|bat|cmd|c|cpp|h|hpp|java|go|rs|rb|toml|ini|log|ipynb|tex|r)$/i.test(file.name);
    const audio = /\.(mp3|m4a|wav|ogg|aac|amr)$/i.test(file.name);
    if (!image && !document && !audio) { toast('请选择图片、录音或文档。'); continue; }
    if (!file.size) { toast('附件为空，请重新选择。'); continue; }
    const maximum = audio ? 128 : image ? 10 : /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|zip)$/i.test(file.name) ? 128 : 8;
    if (file.size > maximum * 1024 * 1024) { toast(`文件不能超过 ${maximum} MB。`); continue; }
    uploads.push(imageUploads.add(file));
  }
  appState.draftId = undefined; renderUploads();
};
$('composer').onsubmit = async event => {
  event.preventDefault();
  const submittedAt = performance.now();
  if (speechSubmitting || speechComposing) return;
  if (messageSending || forking || editing?.submitting || modelSaving) return;
  if (choosingImages || editing && uploads.some(id => !imageUploads.isReady(id))) return;
  if (speechBusy) {
    const selected = appState.current;
    speechSubmitting = true; renderSpeech(); renderSend();
    let completed;
    try { completed = await speechInput.finish(); }
    finally { speechSubmitting = false; renderSpeech(); renderSend(); }
    if (!completed || appState.current !== selected) return;
  }
  const text = composeMessageText($('message').value.trim()); if (!text && !uploads.length) return;
  if (text.length > $('message').maxLength) { toast('引用与草稿超过输入长度，请缩短后重试。'); return; }
  if (messageSending || forking || editing?.submitting || modelSaving) return;
  if (choosingImages || editing && uploads.some(id => !imageUploads.isReady(id))) return;
  if (editing) { toast(''); await submitEdit(text, submittedAt); return; }
  const wasBusy = appState.busy, rawDraft = $('message').value, sentAssets = [...uploads], sentQuotes = [...replyQuotes];
  toast(''); messageSending = true; $('send').disabled = true;
  try {
    if (!appState.current && text.toLowerCase() === '/new') {
      const result = await api('conversations', 'POST', {});
      $('message').value = ''; uploads = []; appState.draftId = undefined; renderUploads();
      await selectConversation(result.id); return;
    }
    if (!appState.current) { appState.current = (await api('conversations', 'POST', {})).id; }
    appState.draftId ||= crypto.randomUUID();
    saveComposerDraft();
    const selected = appState.current;
    window.ZigentTelemetry?.beginReply(appState.draftId, selected, appState.current, submittedAt);
    if (sentAssets.some(id => id.startsWith('upload:')) || messageOutbox.has(selected) && text.toLowerCase() !== '/new') {
      let queued;
      try { queued = await messageOutbox.enqueue({ id: appState.draftId, conversationId: selected, text, assets: [...uploads] }); }
      catch (error) { window.ZigentTelemetry?.cancelReply(appState.draftId); throw error; }
      if ($('message').value === rawDraft) { $('message').value = ''; $('message').style.height = 'auto'; }
      uploads = uploads.filter(id => !queued.assets.includes(id)); replyQuotes = replyQuotes.filter(quote => !sentQuotes.includes(quote));
      appState.draftId = undefined; renderReplyQuotes(); renderUploads(); renderHistory();
      renderMessages(true); messageOutbox.pump(); return;
    }
    const result = await api('messages', 'POST', { id: appState.draftId, conversationId: selected, text, assets: sentAssets });
    if (appState.current === selected) {
      if ($('message').value === rawDraft) { $('message').value = ''; $('message').style.height = 'auto'; }
      uploads = uploads.filter(id => !sentAssets.includes(id)); replyQuotes = replyQuotes.filter(quote => !sentQuotes.includes(quote));
      appState.draftId = undefined; renderReplyQuotes(); renderUploads();
    }
    if (appState.current === selected && result.conversationId && result.conversationId !== selected) await selectConversation(result.conversationId);
    else await refresh();
    renderMessages(true);
  } catch (error) { appState.busy = wasBusy; toast(error); void refresh(); }
  finally { messageSending = false; renderSend(); }
};
async function loadMessageActivity(message, signal) {
  const result = await api(`messages/activity?${new URLSearchParams({ conversationId: message.conversationId, messageId: message.id })}`, 'GET', undefined, signal);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (result.revision !== message.activityRevision) {
    if (appState.current === message.conversationId) await refresh();
    throw new Error('过程已更新，请重试。');
  }
  return result;
}
$('older').onclick = async () => {
  if (!appState.current || !appState.messages.length) return;
  const selected = appState.current, selection = appState.selectionVersion, first = appState.messages[0].seq, revision = appState.conversationRevision;
  if ($('older').disabled) return;
  $('older').disabled = true;
  const request = olderRequest = new AbortController();
  try {
    const result = await api(`messages?conversationId=${selected}&before=${first}&compact=1`, 'GET', undefined, request.signal);
    if (selected !== appState.current || selection !== appState.selectionVersion) return;
    if (result.revision !== revision || appState.conversationRevision !== revision) { await refresh(); return; }
    const position = captureReadingPosition();
    appState.hasOlder = result.hasOlder;
    Object.assign(appState.assetDimensions, result.assetDimensions);
    appState.messages = [...new Map([...result.messages, ...appState.messages].map(message => [message.id, message])).values()].sort((a, b) => a.seq - b.seq); renderMessages();
    restoreReadingPosition(position, true); rememberReadingPosition();
  } catch (error) { if (error.name !== 'AbortError' && selection === appState.selectionVersion) toast(error); }
  finally { if (olderRequest === request) { olderRequest = undefined; $('older').disabled = false; } }
};
$('settings').onclick = () => {
  closeMenu(false); $('account-error').hidden = true;
  openPanel('account-dialog', mobileLayout.matches ? $('menu') : $('settings'));
};
$('close-account').onclick = () => closePanel('account-dialog');
function openAccountPanel(id) {
  const trigger = panelReturnFocus.get($('account-dialog'));
  closePanel('account-dialog'); openPanel(id, trigger);
}
$('open-password').onclick = () => openAccountPanel('settings-dialog');
$('open-usage').onclick = () => void openLazyPanel('usage', 'ZigentUsage');
async function openBrowserWorkspace(options) {
  const selection = appState.selectionVersion;
  await loadFeature('browser', () => Promise.all([loadStyle('./browser-workspace.css'), loadScript('./browser-workspace.js')]));
  if (appState.authenticated && selection === appState.selectionVersion && options.conversationId === appState.current) window.ZigentBrowser.open(options);
}
async function openCurrentBrowser(trigger) {
  if (!appState.current || !appState.browserSession) return;
  try { await openBrowserWorkspace({ conversationId: appState.current, id: appState.browserSession.id, opener: trigger }); }
  catch (error) { toast(error); }
}
$('open-browser').onclick = () => openCurrentBrowser($('open-browser'));
$('close-schedule').onclick = () => closePanel('schedule-dialog');
async function openSchedule({ day = '', trigger } = {}) {
  try {
    const [{ createSchedule }] = await Promise.all([import('./schedule.js'), loadStyle('./schedule.css')]);
    $('schedule-root').replaceChildren();
    if (trigger) openPanel('schedule-dialog', trigger);
    else openAccountPanel('schedule-dialog');
    await createSchedule({ root: $('schedule-root'), api, day }).open();
  } catch (error) { toast(error); }
}
$('open-schedule').onclick = () => void openSchedule();
document.addEventListener('zigent:open-schedule', event => {
  const day = event.detail?.day;
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) void openSchedule({ day, trigger: event.detail.trigger });
});
$('open-automation').onclick = () => void openLazyPanel('automation', 'ZigentAutomation');
$('open-recovery').onclick = () => void openLazyPanel('recovery', 'ZigentRecovery');
$('open-memory').onclick = () => { openAccountPanel('memory-dialog'); void loadMemoryDocuments(); };
$('open-files').onclick = async () => {
  closePanel('account-dialog');
  try {
    if (!fileWorkbench) {
      await loadStyle('./file-workbench.css');
      const { createFileWorkbench } = await import('./file-workbench.js');
      fileWorkbench = createFileWorkbench({ base, api, toast, selectProject: async workspaceId => {
        await api(`workbench/workspaces/${workspaceId}/select`, 'POST', {conversationId:appState.current}); toast('已选择项目');
      } });
    }
    await fileWorkbench.open();
  } catch (error) { toast(error.message); }
};
$('close-memory').onclick = () => closePanel('memory-dialog');
$('memory-retry').onclick = () => void loadMemoryDocuments();
async function loadMemoryDocuments() {
  const version = ++memoryVersion;
  $('memory-status').textContent = '正在加载'; $('memory-status').hidden = false; $('memory-retry').hidden = true;
  try {
    const result = await api('memory');
    if (version !== memoryVersion || !$('memory-dialog').open || !appState.authenticated) return;
    const buttonFor = document => {
      const button = el('button', 'more-action'); button.type = 'button'; button.setAttribute('aria-label', document.title); button.append(el('span', '', document.title));
      button.onclick = () => void openMemoryDocument(document.id, button); return button;
    };
    const archived = result.documents.filter(document => document.id.startsWith('archive-'));
    const archive = el('button', 'more-action', '存档记忆'); archive.type = 'button'; archive.setAttribute('aria-label', '存档记忆');
    const showRoot = () => $('memory-documents').replaceChildren(...result.documents.filter(document => !document.id.startsWith('archive-')).map(buttonFor), archive);
    archive.onclick = () => {
      const back = el('button', 'more-action', '返回'); back.type = 'button'; back.setAttribute('aria-label', '返回'); back.onclick = showRoot;
      $('memory-documents').replaceChildren(back, ...archived.map(buttonFor), ...(!archived.length ? [el('p', '', '暂无存档')] : []));
    };
    showRoot();
    $('memory-status').hidden = true;
  } catch (error) {
    if (version !== memoryVersion || !$('memory-dialog').open) return;
    $('memory-status').textContent = error.message; $('memory-retry').hidden = false;
  }
}
async function openMemoryDocument(documentId, trigger) {
  const version = memoryVersion;
  const read = async () => (await api(`memory/document?${new URLSearchParams({ documentId })}`)).document;
  trigger.disabled = true;
  try {
    const [document] = await Promise.all([read(), loadDocumentWorkspace()]);
    if (version !== memoryVersion || !appState.authenticated || !$('memory-dialog').open) return;
    const opener = panelReturnFocus.get($('memory-dialog'));
    closePanel('memory-dialog'); opener?.focus();
    window.ZigentDocumentWorkspace.open({ key: `memory:${documentId}`, ...document, saveLabel: documentId.startsWith('archive-') ? '保存到存档记忆' : '保存到长期记忆',
      onReload: read,
      onSave: async ({ content, revision }) => (await api('memory/document', 'POST', { documentId, content, revision })).document
    });
  } catch (error) { $('memory-status').textContent = error.message; $('memory-status').hidden = false; }
  finally { trigger.disabled = false; }
}
const automationOptions = { api, close: closePanel,
  renderRun: (run, previous) => {
    const content = previous || el('div', 'automation-work-messages'), children = [];
    for (const attempt of run.attempts || []) {
      if (run.attempts.length > 1) children.push(el('h4', '', `第 ${attempt.attempt} 次执行`));
      const id = `task:${run.id}:${attempt.attempt}`;
      const existing = [...content.querySelectorAll('.activity')].find(item => item.dataset.messageId === id);
      const process = activity(attempt.snapshot, id, existing, []);
      children.push(process);
    }
    if (!run.attempts?.length) children.push(el('p', 'automation-empty', run.state === 'pending' ? '等待执行' : '此记录没有工作过程'));
    if (run.summary) { const decision = markdown(run.summary); decision.classList.add('automation-decision'); children.push(decision); }
    if (run.message) { const answer = markdown(run.message); answer.classList.add('message-text', 'automation-first-message'); children.push(answer); }
    syncChildren(content, children); return content;
  },
  conversation: async () => {
    if (!appState.current) await selectConversation((await api('conversations', 'POST', {})).id);
    return appState.current;
  },
  navigate: async result => {
    if (appState.current !== result.conversationId) await selectConversation(result.conversationId); else await refresh();
    renderMessages(true);
    if (result.messageId) requestAnimationFrame(() => {
      [...$('messages').children].find(item => item.dataset.id === result.messageId)?.scrollIntoView({ block: 'start' });
    });
  },
  discuss: text => {
    closePanel('automation-dialog');
    if ($('message').value.trim()) { toast('请先发送或清空当前草稿。'); $('message').focus(); return; }
    $('message').value = text; resizeMessage(); renderSend(); $('message').focus();
  }
};
window.ZigentTriggerContext?.initialize({ api, discuss: automationOptions.discuss });
const features = new Map(), panelLoads = new WeakMap();
function loadFeature(name, load) {
  if (!features.has(name)) {
    const pending = load().catch(error => { features.delete(name); throw error; });
    features.set(name, pending);
  }
  return features.get(name);
}
function loadDocumentWorkspace() {
  return loadFeature('documents', async () => {
    await Promise.all([loadStyle('./document-workspace.css'), loadScript('./document-editor.js')]);
    await loadScript('./document-workspace.js');
  });
}
async function openLazyPanel(name, global) {
  const dialog = $(`${name}-dialog`);
  if (!dialog.open) openAccountPanel(dialog.id);
  const loadToken = {}; panelLoads.set(dialog, loadToken);
  // Closing works even while the component is downloading or after a failed load.
  $(`close-${name}`).onclick = () => closePanel(dialog.id);
  const status = $(`${name}-status`);
  status.textContent = '正在加载…';
  if (name === 'usage') $('usage-content').hidden = true;
  if (name === 'recovery') { $('recovery-login').hidden = true; $('recovery-content').hidden = true; }
  try {
    await loadFeature(name, async () => {
      await Promise.all([loadStyle(`./${name}.css`), ...(name === 'automation' ? [loadScript('./automation-triggers.js')] : [])]);
      await loadScript(`./${name}.js`);
      window[global].initialize(name === 'automation' ? automationOptions : { api, close: closePanel });
    });
    if (appState.authenticated && dialog.open && panelLoads.get(dialog) === loadToken) window[global].open();
  } catch (error) {
    if (dialog.open && panelLoads.get(dialog) === loadToken) {
      status.textContent = error.message;
      const retry = $(`${name}-retry`); retry.hidden = false;
      retry.onclick = () => { retry.hidden = true; void openLazyPanel(name, global); };
    }
  }
}
$('close-settings').onclick = () => closePanel('settings-dialog');
$('password-form').onsubmit = async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try { await api('password', 'POST', { current: $('current-password').value, password: $('new-password').value }); $('password-form').reset(); $('settings-error').textContent = '密码已更新。此设备继续保持登录。'; connectEvents(); }
  catch (error) { $('settings-error').textContent = error.message; } finally { event.submitter.disabled = false; }
};
$('logout').onclick = async () => {
  cancelSpeech(); $('logout').disabled = true; $('account-error').hidden = true;
  try { await api('logout', 'POST', {}); window.ZigentInteractiveOutput?.clearState(); showLogin(); }
  catch (error) { $('account-error').textContent = error.message; $('account-error').hidden = false; }
  finally { $('logout').disabled = false; }
};
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
$('install').onclick = async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = undefined; $('install').hidden = true; } };
window.addEventListener('offline', () => conversationSync.suspend());
window.addEventListener('online', () => conversationSync.resume(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) conversationSync.suspend(); else conversationSync.resume(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveComposerDraft(); });
window.addEventListener('pagehide', saveComposerDraft);
window.addEventListener('focus', () => conversationSync.resume());
document.addEventListener('freeze', () => conversationSync.suspend());
document.addEventListener('resume', () => conversationSync.resume(true));
window.addEventListener('pagehide', () => conversationSync.suspend());
window.addEventListener('pageshow', event => { if (event.persisted) conversationSync.resume(true); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {});
if (window.ZigentMessageActions) userMessageActions = new window.ZigentMessageActions({
  getMessage: id => appState.messages.find(message => message.id === id && message.role === 'user'),
  canEdit: () => !forking && !editing?.submitting,
  onEdit: editMessage,
  onCopy: async text => {
    try { await navigator.clipboard.writeText(text); toast(''); }
    catch { toast('暂时无法复制，请通过“选择文本”选中后复制。'); }
  }
});
if (window.ZigentReplySelection) replySelection = new window.ZigentReplySelection({
  readingScroller, readingTopEdge, createButton: messageButton,
  onAdd: addReplyToConversation,
  onNew: (text, selected) => addReplyToNewConversation(text, selected),
  onBranch: (text, selected) => addReplyToNewConversation(text, selected, true),
  onCopy: async text => {
    try { await navigator.clipboard.writeText(text); toast(''); }
    catch { toast('暂时无法复制，请重试或使用系统复制。'); return false; }
  }
});
async function start() {
  $('startup-error').hidden = true;
  try { await enter(); }
  catch (error) {
    if (error.status === 401) { showLogin(); return; }
    $('login').hidden = true; $('app').hidden = true;
    $('startup-error-message').textContent = errorMessage(error);
    $('startup-error').hidden = false;
  }
}
$('startup-retry').onclick = async () => {
  $('startup-retry').disabled = true;
  try { await start(); } finally { $('startup-retry').disabled = false; }
};
void start();

// All document surfaces share one immutable-version reader; opening never sends a chat message.
document.addEventListener('click',event=>{
  const control=event.target.closest?.('[data-document-preview]');
  if(!control||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  event.preventDefault();
  const source=control.dataset.versionId?{versionId:control.dataset.versionId}:control.dataset.uploadId?{uploadId:control.dataset.uploadId}:{workspaceId:control.dataset.workspaceId,path:control.dataset.path};
  void import('./document-reader.js').then(({openDocumentPreview})=>openDocumentPreview({...source,name:control.dataset.filename})).catch(error=>toast(error.message));
});
