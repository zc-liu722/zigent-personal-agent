import type { TriggerDiagram } from "../tasks/trigger-diagram.js";

export type TaskChangeState = { title: string; instruction: string; project?: string; delivery: string; status: string; diagram: TriggerDiagram };
export type CalendarPreviewState = { title: string; description?: string; location?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string }; end?: { date?: string; dateTime?: string; timeZone?: string }; recurrence?: string[]; reminderMinutes?: number | null };
export type TodoPreviewState = { title: string; description?: string; due?: { label?: string; date?: string; dateTime?: string; recurring?: boolean };
  priority?: number; labels?: string[]; completed?: boolean };
export type MindmapNode = { label: string; children?: MindmapNode[] };
export type MindmapPreviewState = { title: string; roots: MindmapNode[]; scope?: "full" | "fragment" };
export type OperationPresentation =
  | { kind: "calendar"; action: string; before?: CalendarPreviewState; after?: CalendarPreviewState }
  | { kind: "todo"; action: string; before?: TodoPreviewState; after?: TodoPreviewState }
  | { kind: "mindmap"; action: string; before?: MindmapPreviewState; after?: MindmapPreviewState }
  | { kind: "table"; action: string; title: string; range?: string; before?: string[][]; after?: string[][] }
  | { kind: "document"; action: string; title: string; format?: string; before?: string; after?: string };
/** Reviewed content only: never transport arguments, credentials or runtime state. */
export type ChangePreview = {
  title: string;
  before?: string;
  after?: string;
  /** When the service cannot provide a comparable original, say so explicitly. */
  note?: string;
  task?: { kind?: "trigger-rule"; before?: TaskChangeState; after?: TaskChangeState };
  /** Allowlisted display data. Execution continues to use the saved server draft. */
  presentation?: OperationPresentation;
};
export type ChangeDocument = { id: string; title: string; filename: string; content: string };
