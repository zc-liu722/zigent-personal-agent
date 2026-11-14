import type { DatabaseSync } from "node:sqlite";
import type { WebChannelConfig } from "../config.js";
import type { WebStore } from "../web/store.js";

/** Borrowed data-service connection; the plugin never closes the web database. */
export type RecordingStore = Pick<WebStore, "asset" | "documentMetadata" | "addAsset"> & { readonly db: DatabaseSync };
export type RecordingConfiguration = Pick<NonNullable<WebChannelConfig["transcription"]>, "model" | "apiKey">;
export type RecordingObjectStorage = {uploadUrl(key:string):string;downloadUrl(key:string):string;delete(key:string):Promise<void>};
export type RecordingConnection = { store?: RecordingStore; config?: RecordingConfiguration; objects?: RecordingObjectStorage };
/** Public recording-plugin contract; audio assets remain host-owned. */
export type RecordingReference = { file: string; transcriptId: string; text: string };
export type RecordingWorkflow = {
  skill: { name: string; description: string; body: string };
  migrations: Array<{ id: string; before: string; after: string }>;
  context(references: RecordingReference[], workbench: boolean): string;
};

export type RecordingCapability = RecordingWorkflow & {
  connect(): void;
  transcribe(id: string, signal: AbortSignal, progress: (text: string) => void): Promise<string>;
};
