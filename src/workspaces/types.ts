export type WorkspaceOptions = { agentId: string; ownerUserId: string; stateDirectory: string; maxFileBytes?: number };
export type Workspace = { id: string; name: string; createdAt: number; updatedAt: number };
export type WorkspaceFile = { path: string; name: string; type: "file" | "directory"; size: number; modifiedAt: number; sha256?: string };
export type FilePage = { workspaceId: string; path: string; files: WorkspaceFile[]; nextOffset?: number };
export type WorkspaceRead = { workspaceId: string; path: string; name: string; mime: string; size: number; sha256: string; text: string; offset: number; nextOffset?: number };
export type ArtifactVersion = { id: string; versionId: string; fileId: string; workspaceId: string; name: string; title: string; mime: string; size: number; sha256: string; createdAt: number; parentVersionId?: string; kind: "original" | "artifact"; sourcePath: string; shared?: boolean };
export type PublishOptions = { fileId?: string; logicalId?: string; expectedVersion?: string; expectedHash?: string; title?: string; mime?: string };
export type FileDeliveryItem = { resultId: string; versionId: string; format: string };
export type FileDelivery = {
  id: string; requestKey: string; sessionId: string; turnId: number; replyId: string;
  items: FileDeliveryItem[]; status: "saved_pending_delivery" | "delivered" | "saved_delivery_failed" | "superseded";
  createdAt: number; sequence: number; error?: string;
};
export type FileInput = { id: string; name: string; mime: string; bytes: Buffer; sha256: string };
export type TextEdit = { oldText: string; newText: string };
export type ShareTarget = { agentId: string; ownerUserId: string };
/** Supplied by the authenticated operation handler after authorization, never by model arguments. */
export type ShareAuthorization = { actorUserId: string; operationId: string };
export type ShareGrant = { id: string; kind: "version" | "workspace"; resourceId: string; targetAgentId: string; createdAt: number; revokedAt?: number };
export type WorkspaceEvent = { sequence: number; workspaceId: string; type: string; data: Record<string, unknown>; createdAt: number };
