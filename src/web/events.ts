import type { ServerResponse } from "node:http";
import type { AgentRuntime } from "../runtime.js";
import type { ConversationCoordinator } from "./conversation-coordinator.js";
import { json, type WebRoute } from "./http.js";
import { WebMessageStream } from "./message-stream.js";
import type { WebStore } from "./store.js";

export function createWebEvents(store: WebStore, coordinator: ConversationCoordinator, codex: AgentRuntime["codex"]) {
  const streams = new Set<ServerResponse>();
  const messageStream = new WebMessageStream(store, value => {
    const id = store.resolveConversation(value.conversationId);
    if (!id) return; // Late results for deleted conversations stay private.
    const chatId = store.conversationInfo(id)!.chatId, running = coordinator.activeConversation(chatId) === id;
    return { busy: running, activeMessageId: running ? coordinator.activeMessage(chatId) : undefined };
  });
  const handle: WebRoute = async ({ route, req, res, url, credential }) => {
    if (route === "api/events" && req.method === "GET") {
      if (streams.size >= 20) { json(res, 429, { error: "打开的页面过多。" }); return true; }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.write("event: ready\ndata: {}\n\n"); streams.add(res);
      let pending = false;
      const changed = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (!res.destroyed && !res.writableEnded) res.write("event: change\ndata: {}\n\n"); }, 200).unref(); };
      store.on("change", changed);
      messageStream.add(res, credential, url.searchParams.get("messagePatches") === "1");
      const queue = (value: unknown) => {
        if (!store.authenticate(credential)) { res.end(); return; }
        if (!res.destroyed && !res.writableEnded) res.write(`event: queue\ndata: ${JSON.stringify(value)}\n\n`);
      };
      store.on("queue", queue);
      const browserUpdate = (value: unknown) => {
        if (!store.authenticate(credential)) { res.end(); return; }
        if (!res.destroyed && !res.writableEnded) res.write(`event: browser\ndata: ${JSON.stringify(value)}\n\n`);
      };
      store.on("browser", browserUpdate);
      const performancePing = (value: { credential: string; nonce: string }) => {
        if (value.credential !== credential || !store.authenticate(credential) || res.destroyed || res.writableEnded) return;
        res.write(`event: performance-ping\ndata: ${JSON.stringify({ nonce: value.nonce })}\n\n`);
      };
      store.on("performance-ping", performancePing);
      let codexCursor = codex?.store.displayCursor() ?? 0;
      const codexUpdates = setInterval(() => {
        if (!store.authenticate(credential)) { res.end(); return; }
        const next = codex?.store.displayCursor() ?? 0;
        if (next !== codexCursor && !res.destroyed && !res.writableEnded) { codexCursor = next; if (!res.write(`event: codex\ndata: {}\n\n`)) res.end(); }
      }, 1000); codexUpdates.unref();
      const heartbeat = setInterval(() => { if (!store.authenticate(credential)) res.end(); else res.write(": heartbeat\n\n"); }, 15_000);
      res.on("close", () => { clearInterval(heartbeat); clearInterval(codexUpdates); store.off("performance-ping", performancePing); store.off("change", changed); messageStream.remove(res); store.off("queue", queue); store.off("browser", browserUpdate); streams.delete(res); });
      return true;
    }
    return false;
  };
  return { handle, close: () => { messageStream.close(); for (const stream of streams) stream.end(); } };
}
