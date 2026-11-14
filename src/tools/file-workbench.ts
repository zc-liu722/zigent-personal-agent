import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FileWorkbench } from "../file-workbench/service.js";
import { createCommandTools } from "./command-tools.js";
import type { AgentToolRegistration, ToolExecutionContext } from "./tool-contracts.js";
import type { ToolActivityPresenter } from "./activity-presentation.js";
import { createWorkingFileTool } from "./working-files.js";
import { isConfirmedOperation } from "./confirmed-operation.js";

const id = z.string().uuid();
const path = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceSchema = z.object({ action: z.enum(["list", "inspect", "promote", "uploads", "select", "exit", "create", "open", "import_upload", "shares", "copy_share", "scratch"]), lifetime: z.enum(["temporary", "persistent"]).optional(), workspaceId: id.optional(), name: z.string().trim().min(1).max(160).optional(), purpose: z.string().trim().min(1).max(500).optional(), reason: z.string().trim().min(1).max(500).optional(), confidence: z.enum(["clear", "uncertain"]).optional(), uploadId: id.optional(), grantId: id.optional(), path: path.optional(), all: z.boolean().optional(), offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
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

function workspaceActivity(service?: FileWorkbench): ToolActivityPresenter {
  const heading = (input: unknown) => {
    const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
    let name = typeof value.name === "string" ? value.name.trim() : undefined;
    if (typeof value.workspaceId === "string" && value.workspaceId && value.action !== "create") {
      try { name = service?.files.workspace(value.workspaceId).name; } catch { name = undefined; }
    }
    const subject = name ? ` ${name} 项目区` : "项目区";
    switch (value.action) {
      case "list": return "查看项目区";
      case "uploads": return "查看附件";
      case "shares": return "查看共享项目区";
      case "import_upload": return `导入附件到${subject}`;
      case "copy_share": return `复制共享文件到${subject}`;
      case "create": return `新建${subject}`;
      case "promote": return `保留${subject}`;
      case "inspect": return `查看${subject}`;
      case "exit": return "退出项目区";
      case "select": return `${value.workspaceId ? "选择" : "新建"}${subject}`;
      default: return `选择${subject}`;
    }
  };
  return {
    started: input => { const title = heading(input); return { title, message: `我正在${title}。` }; },
    completed: (input, result) => {
      const action = (input as { action?: string })?.action;
      const value = result as { status?: string; created?: boolean; workspace?: { name?: string }; selection?: { status?: string } };
      if (value.status === "selected" && value.workspace?.name) {
        const title = `${value.created ? "新建" : "选择"} ${value.workspace.name} 项目`;
        return { title, message: `我已${title}。` };
      }
      if (value.status === "unselected") return { title: "退出项目区", message: "我已退出当前项目区。" };
      if (value.status === "promoted") return {title:heading(input),message:"我已将工作区保留为持久项目。"};
      const retained = value.selection?.status === "selected";
      return { title: heading(input), message: value.status === "needs_clarification" && retained ? "我已收到补充，原项目区保持不变。" : value.status === "needs_clarification" ? "我已收到补充，项目区还需明确。"
        : value.status === "cancelled" || value.status === "expired" ? retained ? "我未切换项目区，原项目区保持不变。" : "项目区尚未选定，文件工作未开始。"
        : action === "list" ? "我已查看已有项目区。" : "项目区信息已更新。" };
    },
    failed: input => ({ title: heading(input), message: "这次项目区操作未完成。" })
  };
}

export function createFileWorkbenchTools(service?: FileWorkbench): AgentToolRegistration[] {
  return [
    tool(service, "workspaces", "Manage long-term projects. List or inspect projects, select an existing project by workspaceId to set the conversation default, or exit it. inspect can read metadata for an owner-scoped historical directory by its known ID; promote restores it to the project list with user confirmation, preserving its ID and files. Temporary directories can only be promoted by their original session before expiry. Create only when the user requests a new project. confidence=uncertain offers project choices for an ambiguous project request.", workspaceSchema,
      { action: actions("list", "inspect", "promote", "select", "exit", "create"), workspaceId: uuid, name: string,
        purpose: {...string,maxLength:500}, reason: {...string,maxLength:500}, confidence: actions("clear","uncertain") }, workspaceActivity(service), async (input, context, api) => {
        if (input.action === "list") {
          const registeredProjects = await api.registeredWorkspaces();
          return { activeProjectId: api.workspaceSelection.currentProject(context.sessionId), registeredProjects, projects: api.workspaceSelection.list() };
        }
        if (input.action === "inspect" || input.action === "promote") {
          const workspaceId = required(input.workspaceId, "项目编号");
          await api.registeredWorkspaces();
          const workspace = api.files.workspace(workspaceId);
          if (workspace.lifetime === "legacy") {
            // Metadata stays within the authenticated Agent/owner scope. File
            // access still requires the original session until promotion is confirmed.
            api.files.assertSessionAccess(workspaceId, context.sessionId);
            api.assertExecutable(workspaceId);
          } else api.assertWorkingAccess(workspaceId, context.sessionId);
          if (input.action === "inspect") return { workspace };
          // Reuse the confirmation baseline and receipts, including old saved cards.
          if (!isConfirmedOperation(context, "workspaces", input) || context.subagent || context.taskRunId || context.backgroundTaskKind)
            throw new Error("保留历史目录需要确认。");
          return { status: "promoted", workspace: api.files.promoteWorkspace(workspaceId, context.sessionId) };
        }
        if (input.action === "exit") return api.workspaceSelection.exit(context);
        if (["select","create","open"].includes(input.action)) {
          const create = input.action === "create";
          if (input.lifetime === "temporary" || !create && input.name) throw new Error("新建长期项目请使用 create。");
          await api.registeredWorkspaces();
          return api.workspaceSelection.resolve({ workspaceId: create ? undefined : required(input.workspaceId, "项目编号"),
            name: create ? required(input.name, "项目名称") : undefined,
            purpose: input.purpose ?? (create ? "创建项目" : "选择项目"), reason: input.reason ?? "使用指定项目",
            confidence: input.confidence ?? "clear" }, context);
        }
        // Compatibility for journaled file calls from before the tool split.
        if (input.action === "uploads") {
          if (!context.documentLibrary) throw new Error("当前对话未提供附件读取能力。");
          const offset = input.offset ?? 0, limit = input.limit ?? 30;
          const page = context.documentLibrary.list(input.all ?? false, offset, limit + 1);
          return { uploads: page.slice(0, limit), offset, ...(page.length > limit ? { nextOffset: offset + limit } : {}) };
        }
        if (input.action === "import_upload") return api.importLibrary(context, required(input.uploadId, "附件编号"), input.workspaceId);
        if (input.action === "shares") return { shares: api.files.listShares() };
        const workspace = await api.resolveWorkingDirectory(context, { environmentId: input.workspaceId, write: true, allocate: true });
        if (input.action === "scratch") return { imageScratchDirectory: api.imageScratch.allocate(context.sessionId, context.turnId, workspace, context.signal), environment_id: workspace };
        await api.assertEditable(workspace);
        return input.path ? api.files.copySharedWorkspaceFile(required(input.grantId,"分享编号"), input.path, workspace)
          : api.files.copySharedVersion(required(input.grantId,"分享编号"), workspace);
      }),
    createWorkingFileTool(service),
    ...createCommandTools(service),
    tool(service, "artifact_files", "For inline images and previews use image_assets present under each corresponding paragraph; artifact_files is for requested downloadable files. Save candidates with save (legacy publish also saves only, never sends cards). Supply resultId for stable logical identity across conversion paths; reuse fileId/expectedVersion for revisions. Different formats and independent alternatives use distinct resultIds. deliver selects the COMPLETE final items manifest [{resultId,versionId,format}] and requestKey; no generation or saving occurs during delivery/retry_delivery. Reuse resultIds in this reply to update slots; use a new requestKey for changed versions. retry_delivery takes the returned deliveryId and reuses exact saved versions, even after restart. delivery_status checks a request or this turn. Claim success only for delivered receipts; on failure keep savedVersionIds and retry. User request determines formats/count. keep_candidates(reason=workspace_only|inspection_only) is only for explicit requests to save or inspect in the workspace without delivery. Never deliver working copies, conversions or check images. List originals/artifacts with pagination; versions/restore preserve history. share requires the existing user operation.", artifactSchema,
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
        const previous = input.fileId ? api.files.listVersions(input.fileId)[0]
          : input.action === "restore" && input.versionId ? api.files.artifactVersion(input.versionId) : undefined;
        const path = required(input.path ?? previous?.sourcePath, "文件路径");
        const workspace = await api.resolveWorkingDirectory(context, {
          environmentId: input.workspaceId ?? (previous?.shared ? undefined : previous?.workspaceId), path, write: input.action === "restore",
          allocate: input.action === "restore" && !input.expectedHash
        });
        const relative = await api.execution.workspaceRelativePath(workspace, path);
        if (input.action === "restore") { await api.assertEditable(workspace); const file=await api.files.readArtifactVersion(required(input.versionId,"文件版本")); return api.files.writeFile(workspace,relative,file.bytes,input.expectedHash); }
        if (input.action === "save" && !input.fileId && !input.resultId) throw new Error("保存候选版本需要成果标识或已有文件编号。");
        const version=await api.saveWorkingFile(workspace,relative,{fileId:input.fileId,logicalId:input.resultId?`${context.sessionId}:${context.turnId}:${input.resultId}`:undefined,expectedVersion:input.expectedVersion,expectedHash:input.expectedHash,title:input.title});
        api.noteCandidate(context,version);
        return {...version,checks:await api.versionChecks(version),status:"saved_pending_delivery",delivered:false,next:"检查最新版本后，用 deliver 明确选择最终版本清单；publish 仅保存，不交付。"};
      }),

  ];
}
