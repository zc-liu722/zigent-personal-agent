const $ = id => document.getElementById(id);
const node = (tag, cls = '', text) => { const element = document.createElement(tag); element.className = cls; if (text !== undefined) element.textContent = text; return element; };
const ns = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attrs = {}) => { const element = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value); return element; };
const number = value => value == null ? '—' : Number(value).toLocaleString('zh-CN');
const short = value => value == null ? '—' : value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : number(value);
const latencyNumber = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const ms = value => value == null ? '—' : value < 1000 ? `${latencyNumber.format(value)} ms` : `${latencyNumber.format(value / 1000)} s`;
const percent = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const compliance = row => row?.compliance == null ? '—' : row.complianceMax != null && row.complianceMax > row.compliance
  ? `${percent(row.compliance)}–${percent(row.complianceMax)}` : percent(row.compliance);
const money = value => value == null ? '—' : value === 0 ? '0.00' : value < .01 ? value.toFixed(5) : value.toFixed(2);
const bytes = value => value == null ? '—' : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(0)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`;
const time = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const duration = value => value == null ? '—' : value >= 86400 ? `${Math.floor(value/86400)} 天 ${Math.floor(value/3600)%24} 时` : `${Math.floor(value/3600)} 时 ${Math.floor(value/60)%60} 分`;
const views = { overview: ['服务概览', '01'], performance: ['性能监控', '02'], usage: ['模型用量', '03'], components: ['交互组件', '04'] };
const state = { view: 'overview', agent: '', model: '', hours: 24, period: '30d', group: '', chartMetric: 'tokens', auto: true, performanceMode: 'latency', trends: { '浏览器': 'web.lcp', '对话': 'web.reply_first', '模型': 'model.first_output', '工具': 'tool.call', '网络': 'network.headers', '服务端': 'server.event_loop' } };
const initialRange = new URLSearchParams(location.search);
if ([1,24,168,720].includes(Number(initialRange.get('hours')))) state.hours=Number(initialRange.get('hours'));
if (['today','7d','30d','all'].includes(initialRange.get('period'))) state.period=initialRange.get('period');
let report, controller, version = 0, authenticated = false, componentLab, componentLabLoad;
async function ensureComponentLab() {
  if (!authenticated || state.view !== 'components' || componentLab || componentLabLoad) return;
  const pending = componentLabLoad = import('./component-lab.js');
  try {
    const module = await pending;
    if (componentLabLoad !== pending || !authenticated) return;
    componentLab = module.createComponentLab($('component-lab'), { api, release: report?.release });
  } catch (error) { feedback(error.message || '组件加载失败，请重试', true); }
  finally { if (componentLabLoad === pending) componentLabLoad = undefined; }
}
async function api(path, method = 'GET', input, signal) {
  const response = await fetch(new URL(`api/${path}`, location.href), { method, credentials: 'same-origin', cache: 'no-store', signal,
    ...(input ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {}) });
  let body; try { body = await response.json(); } catch { throw new Error('服务暂不可用，请重试。'); }
  if (!response.ok) { const error = new Error(body.error || '请求未完成，请重试。'); error.status = response.status; throw error; }
  return body;
}
function showLogin() {
  componentLab?.dispose(); componentLab = undefined; componentLabLoad = undefined;
  authenticated = false; version++; controller?.abort(); report = undefined;
  $('app').hidden = true; $('login').hidden = false; $('export').disabled = true;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  for (const id of ['host-cards','host-chart','activity-stats','agents','category-cards','performance-cards','performance-trends','metrics','usage-cards','usage-completeness','usage-chart','models','media-usage']) $(id).replaceChildren();
  $('password-form').reset(); $('password-status').textContent = '';
}
function feedback(message = '', retry = false) { $('feedback').hidden = !message; $('status').textContent = message; $('retry').hidden = !retry; }
function selectView(view) {
  if (!views[view]) view = 'overview'; state.view = view;
  for (const key of Object.keys(views)) $(`view-${key}`).hidden = key !== view;
  for (const button of document.querySelectorAll('nav [data-view]')) { if (button.dataset.view === view) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }
  $('page-title').replaceChildren(document.createTextNode(views[view][0]), node('span','title-dot','.')); $('page-index').textContent = views[view][1];
  $('monitor-filters').hidden = view === 'components';
  $('export').hidden = view === 'components';
  $('performance-sampling').closest('footer').hidden = view === 'components';
  void ensureComponentLab();
  $('model-filter').hidden = view !== 'usage';
  $('resource-range').hidden = view === 'usage';
  const url = new URL(location.href); url.hash = view; history.replaceState(null, '', url);
}
function stat(label, value, detail = '', unit = '', ratio, status = '') {
  const card = node('div', `stat ${status}`), main = node('div','stat-value',value);
  if (unit) main.append(node('small','',unit)); card.append(node('span','stat-label',label), main, node('span','stat-detail',detail));
  return card;
}
function empty(parent, text = '暂无数据') { parent.replaceChildren(node('div','empty',text)); }
function rowIdentity(title, detail) { const td = node('td'); td.append(node('strong','',title), node('small','',detail)); return td; }
function emptyTable(parent, count, text) { const tr = node('tr'), td = node('td','empty',text); td.colSpan = count; tr.append(td); parent.replaceChildren(tr); }
function metrics() { return report.performance.metrics; }
function populate(select, values, first, selected) {
  const current = [...select.options].map(option => `${option.value}\0${option.textContent}`).join('\n');
  const desired = [['',first], ...values];
  if (current !== desired.map(([value,label]) => `${value}\0${label}`).join('\n')) select.replaceChildren(...desired.map(([value,label]) => { const option = node('option','',label); option.value = value; return option; }));
  select.value = selected;
}
function render() {
  const selectedName = report.selectedAgent ? report.availableAgents.find(agent => agent.id === report.selectedAgent)?.name : '全部 Agent';
  populate($('agent'), report.availableAgents.map(agent => [agent.id, agent.name]), '全部 Agent', state.agent);
  populate($('model'), report.models.map(model => [model,model]), '全部模型', state.model);
  $('updated').textContent = time(report.generatedAt); $('release').textContent = report.release ? `BUILD ${report.release.slice(0,8)}` : 'SERVER CONSOLE';
  $('live-state').classList.add('ready'); $('live-state').lastElementChild.textContent = '已连接';
  $('export').disabled = false;
  for (const button of $('hours').querySelectorAll('button')) button.setAttribute('aria-pressed',String(Number(button.dataset.hours) === state.hours));
  for (const button of $('periods').querySelectorAll('button')) button.setAttribute('aria-pressed',String(button.dataset.period === state.period));
  $('window-label').textContent = `${state.hours === 1 ? '近 1 小时' : state.hours === 24 ? '近 24 小时' : `近 ${state.hours/24} 天`} · ${selectedName}`;
  const missing = report.agents.filter(agent => agent.enabled && (agent.metricsState !== 'ready' || agent.usageState !== 'ready'));
  feedback(missing.length ? `数据暂不可用：${missing.map(agent => agent.name).join('、')}` : report.hostHistoryState === 'unavailable' ? '资源历史暂不可用，请重试' : '', report.hostHistoryState === 'unavailable');
  renderHost(); renderAgents(); renderPerformance(); renderUsage();
  componentLab?.updateRelease(report.release); void ensureComponentLab();
}
function renderHost() {
  const host = report.host;
  if (!host) { empty($('host-cards'),'正在采集服务器资源'); return; }
  const memoryRatio = host.memoryUsed / host.memoryTotal, diskRatio = host.disk?.total ? 1-host.disk.free/host.disk.total : null;
  const enabled = report.agents.filter(agent => agent.enabled), online = enabled.filter(agent => ['busy','idle','online'].includes(agent.state));
  $('host-meta').textContent = `${host.platform} / ${host.cores} 核 / 运行 ${duration(host.uptime)}`;
  $('host-cards').replaceChildren(stat('CPU 使用率', host.cpu == null ? '—' : host.cpu.toFixed(1), `${host.cores} 个逻辑核心`, '%', host.cpu == null ? null : host.cpu/100, host.cpu > 85 ? 'warning' : ''),
    stat('系统内存', (host.memoryUsed/1024**3).toFixed(1), `共 ${bytes(host.memoryTotal)} · ${percent(memoryRatio)}`, 'GB', memoryRatio, memoryRatio > .85 ? 'warning' : ''),
    stat('数据盘使用率', diskRatio == null ? '—' : (diskRatio*100).toFixed(1), host.disk ? `可用 ${bytes(host.disk.free)} / ${bytes(host.disk.total)}` : '采集不可用', '%', diskRatio, diskRatio > .9 ? 'warning' : ''),
    stat('在线 Agent', String(online.length), `${enabled.filter(agent => agent.state === 'busy').length} 个处理中`, `/ ${enabled.length}`, enabled.length ? online.length/enabled.length : null));
  trendChart($('host-chart'), report.hostHistory, [
    { label:'CPU', value:point=>point.cpu, format:value=>`${value.toFixed(1)}%`, className:'line' },
    { label:'内存', value:point=>point.memoryUsed/point.memoryTotal*100, format:value=>`${value.toFixed(1)}%`, className:'line memory-line' },
    { label:'磁盘', value:point=>point.diskRatio == null ? null : point.diskRatio*100, format:value=>`${value.toFixed(1)}%`, className:'line disk-line' }
  ], performanceRange(), { peak:100, intervalMs:report.hostHistoryIntervalMs, title:'服务器资源趋势' });
}
function renderAgents() {
  $('agents-count').textContent = `${report.agents.length} AGENTS`;
  $('agents').replaceChildren(...report.agents.map(agent => {
    const online = ['busy','idle','online'].includes(agent.state);
    const labels = { disabled:'已停用', busy:'处理中', idle:'空闲', online:'在线', unavailable:'连接异常' };
    const tr=node('tr'), status=node('td'), badge=node('span',`status-badge ${online ? 'good' : 'collecting'}`,labels[agent.state] || '状态未知'); status.append(badge);
    tr.append(rowIdentity(agent.name,agent.id),status);
    for (const text of [agent.runtime?.cpu == null ? '—' : `${Number(agent.runtime.cpu).toFixed(1)}%`, bytes(agent.runtime?.rss),duration(agent.runtime?.uptime),time(agent.runtime?.at)]) tr.append(node('td','',text)); return tr;
  }));
}
const categories = ['浏览器','对话','模型','工具','网络','服务端'];
const categoryNames = { '浏览器': '前端体验', '对话': '对话响应', '模型': '模型生成', '工具': '工具执行', '网络': '网络与推送', '服务端': '服务端开销' };
function metricValue(metric) { return metrics().find(row => row.metric === metric); }
function metricCard(metric) {
  const row = metricValue(metric), value = row?.[`p${row.percentile}`];
  return stat(row?.label || metric, ms(value), row ? `${number(row.count)} 样本 · 达成 ${compliance(row)}` : '等待采集',
    `P${row?.percentile || 95} ≈`, null, row?.status === 'slow' ? 'warning' : '');
}
function renderPerformance() {
  const rows = metrics(), known = report.performance.availableAgents > 0;
  $('performance-cards').replaceChildren(...['web.lcp','web.reply_first','turn.queue','model.first_output','tool.call','network.headers','web.sse_delivery','server.event_loop'].map(metricCard));
  const counters = [['turn.total','完成对话'],['model.call','模型调用'],['tool.call','工具调用'],['http.request','API 请求']];
  $('activity-stats').replaceChildren(...counters.map(([metric,label]) => {
    const row=metricValue(metric), el=node('div','activity-stat'), main=node('strong','',known?short(row?.count):'—');
    main.append(node('span','unit','次')); el.append(node('span','',label),main); return el;
  }));
  const pairs = { '浏览器':['web.lcp','web.interaction'], '对话':['web.reply_first','web.reply_total'], '模型':['model.first_output','model.call'],
    '工具':['tool.call'], '网络':['network.headers','web.sse_delivery'], '服务端':['http.request','server.event_loop'] };
  $('category-cards').replaceChildren(...categories.map(category => {
    const panel=node('section','panel category-panel'), heading=node('div','section-heading'); heading.append(node('h2','',categoryNames[category]));
    const slow=rows.filter(row=>row.group===category&&row.status==='slow').length;
    heading.append(node('span',slow?'warning':'',slow?`${slow} 项超标`:'汇总统计')); panel.append(heading);
    for(const metric of pairs[category]) {
      const row=metricValue(metric), line=node('div','category-stat'); line.append(node('span','',row.label),node('strong','',ms(row[`p${row.percentile}`]))); panel.append(line);
    }
    if(category==='工具') { const row=metricValue('tool.call'), line=node('div','category-stat'); line.append(node('span','','失败率'),node('strong','',percent(row.errorRate))); panel.append(line); }
    return panel;
  }));
  $('performance-sampling').textContent = known ? `${report.performance.availableAgents} 个 Agent · ${report.performance.dropped} 条采集丢弃` : '等待采集';
  renderTrends(); renderMetrics();
}
function renderMetrics() {
  const rows=metrics().filter(row=>!state.group||row.group===state.group).sort((a,b)=>(a.status==='slow'?-1:0)-(b.status==='slow'?-1:0)||categories.indexOf(a.group)-categories.indexOf(b.group));
  $('metrics').replaceChildren(...rows.map(row=>{
    const tr=node('tr'); tr.append(rowIdentity(row.label,categoryNames[row.group]));
    for(const text of [number(row.count),ms(row.p50),ms(row.p75),ms(row.p95),ms(row.p99),percent(row.errorRate)])tr.append(node('td','',text));
    const target=node('td','',`P${row.percentile} ≤ ${ms(row.target)}`);target.append(node('small',row.status,row.status==='collecting'?'采集中':row.status==='slow'?'超标':row.status==='uncertain'?'待确认':'达标'));
    const attainment=node('td',row.status,compliance(row));if(row.cancelled)attainment.append(node('small','',`取消 ${row.cancelled}`));tr.append(target,attainment);return tr;
  }));
}
function renderTrends() {
  for(const button of $('trend-modes').querySelectorAll('button')) button.setAttribute('aria-pressed',String(button.dataset.mode===state.performanceMode));
  $('performance-trends').replaceChildren(...categories.filter(category=>!state.group||category===state.group).map(category=>{
    const panel=node('section','panel trend-panel'), heading=node('div','section-heading'), select=node('select');
    select.setAttribute('aria-label',`${categoryNames[category]}趋势指标`);
    const options=metrics().filter(row=>row.group===category);
    populate(select,options.map(row=>[row.metric,row.label]),'选择指标',state.trends[category]); select.options[0].disabled=true;
    select.onchange=()=>{state.trends[category]=select.value;renderTrends();};
    heading.append(node('h2','',categoryNames[category]),select); panel.append(heading);
    const metric=metricValue(state.trends[category]), points=report.performance.series.filter(point=>point.metric===metric.metric).sort((a,b)=>a.at-b.at);
    const chart=node('div','chart'); panel.append(chart); latencyChart(chart,points,metric); return panel;
  }));
}
function performanceRange() { return { from:report.generatedAt-state.hours*3600000, through:report.generatedAt }; }
function trendChart(parent,points,series,range,options={}) {
  const valid=value=>typeof value==='number'&&Number.isFinite(value);
  const values=series.flatMap(line=>points.map(line.value).filter(valid));
  if(!values.length) {empty(parent,'所选时段暂无数据');return;}
  const width=900,height=150,peak=options.peak||Math.max(1,options.target||0,...values);
  const x=point=>Math.max(0,Math.min(width,(point.at-range.from)/Math.max(1,range.through-range.from)*width)), y=value=>138-value/peak*125;
  const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,preserveAspectRatio:'none',role:'img','aria-label':options.title||'时间趋势'});
  for(const height of [13,75,138])svg.append(svgNode('line',{x1:0,x2:width,y1:height,y2:height,class:'grid'}));
  if(options.target!=null) svg.append(svgNode('line',{x1:0,x2:width,y1:y(options.target),y2:y(options.target),class:'target-line'}));
  for(const line of series) {
    const usable=points.filter(point=>valid(line.value(point))); let path='',previous;
    for(const point of usable) {
      path+=`${!previous||options.intervalMs&&point.at-previous.at>options.intervalMs*1.5?'M':'L'}${x(point)},${y(line.value(point))} `; previous=point;
    }
    svg.append(svgNode('path',{d:path,class:line.className||'line'}));
    for(const point of usable) {
      const dot=svgNode('circle',{cx:x(point),cy:y(line.value(point)),r:usable.length<20?3:2,class:`trend-dot ${line.className||''}`}),tip=svgNode('title');
      tip.textContent=`${time(point.at)} · ${line.label} ${line.format(line.value(point))}${options.detail?` · ${options.detail(point)}`:''}`;dot.append(tip);svg.append(dot);
    }
  }
  const scale=node('div','chart-scale');scale.append(node('span','',series[0].format(peak)),node('span','',options.caption||''));
  const axis=node('div','axis');axis.append(node('span','',time(range.from)),node('span','',time((range.from+range.through)/2)),node('span','',time(range.through)));
  parent.replaceChildren(scale,svg,axis);
}
function latencyChart(parent,points,metric) {
  const mode=state.performanceMode,field=`p${metric.percentile}`,value=point=>mode==='count'?point.count:mode==='errors'?point.errorRate:point[field];
  const format=mode==='count'?number:mode==='errors'?percent:ms;
  trendChart(parent,points,[{label:mode==='latency'?`P${metric.percentile} ≈`:mode==='count'?'样本量':'失败率',value,format}],performanceRange(),{
    target:mode==='latency'?metric.target:null,peak:mode==='errors'?1:undefined,intervalMs:report.performance.intervalMs,
    title:`${metric.label}时间趋势`,caption:mode==='latency'?`P${metric.percentile} ≈ · 目标 ${ms(metric.target)}`:'',
    detail:point=>`${number(point.count)} 样本 · 失败 ${number(point.errors)}`
  });
  if(!points.some(point=>value(point)!=null))return;
  const summary=node('div','trend-summary');summary.append(node('strong','',format(mode==='count'?metric.count:mode==='errors'?metric.errorRate:metric[field])),node('span','',`${number(metric.count)} 样本 · 失败 ${number(metric.errors)}`));parent.prepend(summary);
}
function renderUsage(){
  const usage=report.usage,total=usage.totals,known=report.agents.some(agent=>agent.usageState==='ready'),tokens=total.inputTokens+total.outputTokens;
  $('usage-cards').replaceChildren(stat('调用次数',known?short(total.requests):'—',total.historical?`历史记录 ${number(total.historical)}`:'已记录的实际调用'),stat('Token 用量',known && !(total.requests>0 && total.missingUsage>=total.requests && !tokens)?short(tokens):'—',`输入 ${short(total.inputTokens)} / 输出 ${short(total.outputTokens)}`),stat('缓存命中率',known?percent(total.inputTokens?total.cachedInputTokens/total.inputTokens:null):'—',`${short(total.cachedInputTokens)} 缓存 Token`),stat(total.unpriced || total.unpricedUsage ? '已计费用' : '费用合计',known?money(total.costs.USD):'—',total.estimatedCosts.USD?`含估算 ${money(total.estimatedCosts.USD)} USD`:'', 'USD'));
  const states=[];for(const [key,label]of [['awaitingBill','待对账'],['unpriced','待定价'],['missingUsage','用量缺失'],['undated','时间缺失']])if(total[key])states.push(`${label} ${number(total[key])}`);
  const missing=report.agents.filter(agent=>agent.usageState!=='ready');if(missing.length)states.push(`${missing.map(agent=>agent.name).join('、')}：用量暂不可用`);
  $('usage-completeness').textContent=states.join(' · ');$('model-count').textContent=`${usage.models.length} MODELS`;
  if(!usage.models.length)emptyTable($('models'),8,known?'所选范围暂无模型用量':'等待用量数据');
  else $('models').replaceChildren(...usage.models.map(model=>{const tr=node('tr'),identity=rowIdentity(model.model,model.supplier);if(model.costType==='subscription')identity.append(node('span','tag subscription','订阅 · 费用 0'));if(model.unpriced || model.unpricedUsage)identity.append(node('span','tag','待定价'));if(model.missingUsage)identity.append(node('span','tag','用量缺失'));tr.append(identity);
    const tokensKnown=!(model.requests>0&&model.missingUsage>=model.requests&&!model.inputTokens&&!model.outputTokens);
    for(const text of [number(model.requests),tokensKnown?number(model.inputTokens):'—',tokensKnown?number(model.outputTokens):'—',tokensKnown?number(model.cachedInputTokens):'—',tokensKnown?number(model.cacheWriteTokens):'—',model.costType!=='subscription' && (model.unpriced || model.unpricedUsage) && !model.costs.USD ? '—' : money(model.costs.USD),number(model.failed)])tr.append(node('td','',text));return tr;}));
  renderUsageChart();
  const media=[];if(total.imageRequests)media.push(`图像 ${number(total.outputImages)} 张 / ${number(total.imageRequests)} 次`);if(total.videoRequests)media.push(`视频 ${number(total.outputVideos)} 条 / ${number(total.outputSeconds)} 秒`);$('media-usage').replaceChildren(...media.map(text=>node('span','',text)));
}
function renderUsageChart() {
  const metric=state.chartMetric,value=day=>metric==='tokens'?day.inputTokens+day.outputTokens:metric==='requests'?day.requests:day.costs.USD;
  for(const button of $('chart-metrics').querySelectorAll('button'))button.setAttribute('aria-pressed',String(button.dataset.metric===metric));
  const points=report.usage.days.map(day=>({...day,at:Date.parse(day.date.includes('T')?`${day.date}+08:00`:`${day.date.length===7?day.date+'-01':day.date}T00:00:00+08:00`)}));
  const from=state.period==='today'?Date.parse(`${new Date(report.generatedAt+8*3600000).toISOString().slice(0,10)}T00:00:00+08:00`)
    :state.period==='all'?points[0]?.at??report.generatedAt:Date.parse(`${new Date(report.generatedAt+8*3600000).toISOString().slice(0,10)}T00:00:00+08:00`)-(state.period==='7d'?6:29)*86400000;
  trendChart($('usage-chart'),points,[{label:metric==='tokens'?'Token':metric==='requests'?'调用':'USD',value,format:metric==='cost'?money:number}],
    {from,through:report.generatedAt},{intervalMs:points.some(point=>point.date.includes('T'))?3600000:points.some(point=>point.date.length===7)?32*86400000:86400000,title:'模型用量时间趋势'});
}
async function load(){
  const own=++version;controller?.abort();controller=new AbortController();$('refresh').disabled=true;$('retry').hidden=true;if(!report&&authenticated)feedback('正在加载监控数据…');
  try{const next=await api(`report?${new URLSearchParams({hours:state.hours,period:state.period,agent:state.agent,model:state.model})}`,'GET',undefined,controller.signal);if(own!==version)return;report=next;authenticated=true;$('login').hidden=true;$('app').hidden=false;render();}
  catch(error){if(own!==version||error.name==='AbortError')return;if(error.status===401){showLogin();return;}$('live-state').classList.remove('ready');$('live-state').lastElementChild.textContent='连接中断';if(!authenticated){$('login').hidden=false;$('login-error').textContent=error.message;}else feedback(`${error.message}${report?' · 显示上次数据':''}`,true);}
  finally{if(own===version)$('refresh').disabled=false;}
}
$('login-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;$('login-error').textContent='';try{await api('login','POST',{password:$('password').value});$('password').value='';authenticated=true;await load();}catch(error){$('login-error').textContent=error.message;}finally{button.disabled=false;}};
$('logout').onclick=async()=>{try{await api('logout','POST',{});showLogin();}catch(error){if(error.status===401)showLogin();else feedback(error.message,true);}};
$('refresh').onclick=()=>void load();$('retry').onclick=()=>void load();
$('agent').onchange=()=>{state.agent=$('agent').value;void load();};$('model').onchange=()=>{state.model=$('model').value;void load();};
$('group').onchange=()=>{state.group=$('group').value;if(report){renderMetrics();renderTrends();}};
$('trend-modes').onclick=event=>{const button=event.target.closest('[data-mode]');if(button){state.performanceMode=button.dataset.mode;if(report)renderTrends();}};
$('hours').onclick=event=>{const button=event.target.closest('[data-hours]');if(button){state.hours=Number(button.dataset.hours);const url=new URL(location.href);url.searchParams.set('hours',state.hours);history.replaceState(null,'',url);void load();}};
$('periods').onclick=event=>{const button=event.target.closest('[data-period]');if(button){state.period=button.dataset.period;const url=new URL(location.href);url.searchParams.set('period',state.period);history.replaceState(null,'',url);void load();}};
$('chart-metrics').onclick=event=>{const button=event.target.closest('[data-metric]');if(button){state.chartMetric=button.dataset.metric;if(report)renderUsageChart();}};
for(const button of document.querySelectorAll('nav [data-view]'))button.onclick=()=>selectView(button.dataset.view);
$('auto-refresh').onclick=()=>{state.auto=!state.auto;$('auto-refresh').setAttribute('aria-checked',String(state.auto));$('refresh-label').textContent=state.auto?'30 秒自动刷新':'自动刷新已暂停';};
setInterval(()=>{if(authenticated&&state.auto&&!document.hidden&&!$('password-dialog').open)void load();},30000);
document.addEventListener('visibilitychange',()=>{if(authenticated&&state.auto&&!document.hidden)void load();});
$('export').onclick=()=>{if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),link=node('a');link.href=url;link.download=`zigent-dashboard-${new Date(report.generatedAt+8*3600000).toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('open-password').onclick=()=>{$('password-form').reset();$('password-status').textContent='';$('password-dialog').showModal();};$('close-password').onclick=()=>$('password-dialog').close();
$('password-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await api('password','POST',{current:$('current-password').value,password:$('new-password').value});$('password-form').reset();$('password-status').textContent='密码已更新';}catch(error){if(error.status===401)showLogin();else $('password-status').textContent=error.message;}finally{button.disabled=false;}};
selectView(location.hash.slice(1));void load();
