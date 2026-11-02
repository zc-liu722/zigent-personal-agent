import type { ModelThoughtSource } from "./types.js";

export type ResponseThought = { text: string; itemId?: string; source: ModelThoughtSource };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Some suppliers send thoughts only in done events or completed output items.
 * Reconcile those snapshots with streamed deltas without repeating their text.
 * Opaque signatures/encrypted_content are deliberately never read here.
 */
export function createResponsesThoughtReader(): (event: Record<string, unknown>) => ResponseThought[] {
  const text = new Map<string, string>();
  const aliases = new Map<string, string>();
  const read = (event: Record<string, unknown>): ResponseThought[] => {
    const output: ResponseThought[] = [];
    const bind = (id: unknown, index: unknown): void => {
      if (typeof id !== "string" || index === undefined) return;
      const alias = String(index), canonical = aliases.get(id) ?? aliases.get(alias) ?? id;
      aliases.set(id, canonical); aliases.set(alias, canonical);
    };
    const emit = (value: unknown, id: unknown, index: unknown, part: unknown, source: ModelThoughtSource, delta = false): void => {
      if (typeof value !== "string" || !value) return;
      bind(id, index);
      const identity = id ?? index;
      if (identity !== undefined && !aliases.has(String(identity))) aliases.set(String(identity), String(identity));
      const itemId = identity === undefined ? undefined
        : `${aliases.get(String(identity)) ?? String(identity)}:${source === "reasoning" ? "reasoning:" : ""}${String(part ?? 0)}`;
      const key = `${source}:${itemId ?? "default"}`;
      const previous = text.get(key) ?? "";
      // A done snapshot usually repeats every delta; emit only its unseen suffix.
      // If the supplier rewrites a snapshot, retain the text already delivered.
      const suffix = delta ? value : value.startsWith(previous) ? value.slice(previous.length) : previous ? "" : value;
      if (!suffix) return;
      text.set(key, previous + suffix);
      output.push({ text: suffix, itemId, source });
    };
    const item = (value: unknown, index: unknown): void => {
      const entry = object(value);
      if (entry?.type !== "reasoning") return;
      bind(entry.id, index);
      for (const [field, source] of [["summary", "summary"], ["content", "reasoning"]] as const) {
        const parts = Array.isArray(entry[field]) ? entry[field] : [];
        parts.forEach((part, partIndex) => {
          const block = object(part);
          if (typeof part === "string" || block?.type === "summary_text" || block?.type === "reasoning_text" || block?.type === "text") {
            emit(typeof part === "string" ? part : block?.text, entry.id, index, partIndex, source);
          }
        });
      }
    };
    const type = event.type;
    bind(event.item_id ?? object(event.item)?.id, event.output_index);
    if (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta"
      || type === "response.reasoning_text.done" || type === "response.reasoning_summary_text.done") {
      const summary = String(type).includes("summary");
      const delta = String(type).endsWith(".delta");
      emit(delta ? event.delta : event.text, event.item_id, event.output_index,
        summary ? event.summary_index : event.content_index, summary ? "summary" : "reasoning", delta);
    }
    if (type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done") {
      emit(object(event.part)?.text, event.item_id, event.output_index, event.summary_index, "summary");
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") item(event.item, event.output_index);
    if (type === "response.completed") {
      const items = object(event.response)?.output;
      if (Array.isArray(items)) items.forEach(item);
    }
    return output;
  };
  return read;
}
