(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const number = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
  const seconds = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value || 0);
  const compact = value => value >= 1e6 ? `${+(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${+(value / 1e3).toFixed(1)}K` : number(value);
  const money = value => `$${new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: value && value < .000001 ? 9 : value && value < .01 ? 6 : 4 }).format(value)}`;
  const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
  let request, close, fetchVersion = 0, controller, timer, report, period = '30d', selected = '', metric = 'tokens', selectedDay;
  const tokens = item => item.inputTokens + item.outputTokens;
  const images = item => item.outputImages || 0;
  const videos = item => item.outputVideos || 0;
  const hasMedia = item => images(item) || videos(item) || item.imageRequests || item.videoRequests || item.outputSeconds;
  const metricValue = item => metric === 'tokens' ? tokens(item) : item.costs.USD;
  const metricLabel = item => metric === 'tokens' ? `${number(tokens(item))} token` : money(item.costs.USD);
  function outputLabel(item) {
    const values = [];
    if (images(item)) values.push(`${number(images(item))} 张`);
    if (videos(item)) values.push(`${number(videos(item))} 条`);
    if (item.outputSeconds) values.push(`${seconds(item.outputSeconds)} 秒`);
    if (tokens(item)) values.push(`${compact(tokens(item))} token`);
    return values.join(' · ') || (hasMedia(item) ? `${number(item.imageRequests || item.videoRequests)} 次调用` : '0 token');
  }
  function badge(text) { return node('span', 'usage-badge', text); }
  function headingCost(totals) {
    const wrap = node('div', 'usage-money');
    wrap.append(node('span', 'usage-currency', 'USD'), node('strong', '', money(totals.costs.USD)));
    return [wrap];
  }

  function render() {
    if (!report) return;
    const totals = report.totals;
    $('usage-cost-label').textContent = totals.unpriced || totals.unpricedUsage || totals.sourceMissing || totals.awaitingBill && !totals.costs.USD ? '已计费用' : totals.estimatedCosts.USD ? '预估费用' : '费用合计';
    $('usage-cost').replaceChildren(...headingCost(totals));
    $('usage-tokens').textContent = compact(tokens(totals)); $('usage-tokens').title = number(tokens(totals));
    $('usage-requests').textContent = number(totals.requests);
    $('usage-cache').textContent = totals.inputTokens ? `${+(totals.cachedInputTokens / totals.inputTokens * 100).toFixed(1)}%` : '—';
    $('usage-generations').hidden = !hasMedia(totals) && !report.models.some(model => model.kinds?.some(kind => kind === 'image' || kind === 'video'));
    $('usage-images').textContent = number(images(totals)); $('usage-videos').textContent = number(videos(totals));
    $('usage-seconds').textContent = seconds(totals.outputSeconds);
    const select = $('usage-model');
    select.replaceChildren(new Option('全部模型', ''), ...report.availableModels.map(model => new Option(model.model, model.key)));
    select.value = selected;
    for (const button of $('usage-periods').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.period === period));
    for (const button of $('usage-chart-metrics').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.metric === metric));
    renderChart(); renderModels();
  }
  function dayLabel(date) { return date.length === 7 ? `${+date.slice(5)}月` : `${+date.slice(5,7)}/${+date.slice(8)}`; }
  function renderChart() {
    const days = report.days;
    selectedDay = days.some(day => day.date === selectedDay) ? selectedDay : days.at(-1)?.date;
    const active = days.find(day => day.date === selectedDay);
    $('usage-chart-day').textContent = active?.date || '';
    $('usage-chart-value').textContent = active ? metricLabel(active) : '—';
    const ns = 'http://www.w3.org/2000/svg';
    const svgNode = (tag, attrs) => { const el = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); return el; };
    const svg = svgNode('svg', { viewBox: '0 0 800 176', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const max = Math.max(1, ...days.map(metricValue));
    for (const y of [12, 64, 116, 168]) svg.append(svgNode('line', { x1: 0, x2: 800, y1: y, y2: y, class: 'usage-chart-grid' }));
    const step = 800 / Math.max(1, days.length), width = Math.max(1, Math.min(42, step * .62));
    days.forEach((day, i) => {
      const value = metricValue(day), height = value / max * 150, x = step * (i+.5) - width/2;
      const top = metric === 'tokens' && value ? height * day.outputTokens / value : 0;
      svg.append(svgNode('rect', { x, y: 168-height, width, height: Math.max(0, height-top), rx: 2, class: 'usage-chart-input' }));
      if (top) svg.append(svgNode('rect', { x, y: 168-top, width, height: top, rx: 2, class: 'usage-chart-output' }));
    });
    const hitAreas = node('div', 'usage-chart-targets');
    days.forEach(day => {
      const button = node('button', '', ''); button.type = 'button';
      button.setAttribute('aria-label', `${day.date}，${metricLabel(day)}`);
      button.setAttribute('aria-pressed', String(day.date === selectedDay));
      button.onclick = () => { selectedDay = day.date; renderChart(); };
      hitAreas.append(button);
    });
    $('usage-chart').replaceChildren(svg, hitAreas);
    const labels = days.length > 1 ? [days[0], days[Math.floor((days.length-1)/2)], days.at(-1)] : days;
    $('usage-chart-axis').replaceChildren(...labels.map(day => node('span', '', dayLabel(day.date))));
    $('usage-chart-legend').hidden = metric !== 'tokens';
  }
  function renderModels() {
    const list = $('usage-models');
    list.replaceChildren();
    const rows = report.models.filter(model => tokens(model) || model.requests || model.historical || hasMedia(model) || model.costs.USD)
      .sort((a,b) => metricValue(b)-metricValue(a) || a.model.localeCompare(b.model));
    $('usage-empty').hidden = rows.length > 0;
    const total = Math.max(1, metricValue(report.totals));
    rows.forEach(model => {
      const details = node('details', 'usage-model-row');
      const summary = node('summary');
      const identity = node('div', 'usage-model-identity');
      identity.append(node('strong', '', model.model));
      const supplierNames = { zenmux: 'ZenMux', 'openai-codex': 'ChatGPT', official: '官方' };
      identity.append(node('span', 'usage-supplier', supplierNames[model.supplier] || model.supplier));
      const stats = node('div', 'usage-model-stats');
      stats.append(node('span', 'usage-model-output', outputLabel(model)));
      const cost = node('strong', 'usage-model-cost');
      const hasCost = model.costs.USD > 0;
      cost.textContent = hasCost ? money(model.costs.USD) : model.unpriced ? '待计价' : model.awaitingBill ? '对账中' : money(0);
      stats.append(cost);
      if (model.unpriced && hasCost) stats.append(badge('待计价'));
      else if (model.awaitingBill) stats.append(badge('对账中'));
      else if (model.estimatedCosts.USD) stats.append(badge('预估'));
      summary.append(identity, stats);
      if (metricValue(model)) {
        const bar = node('div', 'usage-model-bar'); const fill = node('i'); fill.style.width = `${metricValue(model)/total*100}%`; bar.append(fill);
        summary.append(bar);
      }
      const breakdown = node('dl', 'usage-breakdown');
      for (const [label, value] of [...(tokens(model) || !hasMedia(model) ? [['输入',number(model.inputTokens)], ['输出',number(model.outputTokens)], ['缓存命中',number(model.cachedInputTokens)],
        ['缓存写入',number(model.cacheWriteTokens)]] : []), ...(model.imageRequests || images(model) ? [['图像',`${number(images(model))} 张`]] : []),
        ...(model.videoRequests || videos(model) ? [['视频',`${number(videos(model))} 条`], ['视频时长',`${seconds(model.outputSeconds)} 秒`]] : []), ['调用',number(model.requests)],
        ...(model.failed ? [['失败',number(model.failed)]] : []), ...(model.historical ? [['历史记录',number(model.historical)]] : [])]) {
        const item = node('div'); item.append(node('dt','',label), node('dd','',value)); breakdown.append(item);
      }
      details.append(summary, breakdown); list.append(details);
    });
  }
  async function load() {
    const version = ++fetchVersion;
    controller?.abort(); controller = new AbortController();
    $('usage-status').textContent = report ? '' : '正在加载'; $('usage-retry').hidden = true;
    $('usage-content').setAttribute('aria-busy', 'true');
    $('usage-refresh').disabled = true;
    try {
      const result = await request(`usage?period=${period}${selected ? `&model=${encodeURIComponent(selected)}` : ''}`, 'GET', undefined, controller.signal);
      if (version !== fetchVersion || !$('usage-dialog').open) return;
      report = result; render(); $('usage-content').hidden = false; $('usage-status').textContent = '';
    } catch (error) {
      if (version !== fetchVersion || error.name === 'AbortError') return;
      $('usage-status').textContent = error.name === 'TypeError' ? '暂时无法加载' : error.message || '暂时无法加载'; $('usage-retry').hidden = false;
    } finally {
      if (version === fetchVersion) { $('usage-content').setAttribute('aria-busy', 'false'); $('usage-refresh').disabled = false; }
    }
  }
  window.ZigentUsage = {
    initialize(options) {
      request = options.api; close = options.close;
      $('close-usage').onclick = () => close('usage-dialog');
      $('usage-refresh').onclick = load; $('usage-retry').onclick = load;
      $('usage-periods').onclick = event => {
        const button = event.target.closest('button[data-period]'); if (!button) return;
        period = button.dataset.period; selectedDay = undefined; void load();
      };
      $('usage-model').onchange = () => { selected = $('usage-model').value; selectedDay = undefined; void load(); };
      $('usage-chart-metrics').onclick = event => { const button = event.target.closest('button[data-metric]'); if (button) { metric = button.dataset.metric; render(); } };
      $('usage-dialog').addEventListener('close', () => { fetchVersion++; controller?.abort(); clearInterval(timer); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden && $('usage-dialog').open) void load(); });
    },
    open() { report = undefined; $('usage-content').hidden = true; void load(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000); }
  };
})();
