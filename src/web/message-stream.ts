import type { ServerResponse } from "node:http";
import type { WebMessageOperation } from "./message-operations.js";
import type { WebMessage, WebStore } from "./store.js";

type Message = WebMessage & { seq: number };
type State = { busy: boolean; activeMessageId?: string };
type Operations = Pick<Message, "id" | "conversationId" | "seq" | "streamEpoch" | "streamRevision"> & {
  baseRevision: number; operations: readonly WebMessageOperation[];
};
const LIMIT = 128;
function remember(map: Map<string, number>, key: string, value: number): void {
  map.delete(key); map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value!);
}

/** Serialize recorded mutations once; complete views are only requested by unsynchronized clients. */
export class WebMessageStream {
  private readonly clients = new Map<ServerResponse, { credential: string; patches: boolean; revisions: Map<string, number> }>();
  constructor(private readonly store: WebStore, private readonly decorate: (message: { conversationId: string }) => State | undefined) {
    store.on("message", this.broadcast);
    store.on("message-operations", this.broadcastOperations);
  }
  add(response: ServerResponse, credential: string, patches: boolean): void {
    this.clients.set(response, { credential, patches, revisions: new Map() });
  }
  remove(response: ServerResponse): void { this.clients.delete(response); }
  private send(value: Message | Operations, current?: () => Message | undefined): void {
    if (!this.clients.size) return;
    const state = this.decorate(value);
    if (!state) return;
    let fullFrame: string | undefined, patchFrame: string | undefined;
    for (const [response, client] of this.clients) {
      if (response.destroyed || response.writableEnded) { this.clients.delete(response); continue; }
      if (!this.store.authenticate(client.credential)) { response.end(); this.clients.delete(response); continue; }
      const usePatch = current && client.patches && client.revisions.get(value.id) === (value as Operations).baseRevision;
      let frame: string;
      if (usePatch) frame = patchFrame ??= `event: message-patch\ndata: ${JSON.stringify({ ...value, ...state })}\n\n`;
      else {
        if (!fullFrame) {
          const message = current ? current() : value;
          if (!message) return;
          fullFrame = `event: message\ndata: ${JSON.stringify({ ...message, ...state })}\n\n`;
        }
        frame = fullFrame;
      }
      if (!response.write(frame) && response.writableLength > 1024 * 1024) response.end();
      remember(client.revisions, value.id, value.streamRevision!);
    }
  }
  private readonly broadcast = (message: Message) => this.send(message);
  private readonly broadcastOperations = (operations: Operations, current: () => Message | undefined) => this.send(operations, current);
  close(): void {
    this.store.off("message", this.broadcast); this.store.off("message-operations", this.broadcastOperations); this.clients.clear();
  }
}
