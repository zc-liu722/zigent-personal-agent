(() => {
  const target = window.ZigentComponentPreviewContext.parentOrigin;
  const report = error => parent.postMessage({ type: 'zigent:component:error', error: error?.message || '组件加载失败' }, target);
  addEventListener('error', event => report(event.error || { message: event.message || '组件资源加载失败' }));
  addEventListener('unhandledrejection', event => report(event.reason));
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== target || event.data?.type !== 'zigent:studio:inspect' || typeof event.data.requestId !== 'string') return;
    const root = document.getElementById('preview-root') || document.body;
    const controls = [...root.querySelectorAll('button,input,select,textarea,details,[role],a')].filter(node => node.getClientRects().length).slice(0, 35).map(node => {
      const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), label: (node.getAttribute('aria-label') || (node.matches('input,textarea') ? node.getAttribute('placeholder') : node.textContent) || '').slice(0, 180), disabled: Boolean(node.disabled), expanded: node.getAttribute('aria-expanded'), open: node.open, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, style: { color: css.color, background: css.backgroundColor, fontSize: css.fontSize, padding: css.padding, borderRadius: css.borderRadius } };
    });
    parent.postMessage({ type: 'zigent:studio:inspected', requestId: event.data.requestId, snapshot: { ready: true, width: innerWidth, height: innerHeight, text: root.innerText.slice(0, 7000), controls, embeddedFrames: root.querySelectorAll('iframe').length } }, target);
  });
  let sequence = 0;
  addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== target || event.data?.type !== 'zigent:studio:render') return;
    const own = ++sequence;
    try {
      const { componentScenarios } = await import(new URL('./components/fixtures.js', location.href).href);
      const scenario = componentScenarios.find(item => item.id === event.data.scenarioId);
      if (!scenario) throw new Error('此版本不存在该场景');
      const data = structuredClone(event.data.data || scenario.data);
      if (event.data.status !== 'original') {
        data.status = event.data.status; if (data.kind === 'subagent-preview') data.previewState = event.data.status; delete data.statusMessage; delete data.expiresAt;
        if (data.status === 'expired') data.expiresAt = Date.now() - 1000;
        if (data.kind === 'user-question' && data.status === 'completed') data.answers ||= Object.fromEntries(data.questions.map(question => [question.id, question.type === 'text' ? { text: '集中维护交互组件' } : { selectedOptionIds: [question.options?.[0]?.id].filter(Boolean) }]));
      }
      if (own !== sequence) return;
      if (data.kind === 'output' && !event.data.pages) {
        parent.postMessage({ type: 'zigent:studio:output', output: data.output, sequence: own }, target);
        window.ZigentStudioPendingOutput = { own, scenario, data, options: event.data }; return;
      }
      dispatchEvent(new MessageEvent('message', { source: parent, origin: target, data: { ...event.data, type: 'zigent:component:render', scenario, data } }));
    } catch (cause) { report(cause); }
  });
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== target || event.data?.type !== 'zigent:studio:output-pages') return;
    const pending = window.ZigentStudioPendingOutput;
    if (!pending || pending.own !== sequence || event.data.sequence !== pending.own) return;
    dispatchEvent(new MessageEvent('message', { source: parent, origin: target, data: { ...pending.options, type: 'zigent:component:render', scenario: pending.scenario, data: pending.data, pages: event.data.pages } }));
  });
})();
