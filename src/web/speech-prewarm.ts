import WebSocket, { type RawData } from "ws";

export type PreparedSpeechProvider = { socket: WebSocket; started: number; connected?: number };

/** Bounded, device-owned handshakes only: no session, request payload or audio. */
export function createSpeechPrewarmer(connect: () => WebSocket, available: (device: string) => boolean) {
  const pending = new Map<string, () => void>();
  const prepare = (client: WebSocket, device: string,
    resume: (raw: RawData, binary: boolean, provider?: PreparedSpeechProvider) => void) => {
    pending.get(device)?.();
    if (pending.size >= 2 || !available(device)) { client.terminate(); return; }
    let provider: PreparedSpeechProvider | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const detach = () => {
      clearTimeout(timer);
      if (pending.get(device) === close) pending.delete(device);
      client.off("close", close); client.off("error", close); client.off("message", activate);
      provider?.socket.off("open", opened); provider?.socket.off("close", close); provider?.socket.off("error", close);
      provider?.socket.off("message", close);
    };
    const close = () => {
      if (closed) return;
      closed = true; detach(); provider?.socket.terminate(); client.terminate();
    };
    const opened = () => {
      if (closed || !provider) return;
      provider.connected = performance.now();
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "prepared" }));
    };
    const activate = (raw: RawData, binary: boolean) => {
      if (closed) return;
      closed = true; detach();
      // Ownership and all error/close handlers transfer synchronously to the session.
      resume(raw, binary, provider);
    };
    pending.set(device, close);
    client.once("close", close); client.once("error", close); client.once("message", activate);
    timer = setTimeout(close, 8000); timer.unref();
    try {
      const started = performance.now(); provider = { socket: connect(), started };
      // Aborting a CONNECTING socket emits an asynchronous error after detach.
      provider.socket.on("error", () => {});
      provider.socket.once("open", opened); provider.socket.once("close", close); provider.socket.once("error", close);
      provider.socket.once("message", close);
      if (provider.socket.readyState === WebSocket.OPEN) opened();
    } catch { close(); }
  };
  return { prepare, close() { for (const close of [...pending.values()]) close(); } };
}
