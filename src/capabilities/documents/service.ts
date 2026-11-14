import sharp from "sharp";
import type { AgentConfig } from "../../config.js";
import type { ModelGateway } from "../../llm.js";
import type { ToolExecutionContext } from "../../tools/tool-contracts.js";
import type { ProjectSpaceFiles } from "../../project-spaces/files.js";
import { DocumentReader, decodeDocument } from "./reader.js";
import type { Passage } from "./search.js";
import { ProjectFileWriter, serializeFileMutation } from "../../project-spaces/mutations.js";
import { withFileDiff } from "../../file-diff.js";
import { documentFileActivity } from "../../tools/file-activity.js";
export type { DocumentSource, DocumentInput } from "../../plugins/documents/service.js";

/** Stable grants, caches, workers, native libraries and cross-generation file locks. */
export class DocumentCapability {
  readonly reader = new DocumentReader();
  readonly results = new Map<string, {at:number;items:Passage[];metadata:Record<string,unknown>}>();
  readonly decodeDocument=decodeDocument;
  readonly sharp=sharp;
  readonly serializeFileMutation=serializeFileMutation;
  readonly withFileDiff=withFileDiff;
  readonly activity=documentFileActivity;
  writer(agentId:string, assertAccess:()=>void) { return new ProjectFileWriter(agentId,assertAccess); }
  constructor(readonly options:{agentId:string;ownerUserId:string}, readonly model:ModelGateway, readonly projects?:ProjectSpaceFiles) {}
  static fromConfig(config:AgentConfig,model:ModelGateway,projects?:ProjectSpaceFiles) {
    return config.allowedTools.includes("documents")&&config.web?.ownerUserId?new DocumentCapability({agentId:config.id,ownerUserId:config.web.ownerUserId},model,projects):undefined;
  }
  get fileOperations():readonly string[]{return this.projects?["create_text","edit_text","move_file"]:[];}
  canAccess(context:ToolExecutionContext) {
    return context.agentId===this.options.agentId&&context.userId===this.options.ownerUserId&&context.conversationKind==="p2p"
      &&Boolean(context.conversationId&&context.sessionId&&context.documentLibrary)&&!context.signal?.aborted;
  }
}
