import type { ToolActivityPresentation } from './activity-presentation.js';
import { patchFileDiff, resultFileDiff } from '../file-diff.js';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** Only filenames and explicit operation labels enter the file activity contract. */
export function fileActivity(kind: 'read' | 'edit', paths: string[], verb = kind === 'read' ? '阅读' : '编辑'): Partial<ToolActivityPresentation> {
  const files = [...new Set(paths.filter(path => path.trim()).map(path => path.slice(0, 1024)))];
  return { fileOperation: kind, title: files.length ? `${verb} ${basename(files[0]!)}${files.length > 1 ? ` 等 ${files.length} 个文件` : ''}` : `${verb}文件`,
    details: files.slice(0, 40).map(path => ({ label: verb, value: path })) };
}

export function patchFileActivity(input: unknown): Partial<ToolActivityPresentation> {
  const changes = [...text(object(input).input).matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)];
  const files = changes.filter(match => match[1] !== 'Move to');
  const paths = files.map(match => match[2]!.trim());
  const verbs: Record<string, string> = { 'Add File': '创建', 'Update File': '编辑', 'Delete File': '删除', 'Move to': '移至' };
  return { ...fileActivity('edit', paths, files.length === 1 ? verbs[files[0]![1]!] : '编辑'),
    diff: patchFileDiff(text(object(input).input)),
    details: changes.slice(0, 40).map(match => ({ label: verbs[match[1]!]!, value: match[2]!.trim().slice(0, 1024) })) };
}

export function documentFileActivity(input: unknown, result?: unknown): Partial<ToolActivityPresentation> {
  const value = object(input), action = text(value.action), source = object(value.source), destination = object(value.destination);
  if (!['read', 'view', 'search', 'create_text', 'edit_text', 'move_file'].includes(action)) return {};
  const output = object(result), resolved = object(output.source), metadata = object(output.metadata);
  const path = text(source.path) || text(resolved.name) || text(metadata.name);
  const paths = [path, text(destination.path)].filter(Boolean);
  if (action === 'search' && !paths.length && !source.id) return {};
  const diff = ['create_text', 'edit_text'].includes(action) ? resultFileDiff(output.source) : undefined;
  return { ...fileActivity(['create_text', 'edit_text', 'move_file'].includes(action) ? 'edit' : 'read', paths,
    ({ create_text: '创建', edit_text: '编辑', move_file: '移动', search: '检索', view: '查看' } as Record<string, string>)[action] ?? '阅读'), ...(diff ? { diff } : {}) };
}

/** Conservative shell recognition for display only; unknown programs keep the terminal view. */
export function commandFileActivity(command: string): Partial<ToolActivityPresentation> {
  // Never infer operations across interpolation, redirection, substitutions or scripts.
  if (/[$`<>{}()#]/.test(command)) return {};
  const tokens: string[] = [];
  let token = '', quote = '', started = false;
  const flush = () => { if (started) tokens.push(token); token = ''; started = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        if (command[index + 1] === quote) { token += char; index++; } else quote = '';
      } else token += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { flush(); if (char === '\n') tokens.push(';'); }
    else if (';|&'.includes(char)) {
      flush();
      if (command[index + 1] === char) { tokens.push(char + char); index++; } else tokens.push(char);
    } else { token += char; started = true; }
  }
  if (quote) return {};
  flush();
  const files: string[] = [];
  let segment: string[] = [], operation: 'read' | 'edit' | undefined, piped = false;
  function consume(): boolean {
    if (!segment.length) return true;
    const [program, ...args] = segment, name = program!.toLowerCase();
    if (piped && ['select-object', 'select-string', 'format-list', 'format-table', 'out-string'].includes(name)) return true;
    const readers = ['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'sed', 'rg', 'grep'];
    const writers = ['set-content', 'add-content', 'out-file'];
    if (!readers.includes(name) && !writers.includes(name)) return false;
    const editing = writers.includes(name);
    if (operation && operation !== (editing ? 'edit' : 'read')) return false;
    operation = editing ? 'edit' : 'read';
    let pattern = ['sed', 'rg', 'grep'].includes(name), explicitPath = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!, lower = arg.toLowerCase();
      if (['-path', '-literalpath', '-filepath'].includes(lower)) {
        if (!args[i + 1]) return false;
        files.push(args[++i]!); explicitPath = true; continue;
      }
      if (['-e', '--regexp', '--expression'].includes(lower)) {
        const expression = args[++i];
        if (!expression || name === 'sed' && !/^(?:\d+(?:,(?:\d+|\$))?)?p$/.test(expression)) return false;
        pattern = false; continue;
      }
      const valueOptions = ['-encoding', '-totalcount', '-tail', '-readcount', '-delimiter', '-value', '-inputobject', '-filter', '-include', '-exclude', '-g', '--glob', '-t', '--type', '--type-not', '-m', '--max-count', '--context', '--after-context', '--before-context'];
      if (valueOptions.includes(lower) || ['head', 'tail'].includes(name) && ['-n', '--lines', '-c', '--bytes'].includes(lower) || ['-A', '-B', '-C'].includes(arg)) {
        if (args[++i] === undefined) return false;
        continue;
      }
      if (arg.startsWith('-')) {
        if (name === 'sed' && arg !== '--' && !/^-[nEr]+$/.test(arg)) return false;
        if (!/^-(?:[nEHhFlLsvrRUIwxcboiSq]+|\d+|[nc]\d+)$/.test(arg) && !['--', '--raw', '-raw', '-force', '-append', '-nonewline', '--line-number', '--hidden', '--no-heading', '--files', '--ignore-case', '--fixed-strings', '--count'].includes(lower)) return false;
        if (lower === '--files') pattern = false;
        continue;
      }
      if (pattern) {
        if (name === 'sed' && !/^(?:\d+(?:,(?:\d+|\$))?)?p$/.test(arg)) return false;
        pattern = false; continue;
      }
      if (editing && explicitPath) continue;
      files.push(arg);
      if (editing) explicitPath = true;
    }
    return true;
  }
  for (const token of [...tokens, ';']) {
    if ([';', '&&', '|'].includes(token)) {
      if (!consume()) return {};
      segment = []; piped = token === '|';
    } else if (token === '&' || token === '||') return {};
    else segment.push(token);
  }
  return operation ? fileActivity(operation, files) : {};
}
