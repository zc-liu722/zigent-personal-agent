import { spaces } from "../project-spaces/policy.js";
import { loadRegisteredWorkspaces } from "./registered-workspaces.js";
import { CodePointText } from "../text/code-points.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import type { AgentConfig } from "../config.js";
import { loadAgentConfig } from "../config.js";
import { readManifest } from "../config/manifest.js";
import { WorkspaceService, workspaceMime, type ArtifactVersion, type PublishOptions } from "../workspaces/service.js";
import { ExecutionService, type ExecutionCompletion } from "../execution/service.js";
import type { PreviewRuntime, DocumentResult } from "./document-types.js";
import { DocumentPreviews, isDocumentPreview } from "./previews.js";
import { ExecutionPreviewRuntime } from "./preview-runtime.js";
import { closeSqlite, prepareSql } from "../sqlite.js";
import type { ToolExecutionContext } from "../tools/tool-contracts.js";
import type { VisualObservation } from "../browser/observation.js";
import { FileDeliveries } from "./delivery.js";
import { WorkspaceSelection } from "./workspace-selection.js";
import { ImageScratch } from "./image-scratch.js";
import type { SkillCatalog } from "../skills/catalog.js";

export type StorageStatus = {
  basis: "filesystem"; status: "ok"|"low"|"critical"|"unavailable"; checkedAt: number;
  perAgentQuotaBytes: null; totalBytes?: number; freeBytes?: number; warningBelowBytes?: number; criticalBelowBytes?: number;
};

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Product-owned scope and delivery; execution providers never select another user. */
export class FileWorkbench {
  readonly files: WorkspaceService;
  readonly deliveries: FileDeliveries;
  readonly execution: ExecutionService;
  readonly documents: PreviewRuntime;
  readonly previews: DocumentPreviews;
  readonly workspaceSelection: WorkspaceSelection;
  readonly imageScratch: ImageScratch;
  private readonly db: DatabaseSync;
  private uploadsPending?: Promise<string>;
  private maintenance?: NodeJS.Timeout;
  private maintenanceTask?: Promise<void>;
  private storageSnapshot?: StorageStatus;
  private storagePending?: Promise<StorageStatus>;
  private closed = false;
  private completionDelivery?: (notice: ExecutionCompletion) => Promise<{ status: "delivered"|"skipped"; messageId?: string }>;
  private completionTask?: Promise<void>;
  /** The web channel registers one owner-scoped delivery sink; closing drains it before its store closes. */
  registerCompletionDelivery(deliver: (notice: ExecutionCompletion) => Promise<{ status: "delivered"|"skipped"; messageId?: string }>) {
    if(this.completionDelivery) throw new Error("Execution completion delivery is already registered");
    this.completionDelivery=deliver; this.tick();
    return async()=>{ if(this.completionDelivery===deliver)this.completionDelivery=undefined; await this.completionTask; };
  }
  private deliverCompletions() {
    if(this.completionTask || !this.completionDelivery || this.closed)return;
    const deliver=this.completionDelivery;
    this.completionTask=(async()=>{
      for(const notice of this.execution.pendingCompletions()) {
        if(this.closed || this.completionDelivery!==deliver)break;
        try { const receipt=await deliver(notice); this.execution.acknowledgeCompletion(notice.jobId,receipt.status,receipt.messageId); }
        catch(error){ this.execution.deferCompletion(notice.jobId,error instanceof Error && error.name==="BackgroundDeliveryUncertainError"); }
      }
    })().catch(()=>{}).finally(()=>{this.completionTask=undefined;});
  }
  private constructor(readonly config: AgentConfig, private readonly maintenanceMode = false,
    private readonly verifyTaskRun?: (context: ToolExecutionContext) => boolean) {
    const options = config.fileWorkbench!;
    const scope = createHash("sha256").update(config.id + "\0" + config.web!.ownerUserId).digest("hex");
    const control = resolve(options.stateDirectory, "control", scope);
    mkdirSync(control, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(control, "workbench.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS preferences(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS document_checks(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,source_hash TEXT NOT NULL,created_at INTEGER NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_candidate_saves(session_id TEXT NOT NULL,turn_id INTEGER NOT NULL,version_id TEXT NOT NULL,PRIMARY KEY(session_id,turn_id,version_id));
      CREATE TABLE IF NOT EXISTS document_operations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,created_at INTEGER NOT NULL,result TEXT NOT NULL)`);
    this.files = new WorkspaceService({ agentId: config.id, ownerUserId: config.web!.ownerUserId!, stateDirectory: options.stateDirectory });
    this.imageScratch = new ImageScratch(this.db, this.files, id => {
      if (this.execution.hasWorkspaceActivity(id)) throw new Error("执行或同步尚未完成。");
    });
    this.workspaceSelection = new WorkspaceSelection(this.db, this.files, id => this.assertExecutable(id));
    this.deliveries = new FileDeliveries(this.db, this.files);
    const executionToken = options.executionToken ?? (options.executionTokenFile && existsSync(options.executionTokenFile) ? readFileSync(options.executionTokenFile,"utf8").trim() : undefined);
    if(executionToken && !/^[A-Za-z0-9_-]{43,128}$/.test(executionToken))throw new Error("执行凭据格式无效。");
    this.execution = new ExecutionService({ agentId: config.id, ownerUserId: config.web!.ownerUserId!, stateDirectory: options.stateDirectory,
      workspaces: this.files, nativeStateDirectory: options.nativeStateDirectory, endpoint: options.executionEndpoint, previousEndpoint:options.executionPreviousEndpoint, token: executionToken,recoverState:!maintenanceMode,onSynchronized:workspace=>this.importProgramRenders(workspace) });
    if(process.platform==='win32' && options.nativeStateDirectory) {
      this.files.configureWorkingDirectory(id=>this.execution.ensureSharedWorkspace(id),id=>this.assertIdle(id));
      this.files.configureSharedDirectory(async(id,scope)=>{
        const manifest=await readManifest(process.env.AGENTS_CONFIG_PATH ?? 'config/agents.json');
        for(const profile of manifest.agents.filter(profile=>profile.enabled && profile.channel==='web' && profile.fileWorkbench)) {
          const config=await loadAgentConfig(profile.id);
          if(createHash('sha256').update(JSON.stringify([config.id,config.web?.ownerUserId])).digest('hex')!==scope)continue;
          const source=FileWorkbench.connectForMaintenance(config);
          try { await source.execution.ensureSharedWorkspace(id); } finally { await source.close(); }
          break;
        }
      });
    }
    this.documents = new ExecutionPreviewRuntime(this.execution);
    this.previews = new DocumentPreviews(this.db, this.files, this.documents, join(control,"document-previews"), !maintenanceMode);
    if(!maintenanceMode){this.maintenance = setInterval(() => this.tick(), 5000); this.maintenance.unref(); this.tick();}
  }
  static fromConfig(config: AgentConfig, verifyTaskRun?: (context: ToolExecutionContext) => boolean): FileWorkbench | undefined {
    return config.fileWorkbench && config.fileWorkbench.enabled !== false && config.channel === "web" && config.web?.ownerUserId && config.web.ownerPrincipalId
      ? new FileWorkbench(config, false, verifyTaskRun) : undefined;
  }
  /** Attach for explicitly scoped data maintenance without startup recovery or global sweeps. */
  static connectForMaintenance(config: AgentConfig): FileWorkbench {
    const options=config.fileWorkbench,owner=config.web?.ownerUserId;
    if(!options || options.enabled===false || config.channel!=="web" || !owner || !config.web?.ownerPrincipalId)throw new Error("维护连接需要明确的 Agent 和所有者。");
    const root=resolve(options.stateDirectory),scope=createHash("sha256").update(config.id+"\0"+owner).digest("hex");
    for(const path of [join(root,"workspaces.sqlite"),join(root,"control",scope,"workbench.sqlite"),join(root,"execution",scope,"jobs.sqlite")])
      if(!existsSync(path))throw new Error("维护连接只允许打开已有的文件工作台。");
    return new FileWorkbench(config,true);
  }
  canAccess(context: ToolExecutionContext) {
    return !this.closed && context.agentId === this.config.id && context.userId === this.config.web!.ownerUserId
      && context.conversationKind === "p2p" && Boolean(context.sessionId && context.conversationId)
      && (!(context.taskRunId || context.backgroundTaskKind) || Boolean(context.taskRunId && context.taskLeaseToken && this.verifyTaskRun?.(context)))
      && !context.signal?.aborted;
  }
  assertAccess(context: ToolExecutionContext) { if (!this.canAccess(context)) throw new Error("文件与编程能力只对当前 Agent 的授权用户开放。"); }
  assertWorkingAccess(workspaceId: string, sessionId: string) {
    this.files.assertSessionAccess(workspaceId, sessionId);
    const kind = this.files.workspace(workspaceId).lifetime;
    if (kind === "system") throw new Error("请使用原件或成果的文件编号。");
    if (kind === "legacy" && this.workspaceSelection.historicalDirectory(sessionId) !== workspaceId
      && !this.execution.hasSessionWorkspace(sessionId, workspaceId)) throw new Error("此历史目录未关联到当前会话。");
    this.assertExecutable(workspaceId);
  }
  private existingDirectory(sessionId: string) {
    return this.workspaceSelection.historicalDirectory(sessionId) ?? this.files.existingSessionDirectory(sessionId);
  }
  async resolveWorkingDirectory(context: ToolExecutionContext, options: {
    environmentId?: string; path?: string; allocate?: boolean; write?: boolean
  } = {}) {
    this.assertAccess(context);
    let target = options.environmentId;
    // An absolute Windows path from a previous tool result retains its owner
    // even after the conversation changes its default project.
    if (!target && options.path && win32.isAbsolute(options.path) && /^[a-z]:/i.test(options.path)) {
      const projects = await this.registeredWorkspaces();
      const runtime = await this.execution.describe();
      const candidates = projects.map(project => ({ id: project.workspaceId, root: project.cwd }));
      const root = runtime.available ? runtime.capabilities?.workspaceRoot : undefined;
      if (root) {
        const first = win32.relative(root, options.path).split("\\")[0];
        if (first && /^[a-f0-9-]{36}$/.test(first)) candidates.push({ id: first, root: win32.join(root, first) });
      }
      target = candidates.filter(candidate => {
        const relative = win32.relative(candidate.root, options.path!);
        return relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
      }).sort((a, b) => b.root.length - a.root.length)[0]?.id;
      if (!target) throw new Error("该路径没有匹配的文件归属。请提供原环境编号。");
    }
    if (!target && options.write) this.workspaceSelection.assertUnambiguous(context.sessionId, context.turnId);
    target ??= this.workspaceSelection.currentProject(context.sessionId);
    if (target) {
      let registered = false;
      try { registered = Boolean(this.files.registeredDirectory(target)); }
      catch (error) {
        if (process.platform !== "win32" || !this.config.fileWorkbench?.nativeStateDirectory) throw error;
        await this.registeredWorkspaces();
        registered = Boolean(this.files.registeredDirectory(target));
      }
      const directory = registered ? this.files.registeredDirectory(target) : undefined;
      if (directory && !(await spaces(this.config.id)).some(space => space.workspaceId === target && space.windows
        && win32.normalize(space.windows).toLowerCase() === win32.normalize(directory).toLowerCase()))
        throw new Error("登记项目的目录授权已变化。");
    }
    target ??= this.existingDirectory(context.sessionId);
    if (!target && options.allocate) target = this.files.sessionDirectory(context.sessionId);
    if (!target) throw new Error("当前会话没有工作文件。请提供文件编号或所属项目。");
    this.assertWorkingAccess(target, context.sessionId);
    return target;
  }
  async uploadWorkspace(): Promise<string> {
    const saved = prepareSql(this.db, "SELECT value FROM preferences WHERE key='uploads'").get() as {value:string}|undefined;
    if(saved){this.files.markSystem(saved.value);return saved.value;}
    return this.uploadsPending ??= (async()=>{
      const workspace=await this.files.createWorkspace({name:"上传原件",lifetime:"system"});
      prepareSql(this.db,"INSERT OR IGNORE INTO preferences VALUES ('uploads',?)").run(workspace.id);
      return (prepareSql(this.db,"SELECT value FROM preferences WHERE key='uploads'").get() as {value:string}).value;
    })();
  }
  originals(offset = 0, limit = 20): ArtifactVersion[] {
    const saved=prepareSql(this.db,"SELECT value FROM preferences WHERE key='uploads'").get() as {value:string}|undefined;
    return saved ? this.files.listArtifacts(saved.value,"original",offset,limit) : [];
  }
  async retainUpload(input: {id:string;name:string;mime:string;bytes:Buffer;sha256:string}) {
    return this.files.retainInput(await this.uploadWorkspace(),input);
  }
  async retainedUpload(id:string,sha256:string) {
    const saved = prepareSql(this.db, "SELECT value FROM preferences WHERE key='uploads'").get() as { value: string } | undefined;
    return saved && this.files.retainedInput(saved.value, id, sha256);
  }
  assertExecutable(id:string){
    const uploads=prepareSql(this.db,"SELECT value FROM preferences WHERE key='uploads'").get() as {value:string}|undefined;
    if(uploads?.value===id)throw new Error("请用附件编号读取原件，或导入后运行程序。");
  }
  selectWorkspace(sessionId: string, id: string) {
    return this.workspaceSelection.select(sessionId, id, { source: "user" });
  }
  assertIdle(id: string) {
    this.files.workspace(id);
    if (this.execution.list(id).some(job => !terminal.has(job.state) || !this.files.executionDirectory(id) && !["saved","superseded"].includes(job.snapshotState)))
      throw new Error("项目仍在运行或等待结果同步，请先读取执行结果后再修改文件。");
  }
  async assertEditable(id: string) { await this.execution.ensureSharedWorkspace(id); this.assertIdle(id); }
  async importUpload(input: { id: string; name: string; mime: string; bytes: Buffer; sha256: string }, workspaceId: string) {
    await this.assertEditable(workspaceId);
    return this.files.materializeInput(workspaceId, input);
  }
  async importLibrary(context: ToolExecutionContext, uploadId: string, workspaceId?: string) {
    this.assertAccess(context);
    if (!context.documentLibrary) throw new Error("当前对话未提供附件读取能力。");
    const input = await context.documentLibrary.read(uploadId);
    const target = await this.resolveWorkingDirectory(context, { environmentId: workspaceId, write: true, allocate: true });
    return { ...await this.importUpload(input, target), environment_id: target };
  }
  /** Shared filesystem headroom, never an invented per-Agent allocation. */
  async storage(): Promise<StorageStatus> {
    if(this.storageSnapshot && Date.now()-this.storageSnapshot.checkedAt<60_000)return this.storageSnapshot;
    return this.storagePending ??= (async()=>{
      let snapshot:StorageStatus={basis:"filesystem",status:"unavailable",checkedAt:Date.now(),perAgentQuotaBytes:null};
      try {
        const info=await statfs(this.config.fileWorkbench!.stateDirectory);
        const totalBytes=info.blocks*info.bsize, freeBytes=info.bavail*info.bsize;
        if(!Number.isSafeInteger(totalBytes)||totalBytes<=0||!Number.isSafeInteger(freeBytes)||freeBytes<0||freeBytes>totalBytes)
          throw new Error("Invalid filesystem capacity");
        const warningBelowBytes=Math.max(Math.ceil(totalBytes*0.05),10*1024**3);
        const criticalBelowBytes=Math.max(Math.ceil(totalBytes*0.01),2*1024**3);
        snapshot={...snapshot,checkedAt:Date.now(),totalBytes,freeBytes,warningBelowBytes,criticalBelowBytes,
          status:freeBytes<criticalBelowBytes?"critical":freeBytes<warningBelowBytes?"low":"ok"};
      } catch { /* Unavailable measurements never fabricate free space or trigger deletion. */ }
      this.storageSnapshot=snapshot;return snapshot;
    })().finally(()=>{this.storagePending=undefined;});
  }
  async registeredWorkspaces() {
    if (process.platform !== 'win32' || !this.config.fileWorkbench?.nativeStateDirectory) return [];
    return loadRegisteredWorkspaces(this.config.id, () => spaces(this.config.id), (workspaceId, name, directory) => this.files.registerDirectory(workspaceId, name, directory));
  }
  /** Explicit resource use pins the package for script and template consumers. */
  async skillResources(context: ToolExecutionContext, catalog: SkillCatalog, name: string, body: string, environmentId?: string) {
    const skill = catalog.entries.find(skill => skill.name === name);
    if (!skill || name === "health" || Object.keys(skill.files).every(path => path === "SKILL.md"))
      throw new Error("此技能没有可导出的资源。");
    const workspace = await this.resolveWorkingDirectory(context, { environmentId, write: true, allocate: true });
    const identity = createHash("sha256").update(catalog.version).update("\0").update(body).digest("hex");
    const directory = `.skill-resources/${identity}/${name}`;
    let editable = false;
    for (const [path, encoded] of Object.entries(skill.files)) {
      const bytes = path === "SKILL.md" ? Buffer.from(body) : Buffer.from(encoded, "base64");
      const target = `${directory}/${path}`, hash = createHash("sha256").update(bytes).digest("hex");
      const verify = async () => {
        if ((await this.files.readFileBytes(workspace, target, undefined, false)).sha256 !== hash) throw new Error("SKILL_RESOURCE_CONTENT_CHANGED");
      };
      try { await verify(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!editable) { await this.assertEditable(workspace); editable = true; }
        try { await this.files.writeFile(workspace, target, bytes); }
        catch { await verify(); }
      }
    }
    return { resourceDirectory: directory, environment_id: workspace };
  }
  async contextFor(sessionId: string) {
    const active = this.workspaceSelection.currentProject(sessionId);
    const environment = active ?? this.existingDirectory(sessionId);
    const [storage, execution, registeredProjects] = await Promise.all([
      this.storage(),
      Promise.race([this.execution.describe(), new Promise<undefined>(resolve => { const timer = setTimeout(() => resolve(undefined), 750); timer.unref(); })]),
      process.platform === "win32" && this.config.fileWorkbench?.nativeStateDirectory
        ? spaces(this.config.id).then(items => items.flatMap(item => item.workspaceId && item.windows
          ? [{ project: item.id, workspaceId: item.workspaceId, name: item.name, cwd: item.windows }] : [])).catch(() => [])
        : []
    ]);
    const capabilities = execution?.available ? execution.capabilities : undefined;
    const windows = execution?.available && execution.backend === "windows-native";
    const cwd = environment && execution?.available ? windows && capabilities?.workspaceRoot
      ? capabilities.registeredWorkspaces?.[environment] ?? win32.join(capabilities.workspaceRoot, environment)
      : windows ? "." : "/workspace" : undefined;
    return "File and execution context (reference data): " + JSON.stringify({
      activeProjectId: active, currentProject: active ? this.files.workspace(active) : undefined,
      environment_id: environment, cwd, registeredProjects, projects: this.workspaceSelection.list(), execution,
      commandSessions: this.execution.terminalSessions(sessionId),
      storage: storage.status === "low" || storage.status === "critical" ? storage : { status: storage.status },
      recentDeliveries: (prepareSql(this.db, "SELECT record FROM file_deliveries ORDER BY rowid DESC LIMIT 12").all() as Array<{ record: string }>)
        .map(row => JSON.parse(row.record)).filter(row => row.sessionId === sessionId)
    }) + "\nCommands and file-producing tools supply a working directory when needed. A directory allocated for the conversation is temporary and is removed 24 hours after creation; create or promote a project to keep work. Use files for direct attachment and working-file access. An explicit file environment identifies its owner independently of the selected project. Windows execution has network and localhost access. Coordinate concurrent writes, preserve originals, and use artifact_files to save and deliver immutable versions.";
  }
  async describe() {
    const [execution, documents, storage] = await Promise.all([this.execution.describe(), this.documents.describe(),this.storage()]);
    return { execution, storage, documents: { ...documents, python: documents.available?documents.python:undefined, tools: Object.fromEntries(Object.entries(documents.tools).map(([key,value]) => [key, ["officeKit","offlineOcr","libreofficeVersion","backend"].includes(key)?value:Boolean(value)])) },
      retention: { originals: "permanent", deliveredVersions: "permanent", projects: "permanent", temporaryWorkspaces: "24h from creation; original session only", derived: "rebuildable or delivered" } };
  }
  async workingFile(workspaceId:string,path:string) {
    path=path.replace(/^\/workspace\//,'');
    const bytes=await this.execution.readRemoteFile(workspaceId,path),name=path.split('/').at(-1)!;
    const mime=workspaceMime(path);
    return {bytes,path,name,mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  async workingText(workspaceId:string,path:string,offset=0,limit=64000) {
    const file=await this.workingFile(workspaceId,path);if(file.size>4*1024*1024)throw new Error('文字文件过大，请通过命令分段读取。');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(file.bytes);if(text.includes('\0'))throw new Error('请选择文字文件。');
    const characters=new CodePointText(text),{bytes,...metadata}=file;
    return {...metadata,workspaceId,text:characters.slice(offset,offset+limit),offset,...(offset+limit<characters.length?{nextOffset:offset+limit}:{})};
  }
  async snapshotWorkingFile(workspaceId:string,path:string) {
    const file=await this.workingFile(workspaceId,path),version=await this.files.snapshotVersion(workspaceId,path,file.bytes);
    await this.captureWorkingRender(version,path);return version;
  }
  async saveWorkingFile(workspaceId:string,path:string,options:PublishOptions) {
    path=path.replace(/^\/workspace\//,'');
    const file=await this.workingFile(workspaceId,path),version=await this.files.publish(workspaceId,path,options,file.bytes);
    await this.captureWorkingRender(version,path);return version;
  }
  private async captureWorkingRender(version:ArtifactVersion,path:string) {
    try {
      const index=await this.execution.readRemoteFile(version.workspaceId,'.document-render-index.json');if(index.length>1000000)return;
      const reports=JSON.parse(index.toString('utf8'));if(!Array.isArray(reports))return;
      const report=reports.slice().reverse().find(item=>(item.sourceRelative??String(item.sourcePath).replace(/^\/workspace\//,''))===path && item.sourceSha256===version.sha256);
      const runtime=await this.execution.describe(true);
      const runtimeIdentity='runtimeIdentity' in runtime?runtime.runtimeIdentity:undefined;
      if(report && isDocumentPreview(path) && !/\.pdf$/i.test(path)) {
        const pdf=await this.execution.readRemoteFile(version.workspaceId,String(report.pdfRelative??String(report.pdfPath).replace(/^\/workspace\//,'')));
        if(createHash('sha256').update(pdf).digest('hex')===report.pdfSha256)await this.previews.acceptRendered(version.versionId,pdf,report.totalPages,report.runtimeIdentity,report.rendererSha256);
      }
      const file=await this.execution.readRemoteFile(version.workspaceId,'.document-checks.json');if(file.length>200000)return;
      const checks=JSON.parse(file.toString('utf8'));if(!Array.isArray(checks))return;
      for(const check of checks.slice(-200)) {
        if(!runtimeIdentity || check.runtimeIdentity!==runtimeIdentity || check.path!==path || check.expectedHash!==version.sha256 || !['content','structure','visual'].includes(check.kind) || !['passed','issues'].includes(check.assessment) || typeof check.note!=='string' || check.note.length>500 || !Array.isArray(check.pages??[]))continue;
        if(check.kind==='visual'){
          const observed=(prepareSql(this.db,'SELECT record FROM document_checks WHERE workspace_id=? AND source_hash=?').all(version.workspaceId,version.sha256) as Array<{record:string}>).map(row=>JSON.parse(row.record));
          if(!check.pages?.length || check.pages.some((page:number)=>!observed.some(record=>record.kind==='visual_observation' && record.page===page && record.runtimeIdentity===runtimeIdentity)))continue;
        }
        const key=createHash('sha256').update(version.workspaceId+JSON.stringify(check)).digest('hex');
        this.recordDocumentCheck(version.workspaceId,version.sha256,{kind:check.kind,assessment:check.assessment,note:check.note,pages:check.pages,runtimeIdentity,evidence:'agent_assessment'},key);
      }
    } catch { /* Saving bytes remains possible without optional render/review sidecars. */ }
  }
  private async importProgramRenders(workspaceId:string) {
    let reports:unknown;
    try {const file=await this.files.readFileBytes(workspaceId,'.document-render-index.json');if(file.size>1_000_000)return;reports=JSON.parse(file.bytes.toString('utf8'));}catch{return;}
    if(!Array.isArray(reports))return;
    const health=await this.execution.describe();if(!health.available || !('capabilities' in health))return;
    for(const report of reports.slice(-80)) {
      try {
        if(!report || report.runtimeIdentity!==health.runtimeIdentity || !/^[a-f0-9-]{36}$/.test(report.operationId))continue;
        const sourcePath=String(report.sourceRelative??String(report.sourcePath).replace(/^\/workspace\//,'')),source=await this.files.readFileBytes(workspaceId,sourcePath);
        const helper=/\.pdf$/i.test(sourcePath)?health.capabilities?.helpers?.render_pdf:health.capabilities?.helpers?.render_docx;
        if(source.sha256!==report.sourceSha256 || helper?.sha256!==report.rendererSha256 || !Array.isArray(report.images))continue;
        const files=[];
        for(const image of report.images.slice(0,10000)) {
          const path=String(image.relativePath??String(image.path).replace(/^\/workspace\//,'')),file=await this.files.readFileBytes(workspaceId,path);
          if(file.sha256!==image.sha256 || !Number.isInteger(image.page) || image.page<1)throw new Error('页图校验失败。');
          files.push({path,name:file.name,mime:file.mime,size:file.size,sha256:file.sha256,page:image.page});
        }
        const operation={operation:'render',operationId:report.operationId,inputSha256:source.sha256,processedPages:files.map(file=>file.page),totalPages:report.totalPages,files,warnings:[],checks:{rendering:{status:'rendered'},runtimeIdentity:report.runtimeIdentity,rendererSha256:report.rendererSha256}};
        prepareSql(this.db,'INSERT OR IGNORE INTO document_operations VALUES (?,?,?,?)').run(report.operationId,workspaceId,Date.now(),JSON.stringify(operation));
        if(isDocumentPreview(sourcePath) && !/\.pdf$/i.test(sourcePath)) {
          const pdf=await this.files.readFileBytes(workspaceId,String(report.pdfRelative??String(report.pdfPath).replace(/^\/workspace\//,'')));
          if(pdf.sha256!==report.pdfSha256)continue;
          const version=await this.files.snapshotVersion(workspaceId,sourcePath);
          await this.previews.acceptRendered(version.versionId,pdf.bytes,report.totalPages,report.runtimeIdentity,report.rendererSha256);
        }
      } catch { /* A changed source or render never supplies evidence for the new bytes. */ }
    }
    try {
      const file=await this.files.readFileBytes(workspaceId,'.document-checks.json');if(file.size>200000)return;
      const checks=JSON.parse(file.bytes.toString('utf8'));if(!Array.isArray(checks))return;
      for(const check of checks.slice(-200)) {
        if(check.runtimeIdentity!==health.runtimeIdentity || !['content','structure','visual'].includes(check.kind) || !['passed','issues'].includes(check.assessment) || typeof check.note!=='string' || check.note.length>500 || !Array.isArray(check.pages??[]))continue;
        const key=createHash('sha256').update(JSON.stringify(check)).digest('hex');
        if(prepareSql(this.db,"SELECT id FROM document_checks WHERE id=?").get(key))continue;
        await this.documentChecks(workspaceId,check.path,{expectedHash:check.expectedHash,kind:check.kind,assessment:check.assessment,note:check.note,pages:check.pages,receiptId:key});
      }
    } catch { /* Invalid/stale agent assessments never become a pass. */ }
  }
  async viewImage(workspaceId: string, path: string, fromExecution = false, original = false): Promise<VisualObservation> {
    const local = fromExecution ? undefined : await this.files.readFileBytes(workspaceId,path);
    const bytes=local?.bytes ?? await this.execution.readRemoteFile(workspaceId,path);
    const extension=path.split('.').at(-1)?.toLowerCase();
    const input=local ?? {bytes,mime:({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif'} as Record<string,string>)[extension??'']??'',sha256:createHash('sha256').update(bytes).digest('hex')};
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.mime)) throw new Error("请选择渲染后的 PNG/JPEG/WebP 图片。");
    const image=sharp(input.bytes,{limitInputPixels:40_000_000,pages:1}).rotate();
    if(!original)image.resize({width:2400,height:2400,fit:"inside",withoutEnlargement:true});
    const data=await image.png().toBuffer();
    const id = "workspace:" + workspaceId + ":" + input.sha256;
    if(fromExecution) {
      try {
        const index=JSON.parse((await this.execution.readRemoteFile(workspaceId,'.document-render-index.json')).toString('utf8'));
        const report=Array.isArray(index)?index.slice().reverse().find((item:Record<string,unknown>)=>Array.isArray(item.images) && item.images.some((image:{path:string;sha256:string;relativePath?:string})=>(image.relativePath??String(image.path).replace(/^\/workspace\//,''))===path && image.sha256===input.sha256)):undefined;
        if(report) {
          const source=await this.execution.readRemoteFile(workspaceId,String(report.sourceRelative??String(report.sourcePath).replace(/^\/workspace\//,'')));
          const page=report.images.find((image:{path:string;relativePath?:string})=>(image.relativePath??String(image.path).replace(/^\/workspace\//,''))===path).page;
          if(createHash('sha256').update(source).digest('hex')===report.sourceSha256)this.recordDocumentCheck(workspaceId,report.sourceSha256,{kind:'visual_observation',operationId:report.operationId,page,imageSha256:input.sha256,runtimeIdentity:report.runtimeIdentity,assessment:'not_recorded'});
        }
      }catch { /* Images remain viewable without document provenance. */ }
    }
    const provenance = (prepareSql(this.db,"SELECT result FROM document_operations WHERE workspace_id=? ORDER BY created_at DESC").all(workspaceId) as Array<{result:string}>)
      .map(row=>JSON.parse(row.result) as DocumentResult)
      .find(operation=>operation.operation==="render" && operation.files.some(file=>file.path===path && file.sha256===input.sha256 && file.page));
    const page = provenance?.files.find(file=>file.path===path && file.sha256===input.sha256)?.page;
    if (provenance && page) this.recordDocumentCheck(workspaceId,provenance.inputSha256,{kind:"visual_observation",operationId:provenance.operationId,page,imageSha256:input.sha256,runtimeIdentity:provenance.checks.runtimeIdentity,assessment:"not_recorded"});
    return { kind: "visual_observation", id, metadata: { workspaceId, path, sha256: input.sha256,
      ...(provenance?{sourceSha256:provenance.inputSha256,operationId:provenance.operationId,page}:{}),
      evidence:"Image provided for visual review; this is not a layout pass." }, images: [{ observationId: id, mimeType: "image/png", data }] };
  }
  private recordDocumentCheck(workspaceId:string,hash:string,record:Record<string,unknown>,receiptId:string=randomUUID()) {
    prepareSql(this.db,"INSERT OR IGNORE INTO document_checks VALUES (?,?,?,?,?)").run(receiptId,workspaceId,hash,Date.now(),JSON.stringify(record));
  }
  async documentChecks(workspaceId:string,path:string,check?:{expectedHash:string;kind:"content"|"structure"|"visual";assessment:"passed"|"issues";note:string;pages?:number[];receiptId?:string}) {
    const source=await this.files.readFileBytes(workspaceId,path);
    if(check){
      const runtime=await this.execution.describe(true);
      const runtimeIdentity='runtimeIdentity' in runtime?runtime.runtimeIdentity:undefined;
      if(check.expectedHash!==source.sha256)throw new Error("文件已修改，请检查最新版本。");
      if(check.kind==="visual"){
        const observed=(prepareSql(this.db,"SELECT record FROM document_checks WHERE workspace_id=? AND source_hash=?").all(workspaceId,source.sha256) as Array<{record:string}>).map(row=>JSON.parse(row.record) as Record<string,unknown>);
        if(!check.pages?.length || check.pages.some(page=>!observed.some(record=>record.kind==="visual_observation" && record.page===page && runtimeIdentity && record.runtimeIdentity===runtimeIdentity)))
          throw new Error("视觉检查需要明确页码，并先查看当前文件对应的页图。");
      }
      this.recordDocumentCheck(workspaceId,source.sha256,{kind:check.kind,assessment:check.assessment,note:check.note,pages:check.pages,runtimeIdentity,evidence:"agent_assessment"},check.receiptId);
    }
    return this.documentEvidence(workspaceId,source.sha256);
  }
  versionChecks(version:ArtifactVersion) { return this.documentEvidence(version.workspaceId,version.sha256); }
  noteCandidate(context:ToolExecutionContext,version:ArtifactVersion) {
    prepareSql(this.db,"INSERT OR IGNORE INTO file_candidate_saves VALUES (?,?,?)").run(context.sessionId,context.turnId,version.versionId);
  }
  candidatesForTurn(sessionId:string,turnId:number) {
    return (prepareSql(this.db,"SELECT version_id FROM file_candidate_saves WHERE session_id=? AND turn_id=? ORDER BY rowid").all(sessionId,turnId) as Array<{version_id:string}>)
      .map(row=>this.files.artifactVersion(row.version_id));
  }
  deferDelivery(sessionId:string,turnId:number,reason:"workspace_only"|"inspection_only") {
    prepareSql(this.db,"INSERT OR REPLACE INTO preferences VALUES (?,?)").run(`delivery-intent:${sessionId}:${turnId}`,reason);
    return {status:"saved_pending_delivery",deliveryDeferred:true,reason};
  }
  deliveryDeferred(sessionId:string,turnId:number) {
    return Boolean(prepareSql(this.db,"SELECT value FROM preferences WHERE key=?").get(`delivery-intent:${sessionId}:${turnId}`));
  }
  deliveryGuidance(sessionId:string,turnId:number):string|undefined {
    if(this.deliveryDeferred(sessionId,turnId))return;
    const delivery=this.deliveries.forTurn(sessionId,turnId).at(-1);
    if(delivery?.status==="delivered")return;
    if(delivery && delivery.status!=="superseded")return `Runtime delivery check: final files are saved but not delivered. Retry artifact_files retry_delivery with deliveryId=${delivery.id}; never regenerate/save versions for a delivery retry. Check the receipt before the final answer.`;
    const candidates=this.candidatesForTurn(sessionId,turnId);
    if(candidates.length)return "Runtime delivery check: candidate versions are saved, but no final manifest was delivered. Select the final versions matching the CURRENT user request's formats and count, then call artifact_files deliver with complete items and requestKey. Do not deliver all candidates by default. If the user explicitly only requested workspace saving or inspection, call keep_candidates with that reason instead. Saved candidates: "
      + JSON.stringify(candidates.map(({versionId,fileId,name})=>({versionId,fileId,name})));
  }
  private async documentEvidence(workspaceId:string,sourceHash:string) {
    const runtime=await this.execution.describe(true);const runtimeIdentity='runtimeIdentity' in runtime?runtime.runtimeIdentity:undefined;
    const operations=(prepareSql(this.db,"SELECT result FROM document_operations WHERE workspace_id=? ORDER BY created_at").all(workspaceId) as Array<{result:string}>)
      .map(row=>JSON.parse(row.result) as DocumentResult).filter(record=>record.inputSha256===sourceHash || (record.checks.subject as {kind?:string;sha256?:string[]})?.kind==="outputs" && (record.checks.subject as {sha256:string[]}).sha256.includes(sourceHash));
    const checks:Array<Record<string,unknown> & {at:number}>=(prepareSql(this.db,"SELECT created_at,record FROM document_checks WHERE workspace_id=? AND source_hash=? ORDER BY created_at").all(workspaceId,sourceHash) as Array<{created_at:number;record:string}>)
      .map(row=>({at:row.created_at,...JSON.parse(row.record) as Record<string,unknown>}));
    return {sourceSha256:sourceHash,runtimeIdentity,historicalChecks:checks.filter(record=>!runtimeIdentity || record.runtimeIdentity!==runtimeIdentity),historicalOperations:operations.filter(record=>!runtimeIdentity || record.checks.runtimeIdentity!==runtimeIdentity),operations:operations.filter(record=>runtimeIdentity && record.checks.runtimeIdentity===runtimeIdentity).map(record=>({operationId:record.operationId,operation:record.operation,processedPages:record.processedPages,totalPages:record.totalPages,checks:record.checks,warnings:record.warnings})),checks:checks.filter(record=>runtimeIdentity && record.runtimeIdentity===runtimeIdentity),
      viewedPages:[...new Set(checks.filter(record=>runtimeIdentity && record.runtimeIdentity===runtimeIdentity && record.kind==="visual_observation").map(record=>record.page))]};
  }
  async deliver(items: import("../workspaces/types.js").FileDeliveryItem[], requestKey: string, context: ToolExecutionContext) {
    this.assertAccess(context);
    if (context.subagent || !context.replyId) throw new Error("当前渠道没有文件交付位置，请保留版本并在网页对话中交付。");
    prepareSql(this.db,"DELETE FROM preferences WHERE key=?").run(`delivery-intent:${context.sessionId}:${context.turnId}`);
    const receipt=await this.deliveries.deliver({items,requestKey,replyId:context.replyId,sessionId:context.sessionId,turnId:context.turnId});
    return {...receipt,evidence:await Promise.all(items.map(async item=>({versionId:item.versionId,...await this.versionChecks(this.files.artifactVersion(item.versionId))})))};
  }
  async peers() {
    const manifest = await readManifest(process.env.AGENTS_CONFIG_PATH ?? "config/agents.json");
    const peers: Array<{ id: string; name: string }> = [];
    for (const profile of manifest.agents.filter(item => item.enabled && item.id !== this.config.id && item.fileWorkbench && item.fileWorkbench.enabled !== false && item.channel === "web")) {
      // Resolve identity using the same server-side materialization as Agent startup.
      const config = await loadAgentConfig(profile.id);
      if (config.web?.ownerUserId && config.web.ownerPrincipalId === this.config.web!.ownerPrincipalId && resolve(config.fileWorkbench!.stateDirectory) === resolve(this.config.fileWorkbench!.stateDirectory))
        peers.push({ id: profile.id, name: profile.name });
    }
    return peers;
  }
  async share(versionId: string, targetAgent: string, operationId: string, workspace = false) {
    if (!(await this.peers()).some(peer => peer.id === targetAgent)) throw new Error("目标 Agent 不在你的可共享范围内。");
    const target = await loadAgentConfig(targetAgent);
    const recipient = { agentId: target.id, ownerUserId: target.web!.ownerUserId! }, authorization = { actorUserId: this.config.web!.ownerUserId!, operationId };
    if(workspace)await this.files.workspaceDirectory(versionId);
    return workspace ? this.files.shareWorkspace(versionId, recipient, authorization) : this.files.shareVersion(versionId, recipient, authorization);
  }
  private tick() {
    if (this.closed || this.maintenanceMode || this.maintenanceTask) return;
    this.maintenanceTask = (async () => {
      await this.execution.retryCancellations();
      for (const job of this.execution.reconciliationCandidates(4)) {
        if (this.closed) break;
        await this.execution.reconcile(job.id).catch(() => {});
        this.deliverCompletions();
      }
      this.deliverCompletions();
      await this.files.cleanupDerived().catch(() => {});
      await this.files.cleanupTemporary(id => this.execution.releaseTemporaryWorkspace(id)).catch(() => {});
      await this.imageScratch.cleanup().catch(() => {});
      await this.previews.cleanup().catch(()=>{});
    })().finally(() => { this.maintenanceTask = undefined; });
  }
  async close() {
    this.closed = true; clearInterval(this.maintenance); this.execution.drain(); this.documents.close();
    await this.previews.close(); await this.maintenanceTask; await this.completionTask; this.execution.close(); this.files.close(); closeSqlite(this.db);
  }
}
