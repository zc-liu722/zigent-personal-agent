import type { ChatMessage } from "./types.js";
import type { ModelConversationMessage, ModelWebSearchCall } from "../models/types.js";
import { assistantReplayText } from "../models/search-evidence.js";

/** Older replies kept hosted searches only in activity. Recover only recorded
 * completion/query/source metadata; never invent the missing search response. */
export function replayToolTrace(message: Pick<ChatMessage, "toolTrace" | "activityTrace" | "modelName" | "model">): ModelConversationMessage[] {
  const trace = message.toolTrace ?? [];
  if (trace.some(entry => entry.role === "assistant" && entry.searchEvidence)) return trace;
  const functionCalls = new Set(trace.flatMap(entry => entry.role === "assistant"
    ? entry.toolCalls.filter(call => call.name === "web_search").map(call => call.id) : []));
  const calls: ModelWebSearchCall[] = (message.activityTrace ?? []).flatMap(item => {
    if (item.type !== "tool" || item.name !== "web_search" || item.status !== "completed" || functionCalls.has(item.id)) return [];
    const query = item.presentation.details?.find(detail => detail.label === "搜索关键词")?.value;
    return [{ id: item.id, status: "completed", ...(query ? { query } : {}),
      sources: (item.presentation.resources ?? []).flatMap(resource => resource.url
        ? [{ type: "url" as const, url: resource.url, title: resource.title }] : []) }];
  });
  if (!calls.length) return trace;
  return [...trace, { role: "assistant", text: "", toolCalls: [], searchEvidence: {
    version: 1, model: message.modelName ?? message.model ?? "unknown", origin: "saved_activity", calls, citations: []
  } }];
}

/**
 * Interleaved replies store all visible prose in content, while toolTrace also
 * retains the prose preceding each tool call. Replay that prose at its original
 * checkpoint only once. Require an exact activity/content match and exact trace
 * prefixes; legacy final-only replies or edited records keep their full content.
 */
export function assistantHistoryTail(message: Pick<ChatMessage, "content" | "toolTrace" | "activityTrace">): string {
  const activity = message.activityTrace ?? [];
  const responses = activity.flatMap((item, index) => item.type === "response" && item.text.trim()
    ? [{ text: item.text.trim(), index }] : []);
  if (!message.toolTrace?.length || !responses.length || responses.map(item => item.text).join("\n\n") !== message.content.trim()) return message.content;
  let consumed = 0;
  for (const entry of message.toolTrace) {
    if (entry.role !== "assistant" || !entry.text.trim()) continue;
    const callIds = new Set(entry.toolCalls.map(call => call.id));
    const checkpoint = activity.findIndex(item => item.type === "tool" && callIds.has(item.id));
    if (checkpoint < 0) return message.content;
    let remaining = entry.text.trim();
    while (remaining && consumed < responses.length && responses[consumed]!.index < checkpoint
      && remaining.startsWith(responses[consumed]!.text)) {
      remaining = remaining.slice(responses[consumed++]!.text.length).trimStart();
    }
    // Do not guess which text belongs to the trace when metadata disagrees.
    if (remaining) return message.content;
  }
  return consumed ? responses.slice(consumed).map(item => item.text).join("\n\n") : message.content;
}

/** Answers are user content; never promote their text into system instructions. */
export function renderUserMessageContent(message: Pick<ChatMessage, "content" | "questionAnswers">): string {
  const answers = message.questionAnswers?.map(answer =>
    `问题：${answer.question}\n回答：${[...answer.selectedOptions, ...(answer.text ? [answer.text] : [])].join("；")}`
  );
  return answers?.length ? `${message.content}\n\n用户补充回答：\n${answers.join("\n\n")}` : message.content;
}

function renderToolTrace(message: ChatMessage): string[] {
  return replayToolTrace(message).map((entry) => {
    if (entry.role === "tool") {
      return `[tool_result call_id=${JSON.stringify(entry.toolCallId)} failed=${entry.failed}] ${entry.value}`;
    }
    if (entry.role === "assistant") {
      const calls = entry.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
      return [
        assistantReplayText(entry) ? `[assistant] ${assistantReplayText(entry)}` : undefined,
        calls.length ? `[tool_calls] ${JSON.stringify(calls)}` : undefined
      ].filter((part): part is string => Boolean(part)).join("\n");
    }
    return `[user] ${entry.text}`;
  });
}

export function renderMessageForSummary(message: ChatMessage): string {
  const role = message.role === "user" && message.speakerLabel
    ? `user speaker=${JSON.stringify(message.speakerLabel)}`
    : message.role;
  const images = (message.images ?? []).map((image) =>
    `[会话图片 ${image.id}，${message.role === "user" ? "用户发送" : "Agent 发送"}] ${image.description ?? "原图可按图片编号重新查看"}`
  );
  if (message.role !== "assistant") return `[${role}] ${[message.role === "user" ? renderUserMessageContent(message) : message.content, ...images].filter(Boolean).join("\n")}`;
  const tail = assistantHistoryTail(message);
  return [...renderToolTrace(message), ...(tail ? [`[assistant] ${tail}`] : []), ...images].join("\n");
}
