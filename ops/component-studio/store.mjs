import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { build, transform } from 'esbuild';
const execute = promisify(execFile);
const hash = value => value === null ? null : createHash('sha256').update(value).digest('hex');
const same = (a, b) => hash(a) === hash(b);
const revisionOf = changes => hash(JSON.stringify(changes.map(({ path, before, after }) => [path, before, after])));
const editable = path => /^(?:components\/[a-zA-Z0-9_-]+\.(?:js|css)|(?:style|theme)\.css|dom\.js)$/.test(path);
const support = ['component-preview.html', 'component-preview.js', 'component-preview.css', 'markdown.js', 'lazy-assets.js', 'components/paper-grain.svg'];
const error = (message, status = 409) => Object.assign(new Error(message), { status });
async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export class ComponentStudioStore {
  constructor(root) {
    this.root = root; this.web = join(root, 'web'); this.directory = join(root, '.runtime', 'component-studio');
    this.proposals = new Map(); this.queue = Promise.resolve();
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (await realpath(this.directory) !== this.directory || await realpath(this.web) !== this.web) throw error('工作台目录不能使用符号链接', 400);
    for (const directory of ['proposals', 'renders', 'transactions']) await mkdir(join(this.directory, directory), { recursive: true, mode: 0o700 });
    await this.recover();
    for (const entry of await readdir(join(this.directory, 'proposals'))) {
      if (!/^[a-f0-9-]{36}$/.test(entry)) continue;
      let meta;
      try { meta = JSON.parse(await readFile(join(this.directory, 'proposals', entry, 'meta.json'), 'utf8')); }
      catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
      if (meta.id !== entry || !/^[a-z0-9-]{1,80}$/.test(meta.scenarioId)) throw error('草稿记录损坏', 500);
      this.proposals.set(meta.id, meta);
    }
  }
  serial(action) { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  async safePath(directory, path) {
    if (!editable(path) && !support.includes(path)) throw error('文件不在组件编辑范围内', 400);
    const target = resolve(directory, path);
    if (!target.startsWith(resolve(directory) + sep)) throw error('文件路径无效', 400);
    for (let current = target;; current = dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw error('组件文件不能使用符号链接', 400); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (current === resolve(directory)) break;
    }
    return target;
  }
  async read(directory, path) {
    const target = await this.safePath(directory, path);
    try {
      const stats = await lstat(target);
      if (!stats.isFile() || stats.size > 2_000_000) throw error(`组件文件过大或类型无效：${path}`, 400);
      const value = await readFile(target, 'utf8');
      if (value.includes('\0')) throw error(`组件文件必须是文本：${path}`, 400);
      return value;
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  }
  async files(directory) {
    const result = [...support];
    for (const path of ['style.css', 'theme.css', 'dom.js']) result.push(path);
    for (const entry of await readdir(join(directory, 'components'), { withFileTypes: true }).catch(cause => { if (cause.code === 'ENOENT') return []; throw cause; })) {
      const path = `components/${entry.name}`;
      if (editable(path)) { await this.safePath(directory, path); if (entry.isFile()) result.push(path); }
    }
    return [...new Set(result)].sort();
  }
  async snapshot(directory) {
    return new Map(await Promise.all((await this.files(directory)).map(async path => [path, await this.read(directory, path)])));
  }
  async writeSnapshot(directory, files) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [path, value] of files) {
      if (value === null) continue;
      const target = await this.safePath(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, value);
    }
  }
  folder(meta, side) { return join(this.directory, 'proposals', meta.id, side); }
  get(id) { const meta = this.proposals.get(id); if (!meta) throw error('草稿不存在', 404); return meta; }
  async persist(meta) { await writeJson(join(this.directory, 'proposals', meta.id, 'meta.json'), meta); }
  async create(scenarioId, name) {
    const existing = [...this.proposals.values()].find(item => item.scenarioId === scenarioId);
    if (existing) return existing;
    const meta = { id: randomUUID(), scenarioId, name, createdAt: Date.now(), savedAt: null };
    const snapshot = await this.snapshot(this.web);
    await this.writeSnapshot(this.folder(meta, 'base'), snapshot); await this.writeSnapshot(this.folder(meta, 'draft'), snapshot);
    await this.persist(meta); this.proposals.set(meta.id, meta); return meta;
  }
  async readBase(meta, path) {
    await this.safePath(this.folder(meta, 'base'), path);
    return Object.hasOwn(meta.resolvedBases || {}, path) ? meta.resolvedBases[path] : this.read(this.folder(meta, 'base'), path);
  }
  async changes(meta) {
    const [base, draft] = await Promise.all([this.snapshot(this.folder(meta, 'base')), this.snapshot(this.folder(meta, 'draft'))]);
    const changes = [];
    for (const path of new Set([...base.keys(), ...draft.keys(), ...Object.keys(meta.resolvedBases || {})])) {
      const before = Object.hasOwn(meta.resolvedBases || {}, path) ? meta.resolvedBases[path] : base.get(path) ?? null, after = draft.get(path) ?? null;
      if (same(before, after)) continue;
      if (!editable(path)) throw error(`预览适配文件不能修改：${path}`, 400);
      changes.push({ path, before, after, kind: before === null ? 'added' : after === null ? 'deleted' : 'modified' });
    }
    return changes;
  }
  async list() {
    return Promise.all([...this.proposals.values()].map(async meta => {
      const { resolvedBases, ...info } = meta;
      try { const changes = await this.changes(meta); return { ...info, revision: revisionOf(changes), draftDirectory: this.folder(meta, 'draft'), files: changes.map(({ path, kind }) => ({ path, kind })) }; }
      catch (cause) { return { ...info, draftDirectory: this.folder(meta, 'draft'), files: [], error: cause.message }; }
    }));
  }
  async merge(current, before, after, path) {
    if (same(current, before) || same(current, after)) return after;
    if (same(before, after)) return current;
    if (current === null || before === null || after === null) throw error(`源码冲突：${path}`);
    const directory = join(this.directory, 'merge-' + randomUUID());
    await mkdir(directory, { mode: 0o700 });
    try {
      await Promise.all([['current', current], ['base', before], ['draft', after]].map(([file, text]) => writeFile(join(directory, file), text)));
      try {
        const result = await execute('git', ['merge-file', '-p', '--diff3', join(directory, 'current'), join(directory, 'base'), join(directory, 'draft')], { maxBuffer: 8_000_000 });
        return result.stdout;
      } catch { throw error(`源码冲突：${path}`); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async conflicts(meta) {
    const files = [];
    for (const change of await this.changes(meta)) {
      const current = await this.read(this.web, change.path);
      try { await this.merge(current, change.before, change.after, change.path); }
      catch { files.push({ path: change.path, revision: hash(change.after), currentRevision: hash(current), baseRevision: hash(change.before) }); }
    }
    return { files, key: files.length ? hash(JSON.stringify(files)) : null };
  }
  async validateMerged(meta, resolution) {
    const snapshot = await this.snapshot(this.web), changes = await this.changes(meta), conflicts = [];
    for (const change of changes) {
      let content;
      if (resolution?.path === change.path) content = resolution.content;
      else {
        try { content = await this.merge(snapshot.get(change.path) ?? null, change.before, change.after, change.path); }
        catch { conflicts.push(change.path); content = change.after; }
      }
      snapshot.set(change.path, content);
    }
    if (!resolution && conflicts.length) throw error(`仍需合并：${conflicts.join('、')}`);
    if (resolution) snapshot.set(resolution.path, resolution.content);
    const directory = join(this.directory, 'validate-merge-' + randomUUID());
    try {
      await this.writeSnapshot(directory, snapshot);
      for (const change of changes) {
        const content = snapshot.get(change.path);
        if (content !== null) await transform(content, { loader: change.path.endsWith('.css') ? 'css' : 'js', sourcefile: change.path, logLevel: 'silent' });
      }
      await build({ entryPoints: [join(directory, 'component-preview.js')], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
    } catch (cause) { throw error(`合并结果编译失败：${cause.errors?.[0]?.text || cause.message}`, 400); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
  async preview(id) {
    const meta = this.get(id), before = await this.snapshot(this.web), after = new Map(before), conflicts = [], conflictFiles = [];
    for (const change of await this.changes(meta)) {
      try { after.set(change.path, await this.merge(before.get(change.path) ?? null, change.before, change.after, change.path)); }
      catch (cause) { conflicts.push(cause.message); conflictFiles.push(change.path); after.set(change.path, change.after); }
    }
    const revision = createHash('sha256');
    for (const side of [before, after]) for (const [path, value] of [...side].sort()) revision.update(path).update('\0').update(value ?? '<deleted>');
    const version = revision.digest('hex').slice(0, 24), directory = join(this.directory, 'renders', id, version);
    try { await lstat(directory); }
    catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
      await this.writeSnapshot(join(directory, 'before'), before); await this.writeSnapshot(join(directory, 'after'), after);
      const entries = (await readdir(join(this.directory, 'renders', id), { withFileTypes: true })).filter(entry => entry.isDirectory());
      if (entries.length > 8) {
        const ranked = await Promise.all(entries.map(async entry => ({ name: entry.name, at: (await lstat(join(this.directory, 'renders', id, entry.name))).mtimeMs })));
        for (const entry of ranked.sort((a, b) => b.at - a.at).slice(8)) if (entry.name !== version) await rm(join(this.directory, 'renders', id, entry.name), { recursive: true, force: true });
      }
    }
    const conflictState = await this.conflicts(meta);
    return { id, scenarioId: meta.scenarioId, version, conflicts, conflictFiles, conflictKey: conflictState.key, revision: revisionOf(await this.changes(meta)), files: (await this.changes(meta)).map(({ path, kind }) => ({ path, kind })) };
  }
  async inspect(id, path) {
    const meta = this.get(id); if (!editable(path)) throw error('文件不可编辑', 400);
    const before = await this.readBase(meta, path), after = await this.read(this.folder(meta, 'draft'), path);
    const current = await this.read(this.web, path);
    let conflicted = false;
    try { await this.merge(current, before, after, path); } catch { conflicted = true; }
    return { path, before, after, current, revision: hash(after), currentRevision: hash(current), baseRevision: hash(before), conflicted };
  }
  async resolveConflict(id, input, canApply = () => true) {
    const meta = this.get(id), { path, content, revision, currentRevision, baseRevision } = input;
    if (!editable(path) || content !== null && (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 2_000_000)) throw error('合并内容无效', 400);
    if (content !== null) {
      if (/^(?:<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)(?: |$)/m.test(content)) throw error('请先处理代码中的冲突标记', 400);
      try { await transform(content, { loader: path.endsWith('.css') ? 'css' : 'js', logLevel: 'silent' }); }
      catch { throw error('请先修复合并结果的语法错误', 400); }
    }
    const inspected = await this.inspect(id, path);
    if (inspected.revision !== revision || inspected.currentRevision !== currentRevision || inspected.baseRevision !== baseRevision) throw error('源码或草稿已变化，请重新加载文件后合并');
    if (!inspected.conflicted) throw error('这个文件已没有冲突，请刷新预览');
    await this.validateMerged(meta, { path, content });
    const latest = await this.inspect(id, path);
    if (latest.revision !== revision || latest.currentRevision !== currentRevision || latest.baseRevision !== baseRevision) throw error('合并检查期间源码或草稿已变化，请重新读取');
    if (!canApply()) throw error('本轮已停止');
    // The immutable original snapshot stays intact. Version-checked source baselines
    // are persisted atomically in proposal metadata, after the candidate draft exists.
    const previous = meta.resolvedBases;
    await this.edit(id, path, content, revision);
    meta.resolvedBases = { ...previous, [path]: inspected.current };
    try { await this.persist(meta); }
    catch (cause) { if (previous) meta.resolvedBases = previous; else delete meta.resolvedBases; throw cause; }
    return { path, resolved: true };
  }
  async edit(id, path, content, revision) {
    const meta = this.get(id); if (!editable(path)) throw error('文件不可编辑', 400);
    const target = await this.safePath(this.folder(meta, 'draft'), path);
    if (hash(await this.read(this.folder(meta, 'draft'), path)) !== revision) throw error('草稿已被 AI 或其他窗口更新，请重新加载文件');
    if (content === null) await rm(target, { force: true });
    else { await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  }
  async validate(meta) {
    const directory = this.folder(meta, 'draft');
    try {
      for (const change of await this.changes(meta)) if (change.after !== null) await transform(change.after, { loader: change.path.endsWith('.css') ? 'css' : 'js', sourcefile: change.path, logLevel: 'silent' });
      await build({ entryPoints: [join(directory, 'component-preview.js')], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
    } catch (cause) { throw error(`请先修复草稿：${cause.errors?.[0]?.text || cause.message}`, 400); }
  }
  async reset(meta) {
    const snapshot = await this.snapshot(this.web);
    // Keep the AI-visible directory path stable, and replace only its managed files.
    for (const side of ['base', 'draft']) {
      const folder = this.folder(meta, side);
      for (const path of await this.files(folder)) if (!snapshot.has(path) || snapshot.get(path) === null) await rm(await this.safePath(folder, path), { force: true });
      await this.writeSnapshot(folder, snapshot);
    }
    delete meta.resolvedBases;
    await this.persist(meta);
  }
  async discard(ids) { for (const id of ids) await this.reset(this.get(id)); }
  async save(ids, revisions) {
    const plan = new Map(), original = new Map(), metas = ids.map(id => this.get(id)), reviewed = new Map();
    for (const meta of metas) {
      const changes = await this.changes(meta);
      if (typeof revisions?.[meta.id] !== 'string' || revisions[meta.id] !== revisionOf(changes)) throw error('草稿刚刚被 AI 或其他窗口更新，请刷新后再保存');
      reviewed.set(meta.id, revisionOf(changes));
      await this.validate(meta);
      for (const change of changes) {
        if (!original.has(change.path)) original.set(change.path, await this.read(this.web, change.path));
        const current = plan.has(change.path) ? plan.get(change.path) : original.get(change.path);
        plan.set(change.path, await this.merge(current, change.before, change.after, change.path));
      }
    }
    const id = randomUUID(), directory = join(this.directory, 'transactions', id);
    await mkdir(directory, { mode: 0o700 });
    const finalSnapshot = await this.snapshot(this.web);
    for (const [path, value] of plan) finalSnapshot.set(path, value);
    const validation = join(directory, 'validation');
    try {
      await this.writeSnapshot(validation, finalSnapshot);
      for (const [path, value] of plan) if (value !== null) await transform(value, { loader: path.endsWith('.css') ? 'css' : 'js', sourcefile: path, logLevel: 'silent' });
      await build({ entryPoints: [join(validation, 'component-preview.js')], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' });
      for (const meta of metas) if (revisionOf(await this.changes(meta)) !== reviewed.get(meta.id)) throw error('草稿刚刚被 AI 或其他窗口更新，请刷新后再保存');
    } catch (cause) {
      await rm(directory, { recursive: true, force: true });
      if (cause.status) throw cause;
      throw error(`请先修复合并后的组件：${cause.errors?.[0]?.text || cause.message}`, 400);
    }
    const operations = [...plan].map(([path, after]) => ({ path, before: original.get(path), after }));
    const journal = { id, complete: false, operations };
    const journalPath = join(directory, 'journal.json');
    await writeJson(journalPath, journal);
    try {
      for (const operation of operations) {
        if (!same(await this.read(this.web, operation.path), operation.before)) throw error(`源码刚刚被其他程序修改：${operation.path}`);
        await this.replaceSource(operation.path, operation.after);
      }
      journal.complete = true; await writeJson(journalPath, journal);
    } catch (cause) {
      await this.rollback(journal); await rm(directory, { recursive: true, force: true }); throw cause;
    }
    for (const meta of metas) { meta.savedAt = Date.now(); await this.reset(meta); }
    await rm(directory, { recursive: true, force: true }); return { files: operations.map(item => item.path) };
  }
  async replaceSource(path, content) {
    const target = await this.safePath(this.web, path);
    if (content === null) { await rm(target, { force: true }); return; }
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.component-studio-${randomUUID()}.tmp`);
    try { await writeFile(temporary, content); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  async rollback(journal) {
    const conflicts = [];
    for (const operation of [...journal.operations].reverse()) {
      const current = await this.read(this.web, operation.path);
      if (same(current, operation.after)) await this.replaceSource(operation.path, operation.before);
      else if (!same(current, operation.before)) conflicts.push(operation.path);
    }
    if (conflicts.length) throw error(`源码已由其他程序修改，请检查 ${conflicts.join('、')}；备份保存在 ${join(this.directory, 'transactions', journal.id)}`, 500);
  }
  async recover() {
    for (const entry of await readdir(join(this.directory, 'transactions'))) {
      const directory = join(this.directory, 'transactions', entry);
      try {
        const journal = JSON.parse(await readFile(join(directory, 'journal.json'), 'utf8'));
        if (!journal.complete) await this.rollback(journal);
        await rm(directory, { recursive: true, force: true });
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause; await rm(directory, { recursive: true, force: true }); }
    }
  }
}
