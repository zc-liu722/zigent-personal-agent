import { $ } from './dom.js';
import { applyMessagePatch, isNewerMessage } from './message-patches.js';

/** Owns HTTP/SSE ordering; UI callbacks do not receive transport state. */
export function createConversationSync({ conversation: appState, base, api, beforeSelect, selectModel, closeMenu, refreshCodexExecutions, renderHistory, renderMessages, renderQueue, scheduleMessages, captureReadingPosition, restoreReadingPosition, rememberReadingPosition, setReconnecting, toast }) {
  let eventSource, historyRequest, messageRequest, streamVersion = 0, generation = 0;
  let visibleMeasurement;
  let suspended = document.hidden || navigator.onLine === false, lastResume = 0, lastTick = Date.now();
  // Wall-clock age also catches mobile platforms that stop performance.now() during sleep.
  const stale = request => request && Date.now() - request.startedAt > 20000;
  function discardReads() {
    historyRequest?.controller.abort(); messageRequest?.controller.abort();
    historyRequest = messageRequest = undefined;
    cancelPrefetch(); appState.historyLoading = false;
  }
  // Validators and response bodies stay in this tab and are discarded on logout.
  let historyValidation = {}, appliedPage, prefetchRequest;
  let historyTimer, historyVersion = 0, historyRetryAppend = false;
  const messageValidations = new Map();
  const liveUpdates = new Map(), streamMessages = new Map(), cache = new Map();
  const hasVisibleText = value => Boolean(value?.text?.trim() || value?.snapshot?.items?.some(item => ['response', 'commentary'].includes(item.type) && item.text?.trim()));
  // Private transcripts live only in this tab. Bound both conversations and retained history.
  function rememberStreamMessage(message) {
    streamMessages.delete(message.id); streamMessages.set(message.id, message);
    if (streamMessages.size > 128) streamMessages.delete(streamMessages.keys().next().value);
  }
  const cacheFields = ['messages', 'assetDimensions', 'queuedMessages', 'busy', 'activeMessageId', 'browserSession',
    'conversationRevision', 'conversationGreeting', 'branchOrigin', 'hasOlder', 'selectedModel'];
  const messagePath = (id, limit = 20) => `messages?${new URLSearchParams({ conversationId: id, limit, compact: '1' })}`;
  function validationFor(id) {
    const validation = messageValidations.get(id) || {};
    messageValidations.delete(id); messageValidations.set(id, validation);
    while (messageValidations.size > 8) messageValidations.delete(messageValidations.keys().next().value);
    return validation;
  }
  function rememberAppliedPage(result) {
    appliedPage = { result, selection: appState.selectionVersion, streamVersion,
      state: Object.fromEntries(cacheFields.map(key => [key, appState[key]])) };
  }
  function alreadyApplied(result) {
    return !appState.messagesLoading && appliedPage?.result === result && appliedPage.selection === appState.selectionVersion
      && appliedPage.streamVersion === streamVersion && cacheFields.every(key => appliedPage.state[key] === appState[key]);
  }
  function cancelPrefetch(id) {
    if (!prefetchRequest || id && prefetchRequest.id !== id) return;
    clearTimeout(prefetchRequest.timer); prefetchRequest.controller.abort();
    if (prefetchRequest.id !== appState.current && !cache.has(prefetchRequest.id)) messageValidations.delete(prefetchRequest.id);
    prefetchRequest = undefined;
  }
  function canPrefetch() {
    const connection = navigator.connection;
    return appState.authenticated && !document.hidden && eventSource?.readyState === EventSource.OPEN
      && !connection?.saveData && !['slow-2g', '2g'].includes(connection?.effectiveType);
  }
  function prefetchConversation(id, delay = 120) {
    if (!id || id === appState.current || cache.has(id) || !canPrefetch()) return;
    if (prefetchRequest?.id === id && performance.now() - prefetchRequest.created < 5000 && (delay > 0 || prefetchRequest.promise)) return;
    cancelPrefetch();
    const request = prefetchRequest = { id, controller: new AbortController(), created: performance.now(), startedAt: Date.now() };
    request.timer = setTimeout(() => {
      if (prefetchRequest !== request || !canPrefetch()) { cancelPrefetch(id); return; }
      request.validation = validationFor(id);
      // At most one speculative transcript is retained; failed reads stay silent and retry on selection.
      request.promise = api(messagePath(id), 'GET', undefined, request.controller.signal, request.validation).catch(() => undefined);
    }, delay);
  }
  function rememberConversation() {
    if (!appState.current || appState.messagesLoading || appState.conversationRevision === undefined) return;
    const snapshot = Object.fromEntries(cacheFields.map(key => [key, appState[key]]));
    const position = captureReadingPosition();
    snapshot.position = { top: position.top, nearBottom: position.nearBottom,
      anchorId: position.anchor?.dataset.id, anchorOffset: position.anchorOffset };
    snapshot.messages = appState.messages.slice(-200);
    snapshot.hasOlder ||= appState.messages.length > snapshot.messages.length;
    cache.delete(appState.current); cache.set(appState.current, snapshot);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  function recordVisible() {
    const measurement = visibleMeasurement;
    if (!measurement || !appState.messages.length) return;
    requestAnimationFrame(() => {
      if (visibleMeasurement !== measurement || measurement.selection !== appState.selectionVersion) return;
      visibleMeasurement = undefined;
      window.ZigentTelemetry?.record('web.conversation', performance.now() - measurement.start, measurement.cached ? 'cached' : 'remote');
      performance.clearMeasures('zigent:conversation-visible');
      performance.measure('zigent:conversation-visible', { start: measurement.start, detail: { cached: measurement.cached } });
    });
  }
  async function selectConversation(id, greeting = '', initialPage, started = performance.now()) {
    if (!id) cancelPrefetch();
    if (id && id === appState.current) return refreshMessages();
    rememberConversation();
    messageRequest?.controller.abort(); messageRequest = undefined;
    beforeSelect(id);
    const selectedHistory = appState.historyRows.find(item => item.id === id);
    if (selectedHistory && !appState.conversations.some(item => item.id === id)) appState.conversations.push(selectedHistory);
    appState.select(id, greeting); liveUpdates.clear();
    window.ZigentTelemetry?.conversationSelected(id);
    const cached = cache.get(id);
    if (cached) {
      for (const key of cacheFields) appState[key] = cached[key];
      // Never mutate the cached array when streaming or optimistically appending.
      appState.messages = [...cached.messages]; appState.queuedMessages = [...cached.queuedMessages];
      cache.delete(id); cache.set(id, cached);
    }
    if (initialPage) {
      Object.assign(appState, { messages: initialPage.messages, assetDimensions: initialPage.assetDimensions || {}, queuedMessages: initialPage.queued || [],
        busy: initialPage.busy, activeMessageId: initialPage.activeMessageId, browserSession: initialPage.browser || undefined,
        conversationRevision: initialPage.revision, conversationGreeting: initialPage.greeting || '',
        branchOrigin: initialPage.branch, hasOlder: initialPage.hasOlder, selectedModel: initialPage.selectedModel });
    }
    visibleMeasurement = { start: started, cached: Boolean(cached), selection: appState.selectionVersion };
    appState.messagesLoading = Boolean(id && !cached && !initialPage);
    // Adopt a speculative request before closing the drawer moves keyboard focus.
    const messages = initialPage ? undefined : refreshMessages();
    $('branch-origin').hidden = !appState.branchOrigin; selectModel(appState.selectedModel);
    renderQueue(); closeMenu(); renderMessages(true); renderHistory();
    if (cached?.position && !cached.position.nearBottom) {
      restoreReadingPosition(cached.position); rememberReadingPosition();
    }
    if (cached || initialPage) recordVisible();
    if (initialPage) return;
    // The list is independent: never put it in front of a selected transcript.
    if (id && !appState.conversations.some(item => item.id === id)) void refreshHistory();
    await messages;
  }
  function refreshHistory(again = false, append = false) {
    if (!appState.authenticated || document.hidden || navigator.onLine === false) return Promise.resolve();
    clearTimeout(historyTimer); historyTimer = undefined;
    if (stale(historyRequest)) { historyRequest.controller.abort(); historyRequest = undefined; }
    if (historyRequest) { historyRequest.again ||= again; return historyRequest.promise; }
    if (append && !appState.historyNextCursor) return Promise.resolve();
    const request = { controller: new AbortController(), again: false, startedAt: Date.now() }, epoch = generation, version = historyVersion;
    const selection = appState.selectionVersion;
    const query = appState.historyQuery, targetCount = append ? 200 : Math.max(200, appState.historyRows.length);
    let cursor = append ? appState.historyNextCursor : undefined;
    const rows = append ? [...appState.historyRows] : [];
    const valid = () => epoch === generation && version === historyVersion && appState.authenticated && historyRequest === request;
    historyRequest = request;
    appState.historyLoading = true; appState.historyError = ''; renderHistory();
    request.promise = (async () => {
      try {
        let added = 0;
        do {
          const params = new URLSearchParams({ page: '1' });
          if (query) params.set('q', query);
          if (cursor) params.set('cursor', cursor);
          const result = await api(`conversations?${params}`, 'GET', undefined, request.controller.signal, !cursor ? historyValidation : undefined);
          if (!valid()) return;
          // A long paginated refresh is healthy while individual pages keep completing.
          request.startedAt = Date.now();
          rows.push(...result.conversations); added += result.conversations.length; cursor = result.nextCursor;
        } while (!append && cursor && added < targetCount);
        appState.historyRows = [...new Map(rows.map(item => [item.id, item])).values()];
        appState.historyNextCursor = cursor;
        if (!query) {
          // A filtered/paged list cannot establish deletion of a cached conversation.
          const active = appState.conversations.find(item => item.id === appState.current);
          appState.conversations = [...appState.historyRows];
          if (active && !appState.conversations.some(item => item.id === active.id)) appState.conversations.push(active);
        }
        if (!query && !appState.current && selection === appState.selectionVersion && rows[0]) void selectConversation(rows[0].id);
      } catch (error) { if (error.name !== 'AbortError' && valid()) { appState.historyError = error.message; historyRetryAppend = append; } }
      finally {
        if (historyRequest === request) {
          historyRequest = undefined; appState.historyLoading = false; renderHistory();
          if (request.again) void refreshHistory();
        }
      }
    })();
    return request.promise;
  }
  function searchHistory(value) {
    const query = value.trim();
    if (query === appState.historyQuery && !appState.historyError) return;
    historyVersion++; historyRequest?.controller.abort(); historyRequest = undefined;
    clearTimeout(historyTimer); historyValidation = {};
    appState.historyQuery = query; appState.historyRows = []; appState.historyNextCursor = undefined;
    appState.historyError = ''; appState.historyLoading = true;
    $('history').scrollTop = 0; renderHistory();
    historyTimer = setTimeout(() => { historyTimer = undefined; void refreshHistory(); }, query ? 180 : 0);
  }
  function refreshMessages(again = false) {
    if (!appState.authenticated || !appState.current || document.hidden || navigator.onLine === false) return Promise.resolve();
    if (stale(messageRequest)) { messageRequest.controller.abort(); messageRequest = undefined; }
    if (messageRequest) { messageRequest.again ||= again; return messageRequest.promise; }
    const selected = appState.current, selection = appState.selectionVersion;
    const prefetched = prefetchRequest?.id === selected && prefetchRequest.promise && canPrefetch()
      && performance.now() - prefetchRequest.created < 5000 && Date.now() - prefetchRequest.startedAt < 5000 ? prefetchRequest : undefined;
    if (prefetched) prefetchRequest = undefined; else cancelPrefetch();
    const request = { controller: prefetched?.controller || new AbortController(), again: false, startedAt: prefetched?.startedAt ?? Date.now() };
    messageRequest = request;
    const revision = streamVersion, queueRevision = appState.queueVersion, browserRevision = appState.browserVersion;
    const valid = () => appState.authenticated && messageRequest === request && selected === appState.current && selection === appState.selectionVersion;
    request.promise = (async () => {
      try {
        const limit = Math.max(20, Math.min(100, appState.messages.length));
        const result = (prefetched && await prefetched.promise)
          || await api(messagePath(selected, limit), 'GET', undefined, request.controller.signal, validationFor(selected));
        if (!valid()) return;
        if (alreadyApplied(result)) { recordVisible(); return; }
        const position = captureReadingPosition(), firstLoad = appState.messagesLoading;
        // Retain older pages only when the windows overlap; otherwise there may be a gap after reconnecting.
        const previousMessages = new Map(appState.messages.map(message => [message.id, message]));
        const overlap = result.messages.some(message => previousMessages.has(message.id));
        const retained = appState.conversationRevision === result.revision && overlap
          ? appState.messages.filter(message => message.seq < (result.messages[0]?.seq ?? 0)) : [];
        if (browserRevision === appState.browserVersion) appState.browserSession = result.browser || undefined;
        appState.conversationRevision = result.revision;
        appState.conversationGreeting = result.greeting || '';
        appState.assetDimensions = { ...appState.assetDimensions, ...result.assetDimensions };
        appState.hasOlder = retained.length ? appState.hasOlder : result.hasOlder;
        const merged = new Map([...retained, ...result.messages].map(message => [message.id, message]));
        for (const message of result.messages) {
          const previous = streamMessages.get(message.id) ?? previousMessages.get(message.id);
          if (isNewerMessage(previous, message)) merged.set(message.id, previous);
          else rememberStreamMessage(message);
        }
        appState.busy = result.busy; appState.activeMessageId = result.activeMessageId;
        if (queueRevision === appState.queueVersion) appState.queuedMessages = result.queued || [];
        renderQueue();
        appState.branchOrigin = result.branch; $('branch-origin').hidden = !appState.branchOrigin;
        appState.selectedModel = result.selectedModel; selectModel(result.selectedModel);
        let newestBusy;
        for (const [id, update] of liveUpdates) {
          if (update.version > revision) {
            if (!isNewerMessage(merged.get(id), update.message)) {
              merged.set(id, update.message);
              if (typeof update.message.busy === 'boolean' && (!newestBusy || update.version > newestBusy.version)) newestBusy = update;
            }
          } else liveUpdates.delete(id);
        }
        if (newestBusy) { appState.busy = newestBusy.message.busy; appState.activeMessageId = newestBusy.message.activeMessageId; }
        appState.messagesLoading = false;
        appState.messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
        renderMessages(firstLoad); recordVisible();
        if (!firstLoad && !position.nearBottom) { restoreReadingPosition(position); rememberReadingPosition(); }
        // A page merged with newer stream state is not an exact baseline for a later 304.
        if (streamVersion === revision && queueRevision === appState.queueVersion && browserRevision === appState.browserVersion) rememberAppliedPage(result);
        else appliedPage = undefined;
      } catch (error) {
        if (!valid() || error.name === 'AbortError') return;
        if (error.status === 404) {
          cache.delete(selected); messageValidations.delete(selected); appState.conversationRevision = undefined;
          await refreshHistory();
          if (valid()) await selectConversation(appState.conversations.find(item => item.id !== selected)?.id);
        } else { appState.messagesLoading = false; renderMessages(); toast(error); }
      } finally {
        if (messageRequest === request) {
          messageRequest = undefined;
          if (request.again) void refreshMessages();
        }
      }
    })();
    return request.promise;
  }
  async function refresh({ again = true } = {}) {
    // Start both reads together. An initial list read selects and loads the newest conversation.
    await Promise.all([refreshMessages(again), refreshHistory(again)]);
    if (messageRequest) await messageRequest.promise;
  }
  let clearEventRecovery = () => {};
  function connectEvents() {
    if (!appState.authenticated || document.hidden || navigator.onLine === false) return;
    cancelPrefetch();
    clearEventRecovery();
    eventSource?.close();
    streamMessages.clear();
    const connectStarted = performance.now();
    let connectedOnce = false;
    const source = eventSource = new EventSource(`${base}api/events?messagePatches=1`);
    let reconnectNotice, recoveryTimer;
    clearEventRecovery = () => { clearTimeout(reconnectNotice); clearTimeout(recoveryTimer); recoveryTimer = undefined; };
    const recover = () => {
      if (recoveryTimer !== undefined) return;
      recoveryTimer = setTimeout(() => {
        recoveryTimer = undefined;
        if (source !== eventSource || !appState.authenticated || document.hidden) return;
        if (source.readyState === EventSource.OPEN) connected();
        else connectEvents();
      }, 15000);
    };
    const connected = () => {
      if (source !== eventSource || !appState.authenticated) return;
      clearEventRecovery();
      setReconnecting(false);
    };
    recover();
    source.addEventListener('open', () => { connected(); if (!connectedOnce) { connectedOnce = true; window.ZigentTelemetry?.record('web.sse_connect', performance.now() - connectStarted); } });
    source.addEventListener('performance-ping', event => { window.ZigentTelemetry?.receivedPing(JSON.parse(event.data).nonce); });
    source.addEventListener('ready', () => { connected(); void window.ZigentTelemetry?.ping(); void refresh({ again: false }); refreshCodexExecutions(); });
    eventSource.addEventListener('queue', event => {
      connected();
      const update = JSON.parse(event.data);
      cancelPrefetch(update.conversationId);
      if (update.conversationId !== appState.current) {
        const cached = cache.get(update.conversationId); if (cached) cached.queuedMessages = update.queued; return;
      }
      appState.queueVersion++; appState.queuedMessages = update.queued; renderQueue();
    });
    eventSource.addEventListener('browser', event => {
      connected(); const update = JSON.parse(event.data);
      cancelPrefetch(update.conversationId);
      if (update.conversationId !== appState.current) {
        const cached = cache.get(update.conversationId); if (cached) cached.browserSession = update.session || undefined; return;
      }
      appState.browserVersion++; appState.browserSession = update.session || undefined; scheduleMessages();
    });
    eventSource.addEventListener('codex', () => { connected(); refreshCodexExecutions(); });
    eventSource.addEventListener('change', () => { connected(); cancelPrefetch(); void refresh(); });
    const receiveMessage = (message, delta = false) => {
      if (source !== eventSource) return;
      cancelPrefetch(message.conversationId);
      const previous = streamMessages.get(message.id) ?? appState.messages.find(value => value.id === message.id);
      if (isNewerMessage(previous, message)) return;
      const firstVisible = message.role === 'assistant' && hasVisibleText(message) && !hasVisibleText(previous);
      if (firstVisible) window.ZigentTelemetry?.receivedReply(message);
      connected();
      rememberStreamMessage(message);
      if (message.conversationId !== appState.current) {
        const cached = cache.get(message.conversationId);
        if (cached) {
          const messages = new Map(cached.messages.map(value => [value.id, value])); messages.set(message.id, message);
          cached.hasOlder ||= messages.size > 200;
          cached.messages = [...messages.values()].sort((a, b) => a.seq - b.seq).slice(-200);
          cached.queuedMessages = cached.queuedMessages.filter(value => value.id !== message.id);
          if (typeof message.busy === 'boolean') { cached.busy = message.busy; cached.activeMessageId = message.activeMessageId; }
        }
        if (message.role === 'user' || !appState.conversations.some(item => item.id === message.conversationId)) void refreshHistory(true);
        return;
      }
      liveUpdates.set(message.id, { message, version: ++streamVersion });
      if (appState.queuedMessages.some(item => item.id === message.id)) {
        appState.queueVersion++; appState.queuedMessages = appState.queuedMessages.filter(item => item.id !== message.id); renderQueue();
      }
      appState.upsertMessage(message);
      if (typeof message.busy === 'boolean') { appState.busy = message.busy; appState.activeMessageId = message.activeMessageId; }
      else if (message.snapshot) appState.busy = message.snapshot.status === 'running';
      else if (message.role === 'user') appState.busy = true;
      scheduleMessages(delta ? message.id : undefined, firstVisible);
      if (message.role === 'user') void refreshHistory(true);
    };
    eventSource.addEventListener('message', event => receiveMessage(JSON.parse(event.data)));
    eventSource.addEventListener('message-patch', event => {
      if (source !== eventSource) return;
      connected();
      const patch = JSON.parse(event.data);
      const previous = streamMessages.get(patch.id)
        ?? (patch.conversationId === appState.current ? appState.messages : cache.get(patch.conversationId)?.messages)?.find(value => value.id === patch.id);
      if (previous?.streamEpoch === patch.streamEpoch && previous.streamRevision >= patch.streamRevision) return;
      const message = applyMessagePatch(previous, patch);
      if (!message) { connectEvents(); void refresh(); return; }
      receiveMessage(message, true);
    });
    eventSource.onerror = () => {
      if (source !== eventSource || !appState.authenticated) return;
      recover();
      clearTimeout(reconnectNotice);
      reconnectNotice = setTimeout(() => {
        if (source !== eventSource || !appState.authenticated || source.readyState === EventSource.OPEN) return;
        setReconnecting(true);
      }, 2000);
    };
  }
  function suspend() {
    suspended = true; lastTick = Date.now();
    // Discard obsolete reads when the browser freezes a tab or loses its network.
    // A resumed page must never wait behind a request from the old connection.
    clearEventRecovery(); eventSource?.close(); eventSource = undefined;
    clearTimeout(historyTimer); historyTimer = undefined;
    discardReads();
  }
  function resume(force = false) {
    if (!appState.authenticated || document.hidden || navigator.onLine === false) return;
    const now = Date.now(), interrupted = suspended || now - lastTick > 15000;
    const agedRead = stale(historyRequest) || stale(messageRequest);
    lastTick = now; suspended = false;
    // Deduplicate before aborting: a second lifecycle event must not cancel the fresh reads.
    if (!interrupted && !agedRead && now - lastResume < 500 && eventSource && eventSource.readyState !== EventSource.CLOSED) return;
    if (interrupted || force || agedRead) discardReads();
    else if (eventSource?.readyState === EventSource.OPEN) return;
    lastResume = now;
    connectEvents(); void refresh({ again: false });
  }
  setInterval(() => {
    const now = Date.now(), gap = now - lastTick;
    lastTick = now;
    // Timers cannot run while frozen. Recover on the first tick after an unreported pause.
    if (gap > 15000 && appState.authenticated && !document.hidden && navigator.onLine !== false) resume(true);
  }, 5000);
  return { selectConversation, refresh, connectEvents, suspend, resume, prefetchConversation, cancelPrefetch, searchHistory,
    loadMoreHistory: () => refreshHistory(false, appState.historyError ? historyRetryAppend : true),
    bootstrap: async (result, started) => {
      appState.conversations = result.conversations;
      appState.historyQuery = ''; appState.historyRows = result.conversations; appState.historyNextCursor = result.historyNextCursor;
      appState.historyLoading = false; appState.historyError = ''; $('history-search').value = '';
      historyValidation = { path: 'conversations?page=1', etag: result.historyEtag,
        result: { conversations: result.conversations, nextCursor: result.historyNextCursor } };
      if (result.current && result.messages) Object.assign(validationFor(result.current), {
        path: messagePath(result.current), etag: result.messagesEtag, result: result.messages });
      await selectConversation(result.current, '', result.messages, started);
      if (result.messages) rememberAppliedPage(result.messages);
    },
    close: () => { generation++; clearEventRecovery(); eventSource?.close(); eventSource = undefined;
    clearTimeout(historyTimer); historyTimer = undefined; historyVersion++;
    historyRequest?.controller.abort(); messageRequest?.controller.abort(); historyRequest = messageRequest = undefined;
    cancelPrefetch(); historyValidation = {}; messageValidations.clear(); appliedPage = undefined;
    appState.historyRows = []; appState.conversations = []; appState.historyNextCursor = undefined; appState.historyQuery = '';
    appState.historyLoading = false; appState.historyError = '';
    visibleMeasurement = undefined; cache.clear(); liveUpdates.clear(); streamMessages.clear(); appState.select(undefined); } };
}
