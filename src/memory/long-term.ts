import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MemoryConflictError, memoryRevision, previewMemoryChanges, type MemoryChangeRequest, type MemorySnapshot, memorySnapshot } from "./changes.js";
import { validateMemoryDocument, documentContent, archiveDocumentId, type MemoryDocumentTarget } from "./documents.js";
import { MarkdownMemoryStore, type MarkdownMemoryState } from "./markdown-store.js";
import type { LongTermMemory, LongTermMemoryProvider } from "./types.js";
import { memoryPassages, rankMemoryPassages } from "./recall.js";

/** One published generation contains all Markdown files and their confirmation receipts. */
export class FileLongTermMemoryRepository implements LongTermMemoryProvider {
  private readonly store: MarkdownMemoryStore;
  private initialization?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();
  constructor(filePath: string, private readonly agentId: string) { this.store = new MarkdownMemoryStore(filePath, agentId); }
  initialize(): Promise<void> {
    return this.initialization ??= this.store.initialize().then(() => undefined).catch(error => { this.initialization = undefined; throw error; });
  }
  private async readyToRead() { await this.initialize(); await this.queue; }
  async get(userId: string): Promise<LongTermMemory> {
    await this.readyToRead();
    return this.store.readContext(userId);
  }

  private async update(change: (state: MarkdownMemoryState) => void) {
    await this.initialize();
    const task = this.queue.then(async () => {
      const current = await this.store.read();
      const next = structuredClone(current.state);
      change(next);
      if (isDeepStrictEqual(next, current.state)) return;
      await this.store.commit(next, current.generation);
    });
    this.queue = task.catch(() => undefined);
    await task;
  }
  private snapshotFor(state: MarkdownMemoryState, userId: string): MemorySnapshot {
    const user = state.users[userId];
    return memorySnapshot({ behaviorRules: state.behaviorRules, longTermMemory: user?.content ?? "", archiveMemory: user?.archives ?? [] });
  }
  async editableSnapshot(userId: string): Promise<MemorySnapshot> {
    await this.readyToRead();
    return this.store.readSnapshot(userId);
  }
  async readArchive(userId: string, title: string) {
    await this.readyToRead();
    return this.store.readArchive(userId, title);
  }
  async search(userId: string, input: { query: string; target: "longTermMemory" | "behaviorRules" | "archiveMemory" | "all"; limit: number; offset: number; expected_revision?: string }) {
    const snapshot = await this.editableSnapshot(userId);
    if (input.expected_revision && input.expected_revision !== snapshot.revision) throw new MemoryConflictError("Memory changed; restart search at the current revision");
    const documents = [
      { target: "longTermMemory" as const, title: "long-term-memory.md", content: snapshot.longTermMemory },
      { target: "behaviorRules" as const, title: "behavior-rules.md", content: snapshot.behaviorRules },
      ...snapshot.archiveMemory!.map(archive => ({ target: "archiveMemory" as const, ...archive }))
    ].filter(document => input.target === "all" || input.target === document.target);
    const passages = documents.flatMap(document => memoryPassages(document.content).map(passage => ({ ...passage,
      heading: `${document.title} ${passage.heading}`, target: document.target, title: document.title })));
    const ranked = rankMemoryPassages(passages, input.query).filter(item => item.score > 0);
    const items = ranked.slice(input.offset, input.offset + input.limit).map(({ passage }) => ({ target: passage.target,
      title: passage.title, offset: passage.offset, end_offset: passage.endOffset,
      excerpt: passage.content.slice(0, 800), excerpt_truncated: passage.content.length > 800 }));
    return { revision: snapshot.revision, items, has_more: ranked.length > input.offset + items.length,
      ...(ranked.length > input.offset + items.length ? { next_offset: input.offset + items.length } : {}) };
  }
  /** Only the authenticated confirmation path calls the writer; never exposed as a model action. */
  async applyConfirmedChange(userId: string, proposalId: string, request: MemoryChangeRequest): Promise<void> {
    await this.update(state => {
      const receipt = createHash("sha256").update(JSON.stringify([userId, request])).digest("hex");
      if (Object.hasOwn(state.receipts, proposalId)) {
        if (state.receipts[proposalId] !== receipt) throw new Error("Memory confirmation mismatch");
        return;
      }
      const { next } = previewMemoryChanges(this.snapshotFor(state, userId), request);
      state.behaviorRules = next.behaviorRules;
      state.users[userId] = { content: next.longTermMemory, archives: next.archiveMemory ?? [] };
      state.receipts[proposalId] = receipt;
    });
  }
  /** An explicit file save edits only that fixed document, preserving all other users and files. */
  async saveConfirmedDocument(userId: string, target: MemoryDocumentTarget, expectedRevision: string, content: string, archiveTitle?: string): Promise<void> {
    if (!["longTermMemory", "behaviorRules"].includes(target) && !/^archive-[a-f0-9]{24}$/.test(target)) throw new Error("Unknown memory document");
    validateMemoryDocument(target, content);
    await this.update(state => {
      const snapshot = this.snapshotFor(state, userId);
      if (documentContent(snapshot, target) === content) return;
      if (memoryRevision(snapshot) !== expectedRevision) throw new MemoryConflictError();
      const user = state.users[userId] ?? { content: "", archives: [] };
      if (target.startsWith("archive-")) {
        const existing = user.archives.find(item => archiveDocumentId(item.title) === target);
        const title = existing?.title ?? archiveTitle;
        if (!title || archiveDocumentId(title) !== target) throw new Error("Unknown archive document");
        user.archives = user.archives.filter(item => item.title !== title);
        user.archives.push({ title, content });
      } else if (target === "behaviorRules") state.behaviorRules = content;
      else user.content = content;
      state.users[userId] = user;
    });
  }
}
