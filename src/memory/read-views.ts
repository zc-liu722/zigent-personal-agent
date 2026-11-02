import { memorySnapshot, type MemorySnapshot } from "./changes.js";
import type { MarkdownMemoryState } from "./markdown-store.js";
import type { LongTermMemory } from "./types.js";

/** Owned by one verified store snapshot. Never expose its mutable objects. */
export class MemoryReadViews {
  private readonly snapshots = new Map<string, MemorySnapshot>();
  constructor(private readonly state: MarkdownMemoryState) {}

  private snapshot(userId: string): MemorySnapshot {
    const cached = this.snapshots.get(userId);
    if (cached) return cached;
    const user = this.state.users[userId];
    const snapshot = memorySnapshot({ behaviorRules: this.state.behaviorRules,
      longTermMemory: user?.content ?? "", archiveMemory: user?.archives ?? [] });
    // Unknown users need no persistent entry; keep cache size bounded by saved users.
    if (Object.hasOwn(this.state.users, userId)) this.snapshots.set(userId, snapshot);
    return snapshot;
  }

  context(userId: string): LongTermMemory {
    const user = this.state.users[userId];
    return { agentSoul: this.state.agentSoul, behaviorRules: this.state.behaviorRules,
      content: user?.content ?? "", archiveTitles: user?.archives.map(item => item.title) ?? [],
      revision: this.snapshot(userId).revision };
  }

  editableSnapshot(userId: string): MemorySnapshot { return structuredClone(this.snapshot(userId)); }

  archive(userId: string, title: string) {
    const snapshot = this.snapshot(userId), archive = snapshot.archiveMemory?.find(item => item.title === title);
    if (!archive) throw new Error("Archive title not found");
    return { ...archive, filename: `${title}.md`, revision: snapshot.revision };
  }
}
