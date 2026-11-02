const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, action, className = '') => {
  const node = element('button', className, text); node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
};
const sizeLabel = value => {
  const bytes = Number(value || 0);
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`;
};
const dateLabel = value => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '';
const running = job => ['starting', 'queued', 'running', 'waiting_input'].includes(job.state || job.status);
const states = { starting: '准备中', queued: '排队中', running: '运行中', waiting_input: '等待输入', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '已中断' };
const leaf = path => String(path || '').split('/').at(-1) || '文件';

/** Owner-scoped file/project UI. All mutations originate from explicit user actions. */
export function createFileWorkbench({ base, api, toast, selectProject }) {
  const dialog = element('dialog', 'file-workbench');
  dialog.id = 'file-workbench-dialog'; dialog.setAttribute('aria-labelledby', 'file-workbench-title');
  const heading = element('header', 'fw-heading'), title = element('h2', '', '项目与文件'); title.id = 'file-workbench-title';
  const refresh = button('刷新', () => void loadSnapshot()), closeButton = button('×', () => close(), 'fw-close');
  closeButton.setAttribute('aria-label', '关闭项目与文件');
  heading.append(title, refresh, closeButton);
  const feedback = element('div', 'fw-feedback'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');
  const retry = button('重试', () => void retryAction()); retry.hidden = true; feedback.append(retry);
  const feedbackText = element('span'); feedback.prepend(feedbackText);
  const layout = element('div', 'fw-layout'), sidebar = element('aside', 'fw-sidebar'), sidebarHeading = element('div', 'fw-sidebar-heading');
  const newProjectButton = button('新建', () => { projectForm.hidden = !projectForm.hidden; if (!projectForm.hidden) projectName.focus(); });
  sidebarHeading.append(element('h3', '', '项目'), newProjectButton);
  const projectForm = element('form', 'fw-project-form'); projectForm.hidden = true;
  const projectName = element('input'); projectName.required = true; projectName.maxLength = 160; projectName.placeholder = '项目名称'; projectName.setAttribute('aria-label', '新项目名称');
  const createProject = element('button', 'fw-primary', '创建'); createProject.type = 'submit'; projectForm.append(projectName, createProject);
  const projects = element('nav', 'fw-projects'); projects.setAttribute('aria-label', '项目');
  sidebar.append(sidebarHeading, projectForm, projects);
  const main = element('section', 'fw-main'), context = element('div', 'fw-context'), projectTitle = element('h3'), projectSelect = element('select', 'fw-mobile-project');
  projectSelect.setAttribute('aria-label', '选择项目');
  const useProject = button('用于对话', async () => { if (selectProject && selectedWorkspace) { await selectProject(selectedWorkspace); close(); } }); useProject.hidden = !selectProject;
  context.append(projectTitle, projectSelect, useProject);
  const tabs = element('nav', 'fw-tabs'); tabs.setAttribute('aria-label', '项目内容');
  const panel = element('div', 'fw-panel'); panel.id = 'file-workbench-panel';
  const tabButtons = new Map();
  for (const [value, label] of [['files', '文件'], ['artifacts', '成果'], ['originals', '原件'], ['jobs', '任务'], ['shares', '分享']]) {
    const node = button(label, () => { tab = value; detailGeneration++; selectedJob = undefined; detail.hidden = true; detail.replaceChildren(); void renderTab(); });
    node.setAttribute('aria-controls', panel.id); tabButtons.set(value, node); tabs.append(node);
  }
  const detail = element('section', 'fw-detail'); detail.hidden = true;
  main.append(context, tabs, panel, detail); layout.append(sidebar, main); dialog.append(heading, feedback, layout);
  document.body.append(dialog);

  let snapshot, selectedWorkspace = '', tab = 'files', directory = '.', page, returnFocus, controller, timer, requestGeneration = 0, fileGeneration = 0, detailGeneration = 0;
  let retryAction = loadSnapshot, selectedJob, jobOutput = '', jobOffset = 0, snapshotSignature = '', projectSignature = '', artifactSignature = '', artifactPage;
  const drafts = new Map();
  const url = path => new URL(`${base || './'}api/${path}`, location.href).href;
  const request = (path, method = 'GET', value) => api(path, method, value, controller?.signal);
  function status(text = '', retryHandler) {
    const storage=snapshot?.storage;
    if (!text && ['low','critical'].includes(storage?.status)) text='存储空间偏低';
    feedback.dataset.storageStatus=storage?.status || '';
    feedbackText.title=['low','critical'].includes(storage?.status) ? `剩余 ${sizeLabel(storage.freeBytes)} / ${sizeLabel(storage.totalBytes)}` : '';
    feedbackText.textContent = text; retry.hidden = !retryHandler;
    if (retryHandler) retryAction = retryHandler;
    feedback.hidden = !text && !retryHandler;
  }
  function failure(error, retryHandler) {
    if (error?.name === 'AbortError' || !dialog.open) return;
    status(error?.message || '暂时无法加载，请重试。', retryHandler);
  }
  async function action(control, operation) {
    control.disabled = true;
    try { await operation(); }
    catch (error) { failure(error); }
    finally { control.disabled = false; }
  }
  function previewButton(source,name) {
    const control=button('预览');control.dataset.documentPreview='';control.dataset.filename=name;
    for(const [key,value] of Object.entries(source))control.dataset[key]=value;return control;
  }
  function download(path, filename, text = '下载') {
    const link = element('a', 'fw-action', text); link.href = url(path); link.download = filename || ''; return link;
  }
  function empty(text) { panel.replaceChildren(element('p', 'fw-empty', text)); }
  function row(name, meta, actions = []) {
    const line = element('div', 'fw-row'), identity = element('div', 'fw-identity');
    identity.append(typeof name === 'string' ? element('strong', '', name) : name);
    if (meta) identity.append(element('span', 'fw-meta', meta));
    const controls = element('div', 'fw-actions'); controls.append(...actions); line.append(identity, controls); return line;
  }
  function showDetail(titleText) {
    detailGeneration++; selectedJob = undefined; detail.hidden = false;
    const header = element('div', 'fw-detail-heading'), label = element('strong', '', titleText), dismiss = button('收起', () => { detailGeneration++; detail.hidden = true; selectedJob = undefined; });
    header.append(label, dismiss); detail.replaceChildren(header); return detailGeneration;
  }
  function renderProjects() {
    const workspaces = snapshot?.workspaces || [];
    const signature = JSON.stringify([workspaces, selectedWorkspace]);
    if (signature !== projectSignature) {
      projectSignature = signature;
      projects.replaceChildren(...workspaces.map(workspace => {
        const node = button(workspace.name, () => void chooseWorkspace(workspace.id)); node.setAttribute('aria-current', String(workspace.id === selectedWorkspace)); return node;
      }));
      projectSelect.replaceChildren(...workspaces.map(workspace => new Option(workspace.name, workspace.id)));
      projectSelect.value = selectedWorkspace;
    }
    projectTitle.textContent = workspaces.find(workspace => workspace.id === selectedWorkspace)?.name || '文件';
    useProject.disabled = !selectedWorkspace;
  }
  async function chooseWorkspace(workspaceId) {
    if (selectedWorkspace === workspaceId) return;
    selectedWorkspace = workspaceId; directory = '.'; page = undefined; artifactPage = undefined; detail.hidden = true; selectedJob = undefined; detailGeneration++;
    renderProjects(); await renderTab();
  }
  function schedule() {
    clearTimeout(timer);
    if (!dialog.open) return;
    timer = setTimeout(() => { if (!document.hidden) void loadSnapshot(true); else schedule(); }, (snapshot?.jobs || []).some(running) ? 4000 : 15_000);
  }
  async function loadSnapshot(background = false) {
    if (!dialog.open) return;
    const generation = ++requestGeneration;
    if (!background) { refresh.disabled = true; status(snapshot ? '' : '正在加载…'); }
    try {
      const result = await request('workbench');
      if (generation !== requestGeneration || !dialog.open) return;
      snapshot = result;
      if (background && (!feedbackText.textContent || feedbackText.textContent === '存储空间偏低')) status();
      if (!result.workspaces?.some(workspace => workspace.id === selectedWorkspace)) { selectedWorkspace = result.defaultWorkspaceId || result.workspaces?.[0]?.id || ''; directory = '.'; page = undefined; artifactPage = undefined; }
      renderProjects();
      const nextArtifactSignature=JSON.stringify([result.artifacts,result.originals]);
      const artifactsChanged=nextArtifactSignature!==artifactSignature;artifactSignature=nextArtifactSignature;
      const signature = JSON.stringify([result.artifacts, result.originals, result.jobs, result.shares, result.peers]);
      if (!background || signature !== snapshotSignature) {
        snapshotSignature = signature;
        if (!(background && !artifactsChanged && artifactPage && ['artifacts','originals'].includes(tab)) && (tab !== 'files' || !page || !background)) await renderTab();
      }
      if (selectedJob) await loadJob(selectedJob, true);
      if (!background) status();
    } catch (error) { if (generation === requestGeneration) failure(error, () => loadSnapshot()); }
    finally { if (generation === requestGeneration) { refresh.disabled = false; schedule(); } }
  }
  async function renderTab() {
    for (const [value, control] of tabButtons) control.setAttribute('aria-pressed', String(value === tab));
    panel.setAttribute('aria-label', tabButtons.get(tab)?.textContent || '项目内容');
    if (tab !== 'files') fileGeneration++;
    if (tab === 'files') await loadFiles(directory);
    else if (tab === 'artifacts' || tab === 'originals') await loadArtifacts();
    else if (tab === 'jobs') renderJobs();
    else renderShares();
  }
  function fileTools() {
    const toolbar = element('div', 'fw-file-tools'), crumbs = element('nav', 'fw-breadcrumbs'); crumbs.setAttribute('aria-label', '文件位置');
    crumbs.append(button('根目录', () => void loadFiles('.')));
    if (directory !== '.') {
      const parts = directory.split('/');
      parts.forEach((part, index) => { crumbs.append(element('span', '', '/'), button(part, () => void loadFiles(parts.slice(0, index + 1).join('/')))); });
    }
    const newFile = button('新建文件', () => void editFile()); newFile.disabled = !selectedWorkspace;
    toolbar.append(crumbs, newFile); return toolbar;
  }
  async function loadFiles(path = '.', offset = 0, append = false) {
    if (!selectedWorkspace) { empty('暂无项目'); return; }
    const generation = ++fileGeneration, workspaceId = selectedWorkspace;
    const query = new URLSearchParams({ path, offset: String(offset) });
    panel.setAttribute('aria-busy', 'true');
    if (!append) panel.replaceChildren(fileTools(), element('p', 'fw-empty', '正在加载…'));
    try {
      const result = await request(`workbench/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`);
      if (!dialog.open || generation !== fileGeneration || tab !== 'files' || workspaceId !== selectedWorkspace) return;
      directory = result.path || path;
      page = append && page ? { ...result, files: [...page.files, ...result.files] } : result;
      const list = element('div', 'fw-file-list');
      for (const file of page.files || []) {
        const canPreview=file.type==='file'&&/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(file.name);
        const open = canPreview ? previewButton({workspaceId,path:file.path},file.name) : button(file.name || leaf(file.path), () => file.type === 'directory' ? void loadFiles(file.path) : void editFile(file.path), 'fw-file-name');
        if(canPreview){open.className='fw-file-name';open.textContent=file.name;}
        const actions = file.type === 'directory' ? [] : [download(`workbench/workspaces/${encodeURIComponent(workspaceId)}/download?${new URLSearchParams({ path: file.path })}`, file.name)];
        if(canPreview)actions.unshift(previewButton({workspaceId,path:file.path},file.name));
        list.append(row(open, file.type === 'directory' ? '文件夹' : `${sizeLabel(file.size)} · ${dateLabel(file.modifiedAt)}`, actions));
      }
      if (!page.files?.length) list.append(element('p', 'fw-empty', '暂无文件'));
      panel.replaceChildren(fileTools(), list);
      if (page.nextOffset !== undefined) panel.append(button('加载更多', () => void loadFiles(directory, page.nextOffset, true), 'fw-more'));
      status();
    } catch (error) { if (generation === fileGeneration) failure(error, () => loadFiles(path, offset, append)); }
    finally { if (generation === fileGeneration) panel.setAttribute('aria-busy', 'false'); }
  }
  async function editFile(path) {
    const workspaceId = selectedWorkspace, generation = showDetail(path ? leaf(path) : '新建文件');
    const key = `${workspaceId}:${path || '@new'}`;
    let draft = drafts.get(key);
    if (!draft && path) {
      detail.append(element('p', 'fw-empty', '正在读取…'));
      try {
        const result = await request(`workbench/workspaces/${encodeURIComponent(workspaceId)}/file?${new URLSearchParams({ path })}`);
        if (generation !== detailGeneration || !dialog.open) return;
        draft = { path, text: result.text, sha256: result.sha256, offset: result.nextOffset, dirty: false };
      } catch (error) { if (generation === detailGeneration) { detail.lastChild?.remove(); failure(error, () => editFile(path)); } return; }
    }
    if (!draft) draft = { path: directory === '.' ? '' : `${directory}/`, text: '', dirty: false };
    drafts.set(key, draft);
    const header = detail.firstChild; detail.replaceChildren(header);
    const form = element('form', 'fw-editor'), name = element('input'), text = element('textarea');
    name.value = draft.path; name.required = true; name.maxLength = 2048; name.readOnly = Boolean(path); name.placeholder = '文件路径'; name.setAttribute('aria-label', '文件路径');
    text.value = draft.text; text.spellcheck = false; text.setAttribute('aria-label', path ? `${leaf(path)}内容` : '新文件内容');
    const footer = element('div', 'fw-editor-footer'), state = element('span', 'fw-meta'), save = element('button', 'fw-primary', '保存'); save.type = 'submit';
    const more = button('继续读取', () => void action(more, async () => {
      const result = await request(`workbench/workspaces/${encodeURIComponent(workspaceId)}/file?${new URLSearchParams({ path, offset: String(draft.offset) })}`);
      if (generation !== detailGeneration || !dialog.open) return;
      if (result.sha256 !== draft.sha256) throw new Error('文件已变化，请重新打开。');
      draft.text += result.text; draft.offset = result.nextOffset; text.value = draft.text; updateEditor();
    }));
    function updateEditor() {
      text.readOnly = draft.offset !== undefined;
      save.disabled = draft.offset !== undefined;
      more.hidden = draft.offset === undefined;
      state.textContent = draft.offset !== undefined ? '部分内容' : draft.dirty ? '未保存' : draft.sha256 ? '已读取' : '';
    }
    text.oninput = () => { draft.text = text.value; draft.dirty = true; updateEditor(); };
    name.oninput = () => { draft.path = name.value; draft.dirty = true; updateEditor(); };
    form.onsubmit = event => {
      event.preventDefault();
      if (draft.offset !== undefined) return;
      void action(save, async () => {
        const result = await request(`workbench/workspaces/${encodeURIComponent(workspaceId)}/file`, 'PUT', { path: name.value, text: text.value, ...(draft.sha256 ? { expectedHash: draft.sha256 } : {}) });
        if (!dialog.open || generation !== detailGeneration) return;
        draft.sha256 = result.sha256; draft.text = text.value; draft.path = name.value; draft.dirty = false;
        if (!path) { drafts.delete(key); drafts.set(`${workspaceId}:${name.value}`, draft); name.readOnly = true; }
        state.textContent = '已保存'; toast?.('已保存'); await loadFiles(directory);
      });
    };
    footer.append(state, more, save); form.append(name, text, footer); detail.append(form); updateEditor();
    if (!path) name.focus();
  }
  async function loadArtifacts(offset = 0, append = false) {
    if (!selectedWorkspace) { empty('暂无项目'); return; }
    const generation=++fileGeneration, workspaceId=selectedWorkspace, currentTab=tab;
    const kind=currentTab==='originals'?'original':'artifact';
    const query=new URLSearchParams({workspaceId,kind,offset:String(offset),limit:'100'});
    panel.setAttribute('aria-busy','true');
    if (!append) panel.replaceChildren(element('p','fw-empty','正在加载…'));
    try {
      const result=await request(`workbench/artifacts?${query}`);
      if (!dialog.open || generation!==fileGeneration || tab!==currentTab || selectedWorkspace!==workspaceId)return;
      const previous=append && artifactPage?.workspaceId===workspaceId && artifactPage.kind===kind ? artifactPage.artifacts : [];
      const seen=new Set(previous.map(item=>item.versionId||item.id));
      artifactPage={workspaceId,kind,...result,artifacts:[...previous,...(result.artifacts||[]).filter(item=>!seen.has(item.versionId||item.id))]};
      renderArtifacts();status();
    } catch(error){if(generation===fileGeneration)failure(error,()=>loadArtifacts(offset,append));}
    finally{if(generation===fileGeneration)panel.removeAttribute('aria-busy');}
  }
  function renderArtifacts() {
    const artifacts=artifactPage?.artifacts||[];
    if (!artifacts.length) { empty(tab==='originals'?'暂无原件':'暂无成果'); return; }
    panel.replaceChildren(...artifacts.map(item => {
      const versionId = item.versionId || item.id;
      const preview = element('a', 'fw-action', '预览'); preview.href = url(`workbench/versions/${encodeURIComponent(versionId)}/preview`); preview.target = '_blank'; preview.rel = 'noopener noreferrer'; if(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(item.name)){preview.dataset.documentPreview='';preview.dataset.versionId=versionId;preview.dataset.filename=item.name;}
      return row(item.title || item.name, `${item.name} · ${sizeLabel(item.size)} · ${dateLabel(item.createdAt)}`, [
        preview, button('版本', () => void loadVersions(item)), button('分享', () => shareForm({ versionId, name: item.name })),
        download(`workbench/versions/${encodeURIComponent(versionId)}/download`, item.name)
      ]);
    }));
    if(artifactPage.nextOffset!==undefined)panel.append(button('更多',event=>void action(event.currentTarget,()=>loadArtifacts(artifactPage.nextOffset,true)),'fw-more'));
  }
  async function loadVersions(item) {
    const generation = showDetail(item.title || item.name);
    try {
      const result = await request(`workbench/files/${encodeURIComponent(item.fileId)}/versions`);
      if (generation !== detailGeneration || !dialog.open) return;
      for (const version of result.versions || result) {
        const versionId = version.versionId || version.id;
        detail.append(row(version.name, `${dateLabel(version.createdAt)} · ${sizeLabel(version.size)}`, [...(/\.(pdf|docx?|pptx?|xlsx?|odt|odp|ods)$/i.test(version.name)?[previewButton({versionId},version.name)]:[]),button('分享', () => shareForm({ versionId, name: version.name })), download(`workbench/versions/${encodeURIComponent(versionId)}/download`, version.name)]));
      }
    } catch (error) { if (generation === detailGeneration) failure(error, () => loadVersions(item)); }
  }
  function renderJobs() {
    const jobs = (snapshot?.jobs || []).filter(job => !selectedWorkspace || job.workspaceId === selectedWorkspace);
    if (!jobs.length) { empty('暂无任务'); return; }
    panel.replaceChildren(...jobs.map(job => {
      const state = job.state || job.status, controls = [button('查看输出', () => { jobOffset = 0; jobOutput = ''; showDetail('任务输出'); selectedJob = job.id; void loadJob(job.id); })];
      if (running(job)) controls.push(button('取消', event => void action(event.currentTarget, async () => { await request(`workbench/jobs/${encodeURIComponent(job.id)}/cancel`, 'POST', {}); await loadSnapshot(); })));
      const line = row(states[state] || '任务', dateLabel(job.createdAt), controls); line.dataset.state = state; return line;
    }));
  }
  async function loadJob(jobId, background = false) {
    const generation = detailGeneration;
    try {
      const result = await request(`workbench/jobs/${encodeURIComponent(jobId)}?offset=${jobOffset}`);
      if (generation !== detailGeneration || selectedJob !== jobId || !dialog.open) return;
      if (result.output) jobOutput += result.output;
      jobOffset = result.nextOffset ?? jobOffset;
      if (jobOutput.length > 1_000_000) jobOutput = jobOutput.slice(-1_000_000);
      const header = detail.firstChild, output = element('pre', 'fw-job-output', jobOutput || result.error || '暂无输出'); output.tabIndex = 0; output.setAttribute('aria-label', '任务输出');
      const summary = element('div', 'fw-meta', `${states[result.state || result.status] || '任务'}${result.exitCode !== undefined ? ` · 退出码 ${result.exitCode}` : ''}`);
      detail.replaceChildren(header, summary, output);
      if (jobOffset < Number(result.outputBytes || 0)) detail.append(button('加载更多', () => void loadJob(jobId), 'fw-more'));
      if (result.snapshotState === 'conflict') detail.append(element('p', 'fw-inline-error', '项目文件已变化，运行结果尚未写回。'));
      if (result.snapshotState === 'failed') detail.append(element('p', 'fw-inline-error', '运行结果写回未完成。'));
      if (['conflict', 'failed'].includes(result.snapshotState) && !running(result)) detail.append(button('恢复为新项目', event => void action(event.currentTarget, async () => {
        const recovery = await request(`workbench/jobs/${encodeURIComponent(jobId)}/recover`, 'POST', {});
        if (recovery.workspace?.id) { selectedWorkspace = recovery.workspace.id; directory = '.'; page = undefined; }
        detail.hidden = true; selectedJob = undefined; toast?.('已恢复为新项目'); await loadSnapshot();
      })));
      if (!background) output.scrollTop = output.scrollHeight;
    } catch (error) { if (generation === detailGeneration) failure(error, () => loadJob(jobId)); }
  }
  function shareForm(input) {
    showDetail(`分享${input.name ? ` · ${input.name}` : ''}`);
    const sourceWorkspace = selectedWorkspace;
    const peers = snapshot?.peers || [];
    if (!peers.length) { detail.append(element('p', 'fw-empty', '暂无可分享的 Agent')); return; }
    const form = element('form', 'fw-share-form'), target = element('select'); target.setAttribute('aria-label', '接收 Agent'); target.required = true;
    target.append(new Option('选择 Agent', ''));
    for (const peer of peers) target.append(new Option(peer.name || peer.label || peer.id || peer.agentId, peer.id || peer.agentId));
    const submit = element('button', 'fw-primary', '分享'); submit.type = 'submit';
    form.append(target, submit); form.onsubmit = event => { event.preventDefault(); void action(submit, async () => {
      await request('workbench/shares', 'POST', { ...(input.versionId ? { versionId: input.versionId } : { workspaceId: sourceWorkspace }), targetAgent: target.value });
      detail.hidden = true; toast?.('已分享'); await loadSnapshot();
    }); }; detail.append(form);
  }
  function workspaceChoice() {
    const select = element('select'); select.setAttribute('aria-label', '复制到项目');
    for (const workspace of snapshot?.workspaces || []) select.append(new Option(workspace.name, workspace.id));
    select.value = selectedWorkspace || snapshot?.defaultWorkspaceId || ''; return select;
  }
  function renderShares() {
    const toolbar = element('div', 'fw-file-tools'); toolbar.append(element('span', 'fw-meta', '共享访问'), button('分享当前项目', () => shareForm({ name: projectTitle.textContent })));
    const currentAgent = snapshot?.currentAgentId || snapshot?.agentId;
    const shares = snapshot?.shares || [];
    panel.replaceChildren(toolbar);
    if (!shares.length) { panel.append(element('p', 'fw-empty', '暂无分享')); return; }
    for (const share of shares) {
      const incoming = share.direction ? share.direction === 'incoming' : share.targetAgentId === currentAgent;
      const controls = [], name = share.name || share.title || (share.kind === 'workspace' ? '共享项目' : '共享文件');
      if (incoming) {
        if (share.kind === 'workspace') controls.push(button('查看文件', () => void showSharedFiles(share)));
        else {
          const destination = workspaceChoice(), copy = button('复制', event => void action(event.currentTarget, async () => { await request(`workbench/shares/${encodeURIComponent(share.id)}/copy`, 'POST', { workspaceId: destination.value }); toast?.('已复制'); await loadSnapshot(); }));
          copy.disabled = !destination.value; controls.push(destination, copy);
        }
      } else controls.push(button('撤销', event => void action(event.currentTarget, async () => { await request(`workbench/shares/${encodeURIComponent(share.id)}`, 'DELETE'); await loadSnapshot(); })));
      panel.append(row(name, `${incoming ? '收到' : `分享给 ${share.targetAgentName || share.targetAgentId}`} · ${dateLabel(share.createdAt)}`, controls));
    }
  }
  async function showSharedFiles(share, path = '.', offset = 0, existing = []) {
    const generation = showDetail(share.name || '共享项目');
    try {
      const result = await request(`workbench/shares/${encodeURIComponent(share.id)}/files?${new URLSearchParams({ path, offset: String(offset) })}`);
      if (generation !== detailGeneration || !dialog.open) return;
      const destination = workspaceChoice(), bar = element('div', 'fw-file-tools');
      bar.append(button('根目录', () => void showSharedFiles(share)), element('span', 'fw-meta', path === '.' ? '' : path), destination); detail.append(bar);
      if (path !== '.') detail.append(button('上级目录', () => void showSharedFiles(share, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')));
      const files = [...existing, ...(result.files || [])];
      for (const file of files) {
        const open = file.type === 'directory' ? button(file.name, () => void showSharedFiles(share, file.path), 'fw-file-name') : file.name;
        const controls = file.type === 'directory' ? [] : [button('复制', event => void action(event.currentTarget, async () => {
          await request(`workbench/shares/${encodeURIComponent(share.id)}/copy`, 'POST', { workspaceId: destination.value, path: file.path }); toast?.('已复制');
        }))];
        controls.forEach(control => { control.disabled = !destination.value; });
        detail.append(row(open, file.type === 'directory' ? '文件夹' : sizeLabel(file.size), controls));
      }
      if (!files.length) detail.append(element('p', 'fw-empty', '暂无文件'));
      if (result.nextOffset !== undefined) detail.append(button('加载更多', () => void showSharedFiles(share, path, result.nextOffset, files), 'fw-more'));
    } catch (error) { if (generation === detailGeneration) failure(error, () => showSharedFiles(share, path, offset, existing)); }
  }
  projectSelect.onchange = () => void chooseWorkspace(projectSelect.value);
  projectForm.onsubmit = event => {
    event.preventDefault(); void action(createProject, async () => {
      const result = await request('workbench/workspaces', 'POST', { name: projectName.value });
      selectedWorkspace = result.workspace?.id || result.id; directory = '.'; page = undefined; projectForm.hidden = true; projectName.value = '';
      await loadSnapshot();
    });
  };
  function stop() { requestGeneration++; fileGeneration++; detailGeneration++; controller?.abort(); clearTimeout(timer); timer = undefined; }
  function close() { if (dialog.open) dialog.close(); else stop(); }
  dialog.addEventListener('close', () => { stop(); returnFocus?.focus?.({ preventScroll: true }); });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } });
  document.addEventListener('visibilitychange', () => { if (dialog.open && !document.hidden) void loadSnapshot(true); });
  return {
    open() {
      if (dialog.open) { closeButton.focus(); return; }
      returnFocus = document.activeElement; controller = new AbortController(); dialog.showModal(); void loadSnapshot();
    },
    close,
    clear() {
      close(); stop(); snapshot = undefined; selectedWorkspace = ''; directory = '.'; page = undefined; selectedJob = undefined;
      jobOutput = ''; jobOffset = 0; snapshotSignature = ''; projectSignature = ''; artifactSignature = ''; artifactPage = undefined; drafts.clear();
      projects.replaceChildren(); panel.replaceChildren(); detail.replaceChildren(); detail.hidden = true; projectForm.hidden = true; projectName.value = ''; status();
    }
  };
}
