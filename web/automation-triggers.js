(() => {
  'use strict';
  const node = (tag, className, text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
  const sourceName = source => source === 'iphone' ? 'iPhone' : source;
  const eventName = event => event === 'alarm_stopped' ? '闹钟停止' : event === 'charging_started' ? '开始充电' : event === 'notification_received' ? '收到通知' : event;
  const states = new Map();
  let serial = 0;
  function render(type, sources, discuss) {
    const item = node('details', 'automation-entry automation-trigger-type'); item.dataset.triggerType = type.id;
    const saved = states.get(type.id) || {}; states.set(type.id, saved); item.open = Boolean(saved.open);
    item.ontoggle = () => { saved.open = item.open; };
    const summary = node('summary', ''), identity = node('div', 'automation-identity');
    identity.append(node('strong', '', type.title), node('span', 'automation-subtitle', type.parameters.join(' · ')));
    summary.append(identity, node('span', 'automation-badge', '可配置')); item.append(summary);
    const form = node('form', 'automation-trigger-form'); form.setAttribute('aria-label', `${type.title}参数`);
    const preview = node('div', 'automation-trigger-preview');
    const fields = node('div', 'automation-parameters'), controls = {}, wrappers = {};
    function field(name, label, options) {
      const wrapper = node('div', 'automation-parameter'), id = `trigger-parameter-${++serial}`;
      wrapper.dataset.parameter = name;
      const caption = node('label', '', label); caption.htmlFor = id;
      const control = node(options.choices ? 'select' : 'input', ''); control.id = id; control.name = name;
      if (options.choices) for (const [value, title] of options.choices) { const option = node('option', '', title); option.value = value; control.append(option); }
      else { control.type = options.type || 'text'; if (options.min !== undefined) control.min = options.min; if (options.max !== undefined) control.max = options.max; if (options.step !== undefined) control.step = options.step; if (options.maxLength) control.maxLength = options.maxLength; }
      if (options.required) control.required = true;
      if (options.placeholder) control.placeholder = options.placeholder;
      control.value = saved[name] ?? options.value ?? '';
      if (options.choices && !options.choices.some(([value]) => value === control.value)) control.value = options.choices[0]?.[0] || '';
      if (options.choices && !options.choices.length) control.disabled = true;
      controls[name] = control; wrappers[name] = wrapper; wrapper.append(caption, control); fields.append(wrapper);
      return control;
    }
    const timezone = () => field('timezone', '时区', { required: true, value: 'Asia/Shanghai', maxLength: 100 });
    const number = (name, label, value, min, max) => field(name, label, { type: 'number', required: true, value: String(value), min, max });
    const choices = (name, label, values, value) => field(name, label, { choices: values, value });
    let weekdays;
    if (type.id === 'time') {
      choices('schedule', '周期', [['daily', '每天'], ['weekly', '每周'], ['once', '单次']], 'daily');
      field('date', '日期', { type: 'date', required: true });
      field('time', '时间', { type: 'time', required: true, value: '09:00' }); timezone();
      number('lateness', '补跑期限（分钟）', 60, 1, 1440);
      weekdays = node('fieldset', 'automation-weekdays'); weekdays.append(node('legend', '', '星期'));
      for (const [day, label] of [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']]) {
        const option = node('label', ''), input = node('input', ''); input.type = 'checkbox'; input.name = 'weekdays'; input.value = String(day);
        input.checked = (saved.weekdays || ['1', '2', '3', '4', '5']).includes(String(day)); option.append(input, node('span', '', label)); weekdays.append(option);
      }
      fields.append(weekdays);
    } else if (type.id === 'location') {
      choices('locationMode', '范围', [['region', 'OwnTracks 区域'], ['current', '当前位置'], ['coordinates', '坐标围栏']], 'region');
      field('region', '地点', { required: true, maxLength: 200 });
      field('latitude', '纬度（GCJ-02）', { type: 'number', required: true, min: -90, max: 90, step: 'any' });
      field('longitude', '经度（GCJ-02）', { type: 'number', required: true, min: -180, max: 180, step: 'any' });
      number('radius', '半径（米）', 500, 100, 50000);
      choices('event', '方向', [['enter', '到达'], ['leave', '离开']], 'enter');
      field('minSpeedKph', '最低速度（km/h）', { type: 'number', min: 0, max: 2000, step: 'any', placeholder: '不限' });
      field('maxSpeedKph', '最高速度（km/h）', { type: 'number', min: 0, max: 2000, step: 'any', placeholder: '不限' });
      number('cooldown', '冷却（分钟）', 5, 0, 1440);
      number('maxAge', '位置有效期（分钟）', 10, 1, 1440);
      choices('repeat', '次数', [['yes', '每次'], ['no', '单次']], 'yes');
    } else if (type.id === 'external') {
      const active = sources.filter(source => source.status === 'active');
      choices('source', '设备', active.map(source => [source.name, sourceName(source.name)]));
      choices('event', '事件', (active.find(source => source.name === controls.source.value)?.events || []).map(event => [event, eventName(event)]));
      number('cooldown', '冷却（分钟）', 0, 0, 1440);
    } else if (type.id === 'health_change') {
      choices('metric', '指标', [['all', '全部指标'], ['sleep_analysis', '睡眠'], ['heart_rate_variability', 'HRV'], ['heart_rate', '心率']], 'all');
      field('afterTime', '开始时间', { type: 'time' }); timezone();
      number('debounce', '合并窗口（秒）', 30, 0, 3600);
      choices('oncePerDay', '通知上限', [['no', '不限'], ['yes', '每天一次']], 'no');
    }
    const actions = node('div', 'automation-actions');
    function validate() {
      if (type.id === 'location' && controls.minSpeedKph.value !== '' && controls.maxSpeedKph.value !== ''
        && Number(controls.minSpeedKph.value) > Number(controls.maxSpeedKph.value)) controls.maxSpeedKph.setCustomValidity('最高速度不能低于最低速度');
      if (!form.reportValidity()) return false;
      if (controls.timezone) {
        try { new Intl.DateTimeFormat('zh-CN', { timeZone: controls.timezone.value }); }
        catch { controls.timezone.setCustomValidity('请输入有效时区'); controls.timezone.reportValidity(); return false; }
      }
      if (weekdays && controls.schedule.value === 'weekly' && !weekdays.querySelector('input:checked')) {
        const first = weekdays.querySelector('input'); first.setCustomValidity('请选择星期'); first.reportValidity(); return false;
      }
      return true;
    }
    function parameters() {
      const value = name => controls[name].value;
      if (type.id === 'time') {
        const period = value('schedule') === 'once' ? value('date') : value('schedule') === 'daily' ? '每天'
          : `每周${[...weekdays.querySelectorAll('input:checked')].map(input => ['日', '一', '二', '三', '四', '五', '六'][Number(input.value)]).join('、')}`;
        return `${period} ${value('time')}，时区 ${value('timezone')}，补跑期限 ${value('lateness')} 分钟`;
      }
      if (type.id === 'location') {
        const place = value('locationMode') === 'region' ? `「${value('region')}」（先核对手机已有区域并使用对应标识）`
          : value('locationMode') === 'current' ? `以当前实际位置为圆心、半径 ${value('radius')} 米的围栏（先读取最新定位固定圆心）`
            : `GCJ-02 纬度 ${value('latitude')}、经度 ${value('longitude')}，半径 ${value('radius')} 米的围栏`;
        const min = value('minSpeedKph'), max = value('maxSpeedKph');
        const speed = min !== '' && max !== '' ? `，速度在 ${min}–${max} km/h（含边界）` : min !== '' ? `，速度 ≥ ${min} km/h` : max !== '' ? `，速度 ≤ ${max} km/h` : '';
        return `${value('event') === 'enter' ? '到达' : '离开'}${place}时${speed}，冷却 ${value('cooldown')} 分钟，位置有效期 ${value('maxAge')} 分钟，${value('repeat') === 'yes' ? '每次触发' : '仅触发一次'}`;
      }
      if (type.id === 'external') return `收到 ${sourceName(value('source'))} 的「${eventName(value('event'))}」事件时，冷却 ${value('cooldown')} 分钟`;
      return `${value('metric') === 'all' ? '健康数据' : controls.metric.selectedOptions[0].textContent}更新后${value('afterTime') ? `，仅当天 ${value('afterTime')} 后收到的更新` : ''}，时区 ${value('timezone')}，合并 ${value('debounce')} 秒，${value('oncePerDay') === 'yes' ? '每天最多通知一次' : '通知次数不限'}`;
    }
    function offer(savePoint) {
      if (!validate()) return;
      const text = savePoint ? `用${type.title}保存一个可复用触发点，固定触发条件为：${parameters()}。`
        : `用${type.title}创建一个主动任务，触发条件为：${parameters()}。\n任务提示词：`;
      discuss(text);
    }
    const use = node('button', 'automation-button', '用于任务'); use.type = 'submit'; actions.append(use);
    let save;
    if (type.canSavePoint) { save = node('button', 'automation-button', '保存为触发点'); save.type = 'button'; save.onclick = () => offer(true); actions.append(save); }
    form.onsubmit = event => { event.preventDefault(); offer(false); };
    function sync() {
      if (type.id === 'time') {
        const once = controls.schedule.value === 'once', weekly = controls.schedule.value === 'weekly';
        wrappers.date.hidden = !once; controls.date.disabled = !once;
        weekdays.hidden = !weekly; weekdays.disabled = !weekly;
      }
      if (type.id === 'location') {
        const mode = controls.locationMode.value;
        for (const name of ['region', 'latitude', 'longitude', 'radius']) {
          const visible = name === 'region' ? mode === 'region' : name === 'radius' ? mode !== 'region' : mode === 'coordinates';
          wrappers[name].hidden = !visible; controls[name].disabled = !visible;
        }
        if (save) save.hidden = controls.repeat.value === 'no';
      }
      const value = name => controls[name]?.value;
      // Project only configured display fields; never copy coordinates into a visual.
      const numeric = (name, scale = 1) => { const raw = value(name); return raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) * scale : undefined; };
      let visual;
      if (type.id === 'time') visual = { type: 'time', schedule: value('schedule'), date: value('date'), time: value('time'), timezone: value('timezone'),
        weekdays: [...weekdays.querySelectorAll('input:checked')].map(input => Number(input.value)), maxLatenessSeconds: numeric('lateness', 60) };
      if (type.id === 'location') visual = { type: 'location', event: value('event'), place: value('locationMode') === 'region' ? value('region') : value('locationMode') === 'current' ? '当前位置' : '所选地点',
        minSpeedKph: numeric('minSpeedKph'), maxSpeedKph: numeric('maxSpeedKph'),
        radiusMeters: value('locationMode') !== 'region' ? numeric('radius') : undefined, cooldownSeconds: numeric('cooldown', 60), repeat: value('repeat') === 'yes' };
      if (type.id === 'external') visual = { type: 'external', source: value('source'), event: value('event'), cooldownSeconds: numeric('cooldown', 60) };
      if (type.id === 'health_change') visual = { type: 'health_change', metrics: value('metric') === 'all' ? [] : [value('metric')], afterTime: value('afterTime'), timezone: value('timezone'),
        debounceSeconds: numeric('debounce'), oncePerDay: value('oncePerDay') === 'yes' };
      let context;
      if (type.id === 'time' && value('time') && value('timezone') && (value('schedule') !== 'once' || value('date'))
        && (value('schedule') !== 'weekly' || visual.weekdays.length)) context = { kind: 'preview', trigger: { type: 'time', schedule: value('schedule'), time: value('time'), timezone: value('timezone'),
          ...(value('schedule') === 'once' ? { date: value('date') } : value('schedule') === 'weekly' ? { weekdays: visual.weekdays } : {}) } };
      if (type.id === 'location') {
        const mode = value('locationMode');
        if (mode === 'region' && value('region').trim() || mode !== 'region' && visual.radiusMeters >= 100 && visual.radiusMeters <= 50000
          && (mode === 'current' || value('latitude') !== '' && value('longitude') !== '' && Number.isFinite(Number(value('latitude'))) && Number.isFinite(Number(value('longitude'))))) {
          context = { kind: 'preview', trigger: { type: 'location', mode,
            ...(mode === 'region' ? { region: value('region') } : { radiusMeters: visual.radiusMeters }),
            ...(mode === 'coordinates' ? { latitude: Number(value('latitude')), longitude: Number(value('longitude')) } : {}) } };
        }
      }
      const drawing = window.ZigentTriggerVisual.render(visual, context);
      preview.replaceChildren(...(drawing ? [drawing] : []));
    }
    form.addEventListener('input', event => {
      event.target.setCustomValidity?.('');
      if (type.id === 'location') controls.maxSpeedKph.setCustomValidity('');
      for (const [name, control] of Object.entries(controls)) saved[name] = control.value;
      if (weekdays) { weekdays.querySelector('input').setCustomValidity(''); saved.weekdays = [...weekdays.querySelectorAll('input:checked')].map(input => input.value); }
      sync();
    });
    if (type.id === 'external') controls.source.addEventListener('change', () => {
      const events = sources.find(source => source.name === controls.source.value)?.events || [];
      controls.event.replaceChildren(...events.map(event => { const option = node('option', '', eventName(event)); option.value = event; return option; })); saved.event = controls.event.value;
      sync();
    });
    sync();
    if (!type.available) {
      const setup = node('button', 'automation-button', type.id === 'location' ? '接入定位' : type.id === 'health_change' ? '接入健康' : '接入设备');
      setup.type = 'button'; setup.onclick = () => discuss(`设置${type.id === 'location' ? '定位' : type.id === 'health_change' ? '健康' : '设备事件'}接入，以使用${type.title}。`);
      actions.replaceChildren(setup);
    }
    form.append(preview, fields, actions); item.append(form); return item;
  }
  window.ZigentAutomationTriggers = { render };
})();
