export type ExecutionContext = { sessionId?: string; turnId?: number; signal?: AbortSignal };
export type ExecutionInput = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  waitMs?: number;
  terminal?: {tty:boolean;shell:string;login:boolean};
};
export type ExecutionJobState = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type ExecutionJob = {
  id: string; workspaceId: string; state: ExecutionJobState; createdAt: number; updatedAt: number;
  exitCode?: number; error?: string; snapshotState: "pending" | "saved" | "conflict" | "failed" | "superseded";
  snapshotError?: string; snapshotPath?: string;
};
export type ExecutionResult = ExecutionJob & {
  output: string; offset: number; nextOffset: number; outputBytes: number; truncated: boolean;
};
export type ExecutionEvent = { sequence: number; jobId: string; workspaceId: string; type: string; createdAt: number };
export type ExecutionRuntimeCapabilities = { python?: {command:string;version:string}; packages?: Record<string,string|null>; helpers?: Record<string,{path:string;sha256:string}>; tools?: Record<string,string|null>; fonts?: {cjk:boolean;names:string[]}; workspace?:string;workspaceRoot?:string;platform?:string;shell?:string;commandRuntime?:{engine:string;version:string;ready?:boolean;protocol?:string};skills?:string };
export type WorkerIdentity = { capabilities?: ExecutionRuntimeCapabilities; admissionTracking?:boolean; runtimeIdentity?: string; instanceId?:string;hostEpoch?:string; protocol: 1; agentId: string; ownerUserId: string; backend: "container"|"windows-native";permissions?:Record<string,unknown>; image?: string; githubSshConfigured?: boolean };
