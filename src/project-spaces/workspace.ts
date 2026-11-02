import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { inventory, safeRoot, sha256, version, type Inventory, type ProjectSpace } from "./policy.js";

export const executionSchema = z.object({ executor: z.literal("windows-codex"), host: z.literal("windows"), inputVersion: z.string().regex(/^[a-f0-9]{64}$/),
  directory: z.string().min(1).max(1024), baselineTaskId: z.string().uuid(), mode: z.literal("project").optional(),
  publication: z.enum(["pending", "published", "conflict"]).default("pending"), files: z.number().int().nonnegative().max(10000).default(0),
  changedPaths: z.array(z.string().min(1).max(600)).max(10000).optional(),
  cost: z.object({ type: z.literal("subscription") }).default({ type: "subscription" }), monetaryCost: z.literal(0).default(0),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative().optional() }).optional(), usageReportedAt: z.number().int().nonnegative().optional() }).strict();
export type Execution = z.infer<typeof executionSchema>;
export const projectExecutionScope = ({ introduction: _introduction, ...space }: ProjectSpace) => sha256(JSON.stringify({ project: space, execution: "project-v1" }));

type Checkpoint = { version: 1; project: string; inputVersion: string; files: Inventory };

export async function assertProjectWorkspace(space: ProjectSpace, execution: Execution) {
  executionSchema.parse(execution);
  if (execution.mode !== "project" || (await safeRoot(space.windows!)).toLowerCase() !== execution.directory.toLowerCase())
    throw new Error("Legacy work-copy sessions cannot resume in the live project; start a new project session");
}

export async function prepareWorkspace(space: ProjectSpace, stateRoot: string, taskId: string, expected: string): Promise<Execution> {
  z.string().uuid().parse(taskId);
  const directory = await safeRoot(space.windows!);
  const metadata = join(stateRoot, "tasks", taskId, "baseline.json");
  const baseline = await inventory(space, directory, false);
  if (version(baseline) !== expected) throw new Error("Input changed while preparing task");
  // Only recovery metadata lives in private executor state. The project itself
  // is the working directory; no input copy or result bundle is created.
  await mkdir(join(stateRoot, "tasks", taskId), { recursive: true });
  const checkpoint: Checkpoint = { version: 1, project: space.id, inputVersion: expected, files: baseline };
  try { await writeFile(metadata, JSON.stringify(checkpoint), { flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const saved = JSON.parse(await readFile(metadata, "utf8")) as Checkpoint;
    if (JSON.stringify(saved) !== JSON.stringify(checkpoint)) throw new Error("Existing checkpoint requires reconciliation");
  }
  return executionSchema.parse({ executor: "windows-codex", host: "windows", inputVersion: expected, directory, baselineTaskId: taskId, mode: "project" });
}

export async function completeWorkspace(space: ProjectSpace, stateRoot: string, taskId: string, execution: Execution): Promise<Execution> {
  z.string().uuid().parse(taskId);
  await assertProjectWorkspace(space, execution);
  const baseline = JSON.parse(await readFile(join(stateRoot, "tasks", execution.baselineTaskId, "baseline.json"), "utf8")) as Checkpoint;
  if (baseline.project !== space.id || baseline.inputVersion !== execution.inputVersion || version(baseline.files) !== baseline.inputVersion)
    throw new Error("Invalid task baseline");
  const current = await inventory(space, execution.directory, false);
  const original = new Map(baseline.files.map(f => [f.path, f.sha256]));
  const present = new Set(current.map(f => f.path));
  const changedPaths = [...current.filter(f => original.get(f.path) !== f.sha256).map(f => f.path), ...baseline.files.filter(f => !present.has(f.path)).map(f => f.path)];
  // Completion retries never reapply edits or republish deleted output.
  return { ...execution, publication: "published", files: changedPaths.length, changedPaths };
}
