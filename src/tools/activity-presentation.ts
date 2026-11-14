import type { ModelWebSearchCall } from "../models/types.js";
import type { FileDiff } from '../file-diff.js';

export type ToolActivityDetail = {
  label: string;
  value: string;
  format?: "text" | "quote";
};

export type ToolActivityResource = {
  title: string;
  url?: string;
  description?: string;
};

/** Channel-neutral, user-facing description of what an agent is doing. */
export type ToolActivityPresentation = {
  hidden?: boolean;
  /** Underlying work is still pending even if this tool's wait window has ended. */
  waiting?: boolean;
  message: string;
  /** Short, stable action + subject, from explicitly allowlisted fields. */
  title?: string;
  /** The kind of action when the tool's name alone does not identify it. */
  actionKind?: "search" | "read" | "edit" | "image" | "tasks" | "wait";
  /** Shell source explicitly selected from exec_command.cmd for the process view. */
  command?: string;
  /** Explicit file operation, independent of the underlying execution tool. */
  fileOperation?: 'read' | 'edit';
  diff?: FileDiff;
  details?: readonly ToolActivityDetail[];
  resources?: readonly ToolActivityResource[];
  resourcesLabel?: string;
};

export type ToolActivityPresentationContext = {
  referenceImageCount?: number;
};

export type ToolActivityPresenter = {
  started(input: unknown, context?: ToolActivityPresentationContext): ToolActivityPresentation;
  completed(input: unknown, result: unknown, context?: ToolActivityPresentationContext): ToolActivityPresentation;
  failed(input: unknown, error: string, context?: ToolActivityPresentationContext): ToolActivityPresentation;
};

export const hiddenToolActivity = (): ToolActivityPresentation => ({ hidden: true, message: "" });

/** Format one allowlisted name or search term for a compact, single-line title. */
export function activitySubject(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim().slice(0, 80) : "";
}

export const genericToolActivity: ToolActivityPresenter = {
  started: () => ({ message: "我正在处理这一步。" }),
  completed: () => ({ message: "这一步已经处理好了。" }),
  failed: (_input, error) => ({
    message: "这一步没能顺利完成。",
    details: [{ label: "原因", value: error }]
  })
};

function searchQueries(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const call = value as Partial<ModelWebSearchCall>;
  const queries = Array.isArray(call.queries)
    ? call.queries.filter((query): query is string => typeof query === "string" && Boolean(query.trim()))
    : [];
  if (queries.length === 0 && typeof call.query === "string" && call.query.trim()) queries.push(call.query.trim());
  return [...new Set(queries)];
}

function searchResources(value: unknown): ToolActivityResource[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const sources = (value as Partial<ModelWebSearchCall>).sources;
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 8).flatMap((source) => {
    if (!source || typeof source.url !== "string") return [];
    let title = source.title?.trim();
    if (!title) {
      try {
        title = new URL(source.url).hostname.replace(/^www\./, "");
      } catch {
        title = source.url;
      }
    }
    return [{ title, url: source.url }];
  });
}

function searchSourceCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const sources = (value as Partial<ModelWebSearchCall>).sources;
  return Array.isArray(sources)
    ? sources.filter((source) => source && typeof source.url === "string").length
    : 0;
}

export const webSearchActivity: ToolActivityPresenter = {
  started: (input) => {
    const queries = searchQueries(input);
    return {
      title: queries.length > 0 ? `搜索 ${queries.join("；")}` : "搜索",
      message: queries.length > 0 ? "我正在网上查找这些信息。" : "我正在网上查找相关资料。",
      ...(queries.length > 0
        ? { details: [{ label: "搜索关键词", value: queries.join("；") }] }
        : {})
    };
  },
  completed: (input, result) => {
    const queries = searchQueries(result).length > 0 ? searchQueries(result) : searchQueries(input);
    const resources = searchResources(result);
    const sourceCount = searchSourceCount(result);
    return {
      title: queries.length > 0 ? `搜索 ${queries.join("；")}` : "搜索",
      message: sourceCount > 0
        ? `我找到了 ${sourceCount} 个可以参考的来源，正在整理其中的信息。`
        : "搜索已经完成，我正在整理找到的信息。",
      ...(queries.length > 0 ? { details: [{ label: "搜索关键词", value: queries.join("；") }] } : {}),
      ...(resources.length > 0 ? { resources } : {})
    };
  },
  failed: (input, error) => {
    const queries = searchQueries(input);
    return {
      title: queries.length > 0 ? `搜索 ${queries.join("；")}` : "搜索",
      message: "这次网上搜索没有顺利完成。",
      details: [
        ...(queries.length > 0 ? [{ label: "搜索关键词", value: queries.join("；") }] : []),
        { label: "原因", value: error }
      ]
    };
  }
};
