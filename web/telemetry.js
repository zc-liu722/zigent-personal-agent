// Real user timings use the browser's monotonic clock. No content or full URLs are collected.
(() => {
  let enabled = false, sending = 0, samples = [], lcp, lcpObserver, lcpSent = false, flushTimer, lastPingAt = -Infinity;
  const navigationTrace = crypto.randomUUID();
  const interactions = new Map(), pings = new Map(), replies = new Map();
  let firstMessageLcpMs, candidateCount = 0, renderCount = 0;
  const messageRenders = [];
  const base = new URL('.', location.href);
  function scheduleFlush() {
    if (!enabled || sending || flushTimer || document.hidden || !samples.length && !interactions.size) return;
    flushTimer = setTimeout(() => { flushTimer = undefined; void flush(); }, 30000);
  }
  const record = (metric, ms, detail = '', outcome = 'ok', trace, timing) => {
    if (!Number.isFinite(ms) || ms < 0 || ms > 86400000) return;
    if (metric === 'web.render' && !lcpSent) {
      const endMs = performance.now();
      messageRenders.push({ startMs: Math.max(0, endMs - ms), endMs, count: ++renderCount });
      if (messageRenders.length > 32) messageRenders.shift();
    }
    if (samples.length >= 200) { if (metric !== 'web.lcp') return; samples.pop(); }
    const sample = { metric, ms, detail: detail.split('?')[0].slice(0,160), outcome, ...(trace ? { trace } : {}), ...(timing ? { timing } : {}) };
    // The final navigation metric must survive a busy render queue and the last page-hide batch.
    if (metric === 'web.lcp') samples.unshift(sample); else samples.push(sample);
    scheduleFlush();
  };
  const observe = (type, callback, options = {}) => {
    try { const observer = new PerformanceObserver(list => list.getEntries().forEach(callback)); observer.observe({ type, buffered: true, ...options }); return observer; } catch { return undefined; }
  };
  let navigationRecorded = false;
  const navigation = entry => {
    if (navigationRecorded || !entry.responseStart) return; navigationRecorded = true;
    record('web.ttfb', entry.responseStart, '', 'ok', navigationTrace);
    for (const [metric,start,end] of [['dns','domainLookupStart','domainLookupEnd'], ['connect','connectStart','connectEnd'], ['tls','secureConnectionStart','connectEnd']]) {
      if (entry[start] > 0 && entry[end] > entry[start]) record(`web.${metric}`, entry[end] - entry[start], '', 'ok', navigationTrace);
    }
  };
  observe('navigation', navigation);
  const readNavigation = () => { const entry = performance.getEntriesByType('navigation')[0]; if (entry) navigation(entry); };
  if (document.readyState === 'complete') readNavigation(); else window.addEventListener('load', readNavigation, { once: true });
  let background = document.hidden;
  const captureLcp = entry => {
    // Capture the category while the element is still attached (navigation can remove it).
    const element = entry.element;
    const detail = element?.closest('#messages') ? (element.tagName === 'IMG' ? 'messages-image' : 'messages-text') : element?.closest('#welcome') ? 'welcome'
      : element?.closest('#login') ? 'login' : element?.tagName === 'IMG' ? 'image' : 'other';
    candidateCount++;
    if (detail.startsWith('messages-')) firstMessageLcpMs ??= entry.startTime;
    lcp = { at: entry.startTime, detail, url: entry.url };
  };
  lcpObserver = observe('largest-contentful-paint', captureLcp);
  observe('event', entry => {
    if (!entry.interactionId) return;
    interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration));
    if (interactions.size > 100) interactions.delete(interactions.keys().next().value);
    scheduleFlush();
  }, { durationThreshold: 16 });
  const finishLcp = () => {
    lcpObserver?.takeRecords().forEach(captureLcp);
    if (!lcpSent && lcp !== undefined) {
      const timing = { kind: 'lcp', background };
      timing.candidateCount = candidateCount;
      if (firstMessageLcpMs !== undefined) timing.firstMessageLcpMs = firstMessageLcpMs;
      const lastRender = messageRenders.findLast(render => render.endMs <= lcp.at);
      if (lastRender) {
        timing.messageRenderCount = lastRender.count;
        timing.lastMessageRenderStartMs = lastRender.startMs;
        timing.lastMessageRenderEndMs = lastRender.endMs;
      }
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav?.responseStart > 0) timing.ttfbMs = nav.responseStart;
      for (const [field, name] of [['navigationFetchStartMs','fetchStart'], ['navigationRequestStartMs','requestStart'], ['navigationWorkerStartMs','workerStart']]) {
        if (nav?.[name] > 0) timing[field] = nav[name];
      }
      if (nav?.requestStart > 0 && nav.responseStart >= nav.requestStart) timing.navigationResponseMs = nav.responseStart - nav.requestStart;
      for (const [field, name] of [['appReadyMs','app-ready'], ['bootstrapReadyMs','bootstrap-ready'], ['renderStartMs','initial-render-start'], ['renderEndMs','initial-render-end']]) {
        const mark = performance.getEntriesByName(`zigent:${name}`)[0];
        if (mark && mark.startTime <= lcp.at) timing[field] = mark.startTime;
      }
      const bootstrap = performance.getEntriesByName(new URL('api/bootstrap', base).href, 'resource').find(entry => entry.startTime <= lcp.at);
      if (bootstrap) {
        timing.bootstrapStartMs = bootstrap.startTime;
        if (bootstrap.responseEnd > 0 && bootstrap.responseEnd <= lcp.at) timing.bootstrapEndMs = bootstrap.responseEnd;
      }
      const resources = performance.getEntriesByType('resource'), assets = [];
      for (const [name, path] of [['app','app.js'], ['components','interactive-output.js'], ['styles','style.css'], ['telemetry','telemetry.js'], ['bootstrap','api/bootstrap']]) {
        const url = new URL(path, base).href;
        const entry = resources.findLast(item => item.name.split('?')[0] === url && item.responseEnd > 0 && item.responseEnd <= lcp.at);
        if (!entry) continue;
        const asset = { name, startMs: entry.startTime, endMs: entry.responseEnd };
        for (const [field, property] of [['transferBytes','transferSize'], ['encodedBytes','encodedBodySize'], ['decodedBytes','decodedBodySize']]) {
          if (Number.isFinite(entry[property]) && entry[property] >= 0) asset[field] = entry[property];
        }
        assets.push(asset);
      }
      if (assets.length) timing.assets = assets;
      const resource = lcp.url && performance.getEntriesByName(lcp.url, 'resource').find(entry => entry.responseEnd > 0 && entry.responseEnd <= lcp.at);
      if (resource) {
        timing.resourceStartMs = resource.startTime; timing.resourceEndMs = resource.responseEnd;
        if (timing.ttfbMs !== undefined) {
          timing.resourceLoadDelayMs = Math.max(0, resource.startTime - timing.ttfbMs);
          timing.resourceLoadMs = Math.max(0, resource.responseEnd - Math.max(resource.startTime, timing.ttfbMs));
        }
      }
      if (timing.ttfbMs !== undefined) timing.elementRenderDelayMs = Math.max(0, lcp.at - Math.max(timing.ttfbMs, resource?.responseEnd ?? 0));
      record('web.lcp', lcp.at, lcp.detail, 'ok', navigationTrace, timing); lcpSent = true; lcpObserver?.disconnect();
    }
  };
  document.addEventListener('pointerdown', finishLcp, { once: true, capture: true });
  document.addEventListener('keydown', finishLcp, { once: true, capture: true });
  async function flush(final = false) {
    clearTimeout(flushTimer); flushTimer = undefined;
    if (!enabled || sending && !final) return;
    const concurrent = sending > 0;
    // A page can disappear before an in-flight regular report's callback runs.
    // Permit only its small final LCP record to use a concurrent keepalive request.
    if (concurrent && !samples.some(sample => sample.metric === 'web.lcp')) return;
    sending++;
    const batch = [];
    try {
      if (!concurrent) { for (const ms of interactions.values()) record('web.interaction', ms); interactions.clear(); }
      const lcpIndex = samples.findIndex(sample => sample.metric === 'web.lcp');
      if (lcpIndex >= 0) batch.push(...samples.splice(lcpIndex, 1));
      if (!concurrent) batch.push(...samples.splice(0, 50 - batch.length));
      if (!batch.length) return;
      const response = await fetch(new URL('api/performance/client', base), { method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ samples: batch }) });
      if (response.status === 401) { enabled = false; samples = []; }
      else if (!response.ok) samples = [...batch, ...samples].slice(0,200);
    } catch { samples = [...batch, ...samples].slice(0,200); }
    finally { sending--; scheduleFlush(); }
  }
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    for (const pending of replies.values()) {
      if (document.hidden) { pending.background = true; pending.hiddenAt ??= now; }
      else if (pending.hiddenAt !== undefined) { pending.hiddenMs += Math.max(0, now - pending.hiddenAt); pending.hiddenAt = undefined; }
    }
    if (document.hidden) { finishLcp(); background = true; void flush(true); }
    else {
      // A paint callback can finish while hidden. Recheck the last rendered
      // candidate even when a conditional refresh does not redraw the page.
      window.ZigentTelemetry.rendered([...replies.values()].flatMap(pending => pending.renderedMessage ? [pending.renderedMessage] : []));
      scheduleFlush();
    }
  });
  window.addEventListener('pagehide', () => { finishLcp(); void flush(true); });
  window.ZigentTelemetry = {
    record,
    beginReply(id, conversationId, selected, startedAt = performance.now()) { if (!replies.has(id)) { const observedAt = performance.now(); replies.set(id, { at: startedAt, observedAt, hiddenMs: 0, hiddenAt: document.hidden ? observedAt : undefined, conversationId, first: false, terminal: false, background: document.hidden, switched: selected !== conversationId }); } if (replies.size > 40) replies.delete(replies.keys().next().value); void window.ZigentTelemetry.ping(); },
    cancelReply(id) { replies.delete(id); },
    conversationSelected(id) { for (const pending of replies.values()) if (pending.conversationId !== id) pending.switched = true; },
    receivedReply(message) {
      const pending = replies.get(message.replyTo);
      if (!enabled || !pending || pending.first || pending.receivedAt !== undefined) return;
      pending.receivedAt = performance.now();
      record('web.reply_receive', pending.receivedAt - pending.at, '', 'ok', message.replyTo);
    },
    rendered(messages) {
      if (!enabled || document.hidden || !replies.size) return;
      for (const message of messages) {
        const pending = replies.get(message.replyTo); if (!pending || message.role !== 'assistant') continue;
        pending.renderedMessage = message;
        const visible = message.text?.trim() || message.snapshot?.items?.some(item => ['response','commentary'].includes(item.type) && item.text?.trim());
        const terminal = ['completed','failed','cancelled'].includes(message.snapshot?.status);
        const first = visible && !pending.first && !pending.firstScheduled, done = terminal && !pending.terminal && !pending.terminalScheduled;
        if (!first && !done) continue;
        if (first) pending.firstScheduled = true; if (done) pending.terminalScheduled = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (first) pending.firstScheduled = false; if (done) pending.terminalScheduled = false;
          const article = [...document.querySelectorAll('#messages > article')].find(item => item.dataset.id === message.id);
          if (document.hidden || !enabled || replies.get(message.replyTo) !== pending || !article || article.hidden
            || article.classList.contains('virtual-message')) return;
          if (first && !pending.first && article.querySelector('.message-text')?.getClientRects().length) {
            pending.first = true;
            const detail = pending.background ? pending.switched ? 'background-switched' : 'background' : pending.switched ? 'switched' : 'foreground';
            const now = performance.now(), observedMs = Math.max(0, now - pending.observedAt);
            const hiddenMs = Math.min(observedMs, pending.hiddenMs + (pending.hiddenAt === undefined ? 0 : Math.max(0, now - pending.hiddenAt)));
            record('web.reply_first', now - pending.at, detail, 'ok', message.replyTo, { kind: 'reply', hiddenMs, observedMs });
            if (pending.receivedAt !== undefined) record('web.reply_paint', performance.now() - pending.receivedAt, '', 'ok', message.replyTo);
          }
          if (done && !pending.terminal) { pending.terminal = true; record('web.reply_total', performance.now() - pending.at, '', message.snapshot.status === 'failed' ? 'error' : message.snapshot.status === 'cancelled' ? 'cancelled' : 'ok', message.replyTo); }
          if (pending.terminal && !pending.firstScheduled && (pending.first || !visible)) replies.delete(message.replyTo);
        }));
      }
    },
    enabled(value) { const wasEnabled = enabled; enabled = value; if (!value) { clearTimeout(flushTimer); flushTimer = undefined; samples = wasEnabled ? [] : samples.filter(s => ['web.ttfb','web.dns','web.connect','web.tls','web.lcp'].includes(s.metric)); interactions.clear(); pings.clear(); replies.clear(); } else scheduleFlush(); },
    async ping() {
      if (!enabled || document.hidden || performance.now() - lastPingAt < 60000) return;
      lastPingAt = performance.now();
      for (const [id, at] of pings) if (performance.now() - at > 30000) pings.delete(id);
      const nonce = crypto.randomUUID(); pings.set(nonce, performance.now());
      try { await fetch(new URL('api/performance/ping', base), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) }); }
      catch { pings.delete(nonce); }
    },
    receivedPing(nonce) { const at = pings.get(nonce); if (at !== undefined) { record('web.sse_delivery', performance.now() - at); pings.delete(nonce); } }
  };
})();
