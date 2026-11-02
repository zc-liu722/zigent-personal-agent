import { $, el, syncChildren, updateText, messageButton } from './dom.js';
import { interactionStatus, messageInteractions } from './components/interaction-model.js';
import { createMessageWindow } from './message-window.js';
import { createSubagentRenderer, subagentTimeline, createActivityRenderer, activitySourceKey as activityKey } from './components/index.js';
import { createImageViewer } from './image-viewer.js';
import { createImageDownloads } from './image-downloads.js';
import { createImageGeneration } from './components/image-generation.js';

/** Owns keyed DOM views, stream render scheduling and output disposal. */
export function createMessageRenderer({ conversation: appState, assetUrl, loadActivity, branchReply, captureReadingPosition, copyText, isForking, inline, markdown, openConversationDocument, openCurrentBrowser, readingMetrics, readingScroller, readingTopEdge, rememberReadingPosition, renderInteraction, renderSend, restoreReadingPosition, scrollReadingToBottom, scheduleInteractionExpiry, userMessageText, toast, subagentRunningText, pendingArticles = () => [] }) {
  const activityViews = new WeakMap(), messageViews = new WeakMap();
  const generationGames = new Set();
  const imageDownloads = createImageDownloads({ assetUrl });
  const imageViewer = createImageViewer({ assetUrl, downloads: imageDownloads });
  const expandedUserMessages = new WeakSet(), userTextViews = new WeakMap();
  const userTextResize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(entries => {
    const changed = entries.map(entry => userTextViews.get(entry.target)).filter(view => view?.content.isConnected)
      .filter(view => userTextOverflows(view) !== view.overflows);
    if (changed.length) {
      resizeConversationOutput(() => changed.forEach(updateUserText));
      messageWindow.remember();
    }
  });
  const activityCache = new Map(), activityRequests = new Map();
  const { activity } = createActivityRenderer({ inline, load: fetchActivity, cache: activityCache, activityViews,
    captureReadingPosition, restoreReadingPosition, rememberReadingPosition });
  const renderSubagents = createSubagentRenderer({ markdown, activity, load: fetchActivity, resize: resizeConversationOutput, runningText: subagentRunningText });
  const activityCacheLimit = 8 * 1024 * 1024;
  function imageAlbumButton(id, label) {
    const button = messageButton('download', label);
    const canShareFiles = typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File([], 'image.png', { type: 'image/png' })] });
    // Prepare only the save action the user approaches, rather than every visible original.
    for (const event of ['pointerenter', 'pointerdown', 'focus']) {
      button.addEventListener(event, () => { void imageDownloads.prepare(id).catch(() => {}); });
    }
    button.onclick = async () => {
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      let file = imageDownloads.peek(id);
      try {
        if (!file) file = await imageDownloads.prepare(id, { onProgress: progress => {
          button.title = `${label} ${progress}%`; button.setAttribute('aria-label', button.title);
        } });
        if (!canShareFiles || !navigator.canShare({ files: [file] })) { imageDownloads.save(id); return; }
        if (navigator.userActivation?.isActive === false) { toast('图片已就绪，请再次点击保存到相册。'); return; }
        await navigator.share({ files: [file] });
        // Closing the system sheet does not confirm that Photos saved the image.
      } catch (error) {
        if (error.name !== 'AbortError') toast(file ? '请再次点击保存到相册，或长按原图保存。' : error.message || '图片加载失败，请重试。');
      } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.title = label; button.setAttribute('aria-label', label); }
    };
    return button;
  }
  let activityCacheBytes = 0;
  let messageRenderFrame;
  let messageRenderTimer;
  let dirtyMessageIds = new Set(), allMessagesDirty = false;
  const messageWindow = createMessageWindow({ readingScroller, capturePosition: captureReadingPosition,
    restorePosition: restoreReadingPosition, render: dirty => renderMessages(false, dirty),
    dispose: article => { disposeMessageOutputs(article); messageViews.delete(article); } });
  function cancelActivityLoads() {
    for (const request of activityRequests.values()) request.controller.abort();
    activityRequests.clear();
  }
  function clearActivity() {
    for (const game of generationGames) game.dispose();
    generationGames.clear();
    imageViewer.close();
    imageDownloads.clear();
    cancelActivityLoads(); activityCache.clear(); activityCacheBytes = 0; messageWindow.reset();
  }
  function fetchActivity(message) {
    const key = activityKey(message);
    const existing = activityRequests.get(key);
    if (existing) return existing.promise;
    const request = { controller: new AbortController() };
    request.promise = loadActivity(message, request.controller.signal).then(result => {
      if (request.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (result.bytes <= activityCacheLimit) {
        activityCache.set(key, { snapshot: result.snapshot, bytes: result.bytes }); activityCacheBytes += result.bytes;
        while (activityCacheBytes > activityCacheLimit || activityCache.size > 32) {
          const oldest = activityCache.keys().next().value;
          activityCacheBytes -= activityCache.get(oldest).bytes; activityCache.delete(oldest);
        }
      }
      return result.snapshot;
    }).finally(() => { if (activityRequests.get(key) === request) activityRequests.delete(key); });
    activityRequests.set(key, request); return request.promise;
  }
  function scheduleMessages(id, immediate = false) {
    if (id) dirtyMessageIds.add(id); else allMessagesDirty = true;
    if (immediate && messageRenderTimer !== undefined) { clearTimeout(messageRenderTimer); messageRenderTimer = undefined; }
    const requestRender = () => {
      messageRenderTimer = undefined;
      messageRenderFrame = requestAnimationFrame(() => {
        messageRenderFrame = undefined;
        const dirty = allMessagesDirty ? undefined : new Set(dirtyMessageIds);
        renderMessages(false, dirty);
      });
    };
    if (messageRenderTimer === undefined && messageRenderFrame === undefined) {
      if (immediate) requestRender(); else messageRenderTimer = setTimeout(requestRender, 50);
    }
  }
  // Prefer complete unique anchors; recover only unique paragraph-final sentences.
  // Placement metadata never becomes message copy or HTML.
  function outputAnchor(nodes, value, titleOnly = false, recoverSentence = false) {
    if (typeof value !== 'string' || !value.trim()) return;
    const normalize = text => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const wanted = normalize(inlineText(value));
    const candidates = nodes.filter(node => node.nodeType === 1 && !node.matches('pre,.code-block,.activity') && (!titleOnly || /^H[1-6]$/i.test(node.tagName)));
    const exact = candidates.filter(node => normalize(node.textContent) === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length || titleOnly || !recoverSentence || wanted.length < 8 || !/[。！？.!?:]$/.test(wanted)) return;
    // A model may quote the final complete sentence rather than its whole paragraph.
    // Recover only unique sentence boundaries, never an arbitrary substring.
    const suffixes = candidates.filter(node => {
      if (!node.matches('p')) return false;
      const text = normalize(node.textContent);
      return text.endsWith(wanted) && /[。！？.!?][”’"')）\]]?$/.test(text.slice(0, -wanted.length).trimEnd());
    });
    if (suffixes.length !== 1) return;
    const paragraph = suffixes[0];
    const next = nodes.slice(nodes.indexOf(paragraph) + 1).find(node => !node.matches('.activity-process'));
    // Keep a short, explicit lead-in ending in ':' immediately above its visual.
    if (next?.matches('p')) {
      const caption = normalize(next.textContent);
      if (caption.length > 4 && caption.length <= 160 && caption.endsWith(':')) return next;
    }
    return paragraph;
  }
  function inlineText(value) { const node = el('span'); inline(node, value); return node.textContent; }
  function outputCheckpoint(message, view, item) {
    const items = message.snapshot?.items || [];
    let index = items.findIndex(activity => activity.type === 'tool' && activity.operationKey === `output:${item.output?.id}`);
    if (index < 0 && messageInteractions(message).filter(interaction => interaction.kind === 'output').length === 1) {
      const calls = items.filter(activity => activity.type === 'tool' && activity.name === 'present_output');
      if (calls.length === 1) index = items.indexOf(calls[0]);
    }
    const response = items.slice(0, Math.max(index, 0)).reverse().find(activity => activity.type === 'response' || activity.type === 'commentary');
    const tool = items[index];
    const process = tool && [...(view.processParts?.values() || [])]
      .find(node => activityViews.get(node)?.snapshot.items.some(activity => activity.id === tool.id));
    const part = response && view.responseParts?.get(response.id);
    return { anchor: (part?.displayNodes || part?.nodes)?.at(-1), process };
  }
  function outputParts(item, textNodes, checkpoint, completed) {
    const output = item.output;
    if (!output?.blocks?.length) return [{ key: item.id, output }];
    const split = output.blocks.some(block => block.after) || output.blocks.length > 1 && output.blocks.some(block => outputAnchor(textNodes, block.title, true));
    return (split ? output.blocks.map((block, index) => ({ key: `${item.id}:block:${index}`, index,
      output: { ...output, title: block.title || output.title, blocks: [block] }, after: block.after || output.after, title: block.title || output.title }))
      : [{ key: item.id, output, after: output.after, title: output.title }])
      .map(part => ({ ...part, anchor: (part.after ? outputAnchor(textNodes, part.after, false, completed) : outputAnchor(textNodes, part.title, true))
        || ((!part.after || completed) ? checkpoint : undefined) }));
  }
  function disposeMessageOutputs(article) {
    userTextResize?.unobserve(messageViews.get(article)?.userText?.content || article);
    for (const game of messageViews.get(article)?.imageGenerations?.values() || []) {
      game.dispose(); generationGames.delete(game);
    }
    for (const interaction of messageViews.get(article)?.interactions.values() || []) interaction.outputView?.dispose?.();
  }
  function userTextOverflows(view) {
    // The CSS preview shows twelve lines at the user bubble's inherited line height.
    return view.content.getBoundingClientRect().height > parseFloat(getComputedStyle(view.preview).lineHeight) * 12 + 1;
  }
  function updateUserText(view) {
    view.overflows = userTextOverflows(view);
    const expanded = expandedUserMessages.has(view.article);
    view.bubble.classList.toggle('user-message-expanded', expanded);
    view.toggle.hidden = !view.overflows;
    view.toggle.textContent = expanded ? '收起' : '展开全文';
    view.toggle.setAttribute('aria-expanded', String(expanded));
  }
  function foldUserText(bubble, article) {
    const preview = el('div', 'user-message-preview'), content = el('div', 'user-message-content');
    const toggle = el('button', 'user-message-toggle', '展开全文');
    content.append(...bubble.childNodes); preview.append(content);
    preview.id = `user-message-${crypto.randomUUID()}`;
    toggle.type = 'button'; toggle.hidden = true; toggle.setAttribute('aria-controls', preview.id);
    bubble.append(preview, toggle);
    const view = { bubble, article, preview, content, toggle };
    bubble.classList.toggle('user-message-expanded', expandedUserMessages.has(article));
    toggle.onclick = () => {
      const root = readingScroller(), readingEdge = readingTopEdge();
      const offset = bubble.getBoundingClientRect().top - readingEdge;
      const collapse = expandedUserMessages.has(article);
      if (collapse) expandedUserMessages.delete(article); else expandedUserMessages.add(article);
      updateUserText(view);
      // Keep the preview in place on expansion; bring its start back into view
      // when collapsing a message whose beginning has scrolled offscreen.
      root.scrollTop += bubble.getBoundingClientRect().top - readingEdge - (collapse ? Math.max(0, offset) : offset);
      rememberReadingPosition(); messageWindow.remember();
    };
    userTextViews.set(content, view); userTextResize?.observe(content);
    return view;
  }
  function resizeConversationOutput(update) {
    const position = captureReadingPosition(); update();
    restoreReadingPosition(position, false, true);
    rememberReadingPosition();
  }
  // Keep each form's authenticated notice identity, while rendering it at the
  // assistant tool checkpoint. Legacy rows are paired only when the count is exact.
  function questionPlacements(visible) {
    const byId = new Map(visible.map(message => [message.id, message])), placed = new Map(), moved = new Map(), legacy = new Map();
    const attach = (parent, source, item, activityId) => {
      const entries = placed.get(parent.id) || []; entries.push({ source, item, activityId }); placed.set(parent.id, entries);
      const ids = moved.get(source.id) || new Set(); ids.add(item.id); moved.set(source.id, ids);
    };
    let parent;
    for (const source of visible) {
      if (source.role === 'user') parent = undefined;
      if (source.role === 'assistant') parent = source;
      if (source.role !== 'notice') continue;
      for (const item of messageInteractions(source).filter(item => item.kind === 'user-question')) {
        if (item.placement) {
          const target = byId.get(item.placement.messageId);
          if (target?.role === 'assistant' && target.conversationId === source.conversationId
            && target.snapshot?.items.some(activity => activity.id === item.placement.activityId && activity.type === 'tool' && activity.name === 'ask_user_question'))
            attach(target, source, item, item.placement.activityId);
        } else if (parent && parent.conversationId === source.conversationId) {
          const entries = legacy.get(parent.id) || []; entries.push({ source, item }); legacy.set(parent.id, entries);
        }
      }
    }
    for (const [id, entries] of legacy) {
      const target = byId.get(id), occupied = new Set((placed.get(id) || []).map(entry => entry.activityId));
      const checkpoints = (target.snapshot?.items || []).filter(item => item.type === 'tool' && item.name === 'ask_user_question' && !occupied.has(item.id));
      if (checkpoints.length === entries.length) entries.forEach((entry, index) => attach(target, entry.source, entry.item, checkpoints[index].id));
    }
    return { placed, moved };
  }
  // Each ordinary text item keeps its place among the process events. This same
  // durable sequence is used for live SSE, refresh and restored session history.
  function responsePart(text, writingKey, running, previous, message) {
    const writingRunning = running && /^\s{0,3}[`~]{3,}\s*(writing|email|letter|reply)\b/im.test(text);
    if (previous?.text === text && previous.writingKey === writingKey && previous.writingRunning === writingRunning) return { ...previous, running };
    const suffix = previous && text.startsWith(previous.text) ? text.slice(previous.text.length) : undefined;
    // A plain paragraph can grow in place. Formatting delimiters, new blocks,
    // replacements and completion always go through the complete Markdown parser.
    const plain = value => !/[\n\r\\`*_~$<>\[\]#|!]/.test(value);
    if (running && previous?.running && previous.writingKey === writingKey && previous.plainTail && suffix && plain(suffix)) {
      previous.nodes.at(-1).textContent += suffix;
      return { ...previous, text };
    }
    const nodes = [...markdown(text, 0, message).childNodes];
    const boundary = text.lastIndexOf('\n\n'), tail = text.slice(boundary < 0 ? 0 : boundary + 2);
    return { text, writingKey, running, writingRunning, nodes,
      plainTail: nodes.at(-1)?.matches('p') && plain(tail) && !/^\s*(?:[-+]|[0-9])/.test(tail) };
  }
  // A tool continuation can repeat an earlier answer with revised headings.
  // Only fold an earlier response when a later one repeats most of its prose.
  function supersededResponse(item, items, index) {
    const paragraphs = item.text.split(/\n\s*\n/).map(text => text.trim())
      .filter(text => text.length >= 20 && !/^#{1,6}\s/.test(text));
    const total = paragraphs.reduce((sum, text) => sum + text.length, 0);
    if (paragraphs.length < 4 || total < 300) return false;
    return items.slice(index + 1).some(next => {
      if (next.type !== 'response') return false;
      const matched = paragraphs.filter(text => next.text.includes(text));
      return matched.length >= 4 && matched.reduce((sum, text) => sum + text.length, 0) >= total * 0.8;
    });
  }
  function pendingImageGenerations(view, message) {
    const pending = message.role === 'assistant' && message.snapshot?.status === 'running'
      ? message.snapshot.items.filter(item => item.type === 'tool' && item.name === 'image_generation' && item.status === 'running') : [];
    const games = new Map(), cards = new Map();
    for (const item of pending) {
      let game = view.imageGenerations?.get(item.id);
      if (!game || !generationGames.has(game)) {
        game = createImageGeneration(); game.node.dataset.activityId = item.id;
        generationGames.add(game);
      }
      games.set(item.id, game); cards.set(item.id, game.node);
    }
    for (const [id, game] of view.imageGenerations || []) if (!games.has(id)) {
      game.dispose(); generationGames.delete(game);
    }
    view.imageGenerations = games;
    return cards;
  }
  function responseTimeline(view, message, restoreScroll, questions, imageGenerations) {
    const writingKey = JSON.stringify(message.writingEdits);
    const { items, children: subagents } = subagentTimeline(message.snapshot?.items, message.snapshot?.status);
    const hasResponses = items.some(item => item.type === 'response');
    const hasCommentary = items.some(item => item.type === 'commentary');
    if (!hasResponses && !hasCommentary && !questions?.length && !subagents.length) return;
    view.responseParts ||= new Map(); view.processParts ||= new Map(); view.questionParts ||= new Map();
    const nodes = [], usedResponses = new Set(), usedProcesses = new Set(), usedQuestions = new Set();
    const operationResults = Object.fromEntries(items.filter(item => item.type === 'tool' && item.operationKey).map(item => [item.operationKey, item.status]));
    let process = [];
    const flush = (terminal = false) => {
      if (!process.length && !(terminal && message.snapshot.status === 'running' && items.at(-1)?.status !== 'running')) return;
      const key = process[0]?.id || `waiting:${items.at(-1)?.id}`;
      usedProcesses.add(key);
      const snapshot = { ...message.snapshot, items: process, operationResults,
        status: terminal ? message.snapshot.status : 'completed', failureMessage: terminal ? message.snapshot.failureMessage : undefined };
      // The game replaces its loading summary. Full process history returns
      // when the tool finishes, without a generation label or spinner above it.
      if (!process.some(item => imageGenerations.has(item.id))) {
        const details = activity(snapshot, `${message.id}:${key}`, view.processParts.get(key), restoreScroll, message);
        view.processParts.set(key, details); nodes.push(details);
      }
      for (const item of process) if (imageGenerations.has(item.id)) nodes.push(imageGenerations.get(item.id));
      process = [];
    };
    for (const [itemIndex, item] of items.entries()) {
      if (item.type === 'subagent') {
        if (item.id === subagents[0].id) {
          flush(); view.subagents = renderSubagents(subagents, message, view.subagents); nodes.push(view.subagents.node);
        }
        continue;
      }
      const forms = (questions || []).filter(question => question.activityId === item.id);
      if (forms.length) {
        flush(); usedQuestions.add(item.id);
        let checkpoint = view.questionParts.get(item.id);
        if (!checkpoint) { checkpoint = el('div', 'activity activity-question'); view.questionParts.set(item.id, checkpoint); }
        syncChildren(checkpoint, forms.map(form => form.node)); nodes.push(checkpoint); continue;
      }
      if (item.type !== 'response' && item.type !== 'commentary') {
        process.push(item);
        // Keep the visual's preparation separate from the thinking that follows it.
        if (item.type === 'tool' && item.name === 'present_output' && item !== items.at(-1)) flush();
        continue;
      }
      flush(); usedResponses.add(item.id);
      let part = view.responseParts.get(item.id);
      const running = message.snapshot.status === 'running';
      part = responsePart(item.text, writingKey, running, part, message);
      if (item.type === 'response' && !running && supersededResponse(item, items, itemIndex)) {
        const details = part.repeatedDetails || el('details', 'response-superseded');
        const summary = details.firstElementChild || el('summary', '', '查看先前内容');
        syncChildren(details, [summary, ...part.nodes]);
        part.repeatedDetails = details; part.displayNodes = [details];
      } else part.displayNodes = part.nodes;
      view.responseParts.set(item.id, part);
      nodes.push(...part.displayNodes);
    }
    flush(true);
    // Legacy snapshots have one unsplit answer; preserve it instead of dropping it.
    if (!hasResponses && message.text) {
      view.legacyTextPart = responsePart(message.text, writingKey, message.snapshot.status === 'running', view.legacyTextPart, message);
      nodes.push(...view.legacyTextPart.nodes);
    }
    for (const key of view.questionParts.keys()) if (!usedQuestions.has(key)) view.questionParts.delete(key);
    for (const key of view.responseParts.keys()) if (!usedResponses.has(key)) view.responseParts.delete(key);
    for (const key of view.processParts.keys()) if (!usedProcesses.has(key)) view.processParts.delete(key);
    return nodes;
  }
  function renderBrowserEntry() {
    const session = appState.current && appState.browserSession;
    const running = Boolean(session?.running && session.mode !== 'stopped' && session.pauseReason !== 'idle');
    const indicator = $('open-browser'); indicator.hidden = !running;
    indicator.dataset.mode = session?.mode || '';
    indicator.title = running && session.agentRunning ? 'Agent 正在操作电脑' : '进入浏览器';
  }
  function browserEntryMessages(visible) {
    if (!appState.current || !appState.browserSession) return new Set();
    const replies = visible.filter(message => message.role === 'assistant'
      && message.snapshot?.items.some(item => item.type === 'tool' && item.name === 'browser'));
    if (replies.length) return new Set(replies.map(message => message.id));
    // Older history may have no tool snapshots. Its durable browser notice still
    // supplies a chronological position; never fall back to the end of the log.
    const notice = visible.find(message => messageInteractions(message).some(item => item.kind === 'browser' && item.browserSession?.id === appState.browserSession.id));
    return new Set(notice ? [notice.id] : []);
  }
  function messageBrowserEntry(previous) {
    let view = previous;
    if (!view) {
      const node = el('button', 'browser-entry'), icon = el('span', 'browser-entry-icon'), copy = el('span', 'browser-entry-copy'),
        title = el('strong'), state = el('span'), open = el('span', 'browser-entry-open', '进入浏览器 ↗');
      node.type = 'button'; node.setAttribute('aria-haspopup', 'dialog');
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/></svg>';
      copy.append(title, state); node.append(icon, copy, open);
      node.onclick = () => openCurrentBrowser(node);
      view = { node, title, state };
    }
    const session = appState.browserSession, running = session.running && session.mode !== 'stopped' && session.pauseReason !== 'idle';
    updateText(view.title, session.title || '浏览器');
    updateText(view.state, !running ? '已关闭' : session.mode === 'agent' ? (session.agentRunning ? '正在操作电脑' : '空闲') : session.mode === 'user' ? '你正在操作' : '已暂停');
    return view;
  }
  function groupSavedMemoryReceipts(visible, articles) {
    const byId = new Map(articles.map(article => [article.dataset.id, article]));
    const receipts = new Map();
    let reply;
    for (const message of visible) {
      const article = byId.get(message.id), view = article && messageViews.get(article);
      if (message.role === 'user') reply = undefined;
      if (message.role === 'assistant') reply = view?.tools && [...article.children].includes(view.tools) ? { message, view } : undefined;
      for (const interaction of view?.interactions.values() || []) {
        if (!interaction.node.classList.contains('compact-memory')) continue;
        // Keep the source view and its authenticated document scope intact.
        if (reply && message.conversationId === reply.message.conversationId) {
          const nodes = receipts.get(reply.view) || []; nodes.push(interaction.node); receipts.set(reply.view, nodes);
        } else if (interaction.node.parentNode !== article) article.append(interaction.node);
      }
    }
    for (const article of articles) {
      const view = messageViews.get(article);
      if (view?.tools && [...article.children].includes(view.tools)) syncChildren(view.tools,
        [...(view.copy.hidden ? [] : [view.copy]), view.branch, ...(view.duration.hidden ? [] : [view.duration]), ...(receipts.get(view) || [])]);
    }
    for (const article of articles) {
      if (!article.classList.contains('virtual-message')) article.hidden = !article.children.length;
    }
  }
  function renderMessages(forceScroll = false, dirtyIds) {
    const started = performance.now();
    try { return renderMessageViews(forceScroll, dirtyIds); }
    finally { window.ZigentTelemetry?.record('web.render', performance.now() - started); }
  }
  function renderMessageViews(forceScroll = false, dirtyIds) {
    if (messageRenderFrame !== undefined) { cancelAnimationFrame(messageRenderFrame); messageRenderFrame = undefined; }
    if (messageRenderTimer !== undefined) { clearTimeout(messageRenderTimer); messageRenderTimer = undefined; }
    dirtyMessageIds.clear(); allMessagesDirty = false;
    const reading = readingMetrics(), position = captureReadingPosition();
    const nearBottom = reading.nearBottom;
    const existing = new Map([...$('messages').children].map(node => [node.dataset.id, node]));
    const articles = [], restoreScroll = [], outputMounts = [];
    const pending = pendingArticles();
    const greeting = appState.current ? appState.conversationGreeting : appState.homeGreeting;
    $('welcome-greeting').textContent = greeting;
    $('welcome').hidden = appState.messagesLoading || appState.messages.length > 0 || pending.length > 0 || !greeting;
    $('new-mobile').hidden = !appState.messagesLoading && appState.messages.length === 0 && pending.length === 0;
    $('messages-loading').hidden = !appState.messagesLoading;
    $('messages').setAttribute('aria-busy', String(appState.messagesLoading));
    $('older').hidden = !appState.hasOlder;
    const visible = [...appState.messages];
    // busy includes delivery/cleanup after the reply completes. Only synthesize a
    // waiting row before this request has a reply; a terminal reply owns its state.
    // Match the request ID so an older reply cannot hide the next queued turn.
    const hasActiveReply = appState.activeMessageId && visible.some(message =>
      message.role === 'assistant' && message.replyTo === appState.activeMessageId);
    if (appState.busy && !hasActiveReply && !visible.some(message => message.snapshot?.status === 'running'))
      visible.push({ id: 'waiting', role: 'assistant', snapshot: { status: 'running', items: [] } });
    const questionPositions = questionPlacements(visible);
    const browserEntries = browserEntryMessages(visible);
    messageWindow.prepare(visible, existing, appState.selectionVersion, forceScroll || nearBottom);
    let mountedReply;
    for (const [index, message] of visible.entries()) {
      if (message.role === 'user' || message.role === 'assistant') mountedReply = undefined;
      const remainingInteractions = messageInteractions(message).filter(item => !questionPositions.moved.get(message.id)?.has(item.id)
        && (item.kind !== 'browser' || item.actions?.some(action => action.value?.pendingId)));
      if (message.role === 'notice' && !remainingInteractions.length && !message.text && !message.assets?.length && !message.action && !browserEntries.has(message.id)) continue;
      let article = existing.get(message.id);
      if (!article) {
        article = el('article', `message ${message.role}`); article.dataset.id = message.id;
      }
      existing.delete(message.id);
      const pinned = message.snapshot?.status === 'running' || remainingInteractions.some(item => interactionStatus(item) === 'pending')
        || questionPositions.placed.get(message.id)?.some(({ item }) => interactionStatus(item) === 'pending')
        // Saved-memory badges are owned by their notice, but mounted inside this reply's toolbar.
        || message.role === 'notice' && mountedReply === message.conversationId && remainingInteractions.some(item => item.kind === 'memory-proposal');
      if (!messageWindow.shouldMount(message, article, index, pinned)) {
        messageWindow.suspend(message, article); articles.push(article); continue;
      }
      const resumed = messageWindow.resume(article);
      if (message.role === 'assistant') mountedReply = message.conversationId;
      if (dirtyIds && !resumed && !dirtyIds.has(message.id) && message.id !== 'waiting' && messageViews.has(article)) {
        articles.push(article); continue;
      }
      if (!messageViews.has(article)) messageViews.set(article, { body: [], interactions: new Map() });
      article.hidden = false;
      const view = messageViews.get(article), children = [];
      const interactionIds = new Set();
      const inlineQuestions = (questionPositions.placed.get(message.id) || []).map(({ source, item, activityId }) => {
        const key = `question:${source.id}:${item.id}`; interactionIds.add(key);
        const interaction = renderInteraction(item, source, view.interactions.get(key)); view.interactions.set(key, interaction);
        return { activityId, node: interaction.node };
      });
      const imageGenerations = pendingImageGenerations(view, message);
      const timelineNodes = responseTimeline(view, message, restoreScroll, inlineQuestions, imageGenerations);
      if (message.snapshot && !timelineNodes) {
        if (imageGenerations.size) children.push(...imageGenerations.values());
        else {
          view.activity = activity(message.snapshot, message.id, view.activity, restoreScroll, message);
          children.push(view.activity);
        }
      }
      // Snapshot-only deltas must not recreate answers, attachments or action buttons.
      const repeatedNotice = message.role === 'notice' && message.text && messageInteractions(message)
        .some(item => item.description === message.text || item.statusMessage === message.text);
      const displayText = repeatedNotice ? '' : message.text;
      const bodyKey = JSON.stringify([message.role, displayText, message.assets, message.files, message.assets?.map(id => appState.assetDimensions[id]), message.writingEdits,
        /^\s{0,3}[`~]{3,}\s*(writing|email|letter|reply)\b/im.test(displayText) && message.snapshot?.status === 'running']);
      if (view.bodyKey !== bodyKey) {
        if (view.userText) { userTextResize?.unobserve(view.userText.content); view.userText = undefined; }
        view.bodyKey = bodyKey;
        const body = [];
        if (displayText) {
          const text = message.role === 'user' ? userMessageText(displayText) : message.role === 'assistant' ? (view.answer ||= el('div', 'message-text')) : markdown(displayText);
          if (message.role === 'assistant' && !timelineNodes) view.answerNodes = [...markdown(displayText, 0, message).childNodes];
          if (message.role === 'user') {
            text.dataset.messageId = message.id; text.tabIndex = 0; text.setAttribute('aria-haspopup', 'menu');
            text.setAttribute('aria-description', '长按或按 Shift+F10 打开消息操作');
            view.userText = foldUserText(text, article);
            restoreScroll.push(() => updateUserText(view.userText));
          }
          body.push(text);
        }
        if (message.assets?.length) {
          // Streamed captions keep the existing image and its prepared share file.
          const mediaKey = JSON.stringify([message.role, message.assets, message.files, message.assets.map(id => appState.assetDimensions[id])]);
          if (view.mediaKey !== mediaKey) {
            const media = el('div', 'message-assets');
            for (const [index, id] of message.assets.entries()) {
              const link = el('a', 'message-asset-preview'); link.href = assetUrl(id); link.target = '_blank'; link.rel = 'noopener';
              const document = message.files?.[id];
              if (document) {
                link.className='message-document';link.textContent=document.name;link.title=document.name;
                const actions=el('span','message-document-actions');actions.append(link);
                if(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(document.name)) {
                  link.dataset.documentPreview='';link.dataset.uploadId=id;link.dataset.filename=document.name;
                  const preview=el('button','','预览');preview.type='button';preview.dataset.documentPreview='';preview.dataset.uploadId=id;preview.dataset.filename=document.name;actions.append(preview);
                }
                const download=el('a','','下载');download.href=assetUrl(id);download.download=document.name;actions.append(download);media.append(actions);continue;
              }
              const img = el('img'); img.decoding = 'async';
              // Only the final attachment at the reading end can be the initial visible image.
              const prioritize = (forceScroll || nearBottom) && message === visible.at(-1) && index === message.assets.length - 1;
              img.loading = prioritize ? 'eager' : 'lazy';
              if (prioritize) img.fetchPriority = 'high';
              img.src = assetUrl(id, true); img.alt = message.role === 'user' ? '发送的图片' : '生成的图片';
              const size = appState.assetDimensions[id];
              if (size) {
                img.width = size.width; img.height = size.height;
                const maxWidth = message.role === 'user' ? 112 : 380, maxHeight = message.role === 'user' ? 112 : 400;
                img.style.width = `${Math.min(maxWidth, size.width, size.width * maxHeight / size.height)}px`; img.style.height = 'auto';
              }
              img.onerror = () => {
                if (img.src !== new URL(assetUrl(id), location.href).href) { img.src = assetUrl(id); return; }
                img.remove(); link.textContent = '打开附件 ↗';
              };
              link.append(img);
              link.onclick = event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault(); imageViewer.open(id, img, link);
              };
              if (message.role === 'assistant') {
                const frame = el('div', 'message-generated-asset');
                const label = message.assets.length === 1 ? '保存到相册' : `保存图片 ${index + 1} 到相册`;
                frame.append(link, imageAlbumButton(id, label)); media.append(frame);
              } else media.append(link);
            }
            view.mediaKey = mediaKey; view.media = media;
          }
          body.push(view.media);
        } else { view.mediaKey = undefined; view.media = undefined; }
        view.body = body;
        if (!displayText && message.role === 'assistant' && !timelineNodes) view.answerNodes = [];
      }
      if (timelineNodes) view.answerNodes = timelineNodes;
      children.push(...view.body);
      const placedOutputs = [], trailingInteractions = [];
      const textNodes = view.answerNodes || [];
      const seenInteractions = new Set();
      for (const item of remainingInteractions) {
        if (seenInteractions.has(item.id)) continue; seenInteractions.add(item.id);
        const checkpoint = item.kind === 'output' ? outputCheckpoint(message, view, item) : undefined;
        for (const part of item.kind === 'output' ? outputParts(item, textNodes, checkpoint.anchor, message.snapshot?.status !== 'running') : [{ key: item.id }]) {
          interactionIds.add(part.key);
          const previous = view.interactions.get(part.key);
          let interaction;
          if (item.kind === 'output') {
            if (window.ZigentOutputComponents && part.output) {
              const scope = { conversationId: message.conversationId, messageId: message.id, interactionId: item.id };
              const blockIndex = index => part.index === undefined ? index : part.index;
              const outputView = window.ZigentOutputComponents.render(part.output, previous?.outputView, {
                openDocument: (index, trigger) => openConversationDocument(item, message, `block:${blockIndex(index)}`, trigger),
                interactiveUrl: index => new URL(`api/interactive-output?${new URLSearchParams({ ...scope, index: blockIndex(index) })}`, location.href).href,
                resize: resizeConversationOutput
              });
              interaction = { node: outputView.node, outputView };
              if (part.anchor || !part.after || message.snapshot?.status !== 'running') outputMounts.push(outputView);
            } else {
              interaction = previous?.fallback ? previous : { node: el('section', 'interaction output-fallback'), fallback: true };
              updateText(interaction.node, part.output?.title || '可视化结果暂时无法显示，请刷新页面重试。');
            }
          } else interaction = renderInteraction(item, message, previous?.outputView || previous?.fallback ? undefined : previous);
          if (previous?.outputView && previous.outputView !== interaction.outputView) previous.outputView.dispose?.();
          view.interactions.set(part.key, interaction);
          if (item.kind === 'output' && message.role === 'assistant') {
            // Wait for a streamed anchor instead of mounting at the bottom and moving a live iframe.
            if (part.anchor || !part.after || message.snapshot?.status !== 'running') placedOutputs.push({ ...part, node: interaction.node, process: checkpoint.process });
          } else if (!interaction.node.classList.contains('compact-memory') || !interaction.node.parentNode?.classList.contains('message-tools')) trailingInteractions.push(interaction.node);
        }
      }
      if (message.role === 'assistant' && (textNodes.length || placedOutputs.length)) {
        const answer = view.answer ||= el('div', 'message-text'), content = [];
        for (const text of textNodes) { content.push(text); content.push(...placedOutputs.filter(part => part.anchor === text).map(part => part.node)); }
        content.push(...placedOutputs.filter(part => !part.anchor).map(part => part.node));
        // An explicit text anchor can precede the tool checkpoint. Bring its
        // process above the first visual, retaining the keyed, expandable view.
        for (const part of [...placedOutputs].sort((a, b) => content.indexOf(a.node) - content.indexOf(b.node))) {
          const outputIndex = content.indexOf(part.node), processIndex = content.indexOf(part.process);
          if (processIndex <= outputIndex) continue;
          content.splice(processIndex, 1); content.splice(outputIndex, 0, part.process);
        }
        syncChildren(answer, content);
        if (!children.includes(answer)) children.splice(message.snapshot && !timelineNodes ? 1 : 0, 0, answer);
      }
      children.push(...trailingInteractions);
      for (const [id, interaction] of view.interactions) if (!interactionIds.has(id)) { interaction.outputView?.dispose?.(); view.interactions.delete(id); }
      const hasDuration = Number.isFinite(message.replyDurationMs) && message.replyDurationMs >= 0;
      if (message.role === 'assistant' && (message.text || message.assets?.length || hasDuration) && message.snapshot?.status !== 'running') {
        if (!view.tools) {
          view.tools = el('div', 'message-tools'); view.tools.setAttribute('role', 'group'); view.tools.setAttribute('aria-label', '回复操作');
          view.copy = messageButton('copy', '复制回复'); view.branch = messageButton('branch', '从这里创建分支');
          view.duration = el('span', 'message-duration');
          view.feedback = el('p', 'message-action-status'); view.feedback.setAttribute('role', 'status');
          view.tools.append(view.copy, view.branch, view.duration);
        }
        view.copy.onclick = () => copyText(message.text, view.copy, '复制回复');
        view.copy.hidden = !message.text;
        view.branch.onclick = () => branchReply(message, view);
        view.branch.disabled = isForking() || Boolean(message.snapshot && message.snapshot.status !== 'completed');
        view.duration.hidden = !hasDuration;
        updateText(view.duration, hasDuration ? `${(message.replyDurationMs / 1000).toFixed(1)}s` : '');
        if (hasDuration) view.duration.setAttribute('aria-label', `整轮处理耗时 ${view.duration.textContent}`);
        children.push(view.tools); if (view.feedback.textContent) children.push(view.feedback);
      }
      if (browserEntries.has(message.id)) { view.browserEntry = messageBrowserEntry(view.browserEntry); children.push(view.browserEntry.node); }
      syncChildren(article, children); articles.push(article);
    }
    for (const article of existing.values()) disposeMessageOutputs(article);
    groupSavedMemoryReceipts(visible, articles);
    syncChildren($('messages'), [...articles, ...pending]);
    for (const output of outputMounts) output.mount?.();
    // Restore after attachment, in this same frame, before the browser paints.
    for (const restore of restoreScroll) restore();
    renderSend(); renderBrowserEntry();
    messageWindow.observe(articles);
    if (forceScroll) scrollReadingToBottom();
    else restoreReadingPosition(position, false, true);
    rememberReadingPosition(); messageWindow.remember();
    if (!dirtyIds) scheduleInteractionExpiry();
    window.ZigentTelemetry?.rendered(visible);
  }
  return { activity, renderMessages, scheduleMessages, renderBrowserEntry, disposeMessageOutputs, cancelActivityLoads, clearActivity,
    syncReadingRoot: () => { messageWindow.syncRoot(); messageWindow.remember(); } };
}
