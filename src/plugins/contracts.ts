import type { AgentToolRegistration } from "../tools/tool-contracts.js";

/** Numeric service APIs are explicit compatibility ranges, independent of code versions. */
export type PluginManifest = {
  id: string;
  version: string;
  sourceCommit: string;
  hostApi: 1;
  provides: Record<string, number>;
  requires: Record<string, { min: number; max: number }>;
};
export type PluginInstance = {
  /** Services such as model serialization participate in the whole turn's version lease. */
  pinForTurn?: boolean;
  routes?: Readonly<Record<string, { methods: readonly string[]; handle(method: string, input: unknown): { code: number; value: unknown } | Promise<{ code: number; value: unknown }> }>>;
  tools?: readonly AgentToolRegistration[];
  prompts?: Readonly<Record<string, string>>;
  services?: Readonly<Record<string, unknown>>;
  ready(): Promise<void>;
  /** Preparation is passive. These synchronous hooks only transfer intake ownership. */
  start?(): void;
  pause?(): void;
  resume?(): void;
  activeWork?(): number;
  dispose(): Promise<void>;
};
export type PluginDefinition = {
  manifest: PluginManifest;
  create(services: Readonly<Record<string, unknown>>): Promise<PluginInstance>;
};
export type PluginSnapshot = {
  tools: readonly AgentToolRegistration[];
  services: Readonly<Record<string, unknown>>;
  prompts: Readonly<Record<string, string>>;
  versions: Readonly<Record<string, string>>;
  release(): void;
};
export type PluginSource = { snapshot(toolNames?: readonly string[]): PluginSnapshot; snapshotVersions?(versions: Readonly<Record<string, string>>): Promise<PluginSnapshot> };
