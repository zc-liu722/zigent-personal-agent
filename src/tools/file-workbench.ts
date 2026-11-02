import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FileWorkbench } from "../file-workbench/service.js";
import { createCommandTools } from "./command-tools.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";

const id = z.string().uuid();
const path = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceSchema = z.object({ action: z.enum(["list", "uploads", "select", "create", "open", "import_upload", "shares", "copy_share"]), workspaceId: id.optional(), name: z.string().trim().min(1).max(160).optional(), purpose: z.string().trim().min(1).max(500).optional(), reason: z.string().trim().min(1).max(500).optional(), confidence: z.enum(["clear", "uncertain"]).optional(), uploadId: id.optional(), grantId: id.optional(), path: path.optional(), all: z.boolean().optional(), offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const deliveryItem = z.object({resultId:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),versionId:id,format:z.string().regex(/^[a-z0-9]{1,16}$/)}).strict();
const artifactSchema = z.object({ reason:z.enum(["workspace_only","inspection_only"]).optional(), items:z.array(deliveryItem).min(1).max(100).optional(), requestKey:z.string().min(1).max(120).optional(), deliveryId:id.optional(), resultId:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(), action: z.enum(["list", "versions", "save", "publish", "deliver", "retry_delivery", "delivery_status", "keep_candidates", "restore", "share"]), kind: z.enum(["artifact", "original", "all"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(), workspaceId: id.optional(), path: path.optional(), fileId: id.optional(), versionId: id.optional(), expectedVersion: id.optional(), expectedHash: hash.optional(), title: z.string().min(1).max(120).optional(), targetAgent: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional() }).strict();

const string = { type: "string" }, uuid = { type: "string", format: "uuid" };
const common = { workspaceId: uuid, path: { type: "string", maxLength: 1024 }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 64000 } };
const presentation = (title: string, object: string): ToolActivityPresenter => ({
  started: () => ({ title, message: `我正在处理${object}。` }),
  completed: () => ({ title, message: `这一步${object}操作已完成。` }),
  failed: () => ({ title, message: `这次${object}操作未完成。` })
});
function required<T>(value: T | undefined, label: string): T { if (value === undefined) throw new Error(`请提供${label}。`); return value; }
type Parsed = { action: string };
function tool<T extends Parsed>(service: FileWorkbench | undefined, name: string, description: string, schema: z.ZodType<T>, properties: Record<string, unknown>, activity: ToolActivityPresenter,
  execute: (input: T, context: ToolExecutionContext, service: FileWorkbench) => Promise<unknown>): AgentToolRegistration {
  const action = properties.action;
  return { available: Boolean(service), executionMode: "sequential", definition: { type: "function", name, description,
    input_schema: { type: "object", additionalProperties: false, properties: { ...properties, action }, required: ["action"] } }, activity,
    async execute(input, context) { if (!service) throw new Error("文件工作区尚未配置。"); service.assertAccess(context); return execute(schema.parse(input), context, service); } };
}
const actions = (...values: string[]) => ({ type: "string", enum: values });
export function createFileWorkbenchTools(service?: FileWorkbench): AgentToolRegistration[] {
  return [
    tool(service, "workspaces", "Resolve the project BEFORE document creation/editing, attachment processing, coding or any workspace execution. list returns existing project purposes, recent files and the session selection. Use user context, history and memory to choose; recency alone is insufficient. select requires purpose, reason, confidence and exactly one of workspaceId (reuse) or name (new). confidence=clear autonomously selects/creates when the target is explicit, a clear continuation or a clearly independent task. confidence=uncertain displays recommendations in the trusted conversation operation area and waits for a real user choice. Do not ask for clear routine choices, default silently to the files directory, or create one project per file. Keep the selection for continuations; reselect when the task or target changes. No files, commands or project creation run before an uncertain selection is answered. Cancellation/expiry/free text leave placement unresolved; interpret free text before a concrete new selection. create/open are compatibility forms and ask unless clear confidence is supplied. uploads lists attachment metadata (all=true includes earlier conversations); import by upload ID. Shares are read-only and may be copied into the selected project. Never supply host paths.", workspaceSchema,
      { action: actions("list", "uploads", "select", "create", "open", "import_upload", "shares", "copy_share"), workspaceId: uuid, name: string, purpose:{...string,maxLength:500},reason:{...string,maxLength:500},confidence:actions("clear","uncertain"),uploadId: uuid, grantId: uuid, path: string, all: {type:"boolean"}, offset: {type:"integer",minimum:0,maximum:1000000}, limit: {type:"integer",minimum:1,maximum:100} }, {
        started:()=>({title:"选择项目区",message:"我正在确定这项任务的项目区。"}),
        completed:(input,result)=>{const action=(input as {action?:string}).action,value=result as {status?:string;workspace?:{name?:string}};
          return {title:"选择项目区",message:value.status==="selected"?`我已选择项目区“${value.workspace?.name ?? ""}”。`:value.status==="needs_clarification"?"我已收到补充，项目区还需明确。":value.status==="cancelled"||value.status==="expired"?"项目区尚未选定，文件工作未开始。":action==="list"?"我已查看已有项目区。":"项目区信息已更新。"};},
        failed:()=>({title:"选择项目区",message:"这次项目区操作未完成。"})
      }, async (input, context, api) => {
        if (input.action === "list") {const selection=api.workspaceSelection.state(context.sessionId);return { selection:selection ?? {status:"unselected"}, activeWorkspaceId:selection?.status==="selected"?selection.workspaceId:undefined, workspaces: api.workspaceSelection.list() };}
        if (input.action === "uploads") {
          if (!context.documentLibrary) throw new Error("当前对话未提供附件读取能力。");
          const offset=input.offset ?? 0, limit=input.limit ?? 30;
          const page=context.documentLibrary.list(input.all ?? false,offset,limit+1);
          return {uploads:page.slice(0,limit),offset,...(page.length>limit?{nextOffset:offset+limit}:{})};
        }
        if (["select","create","open"].includes(input.action)) {
          if(input.action==="select" && (!input.purpose || !input.reason || !input.confidence))throw new Error("选择项目区需要 purpose、reason 和 confidence。");
          return api.workspaceSelection.resolve({workspaceId:input.action==="create"?undefined:input.workspaceId,name:input.action==="open"?undefined:input.name,
            purpose:input.purpose ?? "确定当前任务的项目区",reason:input.reason ?? "请确认这项任务的项目归属。",confidence:input.confidence ?? "uncertain"},context);
        }
        if (input.action === "import_upload") return api.importLibrary(context, required(input.uploadId, "附件编号"), api.workspaceSelection.require(context,input.workspaceId));
        if (input.action === "shares") return { shares: api.files.listShares() };
        const workspace = api.workspaceSelection.require(context,input.workspaceId);
        return input.path ? api.files.copySharedWorkspaceFile(required(input.grantId,"分享编号"), input.path, workspace)
          : api.files.copySharedVersion(required(input.grantId,"分享编号"), workspace);
      }),
    ...createCommandTools(service).map(command => command.definition.name === "write_stdin" ? command : ({...command,
      async execute(input:unknown,context:ToolExecutionContext) {
        if(!service)throw new Error("文件工作区尚未配置。");
        service.assertAccess(context);
        const environment_id=service.workspaceSelection.require(context,(input as {environment_id?:string}|null)?.environment_id);
        return command.execute({...input as Record<string,unknown>,environment_id},context);
      }
    })),
    tool(service, "artifact_files", "Save candidates with save (legacy publish also saves only, never sends cards). Supply resultId for stable logical identity across conversion paths; reuse fileId/expectedVersion for revisions. Different formats and independent alternatives use distinct resultIds. deliver selects the COMPLETE final items manifest [{resultId,versionId,format}] and requestKey; no generation or saving occurs during delivery/retry_delivery. Reuse resultIds in this reply to update slots; use a new requestKey for changed versions. retry_delivery takes the returned deliveryId and reuses exact saved versions, even after restart. delivery_status checks a request or this turn. Claim success only for delivered receipts; on failure keep savedVersionIds and retry. User request determines formats/count. keep_candidates(reason=workspace_only|inspection_only) is only for explicit requests to save or inspect in the workspace without delivery. Never deliver working copies, conversions or check images. List originals/artifacts with pagination; versions/restore preserve history. share requires the existing user operation.", artifactSchema,
      { action: actions("list", "versions", "save", "publish", "deliver", "retry_delivery", "delivery_status", "keep_candidates", "restore", "share"), kind: actions("artifact","original","all"), offset: {type:"integer",minimum:0}, limit: {type:"integer",minimum:1,maximum:500}, workspaceId:uuid,path:string,fileId:uuid,versionId:uuid,expectedVersion:uuid,expectedHash:string,title:string,targetAgent:string,
        reason:actions("workspace_only","inspection_only"),resultId:{type:"string",pattern:"^[a-zA-Z0-9_-]{1,64}$"},requestKey:{type:"string",minLength:1,maxLength:120},deliveryId:uuid,
        items:{type:"array",minItems:1,maxItems:100,items:{type:"object",additionalProperties:false,properties:{resultId:{type:"string",pattern:"^[a-zA-Z0-9_-]{1,64}$"},versionId:uuid,format:{type:"string",pattern:"^[a-z0-9]{1,16}$"}},required:["resultId","versionId","format"]}} }, {
        started:()=>({title:"处理成果",message:"我正在保存或交付成果文件。"}),
        completed:(_input,result)=>{const status=(result as {status?:string}).status;return {title:"处理成果",message:status==="delivered"?"成果文件已交付。":status==="saved_delivery_failed"?"文件已保存，交付失败，可以重试。":status==="saved_pending_delivery"?"候选版本已保存，等待选择最终成果。":"成果文件记录已更新。"};},
        failed:()=>({title:"处理成果",message:"这次成果文件操作未完成。"})
      }, async (input, context, api) => {
        if (input.action === "keep_candidates") { if(context.subagent)throw new Error("请由主 Agent 决定最终交付。"); return api.deferDelivery(context.sessionId,context.turnId,required(input.reason,"只保留工作区成果的用户要求")); }
        if (input.action === "list") return api.files.listArtifactPage(input.workspaceId,input.kind,input.offset,input.limit);
        if (input.action === "versions") return { versions: api.files.listVersions(required(input.fileId,"文件编号")) };
        if (input.action === "retry_delivery" || input.action === "delivery_status") {
          if (!input.deliveryId && input.action === "delivery_status") return { deliveries:api.deliveries.forTurn(context.sessionId,context.turnId) };
          const delivery=api.deliveries.get(required(input.deliveryId,"交付编号"));
          if (context.subagent || delivery.sessionId!==context.sessionId) throw new Error("请在原会话中重试交付。");
          return input.action === "retry_delivery" ? api.deliveries.retry(delivery.id) : delivery;
        }
        if (input.action === "deliver") {
          // Compatibility for restored calls with one explicit immutable version.
          const version=input.versionId?api.files.artifactVersion(input.versionId):undefined;
          const prior=api.deliveries.forTurn(context.sessionId,context.turnId).filter(item=>item.status==="delivered" && item.replyId===context.replyId).at(-1);
          const resultId=input.resultId ?? version?.fileId;
          const items=input.items ?? (version?[
            ...(prior?.items.filter(item=>item.resultId!==resultId && api.files.artifactVersion(item.versionId).fileId!==version.fileId) ?? []),
            {resultId:resultId!,versionId:version.versionId,format:version.name.split(".").at(-1)!.toLowerCase()}
          ]:undefined);
          return api.deliver(required(items,"最终成果清单"),input.requestKey ?? `legacy-${required(version?.versionId,"交付请求标识")}`,context);
        }
        if (input.action === "share") {
          if (!context.askUserQuestion) throw new Error("请在文件面板中选择分享对象。");
          const version = api.files.artifactVersion(required(input.versionId,"文件版本"));
          const peers = await api.peers(), target = peers.find(peer=>peer.id === input.targetAgent);
          if (!target) return { peers, next: "请选择目标 Agent 后再次发起分享。" };
          const answer = await context.askUserQuestion({ questions: [{ id: "share-file", header: "分享文件", type: "single_select", allowOther: false,
            question: `将“${version.name}”的这一版本分享给 ${target.name}？`, options: [
              {id:"share",label:"分享",description:"允许目标 Agent 读取并复制这个固定版本。"},
              {id:"cancel",label:"取消",description:"保留当前文件访问范围。"}] }] });
          if (answer.status !== "answered" || answer.answers?.["share-file"]?.selectedOptionIds.length !== 1
            || answer.answers["share-file"].selectedOptionIds[0] !== "share") return { status: "cancelled" };
          return api.share(version.versionId, target.id, randomUUID());
        }
        const workspace = api.workspaceSelection.require(context,input.workspaceId);
        if (input.action === "restore") { api.assertIdle(workspace); const file=await api.files.readArtifactVersion(required(input.versionId,"文件版本")); return api.files.writeFile(workspace,required(input.path,"目标路径"),file.bytes,input.expectedHash); }
        if (input.action === "save" && !input.fileId && !input.resultId) throw new Error("保存候选版本需要成果标识或已有文件编号。");
        const version=await api.saveWorkingFile(workspace,required(input.path,"文件路径"),{fileId:input.fileId,logicalId:input.resultId?`${context.sessionId}:${context.turnId}:${input.resultId}`:undefined,expectedVersion:input.expectedVersion,expectedHash:input.expectedHash,title:input.title});
        api.noteCandidate(context,version);
        return {...version,checks:await api.versionChecks(version),status:"saved_pending_delivery",delivered:false,next:"检查最新版本后，用 deliver 明确选择最终版本清单；publish 仅保存，不交付。"};
      }),

  ];
}
