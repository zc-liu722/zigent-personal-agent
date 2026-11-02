import type { ChangePreview } from "../channels/change-preview.js";

type Fields = Record<string, unknown>;
type Node = { label: string; children?: Node[] };
type MapState = { title: string; roots: Node[]; scope?: "full" | "fragment" };
const object = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Presentation reads only explicit document fields, never design plans or transport metadata. */
function markdownState(markdown: string, scope: MapState["scope"]): MapState | undefined {
  if (markdown.length > 80_000) return undefined;
  const roots: Node[] = [], headings: Array<{ level: number; node: Node }> = [], lists: Array<{ indent: number; node: Node }> = [];
  let title = "", count = 0, fence: string | undefined, code: string[] = [];
  const append = (label: string, parent?: Node): Node => {
    const node: Node = { label };
    if (parent) (parent.children ??= []).push(node); else roots.push(node);
    count++; return node;
  };
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) { fence = marker[1]![0]; code = []; }
      else if (marker[1]![0] === fence) { if (code.length) append(code.join("\n"), lists.at(-1)?.node ?? headings.at(-1)?.node); fence = undefined; }
      continue;
    }
    if (fence) { code.push(line); continue; }
    if (!line.trim() || /^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) continue;
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length, label = heading[2]!;
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      lists.length = 0;
      // The first document heading is the central topic, not a duplicate branch.
      if (!title && roots.length === 0 && headings.length === 0) {
        title = label;
        headings.push({ level, node: { label, children: roots } });
      } else headings.push({ level, node: append(label, headings.at(-1)?.node) });
      if (count > 500) return undefined;
      continue;
    }
    const list = line.match(/^(\s*)(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (list) {
      const indent = list[1]!.replace(/\t/g, "    ").length;
      while (lists.length && lists.at(-1)!.indent >= indent) lists.pop();
      const node = append(list[2]!, lists.at(-1)?.node ?? headings.at(-1)?.node);
      lists.push({ indent, node });
    } else append(line.trim(), lists.at(-1)?.node ?? headings.at(-1)?.node);
    if (count > 500 || headings.length + lists.length > 40) return undefined;
  }
  if (fence && code.length) append(code.join("\n"), lists.at(-1)?.node ?? headings.at(-1)?.node);
  if (!title && roots.length === 1) {
    const only = roots[0]!;
    if (only.children?.length) return { title: only.label, roots: only.children, scope };
  }
  return title || roots.length ? { title: title || "思维导图", roots, scope } : undefined;
}

function topicState(value: unknown, scope: MapState["scope"]): MapState | undefined {
  let count = 0;
  const node = (value: unknown, depth: number): Node | undefined => {
    if (depth > 40 || ++count > 500) throw new Error("Mindmap preview too large");
    const source = object(value), label = text(source.title) ?? text(source.label) ?? text(source.text);
    if (!label) return undefined;
    const children = Array.isArray(source.children) ? source.children : object(source.children).attached;
    const converted = Array.isArray(children) ? children.map(child => node(child, depth + 1)) : [];
    if (converted.some(child => !child)) throw new Error("Unrecognized topic");
    return { label, ...(converted.length ? { children: converted as Node[] } : {}) };
  };
  try {
    const root = node(value, 0);
    return root ? { title: root.label, roots: root.children ?? [], scope } : undefined;
  } catch { return undefined; }
}

function readState(value: unknown, scope: MapState["scope"], depth = 0): MapState | undefined {
  if (depth > 7 || value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.length > 100_000) return undefined;
    try { return readState(JSON.parse(value), scope, depth + 1); } catch { /* explicit Markdown only */ }
    return /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/m.test(value) ? markdownState(value, scope) : undefined;
  }
  const source = object(value);
  if (text(source.markdown)) return markdownState(String(source.markdown), scope);
  for (const key of ["rootTopic", "root_topic", "topic"]) {
    const state = topicState(source[key], scope); if (state) return state;
  }
  // A topic tree must explicitly contain children; a transport title alone is not a map.
  if (source.children) { const state = topicState(source, scope); if (state) return state; }
  for (const key of ["data", "result", "structuredContent", "mindmap", "content", "sheets"]) {
    if (source[key] === undefined) continue;
    // Several sheets cannot be represented as one complete map.
    if (key === "sheets" && Array.isArray(source[key]) && source[key].length > 1) continue;
    const children = Array.isArray(source[key]) ? source[key] as unknown[] : [source[key]];
    for (const child of children) {
      const nested = object(child);
      const state = readState(nested.type === "text" ? nested.text : child, scope, depth + 1);
      if (state) return state;
    }
  }
  return undefined;
}
function outline(state: MapState): string {
  const lines = [`# ${state.title}`];
  const walk = (nodes: Node[], depth: number) => nodes.forEach(node => {
    lines.push(`${"  ".repeat(depth)}- ${node.label}`); walk(node.children ?? [], depth + 1);
  });
  walk(state.roots, 0); return lines.join("\n");
}

export function xmindPreview(input: Fields, snapshots: unknown[], title: string): ChangePreview | undefined {
  const operation = String(input.operation ?? "");
  if (!["xmind_create_mindmap", "xmind_edit_mindmap"].includes(operation)) return undefined;
  const creating = operation === "xmind_create_mindmap";
  const after = readState(input.arguments, creating ? "full" : "fragment");
  if (!after) return undefined;
  const before = creating ? undefined : snapshots.map(value => readState(value, "full")).find(Boolean);
  // A fragment is not a replacement for the complete map. Keep the original
  // available visually without reporting untouched branches as deletions.
  return { title, ...(before && after.scope === "full" ? { before: outline(before) } : {}), after: outline(after),
    presentation: { kind: "mindmap", action: operation, ...(before ? { before } : {}), after } };
}
