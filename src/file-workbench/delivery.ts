import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { prepareSql, sqliteTransaction } from "../sqlite.js";
import type { WorkspaceService, ArtifactVersion, FileDelivery, FileDeliveryItem } from "../workspaces/service.js";
import type { ConversationOutput } from "../channels/output.js";

export type FileDeliveryNotice = { delivery: FileDelivery; outputs: ConversationOutput[] };
export type FileDeliveryReceipt = FileDelivery & { savedVersionIds: string[]; retryable: boolean };
/** Durable outbox. A request always names immutable versions, never mutable paths. */
export class FileDeliveries {
  private sink?: (notice: FileDeliveryNotice) => Promise<void>;
  private readonly pending = new Map<string, Promise<FileDeliveryReceipt>>();
  constructor(private readonly db: DatabaseSync, private readonly files: WorkspaceService) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_deliveries(id TEXT PRIMARY KEY,request_scope TEXT NOT NULL UNIQUE,record TEXT NOT NULL)`);
  }
  register(sink: (notice: FileDeliveryNotice) => Promise<void>, options: {recoverPending?:boolean} = {}) {
    if (this.sink) throw new Error("File delivery is already registered");
    this.sink = sink;
    // Recover requests interrupted between the outbox commit and web receipt.
    const recovery = Promise.allSettled((options.recoverPending===false?[]:prepareSql(this.db,"SELECT record FROM file_deliveries ORDER BY rowid").all() as Array<{record:string}>).map(async row=>{
      const delivery = JSON.parse(row.record) as FileDelivery;
      if (delivery.status === "saved_pending_delivery") await this.retry(delivery.id);
      else if (delivery.status === "saved_delivery_failed") await sink({delivery,outputs:[]});
    }));
    return async () => { await recovery; await Promise.allSettled(this.pending.values()); if (this.sink === sink) this.sink = undefined; };
  }
  get(id: string): FileDelivery {
    const row = prepareSql(this.db,"SELECT record FROM file_deliveries WHERE id=?").get(id) as {record:string}|undefined;
    if (!row) throw new Error("交付请求不存在。");
    return JSON.parse(row.record) as FileDelivery;
  }
  forTurn(sessionId: string, turnId: number): FileDelivery[] {
    return (prepareSql(this.db,"SELECT record FROM file_deliveries ORDER BY rowid").all() as Array<{record:string}>)
      .map(row => JSON.parse(row.record) as FileDelivery).filter(row => row.sessionId === sessionId && row.turnId === turnId);
  }
  async deliver(input: {requestKey:string;sessionId:string;turnId:number;replyId:string;items:FileDeliveryItem[]}): Promise<FileDeliveryReceipt> {
    if (!input.replyId || !input.requestKey || input.requestKey.length > 120 || !input.items.length || input.items.length > 100) throw new Error("交付清单无效。");
    if (new Set(input.items.map(item=>item.resultId)).size !== input.items.length) throw new Error("成果标识重复。");
    const scope = JSON.stringify([input.sessionId,input.turnId,input.requestKey]);
    const row = prepareSql(this.db,"SELECT record FROM file_deliveries WHERE request_scope=?").get(scope) as {record:string}|undefined;
    if (row) {
      const saved = JSON.parse(row.record) as FileDelivery;
      if (JSON.stringify(saved.items) !== JSON.stringify(input.items)) throw new Error("交付请求已绑定其他版本，请使用新的请求标识。");
      return this.retry(saved.id);
    }
    // Resolve all saved identities before accepting the request. Blob/format
    // validation below returns a retryable receipt without losing these versions.
    for (const item of input.items) this.files.artifactVersion(item.versionId);
    const delivery: FileDelivery = { ...input, id:randomUUID(), status:"saved_pending_delivery", createdAt:Date.now(),sequence:0 };
    sqliteTransaction(this.db,()=>{
      const inserted=prepareSql(this.db,"INSERT INTO file_deliveries VALUES (?,?,?)").run(delivery.id,scope,JSON.stringify(delivery));
      delivery.sequence=Number(inserted.lastInsertRowid);
      prepareSql(this.db,"UPDATE file_deliveries SET record=? WHERE id=?").run(JSON.stringify(delivery),delivery.id);
    });
    return this.retry(delivery.id);
  }
  retry(id: string): Promise<FileDeliveryReceipt> {
    const active = this.pending.get(id); if (active) return active;
    const task = this.attempt(id).finally(()=>this.pending.delete(id)); this.pending.set(id,task); return task;
  }
  private receipt(delivery: FileDelivery): FileDeliveryReceipt {
    return {...delivery,savedVersionIds:delivery.items.map(item=>item.versionId),retryable:delivery.status!=="delivered" && delivery.status!=="superseded"};
  }
  private async versions(items: FileDeliveryItem[]): Promise<ArtifactVersion[]> {
    const versions: ArtifactVersion[] = [];
    for (const item of items) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(item.resultId) || !/^[a-z0-9]{1,16}$/.test(item.format)) throw new Error("成果标识或格式无效。");
      const version = await this.files.readArtifactVersion(item.versionId);
      if (extname(version.name).slice(1).toLowerCase() !== item.format) throw new Error("交付格式与文件版本不一致。");
      // Do not retain bytes in the outbox or presentation.
      const {bytes: _bytes,...metadata} = version; versions.push(metadata);
    }
    if (new Set(versions.map(version=>version.fileId)).size!==versions.length) throw new Error("每个逻辑文件只能选择一个最终版本。");
    return versions;
  }
  private async attempt(id: string): Promise<FileDeliveryReceipt> {
    let delivery = this.get(id);
    if (delivery.status === "delivered" || delivery.status === "superseded") return this.receipt(delivery);
    if (this.forTurn(delivery.sessionId,delivery.turnId).some(other=>other.replyId===delivery.replyId && other.status==="delivered" && other.sequence>delivery.sequence)) {
      delivery={...delivery,status:"superseded",error:"已有更新的成果清单。"};
      prepareSql(this.db,"UPDATE file_deliveries SET record=? WHERE id=?").run(JSON.stringify(delivery),id);
      try { await this.sink?.({delivery,outputs:[]}); } catch { /* No file is re-delivered. */ }
      return this.receipt(delivery);
    }
    try {
      const versions = await this.versions(delivery.items);
      if (!this.sink) throw new Error("文件交付暂不可用。");
      const outputs: ConversationOutput[] = versions.map((version,index)=>({
        id:"file-"+createHash("sha256").update(delivery.items[index]!.resultId).digest("hex").slice(0,40),
        title:version.title.slice(0,120),blocks:[{type:"artifact",versionId:version.versionId,fileId:version.fileId,
          filename:version.name,mime:version.mime,size:version.size,sha256:version.sha256}]
      }));
      // The web sink commits the complete manifest and clears the retry interaction in one save.
      await this.sink({delivery:{...delivery,status:"delivered",error:undefined},outputs});
      delivery = {...delivery,status:"delivered",error:undefined};
      for (const older of this.forTurn(delivery.sessionId,delivery.turnId)) {
        if (older.replyId===delivery.replyId && older.sequence<delivery.sequence && ["saved_pending_delivery","saved_delivery_failed"].includes(older.status))
          prepareSql(this.db,"UPDATE file_deliveries SET record=? WHERE id=?").run(JSON.stringify({...older,status:"superseded",error:"已有更新的成果清单。"}),older.id);
      }
    } catch (error) {
      delivery = error instanceof Error && error.message==="FILE_DELIVERY_SUPERSEDED"
        ? {...delivery,status:"superseded",error:"已有更新的成果清单，这次交付已结束。"}
        : {...delivery,status:"saved_delivery_failed",error:"文件已保存，交付失败，请重试。"};
      try { await this.sink?.({delivery,outputs:[]}); } catch { /* Outbox remains retryable even if the channel is unavailable. */ }
    }
    prepareSql(this.db,"UPDATE file_deliveries SET record=? WHERE id=?").run(JSON.stringify(delivery),id);
    return this.receipt(delivery);
  }
}
