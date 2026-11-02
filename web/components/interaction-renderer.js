import { createMarkdownRenderer } from '../markdown.js';
import { el, syncChildren, updateText } from '../dom.js';
import { interactionUrl, interactionStatus, messageInteractions } from './interaction-model.js';
import { projectOperationChange, renderOperationPreview } from './operation-preview.js';

export function createInteractionRenderer({ conversation: appState, api, loadModelLibrary, openConversationDocument, openBrowserWorkspace, openPanel, refresh, renderMessages }) {
  const { markdown } = createMarkdownRenderer({ openConversationDocument });
  let interactionExpiryTimer;
  const changePreviewHeight = 180, changePreviews = new WeakMap();
  function syncChangePreview(preview) {
    if (!preview.content.getClientRects().length) return;
    const overflowing = !preview.unclipped && preview.content.getBoundingClientRect().height > changePreviewHeight;
    preview.expanded = overflowing && preview.expanded;
    preview.node.classList.toggle('expanded', preview.expanded);
    preview.node.classList.toggle('truncated', overflowing && !preview.expanded);
    preview.toggle.hidden = !overflowing;
    preview.toggle.setAttribute('aria-expanded', String(preview.expanded));
    updateText(preview.toggle, preview.expanded ? '收起' : '展开全部');
  }
  const changePreviewObserver = new ResizeObserver(entries => {
    for (const { target } of entries) {
      if (!target.isConnected) { changePreviewObserver.unobserve(target); continue; }
      const preview = changePreviews.get(target);
      if (preview) syncChangePreview(preview);
    }
  });
  function observeChangePreview(view, item) {
    if (!view.changePreview) {
      const viewport = el('div', 'change-preview-viewport'), content = el('div', 'change-preview-content'),
        toggle = el('button', 'change-preview-toggle', '展开全部');
      toggle.type = 'button'; toggle.hidden = true; toggle.setAttribute('aria-expanded', 'false');
      viewport.id = `change-preview-${item.id}`; toggle.setAttribute('aria-controls', viewport.id);
      viewport.append(content); view.memoryDiff.append(viewport, toggle);
      view.memoryDiff.style.setProperty('--change-preview-height', `${changePreviewHeight}px`);
      const preview = view.changePreview = { node: view.memoryDiff, viewport, content, toggle, expanded: false };
      toggle.onclick = () => {
        const collapsing = preview.expanded;
        preview.expanded = !preview.expanded; syncChangePreview(preview);
        if (collapsing) toggle.scrollIntoView({ block: 'nearest' });
      };
      // Reveal any clipped control reached by keyboard navigation.
      viewport.addEventListener('focusin', event => {
        if (!preview.expanded && event.target.getBoundingClientRect().bottom > viewport.getBoundingClientRect().bottom) {
          preview.expanded = true; syncChangePreview(preview);
        }
      });
      changePreviews.set(content, preview);
    }
    changePreviewObserver.observe(view.changePreview.content);
    return view.changePreview;
  }
  function memoryDiffLines(before, after, contextLines = 3) {
    const oldLines = typeof before === 'string' ? before.split('\n') : [], newLines = typeof after === 'string' ? after.split('\n') : [];
    const rows = [], n = oldLines.length, m = newLines.length;
    // Bound comparison work for long, newline-heavy records. The fallback still
    // shows every removed/added line and retains the common leading/trailing text.
    if (n * m > 200000) {
      let start = 0, end = 0;
      while (start < n && start < m && oldLines[start] === newLines[start]) start++;
      while (end < n - start && end < m - start && oldLines[n - end - 1] === newLines[m - end - 1]) end++;
      oldLines.slice(0, start).forEach(text => rows.push({ kind: 'context', text }));
      oldLines.slice(start, n - end).forEach(text => rows.push({ kind: 'remove', text }));
      newLines.slice(start, m - end).forEach(text => rows.push({ kind: 'add', text }));
      oldLines.slice(n - end).forEach(text => rows.push({ kind: 'context', text }));
    } else {
      const width = m + 1, lengths = new Uint16Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
        lengths[i * width + j] = oldLines[i] === newLines[j] ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && oldLines[i] === newLines[j]) { rows.push({ kind: 'context', text: oldLines[i++] }); j++; }
        else if (j < m && (i === n || lengths[i * width + j + 1] > lengths[(i + 1) * width + j])) rows.push({ kind: 'add', text: newLines[j++] });
        else rows.push({ kind: 'remove', text: oldLines[i++] });
      }
    }
    // Only unchanged context is shortened; all proposed changes remain available.
    const contextRows = contextLines === 1 ? rows.filter(row => row.kind !== 'context' || row.text.trim()) : rows;
    const visible = [];
    for (let start = 0; start < contextRows.length;) {
      if (contextRows[start].kind !== 'context') { visible.push(contextRows[start++]); continue; }
      let end = start;
      while (end < contextRows.length && contextRows[end].kind === 'context') end++;
      const head = start === 0 ? 0 : Math.min(contextLines, end - start), tail = end === contextRows.length ? 0 : Math.min(contextLines, end - start - head);
      if (end - start <= head + tail + 1) visible.push(...contextRows.slice(start, end));
      else {
        visible.push(...contextRows.slice(start, start + head), { kind: 'omit', text: `${end - start - head - tail} 行未变更` }, ...contextRows.slice(end - tail, end));
      }
      start = end;
    }
    return visible;
  }
  function renderDiff(before, after, contextLines = 1) {
    return memoryDiffLines(before, after, contextLines).map(row => {
      const line = el('div', `memory-diff-line ${row.kind}`), marker = el('span', 'memory-diff-marker', { add: '+', remove: '−', context: ' ', omit: '⋯' }[row.kind]);
      marker.setAttribute('aria-hidden', 'true');
      const text = el(row.kind === 'add' ? 'ins' : row.kind === 'remove' ? 'del' : 'span', 'memory-diff-text', row.text || '\u00a0');
      line.append(marker, text); return line;
    });
  }
  function renderTaskChange(change, context, showVisual = true) {
    const state = change.task.after || change.task.before;
    if (!state) return el('div');
    const body = el('div', 'operation-task');
    const visual = showVisual ? window.ZigentTriggerVisual?.render(state.diagram?.visual, context) : undefined;
    const logic = window.ZigentTriggerDiagram?.render(state.diagram);
    const details = el('div', 'operation-task-details');
    if (visual) {
      details.append(visual);
    }
    if (change.task.before) {
      const diff = el('div', 'operation-task-diff');
      diff.append(...renderDiff(change.before, change.after)); details.append(diff);
    } else details.append(el('p', 'operation-task-instruction task-plan-instruction', state.instruction));
    if (logic) {
      const logicDetails = el('details', 'trigger-visual-logic');
      logicDetails.append(el('summary', '', '触发逻辑'), logic);
      details.append(logicDetails);
    }
    body.append(details);
    return body;
  }
  function renderChanges(changes, view, item, message) {
    const nodes = [], keys = new Set();
    const hasTask = changes.some(change => change?.task && change.task.kind !== 'trigger-rule');
    const targetLabel = change => change.title.replace(/^(新增|修改|删除)(长期记忆|存档记忆.*|个人档案|行为规则)$/, '$2');
    const targets = new Set(changes.filter(change => typeof change?.title === 'string').map(targetLabel));
    let previousTarget;
    for (const [index, change] of changes.entries()) {
      if (!change || typeof change.title !== 'string' || (typeof change.before !== 'string' && typeof change.after !== 'string')) continue;
      const key = String(index); keys.add(key);
      let entry = view.memoryEntries.get(key);
      if (!entry) {
        entry = { node: el('section', 'memory-diff-change'), label: el('p', 'memory-diff-label'), body: el('div', 'memory-diff-body'), note: el('p', 'change-preview-note') };
        entry.node.append(entry.label, entry.note, entry.body); view.memoryEntries.set(key, entry);
      }
      const bundledRule = hasTask && change.task?.kind === 'trigger-rule';
      const special = ['todo', 'calendar'].includes(item.operationView);
      const scheduleChange = ['todo', 'calendar'].includes(change.presentation?.kind) || special;
      const target = targetLabel(change); updateText(entry.label, target);
      entry.label.hidden = scheduleChange || bundledRule || targets.size < 2 || target === previousTarget; previousTarget = target;
      const showDiff = typeof change.before === 'string' || item.kind === 'memory-proposal';
      const snapshot = JSON.stringify([change, bundledRule, showDiff, item.operationView, item.status]);
      if (entry.snapshot !== snapshot) {
        entry.snapshot = snapshot;
        entry.node.setAttribute('aria-label', change.title);
        updateText(entry.note, typeof change.note === 'string' ? change.note : ''); entry.note.hidden = !entry.note.textContent;
        // Memory additions are part of a change proposal, so mark every added line.
        // Other new objects show plain content; an empty original still counts as a diff.
        const visual = change.presentation ? renderOperationPreview(change.presentation) : undefined;
        entry.note.hidden = !!visual && !(changes.length > 1 && change.note === '已完成' && !(item.operationView === 'todo' && item.status === 'completed')) || !entry.note.textContent;
        if (change.task) {
          const context = side => message ? { kind: 'interaction', conversationId: message.conversationId, messageId: message.id, id: item.id, index, side } : undefined;
          const nodes = [renderTaskChange(change, context(change.task.after ? 'after' : 'before'), !bundledRule)];
          if (bundledRule) {
            // The task already shows this rule's map; retain its revision and
            // subscriber impact as reviewable details without loading a second map.
            const details = el('details', 'operation-trigger-rule trigger-visual-logic');
            details.append(el('summary', '', target), ...nodes); entry.body.replaceChildren(details);
          } else entry.body.replaceChildren(...nodes);
        } else if (visual && change.presentation?.kind === 'document') {
          const document = el('section', 'content-preview content-preview-document');
          const documentTitle = el('h4', '', change.presentation.title || '');
          documentTitle.style.textAlign = 'left';
          documentTitle.style.color = 'var(--muted)';
          documentTitle.style.fontStyle = 'italic';
          document.append(documentTitle);
          const diff = el('div', 'operation-preview-original');
          diff.setAttribute('aria-label', '文档差异');
          const rows = memoryDiffLines(change.presentation.before, change.presentation.after, Infinity);
          for (let start = 0; start < rows.length;) {
            let end = start + 1;
            while (end < rows.length && rows[end].kind === rows[start].kind) end++;
            const kind = rows[start].kind, line = el('div', 'memory-diff-line ' + kind);
            const marker = el('span', 'memory-diff-marker', { add: '+', remove: '−', context: ' ' }[kind]);
            marker.setAttribute('aria-hidden', 'true');
            const content = el('div', 'memory-diff-text markdown');
            content.style.whiteSpace = 'normal';
            content.append(markdown(rows.slice(start, end).map(row => row.text).join('\n')));
            line.append(marker, content); diff.append(line); start = end;
          }
          document.append(diff); entry.body.replaceChildren(document);
        } else if (visual && (scheduleChange || ['table', 'mindmap'].includes(change.presentation?.kind))) {
          entry.body.replaceChildren(visual);
        } else if (visual) {
          const details = el('details', 'operation-preview-details'), summary = el('summary', '', '变更明细');
          const original = el('div', 'operation-preview-original');
          if (change.note) original.append(el('p', 'change-preview-note', change.note));
          original.append(...(!showDiff ? [el('p', 'operation-content', change.after)] : renderDiff(change.before, change.after)));
          details.append(summary, original); entry.body.replaceChildren(visual, details);
        } else if (special) {
          const row = el('div', `operation-item operation-item-${item.operationView}`);
          const mark = el('span', 'operation-item-mark', item.operationView === 'calendar' ? String(index + 1).padStart(2, '0') : '');
          mark.setAttribute('aria-hidden', 'true');
          const content = el('div', 'operation-item-content');
          content.append(...(!showDiff ? [el('p', 'operation-content', change.after)] : renderDiff(change.before, change.after)));
          row.append(mark, content); entry.body.replaceChildren(row);
        } else entry.body.replaceChildren(...(!showDiff ? [el('p', 'operation-content', change.after)] : renderDiff(change.before, change.after)));
      }
      nodes.push(entry.node);
    }
    for (const key of view.memoryEntries.keys()) if (!keys.has(key)) view.memoryEntries.delete(key);
    view.memoryDiff.hidden = !nodes.length;
    if (nodes.length || view.changePreview) {
      const preview = observeChangePreview(view, item);
      // Maps and their controls must remain visible even after asynchronous loading.
      preview.unclipped = changes.some(change => change?.task || change?.presentation);
      preview.node.classList.toggle('unclipped', preview.unclipped);
      syncChildren(preview.content, nodes);
      syncChangePreview(preview);
    }
  }
  function createQuestionView() {
    const node = el('section', 'interaction user-question'), questions = el('div', 'question-fields'),
      footer = el('div', 'question-footer'), skip = el('button', 'question-skip', '跳过'),
      navigation = el('div', 'question-navigation'), previous = el('button', 'question-previous', '‹'),
      progress = el('span', 'question-progress'), next = el('button', 'question-next', '继续'),
      feedback = el('p', 'interaction-feedback'), receipt = el('details', 'question-receipt'),
      receiptTitle = el('summary'), receiptAnswers = el('div', 'question-receipt-answers'), end = el('p', 'question-end');
    for (const button of [skip, previous, next]) button.type = 'button';
    previous.setAttribute('aria-label', '上一题'); progress.setAttribute('aria-live', 'polite');
    node.setAttribute('role', 'group'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
    navigation.append(previous, progress, next); footer.append(skip, navigation);
    receipt.append(receiptTitle, receiptAnswers); node.append(questions, footer, feedback, receipt, end);
    return { node, questions, footer, skip, previous, progress, next, feedback, receipt, receiptTitle, receiptAnswers, end,
      questionEntries: new Map(), questionIndex: 0, submitting: false, questionControls: true };
  }
  function questionDraftKey(item) { return `${location.pathname}:question:${item.id}`; }
  function saveQuestionDraft(item, view) {
    const answers = Object.fromEntries([...view.questionEntries].map(([id, entry]) => [id, {
      selected: [...entry.options].filter(([, choice]) => choice.control.checked).map(([key]) => key), text: entry.input.value
    }]));
    try { sessionStorage.setItem(questionDraftKey(item), JSON.stringify({ questionIndex: view.questionIndex, answers })); } catch {}
  }
  function renderQuestionFields(item, view, status) {
    const questions = Array.isArray(item.questions) ? item.questions : [];
    const nodes = [], keys = new Set();
    for (const [index, question] of questions.entries()) {
      if (!question || typeof question.id !== 'string' || !['single_select', 'multi_select', 'text'].includes(question.type)) continue;
      keys.add(question.id);
      let entry = view.questionEntries.get(question.id);
      if (!entry) {
        const node = el('fieldset', 'question-field'), legend = el('legend', 'question-legend'),
          choices = el('div', 'question-options'), input = el(question.type === 'text' ? 'textarea' : 'input', 'question-input');
        input.maxLength = 4000;
        if (question.type === 'text') input.rows = 1; else input.type = 'text';
        input.setAttribute('aria-label', question.type === 'text' ? '你的回答' : '其他回答');
        node.append(legend, choices); if (question.type === 'text') node.append(input);
        entry = { node, legend, choices, input, options: new Map() };
        const draft = view.questionDraft?.answers?.[question.id];
        if (typeof draft?.text === 'string') input.value = draft.text.slice(0, 4000);
        view.questionEntries.set(question.id, entry);
      }
      updateText(entry.legend, question.question);
      entry.node.disabled = !!view.submitting || status !== 'pending';
      entry.node.hidden = index !== view.questionIndex;
      const options = question.type === 'text' ? [] : Array.isArray(question.options) ? question.options : [];
      const optionNodes = [], optionKeys = new Set();
      const choices = [...options.map(option => ({ ...option, other: false })),
        ...(question.type !== 'text' && question.allowOther !== false ? [{ id: '__other__', label: '其他', other: true }] : [])];
      for (const option of choices) {
        optionKeys.add(option.id);
        let choice = entry.options.get(option.id);
        if (!choice) {
          const node = el(option.other ? 'div' : 'label', `question-option${option.other ? ' question-option-other' : ''}`), control = el('input'),
            copy = el('span', 'question-option-copy'), label = el('span', 'question-option-label'), description = el('span', 'question-option-description');
          control.type = question.type === 'multi_select' ? 'checkbox' : 'radio';
          control.name = `question-${item.id}-${question.id}`; control.value = option.id;
          control.checked = view.questionDraft?.answers?.[question.id]?.selected?.includes(option.id) === true;
          copy.append(label, description); node.append(control, copy);
          if (option.other) { control.setAttribute('aria-label', '其他'); copy.hidden = true; node.append(entry.input); }
          choice = { node, control, label, description }; entry.options.set(option.id, choice);
        }
        updateText(choice.label, option.label); updateText(choice.description, option.description || '');
        choice.description.hidden = !option.description || !choice.control.checked;
        choice.control.onchange = () => {
          view.feedback.textContent = '';
          saveQuestionDraft(item, view);
          renderUserQuestion(item, view.message, view);
          if (option.other && choice.control.checked) entry.input.focus();
        };
        optionNodes.push(choice.node);
      }
      for (const id of entry.options.keys()) if (!optionKeys.has(id)) entry.options.delete(id);
      syncChildren(entry.choices, optionNodes); entry.choices.hidden = !optionNodes.length;
      entry.input.placeholder = question.placeholder || (question.type === 'text' ? '输入回答…' : '其他…');
      if (question.type !== 'text') {
        const chooseOther = () => {
          const other = entry.options.get('__other__');
          if (!other || other.control.checked) return;
          if (question.type === 'single_select') for (const choice of entry.options.values()) choice.control.checked = false;
          other.control.checked = true; renderUserQuestion(item, view.message, view);
        };
        entry.input.oninput = () => { chooseOther(); saveQuestionDraft(item, view); };
      } else entry.input.oninput = () => saveQuestionDraft(item, view);
      nodes.push(entry.node);
    }
    for (const id of view.questionEntries.keys()) if (!keys.has(id)) view.questionEntries.delete(id);
    syncChildren(view.questions, nodes);
  }
  function collectQuestionAnswers(item, view, currentOnly = false) {
    const answers = {}, questions = item.questions || [];
    for (const [index, question] of questions.entries()) {
      if (currentOnly && index !== view.questionIndex) continue;
      const entry = view.questionEntries.get(question.id);
      if (!entry) throw new Error('问题尚未加载完成，请刷新重试。');
      const selectedOptionIds = [...entry.options].filter(([id, choice]) => id !== '__other__' && choice.control.checked).map(([id]) => id);
      const other = entry.options.get('__other__')?.control.checked;
      const text = question.type === 'text' || other ? entry.input.value.trim() : '';
      if ((question.type === 'text' || other) && !text || question.type !== 'text' && !other && !selectedOptionIds.length) {
        view.questionIndex = index;
        view.invalidControl = question.type === 'text' || other ? entry.input : entry.options.values().next().value?.control;
        throw new Error(question.type === 'text' || other ? '请填写回答。' : question.type === 'multi_select' ? '请选择至少一项。' : '请选择一项。');
      }
      answers[question.id] = { ...(selectedOptionIds.length ? { selectedOptionIds } : {}), ...(text ? { text } : {}) };
    }
    return answers;
  }
  function focusCurrentQuestion(item, view) {
    const question = item.questions?.[view.questionIndex], entry = view.questionEntries.get(question?.id);
    if (!entry) return;
    const selected = [...entry.options.values()].find(choice => choice.control.checked);
    const target = question.type === 'text' || selected?.control.value === '__other__' ? entry.input : selected?.control || entry.options.values().next().value?.control;
    target?.focus();
  }
  function renderUserQuestion(item, message, view) {
    if (!view?.questionControls) view = createQuestionView();
    if (!view.draftLoaded) {
      view.draftLoaded = true;
      try { view.questionDraft = JSON.parse(sessionStorage.getItem(questionDraftKey(item)) || 'null'); } catch {}
      if (Number.isInteger(view.questionDraft?.questionIndex)) view.questionIndex = view.questionDraft.questionIndex;
    }
    view.message = message;
    const status = interactionStatus(item), pending = status === 'pending', completed = status === 'completed', questions = item.questions || [];
    if (!pending) { try { sessionStorage.removeItem(questionDraftKey(item)); } catch {} }
    view.questionIndex = Math.max(0, Math.min(view.questionIndex, questions.length - 1));
    const active = questions[view.questionIndex];
    view.node.className = `interaction user-question ${status}`; view.node.dataset.interactionId = item.id;
    view.node.setAttribute('aria-label', pending ? active?.question || '提问' : completed ? '已回答' : '提问已结束');
    view.node.setAttribute('aria-busy', view.submitting ? 'true' : 'false');
    if (pending) renderQuestionFields(item, view, status);
    view.questions.hidden = view.footer.hidden = !pending;
    view.receipt.hidden = !completed; view.end.hidden = pending || completed;
    if (completed) {
      const summaries = [], details = [];
      for (const question of questions) {
        const answer = item.answers?.[question.id];
        const options = question.type === 'text' ? [] : question.options || [];
        const text = [...options.filter(option => answer?.selectedOptionIds?.includes(option.id)).map(option => option.label), answer?.text || ''].filter(Boolean).join('、');
        if (text) { summaries.push(text.length > 40 ? `${text.slice(0, 40)}…` : text); details.push(el('p', '', `${question.header || question.question}：${text}`)); }
      }
      updateText(view.receiptTitle, `${item.questionPurpose === 'workspace' ? '已提交' : '已回答'}${summaries.length ? ` · ${summaries.join(' · ')}` : ''}`);
      syncChildren(view.receiptAnswers, details);
    }
    updateText(view.end, item.questionPurpose === 'workspace'
      ? status === 'cancelled' ? '暂不开始' : status === 'expired' ? '选择已过期' : status === 'failed' ? '选择未完成' : ''
      : status === 'cancelled' ? !item.statusMessage || item.statusMessage.startsWith('已跳过') ? '已跳过' : '提问已结束' : status === 'expired' ? '提问已结束' : status === 'failed' ? item.statusMessage || '提问未完成' : '');
    view.previous.hidden = questions.length < 2 || view.questionIndex === 0;
    view.progress.hidden = questions.length < 2;
    updateText(view.progress, `${view.questionIndex + 1} / ${questions.length}`);
    updateText(view.next, view.submitting ? '发送中…' : view.questionIndex < questions.length - 1 ? '继续' : item.questionPurpose === 'workspace' ? '确认并继续' : '提交');
    updateText(view.skip, item.questionPurpose === 'workspace' ? '暂不开始' : '跳过');
    for (const control of [view.previous, view.skip, view.next]) control.disabled = !!view.submitting;
    view.previous.onclick = () => { if (!view.submitting) { view.questionIndex--; saveQuestionDraft(item, view); view.feedback.textContent = ''; renderUserQuestion(item, message, view); focusCurrentQuestion(item, view); } };
    const send = async action => {
      if (!action || view.submitting || !appState.current || interactionStatus(item) !== 'pending') return;
      let answers;
      if (!action.value.cancel) {
        try { answers = collectQuestionAnswers(item, view, view.questionIndex < questions.length - 1); }
        catch (error) { view.feedback.textContent = error.message; renderUserQuestion(item, message, view); view.invalidControl?.focus(); return; }
        if (view.questionIndex < questions.length - 1) { view.questionIndex++; saveQuestionDraft(item, view); view.feedback.textContent = ''; renderUserQuestion(item, message, view); focusCurrentQuestion(item, view); return; }
      }
      view.submitting = true; view.feedback.textContent = ''; renderUserQuestion(item, message, view);
      try {
        await api('interactions', 'POST', { conversationId: appState.current, messageId: message.id, interactionId: item.id, actionId: action.id, ...(answers ? { answers } : {}) });
        await refresh();
      } catch (error) { view.feedback.textContent = error.message; }
      finally { view.submitting = false; renderMessages(); }
    };
    view.next.onclick = () => send(item.actions?.find(action => action.kind === 'submit' && action.value?.type === 'question-answer' && !action.value.cancel));
    view.skip.onclick = () => send(item.actions?.find(action => action.kind === 'submit' && action.value?.type === 'question-answer' && action.value.cancel));
    view.feedback.hidden = !view.feedback.textContent || !pending;
    return view;
  }
  const codexViews = new Set();
  function renderCodexExecution(item, message, view) {
    if (!item.codexTask || !message) { if (view.codex) view.codex.details.hidden = true; return; }
    if (!view.codex) {
      const details = el('details', 'codex-execution'), summary = el('summary', 'codex-open'),
        label = el('span', '', '查看执行过程'), badge = el('span', 'codex-project'),
        heading = el('div', 'codex-heading'), phase = el('span', 'codex-phase'), directory = el('code', 'codex-directory'),
        timeline = el('div', 'codex-timeline'), feedback = el('p', 'codex-feedback'), retry = el('button', 'codex-refresh', '重新加载');
      summary.append(label, badge); heading.append(phase, directory); details.append(summary, heading, timeline, feedback, retry);
      retry.type = 'button'; retry.hidden = true; timeline.setAttribute('aria-label', 'Codex 执行记录');
      view.node.insertBefore(details, view.footer);
      const execution = { details, badge, phase, directory, timeline, feedback, retry, cursor: 0, items: new Map(), entries: new Map() };
      view.codex = execution; codexViews.add(execution);
      details.ontoggle = () => { if (details.open) void loadCodexExecution(execution); else execution.abort?.abort(); };
      retry.onclick = () => void loadCodexExecution(execution);
    }
    const execution = view.codex;
    execution.taskId = item.codexTask.id; execution.conversationId = message.conversationId;
    execution.details.hidden = false; updateText(execution.badge, item.codexTask.project);
    updateText(execution.phase, item.statusMessage || '执行中'); updateText(execution.directory, item.codexTask.directory || '');
  }
  async function loadCodexExecution(view) {
    if (!view.details.open || !view.details.isConnected || view.conversationId !== appState.current) return;
    if (view.loading) { view.again = true; return; }
    view.loading = true; view.abort = new AbortController(); view.retry.hidden = true;
    try {
      let result;
      do {
        result = await api(`codex/task?${new URLSearchParams({ conversationId: view.conversationId, taskId: view.taskId, after: String(view.cursor) })}`, 'GET', undefined, view.abort.signal);
        if (!view.details.isConnected || view.conversationId !== appState.current) return;
        for (const item of result.items) {
          const key = `${item.attempt}:${item.itemId}`, previous = view.items.get(key);
          view.items.set(key, { ...item, at: previous?.at ?? item.at });
        }
        view.cursor = result.cursor;
      } while (result.hasMore && view.details.open);
      updateText(view.phase, result.task.phase); view.feedback.textContent = view.items.size ? '' : '等待执行记录';
      const ordered = [...view.items.entries()].sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq).slice(-192);
      const keys = new Set(ordered.map(([key]) => key));
      for (const key of view.items.keys()) if (!keys.has(key)) { view.items.delete(key); view.entries.delete(key); }
      const nodes = [];
      const follow = view.timeline.scrollHeight - view.timeline.scrollTop - view.timeline.clientHeight < 48;
      for (const [key, item] of ordered) {
        let entry = view.entries.get(key);
        if (!entry) {
          const node = el('details', `codex-item codex-${item.kind}`), summary = el('summary'), state = el('span', 'codex-item-state'), title = el('span', 'codex-item-title'),
            time = el('time'), content = el('div', 'codex-item-content'), text = el('pre', 'codex-text'), output = el('pre', 'codex-output');
          summary.append(state, title, time); content.append(text, output); node.append(summary, content);
          node.open = item.kind === 'message' || item.status === 'started'; entry = { node, state, title, time, text, output }; view.entries.set(key, entry);
        }
        entry.node.dataset.status = item.status;
        updateText(entry.state, item.status === 'started' ? '进行中' : item.status === 'failed' ? '失败' : '完成');
        updateText(entry.title, item.kind === 'command' ? item.text?.split('\n')[0] || item.title : item.title);
        updateText(entry.time, new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        entry.time.dateTime = new Date(item.at).toISOString();
        updateText(entry.text, [item.cwd, item.text].filter(Boolean).join('\n')); entry.text.hidden = !entry.text.textContent;
        updateText(entry.output, [item.output, typeof item.exitCode === 'number' ? `退出码 ${item.exitCode}` : ''].filter(Boolean).join('\n')); entry.output.hidden = !entry.output.textContent;
        nodes.push(entry.node);
      }
      syncChildren(view.timeline, nodes);
      if (follow) view.timeline.scrollTop = view.timeline.scrollHeight;
    } catch (error) { if (error.name !== 'AbortError') { view.feedback.textContent = error.message; view.retry.hidden = false; } }
    finally { view.loading = false; if (view.again) { view.again = false; void loadCodexExecution(view); } }
  }
  function refreshCodexExecutions() {
    for (const view of codexViews) {
      if (!view.details.isConnected) { view.abort?.abort(); codexViews.delete(view); }
      else if (view.details.open) void loadCodexExecution(view);
    }
  }
  function createInteractionView() {
    const node = el('section', 'interaction'), header = el('div', 'interaction-heading'),
      title = el('h3'), description = el('p', 'interaction-description'),
      status = el('p', 'interaction-status'), actions = el('div', 'interaction-actions'), feedback = el('p', 'interaction-feedback'),
      manual = el('input', 'interaction-link'), plan = el('div', 'task-plan'), schedule = el('p', 'task-plan-schedule'),
      scheduleNote = el('span', 'task-plan-timezone'), scheduleSlot = el('div', 'task-plan-slot schedule-slot'), deliverySlot = el('div', 'task-plan-slot delivery-slot'),
      delivery = el('p', 'task-plan-delivery'), taskDetails = el('details', 'task-plan-details'), taskSummary = el('summary', '', '看看我会做什么'), instruction = el('p', 'task-plan-instruction'),
      footer = el('div', 'interaction-footer'), documents = el('div', 'interaction-documents'), memoryReview = el('details', 'memory-change-details'),
      review = el('details', 'interaction-details'), memoryDiff = el('div', 'memory-diff'), memoryToggle = el('button', 'memory-change-toggle');
    scheduleSlot.append(schedule, scheduleNote);
    deliverySlot.append(delivery);
    taskDetails.append(taskSummary, instruction); plan.append(scheduleSlot, deliverySlot, taskDetails); plan.hidden = true;
    node.setAttribute('role', 'group');
    status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); feedback.setAttribute('role', 'status');
    manual.type = 'text'; manual.readOnly = true; manual.hidden = true; manual.setAttribute('aria-label', '授权链接，可选中后复制');
    manual.onclick = () => manual.select();
    footer.append(status, actions);
    memoryToggle.type = 'button'; memoryToggle.hidden = true;
    const syncMemoryToggle = () => memoryToggle.setAttribute('aria-expanded', String(memoryReview.open));
    memoryToggle.onclick = () => { memoryReview.open = !memoryReview.open; syncMemoryToggle(); };
    memoryReview.ontoggle = syncMemoryToggle;
    footer.append(memoryToggle);
    memoryReview.append(el('summary', '', '查看本次变更')); memoryReview.hidden = true;
    review.append(el('summary', '', '查看详情')); review.hidden = true;
    header.append(title); node.append(header, description, memoryDiff, documents, memoryReview, plan, review, footer, feedback, manual);
    return { node, header, title, description, status, actions, feedback, manual, plan, schedule, scheduleNote, delivery, instruction, taskDetails, footer, documents, memoryReview, memoryToggle, review, memoryDiff, memoryEntries: new Map(), documentEntries: new Map(), entries: new Map(), submitting: undefined };
  }
  function renderModelReasoning(entry, action, item, view, submit) {
    if (!entry.reasoningPanel) {
      entry.reasoningPanel = el('div', 'model-reasoning-panel');
      entry.reasoningPanel.setAttribute('role', 'group'); entry.reasoningPanel.setAttribute('aria-label', '思考强度');
      entry.reasoningSlider = el('input', 'model-reasoning-slider'); entry.reasoningSlider.type = 'range';
      entry.reasoningSlider.min = '0'; entry.reasoningSlider.step = '1'; entry.reasoningSlider.setAttribute('aria-label', '思考强度');
      entry.reasoningLabels = el('div', 'model-reasoning-labels'); entry.reasoningLabels.setAttribute('aria-hidden', 'true');
      entry.reasoningPanel.append(entry.reasoningSlider, entry.reasoningLabels);
      entry.node.append(entry.reasoningPanel);
    }
    const reasoning = action.reasoning, selected = Boolean(action.selected), levels = reasoning?.levels || [];
    entry.node.classList.add('model-option'); entry.node.classList.toggle('selected', selected);
    entry.reasoningPanel.hidden = !selected || Boolean(action.disabled);
    const label = levels.find(level => level.value === reasoning.selected)?.label || '默认';
    const slider = entry.reasoningSlider;
    slider.max = String(Math.max(1, levels.length - 1));
    slider.value = String(Math.max(0, levels.findIndex(level => level.value === (entry.reasoningDraft ?? reasoning.selected))));
    slider.disabled = Boolean(view.submitting) || Boolean(action.disabled) || !reasoning?.adjustable || levels.length < 2;
    const labels = levels.map(level => el('span', '', level.label));
    syncChildren(entry.reasoningLabels, labels);
    function preview() {
      const index = Number(slider.value), level = levels[index];
      slider.setAttribute('aria-valuetext', level?.label || label);
      slider.style.setProperty('--reasoning-progress', `${index / Number(slider.max) * 100}%`);
      labels.forEach((node, position) => node.classList.toggle('selected', position === index));
    }
    preview(); slider.oninput = preview;
    slider.onchange = async () => {
      const level = levels[Number(slider.value)];
      if (view.submitting || !action.selected || !submit || !reasoning?.adjustable || !level || level.value === reasoning.selected) return;
      view.submitting = `reasoning:${action.id}`; view.feedback.textContent = '';
      entry.reasoningDraft = level.value; renderInteraction(item, undefined, view, submit);
      try { await submit({ ...action, value: { ...action.value, reasoningEffort: level.value } }); }
      catch (error) { view.feedback.textContent = error.message; }
      finally { view.submitting = undefined; delete entry.reasoningDraft; renderInteraction(item, undefined, view, submit); slider.focus(); }
    };
  }
  function renderCodexForm(item, view) {
    if (!item.codexForm) { if (view.codexForm) view.codexForm.node.hidden = true; return; }
    const form = item.codexForm, editable = ['pending', 'failed'].includes(interactionStatus(item)) && item.actions?.length;
    if (!view.codexForm) {
      const node = el('div', 'codex-dispatch-form'), executor = el('select'), project = el('select'), session = el('select'), prompt = el('textarea'), review = el('input'), projectControl = el('div', 'codex-project-control'), path = el('div', 'codex-project-path');
      for (const [label, control] of [['执行器', executor], ['项目', project], ['会话', session], ['派发提示词', prompt], ['完成后核对并补做', review]]) {
        const field = el('label', `codex-dispatch-field${control === prompt ? ' codex-dispatch-prompt' : control === review ? ' codex-dispatch-review' : ''}`);
        if (control === project) { projectControl.append(path, project); field.append(el('span', '', label), projectControl); }
        else field.append(el('span', '', label), control);
        node.append(field);
        control.setAttribute('aria-label', label);
      }
      prompt.maxLength = 16000; prompt.rows = 8; review.type = 'checkbox';
      view.codexForm = { node, executor, project, session, prompt, review, path };
      view.node.insertBefore(node, view.memoryReview);
    }
    const controls = view.codexForm; controls.node.hidden = false;
    if (controls.version !== item.actions?.[0]?.id || !controls.draft) {
      controls.version = item.actions?.[0]?.id;
      controls.draft = { projectKey: form.projectKey, sessionId: form.sessionId, prompt: form.prompt, reviewAfterCompletion: !!form.reviewAfterCompletion };
    }
    const draft = controls.draft, selected = form.projects.find(item => item.key === draft.projectKey);
    const compactPath = value => String(value || '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
    const options = (control, items, value) => {
      const signature = JSON.stringify(items);
      if (control.dataset.options !== signature) { syncChildren(control, items.map(([key, label, disabled]) => { const option = el('option', '', label); option.value = key; option.disabled = !!disabled; return option; })); control.dataset.options = signature; }
      control.value = value;
    };
    const execution = selected?.project.executor || 'codex';
    options(controls.executor, [...new Set(form.projects.map(p => p.project.executor || 'codex'))].map(id => [id, ({ 'windows-codex': 'Windows Codex', 'linux-claude': 'Linux Claude · 无账号', codex: 'Codex' })[id] || id, !form.projects.some(p => (p.project.executor || 'codex') === id && p.project.available !== false)]), execution);
    controls.executor.onchange = () => { const target = form.projects.find(p => (p.project.executor || 'codex') === controls.executor.value); if (target) { draft.projectKey = target.key; draft.sessionId = ''; renderCodexForm(item, view); } };
    options(controls.project, form.projects.filter(p => (p.project.executor || 'codex') === execution).map(item => [item.key, compactPath(item.project.directory || item.project.roots?.[0] || item.project.name)]), draft.projectKey);
    options(controls.session, [['', '新建会话'], ...form.sessions.filter(item => item.deviceId === selected?.deviceId && item.projectId === selected?.project.id).map(item => [item.id, `${item.title} · ${item.threadId}`])], draft.sessionId);
    updateText(controls.path, compactPath(selected?.project.directory || selected?.project.roots?.[0] || selected?.project.name));
    if (controls.pathKey !== draft.projectKey) {
      controls.pathKey = draft.projectKey;
      requestAnimationFrame(() => { controls.path.scrollLeft = controls.path.scrollWidth; });
    }
    controls.review.checked = !!draft.reviewAfterCompletion;
    controls.review.onchange = () => { draft.reviewAfterCompletion = controls.review.checked; };
    if (controls.prompt.value !== draft.prompt) controls.prompt.value = draft.prompt;
    controls.project.onchange = () => { draft.projectKey = controls.project.value; draft.sessionId = ''; renderCodexForm(item, view); };
    controls.session.onchange = () => { draft.sessionId = controls.session.value; };
    controls.prompt.oninput = () => { draft.prompt = controls.prompt.value; };
    for (const control of [controls.executor, controls.project, controls.session, controls.prompt, controls.review]) control.disabled = !editable || !!view.submitting;
  }
  function renderInteraction(item, message, view, submit) {
    if (item.kind === 'user-question') return renderUserQuestion(item, message, view);
    if (view?.questionControls) view = undefined;
    view ||= createInteractionView();
    const status = interactionStatus(item), authorization = item.kind === 'authorization', taskProposal = item.kind === 'task-proposal', memoryProposal = item.kind === 'memory-proposal';
    const changes = (item.codexForm ? [] : memoryProposal ? (item.memoryChanges || []).filter(change => ['longTermMemory', 'archiveMemory', 'userProfile', 'behaviorRules'].includes(change.target))
      .map(change => ({ title: `${{ add: '新增', update: '修改', delete: '删除' }[change.operation]}${change.target === 'archiveMemory' ? `存档记忆：${change.title || ''}` : change.target === 'longTermMemory' ? '长期记忆' : change.target === 'userProfile' ? '个人档案' : '行为规则'}`, before: change.before, after: change.after }))
      : Array.isArray(item.changes) ? item.changes
      : taskProposal && item.taskPlan ? [{ title: item.title, after: `标题：${item.title}\n触发安排：${item.taskPlan.schedule}\n执行内容：${item.taskPlan.instruction}\n通知方式：${item.taskPlan.delivery}` }]
      : item.kind === 'operation-confirmation' && item.description ? [{ title: item.title, after: item.description, note: '历史提议没有保存可比较的原文，以下展示原操作说明。' }] : []).map(change => projectOperationChange(change, item));
    const changePreview = changes.length > 0;
    updateText(view.memoryReview.firstChild, changes.some(change => typeof change?.before === 'string') ? '查看本次变更' : '查看本次内容');
    const entries = Array.isArray(item.actions) ? item.actions : [];
    const pending = status === 'pending', retry = entries.some(action => action.kind === 'submit' && ['authorization-retry', 'task-proposal', 'memory-proposal', 'operation-confirmation', 'audio-transcription'].includes(action.value?.type));
    const hasLink = entries.some(action => action.kind === 'link' && interactionUrl(action.url, authorization));
    if (view.lastStatus !== undefined && view.lastStatus !== status) { view.feedback.textContent = ''; view.manual.hidden = true; view.manual.value = ''; }
    view.lastStatus = status;
    const visualPreview = changes.some(change => change?.presentation);
    const mindmapCard = changes.some(change => change?.presentation?.kind === 'mindmap');
    // Keep compact object summaries visible after completion; secondary content stays folded.
    const settled = item.kind !== 'user-question' && !item.memoryDocumentView && !submit && ['completed', 'cancelled'].includes(status);
    view.node.className = `interaction ${item.kind} ${status}${changePreview ? ' change-preview' : ''}${visualPreview ? ' visual-operation' : ''}${settled ? ' settled' : ''}${['todo', 'calendar', 'task'].includes(item.operationView) ? ` operation-view-${item.operationView}` : ''}`; view.node.dataset.interactionId = item.id;
    view.node.setAttribute('aria-busy', view.submitting ? 'true' : 'false');
    view.node.classList.toggle('operation-view-mindmap', mindmapCard);
    const targetEntries = Array.isArray(item.memoryChanges) && item.memoryChanges.length ? item.memoryChanges : Array.isArray(item.documents) ? item.documents : [];
    const memoryTargets = [...new Set(targetEntries.map(change => change.target || (change.id?.startsWith('archive-') ? 'archiveMemory' : change.id)))];
    const memoryTarget = ['longTermMemory', 'archiveMemory', 'userProfile', 'behaviorRules'].filter(target => memoryTargets.includes(target))
      .map(target => target === 'archiveMemory' ? '存档记忆' : target === 'longTermMemory' ? '长期记忆' : target === 'userProfile' ? '个人档案' : '行为规则').join('、') || '长期记忆';
    const todoCard = (item.kind === 'operation-confirmation' || item.kind === 'schedule-reminder') && ['todo', 'calendar'].includes(item.operationView);
    updateText(view.title, todoCard ? (item.operationView === 'calendar' ? '日历' : 'Todo') : memoryProposal && !item.memoryDocumentView ? `更新${memoryTarget}` : typeof item.title === 'string' ? item.title : authorization ? '连接账号' : '继续处理');
    view.node.setAttribute('aria-label', view.title.textContent);
    const documentCard = changes.some(change => ['document', 'markdown'].includes(change.presentation?.kind));
    view.node.classList.toggle('operation-view-document', documentCard);
    const confirmationCard = !submit && (documentCard || todoCard || ['operation-confirmation', 'task-proposal', 'memory-proposal', 'audio-transcription', 'authorization', 'actions', 'browser'].includes(item.kind)
      || entries.some(action => action?.kind === 'submit' && typeof action.value?.confirm === 'boolean'));
    view.node.classList.toggle('confirmation-card', confirmationCard);
    view.header.hidden = settled && !confirmationCard;
    const actionParent = confirmationCard ? view.header : view.footer;
    if (view.actions.parentNode !== actionParent) actionParent.append(view.actions);
    const statusParent = confirmationCard && status === 'completed' ? view.header : view.footer;
    if (view.status.parentNode !== statusParent) statusParent.insertBefore(view.status, statusParent === view.footer ? view.footer.firstChild : null);
    renderCodexExecution(item, message, view);
    renderCodexForm(item, view);
    renderChanges(changes, view, item, message);
    updateText(view.description, typeof item.description === 'string' ? item.description : '');
    view.description.hidden = !view.description.textContent;
    const documentNodes = [];
    for (const document of Array.isArray(item.documents) ? item.documents : []) {
      if (!document || typeof document.id !== 'string') continue;
      let button = view.documentEntries.get(document.id);
      if (!button) {
        button = el('button', 'document-file-card'); button.type = 'button';
        const copy = el('span', 'document-file-copy'); copy.append(el('strong')); button.append(copy);
        view.documentEntries.set(document.id, button);
      }
      const documentCount = item.documents.length;
      const fullFile = documentCount === 1 && !settled && !item.memoryDocumentView;
      updateText(button.firstChild.children[0], fullFile ? '查看全文' : document.title);
      button.setAttribute('aria-label', fullFile ? `查看全文：${document.title}` : `查看${document.title}`);
      button.onclick = () => openConversationDocument(item, message, document.id, button);
      documentNodes.push(button);
    }
    syncChildren(view.documents, documentNodes); view.documents.hidden = !documentNodes.length;
    const compactMemory = settled && memoryProposal && status === 'completed' && documentNodes.length > 0 && !/其他内容未应用/.test(item.statusMessage || '');
    view.node.classList.toggle('compact-memory', compactMemory);
    if (compactMemory) syncChildren(view.documents, documentNodes.flatMap((node, index) => index ? [el('span', '', '、'), node] : [node]));
    const fileReview = !visualPreview && !item.memoryDocumentView && settled && (changePreview || memoryProposal && !!view.description.textContent);
    view.memoryReview.hidden = !fileReview;
    const detailParent = fileReview ? view.memoryReview : settled || changePreview && !memoryProposal ? view.review : view.node;
    if (view.description.parentNode !== detailParent) detailParent === view.node ? view.node.insertBefore(view.description, view.memoryReview) : detailParent.append(view.description);
    const diffParent = fileReview ? view.memoryReview : view.node;
    if (view.memoryDiff.parentNode !== diffParent) diffParent === view.node ? view.node.insertBefore(view.memoryDiff, view.memoryReview) : diffParent.append(view.memoryDiff);
    const documentParent = compactMemory ? view.footer : (memoryProposal || changePreview) && !item.memoryDocumentView && !settled ? view.header : view.node;
    if (view.documents.parentNode !== documentParent) documentParent === view.node ? view.node.insertBefore(view.documents, view.memoryReview) : documentParent.insertBefore(view.documents, compactMemory ? view.status : null);
    view.description.hidden = authorization || visualPreview || !!item.codexForm || !view.description.textContent;
    const planParent = settled ? view.review : view.node;
    if (view.plan.parentNode !== planParent) planParent === view.node ? view.node.insertBefore(view.plan, view.review) : planParent.append(view.plan);
    view.plan.hidden = changePreview || item.kind !== 'task-proposal' || !item.taskPlan;
    if (!view.plan.hidden) {
      const scheduleText = String(item.taskPlan.schedule || ''), parts = scheduleText.match(/^(.*?)[（(]([^（）()]+)[）)]$/);
      updateText(view.schedule, parts ? parts[1].trim() : scheduleText);
      updateText(view.scheduleNote, parts ? parts[2] : ''); view.scheduleNote.hidden = !parts;
      updateText(view.delivery, item.taskPlan.delivery); updateText(view.instruction, item.taskPlan.instruction);
    }
    const fallback = { pending: authorization ? hasLink ? '' : '正在准备授权链接…' : '',
      completed: authorization ? '账号已连接，可以继续使用。' : '操作已完成。', failed: '操作未完成，请重试。',
      expired: authorization ? '授权已过期，刚才的操作未执行。' : '这项操作已过期，请重新发起。', cancelled: '操作已取消。' };
    let statusText = status === 'expired' && item.status === 'pending' ? fallback.expired : item.statusMessage || fallback[status];
    if (authorization && status === 'expired') statusText = fallback.expired;
    if (pending && (memoryProposal || taskProposal) && !(taskProposal && /正在设置/.test(statusText))) statusText = '';
    if (pending && (changePreview || item.codexForm) && statusText === '确认后才会执行。') statusText = '';
    if (item.memoryDocumentView || item.kind === 'schedule-reminder') statusText = '';
    if (submit) statusText = item.statusMessage || '';
    if (settled && memoryProposal) statusText = status === 'completed'
      ? /其他内容未应用/.test(item.statusMessage || '') ? item.statusMessage : `${memoryTarget}已保存` : '已取消，记忆未更改。';
    if (compactMemory) statusText = '已保存';
    if (settled && taskProposal) statusText = `${item.title} · ${status === 'completed' ? '已启用' : '已取消'}`;
    if (confirmationCard && item.kind !== 'schedule-reminder' && status === 'completed') statusText = '✓';
    if (authorization && status === 'expired' && !retry) statusText += ' 请告诉我继续授权。';
    if (authorization && statusText === '授权后请重新提出请求，刚才的操作不会自动执行。') statusText = '';
    updateText(view.status, statusText);
    view.status.hidden = !statusText;
    if (confirmationCard && status === 'completed') view.status.setAttribute('aria-label', item.statusMessage || '已完成');
    else view.status.removeAttribute('aria-label');
    if (view.feedback.textContent === statusText) updateText(view.feedback, '');
    view.review.hidden = memoryProposal || fileReview || !(settled && (!view.description.hidden || !view.plan.hidden) || changePreview && !view.description.hidden);
    updateText(view.review.firstChild, visualPreview ? '操作详情' : changePreview ? '说明' : '查看详情');
    if (view.detailStatus !== status) {
      if (settled) { view.memoryReview.open = false; view.review.open = false; if (taskProposal) view.taskDetails.open = true; }
      view.detailStatus = status;
    }
    view.memoryToggle.hidden = !compactMemory || !fileReview;
    view.memoryReview.id = `memory-changes-${item.id}`;
    view.memoryToggle.setAttribute('aria-controls', view.memoryReview.id);
    view.memoryToggle.setAttribute('aria-label', compactMemory ? '查看本次变更' : view.memoryReview.firstChild.textContent);
    view.memoryToggle.setAttribute('aria-expanded', String(view.memoryReview.open));
    const nodes = [], keys = new Set(); let hasPrimary = false;
    for (const action of entries) {
      if (action?.kind === 'submit' && (action.value?.confirm === false || /^取消$/.test(String(action.label || '').trim()))) continue;
      if (!action || typeof action.id !== 'string' || !['link', 'submit'].includes(action.kind)) continue;
      const url = action.kind === 'link' ? interactionUrl(action.url, authorization) : undefined;
      if (action.kind === 'link' && !url) continue;
      const key = `${action.kind}:${action.id}`; if (keys.has(key)) continue; keys.add(key);
      let entry = view.entries.get(key);
      if (!entry) {
        entry = { node: el('div', 'interaction-action'), control: el(action.kind === 'link' ? 'a' : 'button', 'interaction-control') };
        if (action.kind === 'submit') entry.control.type = 'button';
        entry.node.append(entry.control);
        view.entries.set(key, entry);
      }
      const control = entry.control, available = action.kind === 'submit' && action.value?.type === 'authorization-retry' ? ['failed', 'expired'].includes(status)
        : action.kind === 'submit' && action.value?.type === 'audio-transcription' ? ['failed', 'cancelled'].includes(status)
        : action.kind === 'submit' && ['task-proposal', 'memory-proposal', 'operation-confirmation'].includes(action.value?.type) ? ['pending', 'failed'].includes(status) : pending;
      entry.node.hidden = !available;
      control.className = `interaction-control${!submit && available && !hasPrimary ? ' primary-action' : ''}`;
      if (typeof action.selected === 'boolean') control.setAttribute('aria-pressed', String(action.selected));
      if (available) hasPrimary = true;
      const label = typeof action.label === 'string' ? action.label : action.kind === 'link' ? '打开链接' : '继续';
      if (action.pricing && action.kind === 'submit') {
        if (!entry.priceBody) {
          entry.priceBody = el('span', 'model-option-copy'); entry.label = el('span', 'model-option-label');
          entry.price = el('span', 'model-option-price');
          entry.inputPrice = el('span'); entry.outputPrice = el('span'); entry.price.append(entry.inputPrice, entry.outputPrice);
          entry.priceBody.append(entry.label, entry.price);
        }
        updateText(entry.label, view.submitting === key ? '正在保存…' : label);
        const pricing = action.pricing;
        updateText(entry.inputPrice, `输入：${pricing.input} `);
        updateText(entry.outputPrice, `输出：${pricing.output}`);
        syncChildren(control, [entry.priceBody]);
        control.setAttribute('aria-label', `${label}，${entry.price.textContent}`);
      } else updateText(control, view.submitting === key ? '处理中…' : label);
      if (action.kind === 'link') {
        if (available) { control.href = url; control.target = '_blank'; control.rel = 'noopener noreferrer'; }
        else { control.removeAttribute('href'); control.removeAttribute('target'); }
        control.setAttribute('aria-label', `${label}（在新页面打开）`);
        control.onclick = event => { if (interactionStatus(item) !== 'pending') { event.preventDefault(); renderMessages(); } };
        if (entry.copy) {
          entry.copy.onclick = async () => {
            if (interactionStatus(item) !== 'pending') { renderMessages(); return; }
            entry.copy.disabled = true;
            try {
              if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
              await navigator.clipboard.writeText(url);
              if (view.lastStatus !== 'pending' || control.href !== url) return;
              view.feedback.textContent = '链接已复制。'; view.feedback.hidden = false; view.manual.hidden = true;
            } catch {
              if (view.lastStatus !== 'pending' || control.href !== url) return;
              view.feedback.textContent = '请选中下方链接复制，也可以直接点击前往授权。'; view.feedback.hidden = false; view.manual.value = url; view.manual.hidden = false; view.manual.focus(); view.manual.select();
            } finally { entry.copy.disabled = false; }
          };
        }
      } else {
        control.disabled = !!view.submitting || Boolean(action.disabled);
        control.onclick = async () => {
          if (view.submitting || !available || action.disabled || (!submit && !appState.current)) return;
          if (interactionStatus(item) !== status) { renderMessages(); return; }
          if (item.codexForm && action.value?.confirm && !view.codexForm.draft.prompt.trim()) { view.feedback.textContent = '请填写提示词'; view.codexForm.prompt.focus(); return; }
          const redraw = () => submit ? renderInteraction(item, message, view, submit) : renderMessages();
          view.submitting = key; view.feedback.textContent = ''; redraw();
          try {
            if (action.value?.type === 'model-picker') {
              openPanel('model-dialog', control); await loadModelLibrary(action.value.requestId);
            } else if (submit) await submit(action);
            else if (item.legacy) await api('action', 'POST', { conversationId: appState.current, requestId: action.value.requestId, confirm: action.value.confirm });
            else await api('interactions', 'POST', { conversationId: appState.current, messageId: message.id, interactionId: item.id, actionId: action.id, ...(item.codexForm && action.value?.confirm ? { codexEdits: { ...view.codexForm.draft } } : {}) });
            if (action.value?.type === 'browser-control' && action.value.action === 'view') await openBrowserWorkspace({ conversationId: message.conversationId, id: action.value.browserId, opener: control });
            if (!submit) await refresh();
          } catch (error) { view.feedback.textContent = error.message; }
          finally { view.submitting = undefined; redraw(); }
        };
      }
      if (action.kind === 'submit' && action.value?.type === 'model-select') renderModelReasoning(entry, action, item, view, submit);
      nodes.push(entry.node);
    }
    for (const key of view.entries.keys()) if (!keys.has(key)) view.entries.delete(key);
    syncChildren(view.actions, nodes);
    view.actions.hidden = !nodes.some(node => !node.hidden);
    view.footer.hidden = (view.status.parentNode !== view.footer || view.status.hidden) && (view.actions.parentNode !== view.footer || view.actions.hidden) && view.memoryToggle.hidden;
    if (!pending) { view.manual.hidden = true; view.manual.value = ''; }
    view.feedback.hidden = !view.feedback.textContent;
    return view;
  }
  function scheduleInteractionExpiry() {
    if (interactionExpiryTimer !== undefined) { clearTimeout(interactionExpiryTimer); interactionExpiryTimer = undefined; }
    const expiry = appState.messages.flatMap(messageInteractions).filter(item => item.status === 'pending' && Number.isFinite(item.expiresAt) && item.expiresAt > Date.now()).reduce((next, item) => Math.min(next, item.expiresAt), Infinity);
    if (expiry < Infinity) interactionExpiryTimer = setTimeout(() => { interactionExpiryTimer = undefined; renderMessages(); }, Math.min(expiry - Date.now() + 20, 2147483647));
  }
  return { renderInteraction, refreshCodexExecutions, scheduleInteractionExpiry, dispose: () => { clearTimeout(interactionExpiryTimer); changePreviewObserver.disconnect(); for (const view of codexViews) view.abort?.abort(); codexViews.clear(); }, clearExpiry: () => { clearTimeout(interactionExpiryTimer); interactionExpiryTimer = undefined; } };
}
