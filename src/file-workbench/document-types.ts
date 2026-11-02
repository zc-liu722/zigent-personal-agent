/** Immutable rendering evidence and the internal Word preview contract. */
export type PreviewRequest = {
  operation: "convert";
  workspaceRoot: string;
  inputPath: string;
  outputDirectory: string;
  outputName?: string;
  format: "pdf";
};
export type DocumentResult = {
  operation: "render" | "convert";
  operationId: string;
  inputSha256: string;
  processedPages: number[];
  totalPages: number | null;
  files: Array<{ path: string; name: string; mime: string; size: number; sha256: string; page?: number }>;
  text?: string;
  metadata?: Record<string, unknown>;
  warnings: string[];
  checks: Record<string, unknown>;
};
export type RuntimeDescription = {
  version: string; available: boolean; python: string; packages: Record<string, string | null>;
  tools: Record<string, string | null>; operations: string[]; fonts: { cjk: boolean; names: string[] };
  runtimeIdentity?: string; renderingIdentity?: string; helpers?: Record<string, unknown>;
  error?: string;
};
export interface PreviewRuntime {
  describe(): Promise<RuntimeDescription>;
  execute(request: PreviewRequest): Promise<DocumentResult>;
  close(): void;
}
