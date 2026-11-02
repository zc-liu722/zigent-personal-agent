export type FileDiff = { patch: string; additions?: number; deletions?: number };

// Presentation-only metadata never enters the model's serialized tool result.
const resultDiffs = new WeakMap<object, FileDiff>();
export function withFileDiff<T extends object>(result: T, diff: FileDiff): T { resultDiffs.set(result, diff); return result; }
export function resultFileDiff(result: unknown): FileDiff | undefined {
  return result && typeof result === 'object' ? resultDiffs.get(result) : undefined;
}

const lines = (text: string) => text ? text.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n') : [];

/** Translate the actual patch payload; never infer removed file contents. */
export function patchFileDiff(source: string, originals = new Map<string, string>()): FileDiff {
  const rows: string[] = [];
  let additions = 0, deletions = 0, known = true, active = false;
  const input = source.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < input.length; index++) {
    const row = input[index]!;
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(row);
    if (header) {
      const [, action, path] = header;
      active = true;
      rows.push(`--- ${action === 'Add File' ? '/dev/null' : path}`, `+++ ${action === 'Delete File' ? '/dev/null' : path}`);
      if (action === 'Add File') {
        let count = 0;
        for (let at = index + 1; at < input.length && !input[at]!.startsWith('*** '); at++) if (input[at]!.startsWith('+')) count++;
        rows.push(`@@ -0,0 +1,${count} @@`);
      } else if (action === 'Delete File') {
        const before = originals.get(path!);
        if (before === undefined) known = false;
        else {
          const removed = lines(before); deletions += removed.length;
          rows.push(`@@ -1,${removed.length} +0,0 @@`);
          for (const line of removed) rows.push(`-${line}`);
          if (before && !before.endsWith('\n')) rows.push('\\ No newline at end of file');
        }
      }
      continue;
    }
    if (!active) continue;
    if (row.startsWith('*** Move to: ')) { rows[rows.length - 1] = `+++ ${row.slice(13)}`; continue; }
    if (row.startsWith('*** ')) { if (row === '*** End Patch') active = false; continue; }
    if (row.startsWith('@@') || /^[ +\-]/.test(row)) {
      rows.push(row);
      if (row.startsWith('+')) additions++;
      if (row.startsWith('-')) deletions++;
    }
  }
  return { patch: rows.join('\n'), ...(known ? { additions, deletions } : {}) };
}

/** A unified line diff with bounded comparison work and three lines of context. */
export function textFileDiff(path: string, before: string, after: string): FileDiff {
  // Keep terminators while comparing so a changed final newline is counted.
  const split = (text: string) => text.replaceAll('\r\n', '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const oldLines = split(before), newLines = split(after);
  type Row = { kind: ' ' | '+' | '-'; text: string };
  const rows: Row[] = [];
  let start = 0, end = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]) end++;
  const left = oldLines.slice(start, oldLines.length - end), right = newLines.slice(start, newLines.length - end);
  for (const text of oldLines.slice(0, start)) rows.push({ kind: ' ', text });
  if (left.length * right.length <= 1_000_000) {
    const width = right.length + 1, lengths = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
      lengths[i * width + j] = left[i] === right[j] ? lengths[(i + 1) * width + j + 1]! + 1
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { rows.push({ kind: ' ', text: left[i++]! }); j++; }
      else if (j < right.length && (i === left.length || lengths[i * width + j + 1]! > lengths[(i + 1) * width + j]!)) rows.push({ kind: '+', text: right[j++]! });
      else rows.push({ kind: '-', text: left[i++]! });
    }
  } else {
    for (const text of left) rows.push({ kind: '-', text });
    for (const text of right) rows.push({ kind: '+', text });
  }
  for (const text of oldLines.slice(oldLines.length - end)) rows.push({ kind: ' ', text });
  const additions = rows.filter(row => row.kind === '+').length, deletions = rows.filter(row => row.kind === '-').length;
  const patch = [`--- ${before ? path : '/dev/null'}`, `+++ ${after ? path : '/dev/null'}`];
  let oldAt = 1, newAt = 1, index = 0;
  while (index < rows.length) {
    let changed = index;
    while (changed < rows.length && rows[changed]!.kind === ' ') changed++;
    if (changed === rows.length) break;
    const first = Math.max(index, changed - 3);
    for (; index < first; index++) { oldAt++; newAt++; }
    let lastChange = changed, finish = changed;
    while (finish < rows.length && finish <= lastChange + 6) {
      if (rows[finish]!.kind !== ' ') lastChange = finish;
      finish++;
    }
    const last = Math.min(rows.length, lastChange + 4), hunk = rows.slice(first, last);
    const oldCount = hunk.filter(row => row.kind !== '+').length, newCount = hunk.filter(row => row.kind !== '-').length;
    patch.push(`@@ -${oldCount ? oldAt : oldAt - 1},${oldCount} +${newCount ? newAt : newAt - 1},${newCount} @@`);
    for (const row of hunk) {
      patch.push(row.kind + row.text.replace(/\n$/, ''));
      if (!row.text.endsWith('\n')) patch.push('\\ No newline at end of file');
      if (row.kind !== '+') oldAt++;
      if (row.kind !== '-') newAt++;
    }
    index = last;
  }
  return { additions, deletions, patch: patch.join('\n') };
}
