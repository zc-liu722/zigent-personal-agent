import { createHash } from "node:crypto";
import type { AgentRunSnapshot } from "../agent/transcript.js";
import type { WebMessage } from "./store.js";

export function activityIdentity(snapshot: AgentRunSnapshot) {
  const serialized = JSON.stringify(snapshot);
  return { revision: createHash("sha256").update(serialized).digest("hex"), bytes: Buffer.byteLength(serialized) };
}

/** Preserve answers and timeline anchors; defer only terminal process details. */
export function compactMessage(message: WebMessage): WebMessage {
  const snapshot = message.snapshot;
  if (!snapshot || snapshot.status === "running" || message.activityDeferred || !snapshot.items.some(item => item.type === "thought" || item.type === "tool" || item.type === "subagent")) return message;
  return { ...message, activityDeferred: true, activityRevision: activityIdentity(snapshot).revision, snapshot: {
    ...snapshot, answerDraft: "", items: snapshot.items.map(item => {
      if (item.type === "response" || item.type === "commentary") return item;
      if (item.type === "subagent") return { ...item, task: "", snapshot: { ...item.snapshot, answerDraft: "", items: [] } };
      if (item.type !== "tool") return { ...item, text: item.text.split(/\r?\n/, 1)[0]!.slice(0, 160) };
      return { id: item.id, type: item.type, status: item.status, name: item.name, operationKey: item.operationKey,
        presentation: { title: item.presentation.title, fileOperation: item.presentation.fileOperation,
          ...(item.presentation.diff ? { diff: { additions: item.presentation.diff.additions, deletions: item.presentation.diff.deletions, patch: '' } } : {}),
          hidden: item.presentation.hidden, message: item.presentation.message.slice(0, 240) } };
    })
  } };
}
